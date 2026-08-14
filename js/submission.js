import { validateAndResolveLink } from './linkValidation.js';
import { submitPlayerLinks, closeSubmissionsAndCompile } from './firebase.js';
import { uploadClipVideo } from './cloudinaryUpload.js';
import { mergeSubmissions } from './scoring.js';
import { MAX_LINKS_PER_PLAYER, SUBMISSION_TIMER_SECONDS, MAX_UPLOAD_SIZE_MB, UPLOAD_ENABLED } from './config.js';
import { showPhaseError } from './uiError.js';

let slotState = []; // [{ mode: 'link'|'upload', url, status: 'empty'|'checking'|'ok'|'bad', result, error, fileName, progress, uploadTask }]
let timerInterval = null;
let timerStartedAtRound = null;
let bound = false;
let currentCode = null;
let currentRound = null;

// Upload is the primary, preferred submission route - every slot opens on
// it, and pasting a link is the fallback for a clip you can't easily get
// onto the device. That's a playback decision, not a taste one: an uploaded
// clip becomes a same-origin <video> this app fully controls (reliable
// autoplay, real sound, and the only thing that can be seeked accurately
// enough for synced playback), while a platform link is at the mercy of
// TikTok's Embed Player or Instagram's uncontrollable blockquote - see the
// header comment in js/embeds.js. Falls back to link mode if uploads are
// gated off (UPLOAD_ENABLED), since a slot would otherwise open on a
// control that never renders.
function freshSlotState() {
  const mode = UPLOAD_ENABLED ? 'upload' : 'link';
  return Array.from({ length: MAX_LINKS_PER_PLAYER }, () => ({ mode, url: '', status: 'empty' }));
}

function cancelSlotUpload(slot) {
  if (slot?.uploadTask) {
    try { slot.uploadTask.cancel(); } catch {}
    slot.uploadTask = null;
  }
}

async function hashFile(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function setSlotMode(i, mode) {
  const slot = slotState[i];
  if (slot.mode === mode) return;
  cancelSlotUpload(slot);
  slotState[i] = { mode, url: '', status: 'empty' };
  renderSlots();
  updateSubmitEnabled();
}

function buildLinkInput(i, slot) {
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
  return input;
}

function iconBar(className) {
  const bar = document.createElement('span');
  bar.className = className;
  return bar;
}

function buildFileInput(i) {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'video/*';
  fileInput.id = `upload-input-${i}`;
  fileInput.className = 'upload-input';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handleFileSelected(i, file);
  });
  return fileInput;
}

// Four states matching the Claude Design import's upload box
// (idle/uploading/success/error) - see output.md for the source.
function buildUploadControl(i, slot) {
  const box = document.createElement('div');

  if (slot.status === 'checking') {
    box.className = 'upload-box uploading';
    const row = document.createElement('div');
    row.className = 'upload-progress-row';
    const head = document.createElement('div');
    head.className = 'upload-progress-head';
    const filenameEl = document.createElement('span');
    filenameEl.className = 'upload-progress-filename';
    filenameEl.textContent = slot.fileName || '';
    const pctEl = document.createElement('span');
    pctEl.className = 'upload-progress-pct';
    pctEl.textContent = `${Math.round((slot.progress || 0) * 100)}%`;
    head.append(filenameEl, pctEl);
    const track = document.createElement('div');
    track.className = 'upload-progress-track';
    const fill = document.createElement('div');
    fill.className = 'upload-progress-fill';
    fill.id = `upload-progress-fill-${i}`;
    fill.style.width = `${Math.round((slot.progress || 0) * 100)}%`;
    track.appendChild(fill);
    const caption = document.createElement('div');
    caption.className = 'upload-progress-caption';
    caption.textContent = 'Uploading...';
    row.append(head, track, caption);
    box.appendChild(row);
    return box;
  }

  if (slot.status === 'ok') {
    box.className = 'upload-box success';
    const icon = document.createElement('div');
    icon.className = 'upload-box-icon check';
    icon.append(iconBar('bar1'), iconBar('bar2'));
    const body = document.createElement('div');
    body.className = 'upload-box-body';
    const title = document.createElement('div');
    title.className = 'upload-box-title success';
    title.textContent = slot.fileName || 'Video uploaded';
    const subtitle = document.createElement('div');
    subtitle.className = 'upload-box-subtitle';
    subtitle.textContent = 'Uploaded successfully';
    body.append(title, subtitle);
    const label = document.createElement('label');
    label.setAttribute('for', `upload-input-${i}`);
    label.className = 'upload-replace-link';
    label.textContent = 'Replace';
    box.append(icon, body, label, buildFileInput(i));
    return box;
  }

  if (slot.status === 'bad') {
    box.className = 'upload-box error';
    const icon = document.createElement('div');
    icon.className = 'upload-box-icon error-icon';
    icon.textContent = '!';
    const body = document.createElement('div');
    body.className = 'upload-box-body';
    const title = document.createElement('div');
    title.className = 'upload-box-title error';
    title.textContent = 'Upload failed';
    const subtitle = document.createElement('div');
    subtitle.className = 'upload-box-subtitle';
    subtitle.textContent = slot.error || 'Connection hiccup - try again.';
    body.append(title, subtitle);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'upload-retry-btn';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => {
      slot.status = 'empty';
      slot.error = null;
      slot.fileName = null;
      slot.progress = 0;
      renderSlots();
      updateSubmitEnabled();
    });
    box.append(icon, body, retry);
    return box;
  }

  // Idle - nothing chosen yet.
  box.className = 'upload-box idle';
  const icon = document.createElement('div');
  icon.className = 'upload-box-icon';
  icon.append(iconBar('bar-h'), iconBar('bar-v'));
  const body = document.createElement('div');
  body.className = 'upload-box-body';
  const title = document.createElement('div');
  title.className = 'upload-box-title';
  title.textContent = 'Choose a video file';
  const subtitle = document.createElement('div');
  subtitle.className = 'upload-box-subtitle';
  subtitle.textContent = `MP4 or MOV, up to ${MAX_UPLOAD_SIZE_MB}MB`;
  body.append(title, subtitle);
  const label = document.createElement('label');
  label.setAttribute('for', `upload-input-${i}`);
  label.className = 'upload-browse-btn';
  label.textContent = 'Browse';
  box.append(icon, body, label, buildFileInput(i));
  return box;
}

