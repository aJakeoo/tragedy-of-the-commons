import { setRevealAttribution, startVoting } from './firebase.js';
import { showPhaseError } from './uiError.js';
import {
  buildTikTokBlockquote,
  buildInstagramBlockquote,
  loadTikTokEmbedScript,
  processInstagramEmbeds,
  registerEmbedCard,
  resetKnownEmbeds,
} from './embeds.js';

let bound = false;
let startingVoting = false;
let presenterRound = null;
let renderedEntryIds = null; // sorted, joined — identifies the current grid's contents

function buildCard(entryId, entry) {
  const card = document.createElement('div');
  card.className = 'presenter-card';
  card.dataset.entryId = entryId;

  const badge = document.createElement('p');
  badge.className = 'muted';
  badge.textContent = entry.platform === 'tiktok' ? 'TikTok' : 'Instagram Reels';
  card.appendChild(badge);

  const embedContainer = document.createElement('div');
  embedContainer.className = 'presenter-embed';
  card.appendChild(embedContainer);

  registerEmbedCard(embedContainer, {
    platform: entry.platform,
    embedHtml: entry.embedHtml,
    url: entry.url,
  });

  let hasTikTokEmbed = false;
  if (entry.platform === 'tiktok' && entry.embedHtml) {
    embedContainer.appendChild(buildTikTokBlockquote(entry.embedHtml));
    hasTikTokEmbed = true;
  } else {
    // Instagram links (and a TikTok entry with no embed HTML for some
    // reason) fall back to Instagram's own embed widget.
    embedContainer.appendChild(buildInstagramBlockquote(entry.url));
  }

  if (entry.title) {
    const title = document.createElement('p');
    title.textContent = entry.title;
    card.appendChild(title);
  }

  const contributorsWrap = document.createElement('div');
  contributorsWrap.className = 'presenter-contributors';
  card.appendChild(contributorsWrap);

  return { card, hasTikTokEmbed };
}

function renderContributors(card, entry, revealAttribution) {
  const wrap = card.querySelector('.presenter-contributors');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (revealAttribution) {
    (entry.contributors || []).forEach(c => {
      const tag = document.createElement('span');
      tag.className = 'contributor-tag';
      tag.textContent = c.name;
      wrap.appendChild(tag);
    });
  } else {
    const hidden = document.createElement('span');
    hidden.className = 'muted';
    hidden.textContent = 'Submitted by: hidden';
    wrap.appendChild(hidden);
  }
}

// Rebuilds the whole grid — only called when the actual set of entries for
// this round changes, not on every snapshot (e.g. toggling attribution
// shouldn't reload every embed and reset any playback in progress).
function renderGrid(entries) {
  const grid = document.getElementById('presenter-grid');
  grid.innerHTML = '';
  resetKnownEmbeds();

  if (entries.length === 0) {
    grid.innerHTML = '<p class="muted">No clips were submitted this round.</p>';
    return;
  }

  let anyTikTok = false;
  for (const [entryId, entry] of entries) {
    const { card, hasTikTokEmbed } = buildCard(entryId, entry);
    if (hasTikTokEmbed) anyTikTok = true;
    grid.appendChild(card);
  }

  // One script load processes every TikTok blockquote currently in the grid;
  // likewise one process() call picks up every Instagram blockquote.
  if (anyTikTok) loadTikTokEmbedScript();
  processInstagramEmbeds();
}

export function render(room, ctx) {
  const round = room.round;
  const roundData = room.rounds?.[round] || {};
  const submissions = roundData.submissions || {};
  const entries = Object.entries(submissions); // [entryId, entry][]
  const revealAttribution = !!roundData.revealAttribution;

  if (presenterRound !== round) {
    presenterRound = round;
    startingVoting = false;
    const startBtn = document.getElementById('start-voting-btn');
    startBtn.disabled = entries.length === 0;
    startBtn.textContent = 'Start voting';
  }

  if (!bound) {
    bound = true;
    document.getElementById('attribution-toggle').addEventListener('change', e => {
      const r = window.__totcCurrentRoom;
      setRevealAttribution(ctx.code, r.round, e.target.checked);
    });
    document.getElementById('start-voting-btn').addEventListener('click', async e => {
      startingVoting = true;
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Starting voting...';
      try {
        await startVoting(ctx.code);
      } catch (err) {
        startingVoting = false;
        btn.disabled = false;
        btn.textContent = 'Start voting';
        showPhaseError(err);
      }
    });
  }

  const entryIdsKey = entries.map(([id]) => id).sort().join(',');
  if (entryIdsKey !== renderedEntryIds) {
    renderedEntryIds = entryIdsKey;
    renderGrid(entries);
  }

  document.querySelectorAll('#presenter-grid .presenter-card').forEach(card => {
    const entry = submissions[card.dataset.entryId];
    if (entry) renderContributors(card, entry, revealAttribution);
  });

  document.getElementById('host-presenter-controls').classList.toggle('hidden', !ctx.isHost);
  document.getElementById('guest-watching-note').classList.toggle('hidden', ctx.isHost);

  if (ctx.isHost) {
    document.getElementById('attribution-toggle').checked = revealAttribution;
    if (!startingVoting) {
      document.getElementById('start-voting-btn').disabled = entries.length === 0;
    }
  }
}
