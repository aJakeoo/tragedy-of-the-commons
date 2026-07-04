import { setPresentIndex, setRevealAttribution, startVoting } from './firebase.js';
import { showPhaseError } from './uiError.js';
import { renderTikTokEmbed, renderInstagramEmbed } from './embeds.js';

let bound = false;
let startingVoting = false;
let presenterRound = null;
let lastRenderedEntryId = null;

function renderCard(entryId, entry, revealAttribution) {
  const card = document.getElementById('presenter-card');

  if (!entry) {
    lastRenderedEntryId = null;
    card.innerHTML = '<p class="muted">No clips were submitted this round.</p>';
    return;
  }

  // Only re-render the embed itself when the clip actually changes — this
  // function also re-runs on unrelated updates (e.g. the attribution toggle
  // firing a new room snapshot), and reloading a TikTok/Instagram embed
  // resets any playback the host already started.
  if (entryId !== lastRenderedEntryId) {
    lastRenderedEntryId = entryId;
    card.innerHTML = '';

    const badge = document.createElement('p');
    badge.className = 'muted';
    badge.textContent = entry.platform === 'tiktok' ? 'TikTok' : 'Instagram Reels';
    card.appendChild(badge);

    const embedContainer = document.createElement('div');
    embedContainer.id = 'presenter-embed';
    card.appendChild(embedContainer);
    if (entry.platform === 'tiktok' && entry.embedHtml) {
      renderTikTokEmbed(embedContainer, entry.embedHtml);
    } else {
      // Instagram links (and a TikTok entry with no embed HTML for some
      // reason) fall back to Instagram's own embed widget or, failing that,
      // a plain link — either way the host still doesn't need this app's
      // "Open clip" link to be the ONLY option.
      renderInstagramEmbed(embedContainer, entry.url);
    }

    if (entry.title) {
      const title = document.createElement('p');
      title.textContent = entry.title;
      card.appendChild(title);
    }

    const contributorsWrap = document.createElement('div');
    contributorsWrap.id = 'presenter-contributors';
    card.appendChild(contributorsWrap);
  }

  renderContributors(entry, revealAttribution);
}

function renderContributors(entry, revealAttribution) {
  const wrap = document.getElementById('presenter-contributors');
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

export function render(room, ctx) {
  const round = room.round;
  const roundData = room.rounds?.[round] || {};
  const submissions = roundData.submissions || {};
  const entries = Object.entries(submissions); // [entryId, entry][]
  const presentIndex = Math.min(roundData.presentIndex || 0, Math.max(entries.length - 1, 0));
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
    document.getElementById('presenter-prev-btn').addEventListener('click', () => {
      const r = window.__totcCurrentRoom;
      const data = r.rounds?.[r.round] || {};
      const total = Object.keys(data.submissions || {}).length;
      const idx = Math.max(0, (data.presentIndex || 0) - 1);
      if (total > 0) setPresentIndex(ctx.code, r.round, idx);
    });
    document.getElementById('presenter-next-btn').addEventListener('click', () => {
      const r = window.__totcCurrentRoom;
      const data = r.rounds?.[r.round] || {};
      const total = Object.keys(data.submissions || {}).length;
      const idx = Math.min(total - 1, (data.presentIndex || 0) + 1);
      if (total > 0) setPresentIndex(ctx.code, r.round, idx);
    });
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

  const [currentEntryId, currentEntry] = entries[presentIndex] || [];
  renderCard(currentEntryId, currentEntry, revealAttribution);

  document.getElementById('host-presenter-controls').classList.toggle('hidden', !ctx.isHost);
  document.getElementById('guest-watching-note').classList.toggle('hidden', ctx.isHost);

  if (ctx.isHost) {
    document.getElementById('presenter-position').textContent =
      entries.length ? `${presentIndex + 1} of ${entries.length}` : '0 of 0';
    document.getElementById('presenter-prev-btn').disabled = presentIndex <= 0;
    document.getElementById('presenter-next-btn').disabled = presentIndex >= entries.length - 1;
    document.getElementById('attribution-toggle').checked = revealAttribution;
    if (!startingVoting) {
      document.getElementById('start-voting-btn').disabled = entries.length === 0;
    }
  }
}