function renderSlots() {
  const container = document.getElementById('link-slots');
  container.innerHTML = '';
  slotState.forEach((slot, i) => {
    const div = document.createElement('div');
    div.className = 'link-slot' + (slot.status === 'ok' ? ' valid' : slot.status === 'bad' ? ' invalid' : '');

    const label = document.createElement('label');
    label.textContent = `Clip ${i + 1}`;
    div.appendChild(label);

    // Gated off for now - see UPLOAD_ENABLED in config.js. The toggle only
    // renders (and a slot can only ever be in 'upload' mode) once uploads
    // have somewhere to land. Upload leads the pair: it's the default and
    // the recommended route (see freshSlotState), and the tab order should
    // say so before the player has to read anything.
    if (UPLOAD_ENABLED) {
      const toggle = document.createElement('div');
      toggle.className = 'slot-mode-toggle';
      const uploadTab = document.createElement('button');
      uploadTab.type = 'button';
      uploadTab.className = 'slot-mode-tab' + (slot.mode === 'upload' ? ' selected' : '');
      const uploadFlag = document.createElement('span');
      uploadFlag.className = 'slot-mode-flag';
      uploadFlag.textContent = 'Best';
      uploadTab.append(iconBar('icon-upload'), document.createTextNode('Upload'), uploadFlag);
      uploadTab.addEventListener('click', () => setSlotMode(i, 'upload'));
      const linkTab = document.createElement('button');
      linkTab.type = 'button';
      linkTab.className = 'slot-mode-tab' + (slot.mode === 'upload' ? '' : ' selected');
      linkTab.append(iconBar('icon-link'), document.createTextNode('Link'));
      linkTab.addEventListener('click', () => setSlotMode(i, 'link'));
      toggle.append(uploadTab, linkTab);
      div.appendChild(toggle);
    }

    div.appendChild(slot.mode === 'upload' ? buildUploadControl(i, slot) : buildLinkInput(i, slot));

    // Only in link mode, and only when uploading is actually available as
    // the alternative: a standing nudge back toward the preferred route,
    // with the reason attached rather than just an assertion.
    if (slot.mode !== 'upload' && UPLOAD_ENABLED) {
      const hint = document.createElement('p');
      hint.className = 'slot-mode-hint muted';
      hint.textContent = 'Uploaded clips play back best - links depend on the platform’s own player.';
      div.appendChild(hint);
    }

    // The upload box carries its own status treatment (icon/heading/
    // subtitle per state) - the separate status line below is only needed
    // for link mode's real oEmbed validation feedback.
    if (slot.mode !== 'upload') {
      const status = document.createElement('div');
      status.className = 'status';
      status.id = `link-status-${i}`;
      div.appendChild(status);
    }

    container.appendChild(div);
  });
  slotState.forEach((_, i) => renderStatus(i));
}

// Link mode only - upload mode's status lives entirely in the upload box
// itself (see buildUploadControl), so this element doesn't exist for an
// upload-mode slot and the call below is a no-op.
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

async function handleFileSelected(i, file) {
  const slot = slotState[i];
  cancelSlotUpload(slot);

  if (!file.type.startsWith('video/')) {
    slot.status = 'bad';
    slot.error = "That file doesn't look like a video - pick a video from your library.";
    slot.fileName = file.name;
    renderSlots();
    updateSubmitEnabled();
    return;
  }
  if (file.size > MAX_UPLOAD_SIZE_MB * 1024 * 1024) {
    slot.status = 'bad';
    slot.error = `That video is too big (max ${MAX_UPLOAD_SIZE_MB}MB).`;
    slot.fileName = file.name;
    renderSlots();
    updateSubmitEnabled();
    return;
  }

  slot.status = 'checking';
  slot.fileName = file.name;
  slot.progress = 0;
  slot.error = null;
  renderSlots();

  try {
    const hash = await hashFile(file);
    if (slotState[i] !== slot) return; // slot was switched back to link mode mid-hash
    const { task, promise } = uploadClipVideo(currentCode, currentRound, file, hash, progress => {
      if (slotState[i] !== slot) return;
      slot.progress = progress;
      const fill = document.getElementById(`upload-progress-fill-${i}`);
      if (fill) fill.style.width = `${Math.round(progress * 100)}%`;
    });
    slot.uploadTask = task;
    const result = await promise;
    if (slotState[i] !== slot) return;
    slot.uploadTask = null;
    slot.status = 'ok';
    slot.error = null;
    slot.result = result; // { url, platform, canonicalId, thumbnail, title, author, embedHtml } - see cloudinaryUpload.js
    renderSlots();
    updateSubmitEnabled();
  } catch (err) {
    if (slotState[i] !== slot) return;
    slot.uploadTask = null;
    slot.status = 'bad';
    slot.error = err?.message === 'TIMED_OUT' ? 'Upload timed out - try again.' : "That upload didn't work - try again.";
    renderSlots();
    updateSubmitEnabled();
  }
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
  currentCode = ctx.code;
  currentRound = round;

  if (!bound) {
    bound = true;
    slotState = freshSlotState();
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
    slotState.forEach(cancelSlotUpload);
    slotState = freshSlotState();
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
