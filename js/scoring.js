import { MERGE_VOTE_MULTIPLIER_PER_CONTRIBUTOR } from './config.js';

// Firebase keys can't contain . # $ [ ] / - canonical IDs are normally plain
// alphanumerics but this keeps merging safe regardless of source platform.
export function sanitizeKey(raw) {
  return String(raw).replace(/[.#$\[\]/]/g, '_');
}

// Merges each player's raw link submissions into deduped entries keyed by
// canonical ID. Two players pasting the same video end up as one entry with
// both names in `contributors`, whatever order they submitted in.
//
// Each entry also gets a random `order` index, assigned once here at
// compile time and persisted with the entry. Without it, entries come out
// grouped by submitter (player 1's clips, then player 2's, ...), which
// both telegraphs who submitted what and makes the feed predictable.
// Shuffling once at compile - rather than per-render - keeps every
// client's feed and ballot in the same random order, stable across
// snapshots.
//
// playerSubmissions: { [playerId]: { name, links: [{ url, platform, canonicalId, thumbnail, title, author, embedHtml }] } }
// returns: { [entryId]: { canonicalId, platform, url, thumbnail, title, author, embedHtml, contributors: [{id, name}], order } }
export function mergeSubmissions(playerSubmissions) {
  const entries = {};
  for (const [playerId, sub] of Object.entries(playerSubmissions || {})) {
    for (const link of sub.links || []) {
      const entryId = `${link.platform}_${sanitizeKey(link.canonicalId)}`;
      if (!entries[entryId]) {
        entries[entryId] = {
          canonicalId: link.canonicalId,
          platform: link.platform,
          url: link.url,
          thumbnail: link.thumbnail || null,
          title: link.title || '',
          author: link.author || '',
          embedHtml: link.embedHtml || null,
          contributors: [],
        };
      }
      if (!entries[entryId].contributors.some(c => c.id === playerId)) {
        entries[entryId].contributors.push({ id: playerId, name: sub.name });
      }
    }
  }

  // Fisher-Yates over the entry ids, then stamp each entry with its slot.
  const ids = Object.keys(entries);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  ids.forEach((id, i) => {
    entries[id].order = i;
  });

  return entries;
}

// Presentation order for compiled entries: the random compile-time order,
// with entryId as a deterministic tiebreak for rooms compiled before
// `order` existed.
export function sortEntries(entries) {
  return [...entries].sort(([idA, a], [idB, b]) => {
    const oa = a.order ?? 0;
    const ob = b.order ?? 0;
    return oa - ob || (idA < idB ? -1 : 1);
  });
}

export function multiplierFor(entry) {
  return entry.contributors.length * MERGE_VOTE_MULTIPLIER_PER_CONTRIBUTOR;
}

// Tallies weighted totals and produces a rank-sorted list (competition
// ranking: ties share a rank, next rank skips accordingly). Also returns,
// per entry, which voters contributed how many raw points - the reveal
// animation shows this breakdown ("Tommy +4, Randy +2") rather than just an
// abstract total. Voter identity here is intentionally always included:
// it's a separate concern from the presenter phase's submitter-attribution
// toggle, which only ever hides who *submitted* a clip, not who *voted* for
// it - voter identity is public at reveal time regardless of that toggle.
//
// submissions: { [entryId]: { ...entry, contributors } }
// ballots: { [playerId]: { [entryId]: points } }
// returns each result with `voterBreakdown: [{ playerId, points }]`, sorted
// by points descending - resolving playerId to a display name is left to
// the caller (reveal.js), which has access to the room's player list.
export function tallyResults(submissions, ballots) {
  const totals = {};
  const breakdowns = {};
  for (const entryId of Object.keys(submissions)) {
    totals[entryId] = 0;
    breakdowns[entryId] = [];
  }

  for (const [voterId, ballot] of Object.entries(ballots || {})) {
    for (const [entryId, points] of Object.entries(ballot || {})) {
      if (!(entryId in totals) || !points) continue;
      const pts = Number(points);
      totals[entryId] += pts;
      breakdowns[entryId].push({ playerId: voterId, points: pts });
    }
  }
  for (const entryId of Object.keys(breakdowns)) {
    breakdowns[entryId].sort((a, b) => b.points - a.points);
  }

  const results = Object.entries(submissions).map(([entryId, entry]) => {
    const multiplier = multiplierFor(entry);
    const rawPoints = totals[entryId] || 0;
    return {
      entryId,
      ...entry,
      multiplier,
      rawPoints,
      weightedPoints: rawPoints * multiplier,
      voterBreakdown: breakdowns[entryId],
    };
  });

  results.sort((a, b) => b.weightedPoints - a.weightedPoints);

  let rank = 0;
  let lastScore = null;
  results.forEach((r, i) => {
    if (r.weightedPoints !== lastScore) {
      rank = i + 1;
      lastScore = r.weightedPoints;
    }
    r.rank = rank;
  });

  return results;
}
