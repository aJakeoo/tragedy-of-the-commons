import { setPresentIndex, setRevealAttribution, startVoting } from './firebase.js';
import { showPhaseError } from './uiError.js';

let bound = false;
let startingVoting = false;
let presenterRound = null;

function renderCard(entry, revealAttribution) {
  const card = document.getElementById('presenter-card');
  card.innerHTML = '';

  if (!entry) {
    card.innerHTML = '<p class="muted">No clips were submitted this round.</p>';
    return;
  }

  const badge = document.createElement('p');
  badge.className = 'muted';
  badge.textContent = entry.platform === 'tiktok' ? 'TikTok' : 'Instagram Reels';
  card.appendChild(badge);

  if (entry.thumbnail) {
    const img = document.createElement('img');
    img.src = entry.thumbnail;
    img.alt = entry.title || 'Clip thumbnail';
    card.appendChild(img);
  }

  const link = document.createElement('p');
  const a = document.createElement('a');
  a.href = entry.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'Open clip';
  link.appendChild(a);
  card.appendChild(link);

  if (entry.title) {
    const title = document.createElement('p');
    title.textContent = entry.title;
    card.appendChild(title);
  }

  const contributorsWrap = document.createElement('div');
  if (revealAttribution) {
    (entry.contributors || []).forEach(c => {
      const tag = document.createElement('span');
      tag.className = 'contributor-tag';
      tag.textContent = c.name;
      contributorsWrap.appendChild(tag);
    });
  } else {
    contributorsWrap.innerHTML = '<span class="muted">Submitted by: hidden</span>';
  }
  card.appendChild(contributorsWrap);
}

export function render(room, ctx) {
  const round = room.round;
  const roundData = room.rounds?.[round] || {};
  const submissions = roundData.submissions || {};
  const entries = Object.values(submissions);
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

  renderCard(entries[presentIndex], revealAttribution);

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
