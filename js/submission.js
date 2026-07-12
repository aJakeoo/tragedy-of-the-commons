import { validateAndResolveLink } from './linkValidation.js';
import { submitPlayerLinks, closeSubmissionsAndCompile } from './firebase.js';
import { mergeSubmissions } from './scoring.js';
import { MAX_LINKS_PER_PLAYER, SUBMISSION_TIMER_SECONDS } from './config.js';
import { showPhaseError } from './uiError.js';

let slotState = []; // [{ url, status: 'empty'|'checking'|'ok'|'bad', result, error }]
let timerInterval = null;
let timerStartedAtRound = null;
let bound = false;

function renderSlots() {
  const container = document.getElementById('link-slots');
  container.innerHTML = '';
  slotState.forEach((slot, i) => {
    const div = document.createElement('div');
    div.className = 'link-slot' + (slot.status === 'ok' ? ' valid' : slot.status === 'bad' ? ' invalid' : '');

    const label = document.createElement('label');
    label.textContent = `Link ${i + 1}`;
    label.setAttribute('for', `link-input-${i}`);

    const input = document.createElement('input');
    input.type = 'url';
    input.id = `link-input-${i}`;
    input.placeholder = 'Paste a TikTok or Instagram Reels link';
    input.value = slot.url || '';
    input.addEventListener('input', () => {
      slot.url = input.value;
      slot.status = input.value.trim() ? 'checking' : 'empty';
      slot.error = null;
      scheduleCheck(i);
      renderStatus(i);
    });

    const status = document.createElement('div');
    status.className = 'status';
    status.id = `link-status-${i}`;

    div.append(label, input, status);
    container.appendChild(div);
  });
  slotState.forEach((_, i) => renderStatus(i));
}

function renderStatus(i) {
  const el = document.getElementById(`link-status-${i}`);
  const slotDiv = document.getElementById(`link-input-${i}`)?.closest('.link-slot');
  if (!el) return;
  const slot = slotState[i];
  el.className = 'status';
  slotDiv?.classList.remove('valid', 'invalid');
  if (slot.status === 'checking') {
    el.textContent = 'Checking...';
    el.classList.add('checking');
  } else if (slot.status === 'ok') {
    el.textContent = `Looks good${slot.result?.unverifiable ? ' (format valid - Instagram can’t be auto-verified)' : ''}.`;
    el.classList.add('ok');
    slotDiv?.classList.add('valid');
  } else if (slot.status === 'bad') {
    el.textContent = slot.error || "This link didn't work - try another.";
    el.classList.add('bad');
    slotDiv?.classList.add('invalid');
  } else {
    el.textContent = '';
  }
}

const debounceTimers = {};
function scheduleCheck(i) {
  clearTimeout(debounceTimers[i]);
  debounceTimers[i] = setTimeout(() => checkSlot(i), 500);
}

async function checkSlot(i) {
  const slot = slotState[i];
  const url = slot.url.trim();
  if (!url) {
    slot.status = 'empty';
    renderStatus(i);
    updateSubmitEnabled();
    return;
  }
  slot.status = 'checking';
  renderStatus(i);
  const result = await validateAndResolveLink(url);
  // Guard against stale responses if the field changed again during the fetch.
  if (slotState[i].url.trim() !== url) return;
  if (result.ok) {
    slot.status = 'ok';
    slot.result = result;
    slot.error = null;
  } else {
    slot.status = 'bad';
    slot.result = null;
    slot.error = result.error;
  }
  renderStatus(i);
  updateSubmitEnabled();
}

function updateSubmitEnabled() {
  const hasValid = slotState.some(s => s.status === 'ok');
  document.getElementById('submit-links-btn').disabled = !hasValid;
}

function startTimer(round) {
  if (timerStartedAtRound === round) return; // don't restart on unrelated room updates
  timerStartedAtRound = round;
  clearInterval(timerInterval);
  let remaining = SUBMISSION_TIMER_SECONDS;
  const fill = document.getElementById('timer-fill');
  const label = document.getElementById('timer-label');
  fill.style.width = '100%';
  fill.classList.remove('low');

  const tick = () => {
    const pct = Math.max(0, (remaining / SUBMISSION_TIMER_SECONDS) * 100);
    fill.style.width = `${pct}%`;
    fill.classList.toggle('low', remaining <= 10);
    label.textContent = remaining > 0
      ? `${remaining}s - just a nudge, submissions aren't locked when this hits zero`
      : "Time's up, but you can still submit whenever you're ready.";
    remaining -= 1;
    if (remaining < -1) clearInterval(timerInterval);
  };
  tick();
  timerInterval = setInterval(tick, 1000);
}

export function render(room, ctx) {
  const round = room.round;

  if (!bound) {
    bound = true;
    slotState = Array.from({ length: MAX_LINKS_PER_PLAYER }, () => ({ url: '', status: 'empty' }));
    renderSlots();

    document.getElementById('submit-links-btn').addEventListener('click', async () => {
      const validLinks = slotState.filter(s => s.status === 'ok').map(s => ({
        url: s.result.url,
        platform: s.result.platform,
        canonicalId: s.result.canonicalId,
        thumbnail: s.result.thumbnail,
        title: s.result.title,
        author: s.result.author,
        embedHtml: s.result.embedHtml || null,
      }));
      if (validLinks.length === 0) return;
      try {
        await submitPlayerLinks(ctx.code, room.round, ctx.playerId, ctx.playerName, validLinks);
        document.getElementById('submitted-note').classList.remove('hidden');
      } catch (err) {
        showPhaseError(err);
      }
    });

    document.getElementById('close-submissions-btn').addEventListener('click', async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Compiling...';
      try {
        const current = window.__totcCurrentRoom;
        const merged = mergeSubmissions(current.rounds?.[current.round]?.playerSubmissions || {});
        await closeSubmissionsAndCompile(ctx.code, current.round, merged);
        // Left disabled - the phase switches away as soon as `status` updates.
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Close submissions & compile';
        showPhaseError(err);
      }
    });
  }

  // Reset per-round UI state when a fresh round starts (round number changed
  // since this module last saw it and no submissions exist yet for it).
  if (timerStartedAtRound !== round) {
    slotState = Array.from({ length: MAX_LINKS_PER_PLAYER }, () => ({ url: '', status: 'empty' }));
    renderSlots();
    document.getElementById('submitted-note').classList.add('hidden');
    startTimer(round);

    const closeBtn = document.getElementById('close-submissions-btn');
    closeBtn.disabled = false;
    closeBtn.textContent = 'Close submissions & compile';
  }

  updateSubmitEnabled();

  const players = room.players || {};
  const playerSubmissions = room.rounds?.[round]?.playerSubmissions || {};
  const submittedCount = Object.keys(playerSubmissions).length;
  const totalPlayers = Object.keys(players).length;
  document.getElementById('submission-progress').textContent =
    `${submittedCount} of ${totalPlayers} player${totalPlayers === 1 ? '' : 's'} have submitted.`;

  document.getElementById('host-close-controls').classList.toggle('hidden', !ctx.isHost);
}
