import { MERGE_VOTE_MULTIPLIER_PER_CONTRIBUTOR } from './config.js';

// Firebase keys can't contain . # $ [ ] / — canonical IDs are normally plain
// alphanumerics but this keeps merging safe regardless of source platform.
export function sanitizeKey(raw) {
  return String(raw).replace(/[.#$\[\]/]/g, '_');
}

// Merges each player's raw link submissions into deduped entries keyed by
// canonical ID. Two players pasting the same video end up as one entry with
// both names in `contributors`, whatever order they submitted in.
//
// playerSubmissions: { [playerId]: { name, links: [{ url, platform, canonicalId, thumbnail, title, author, embedHtml }] } }
// returns: { [entryId]: { canonicalId, platform, url, thumbnail, title, author, embedHtml, contributors: [{id, name}] } }
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
  return entries;
}

export function multiplierFor(entry) {
  return entry.contributors.length * MERGE_VOTE_MULTIPLIER_PER_CONTRIBUTOR;
}

// Tallies weighted totals and produces a rank-sorted list (competition
// ranking: ties share a rank, next rank skips accordingly). Also returns,
// per entry, which voters contributed how many raw points — the reveal
// animation shows this breakdown ("Tommy +4, Randy +2") rather than just an
// abstract total. Voter identity here is intentionally always included:
// it's a separate concern from the presenter phase's submitter-attribution
// toggle, which only ever hides who *submitted* a clip, not who *voted* for
// it — voter identity is public at reveal time regardless of that toggle.
//
// submissions: { [entryId]: { ...entry, contributors } }
// ballots: { [playerId]: { [entryId]: points } }
// returns each result with `voterBreakdown: [{ playerId, points }]`, sorted
// by points descending — resolving playerId to a display name is left to
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
