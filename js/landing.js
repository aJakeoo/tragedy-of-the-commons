import { createRoom, joinRoom, roomExists } from './firebase.js';
import { generateRoomCode, generatePlayerId, GAME_NAME, GAME_TAGLINE } from './config.js';

document.title = GAME_NAME;
document.getElementById('game-title').textContent = GAME_NAME;
document.getElementById('game-tagline').textContent = GAME_TAGLINE;

// Arriving via the lobby's join QR code (?code=XXXX) - pre-fill the room
// code and drop focus straight into the name field so scanning is the only
// typing-free step; the player still has to type their name.
const prefillCode = new URLSearchParams(location.search).get('code');
if (prefillCode) {
  const joinCodeInput = document.getElementById('join-code');
  joinCodeInput.value = prefillCode.toUpperCase();
  joinCodeInput.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('join-name').focus();
}

function showError(elId, message) {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.classList.remove('hidden');
}

function clearError(elId) {
  document.getElementById(elId).classList.add('hidden');
}

function savePlayerSession(code, playerId, playerName) {
  sessionStorage.setItem('totc_roomCode', code);
  sessionStorage.setItem('totc_playerId', playerId);
  sessionStorage.setItem('totc_playerName', playerName);
}

document.getElementById('create-btn').addEventListener('click', async () => {
  clearError('create-error');
  const name = document.getElementById('create-name').value.trim();
  if (!name) return showError('create-error', 'Enter your name first.');

  const btn = document.getElementById('create-btn');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Creating...';
  try {
    let code;
    do {
      code = generateRoomCode();
    } while (await roomExists(code));

    const playerId = generatePlayerId();
    await createRoom(code, { id: playerId, name });
    savePlayerSession(code, playerId, name);
    window.location.href = 'lobby.html';
  } catch (err) {
    showError('create-error', err.message === 'TIMED_OUT'
      ? "That took too long - check your connection and try again."
      : err.message || 'Could not create room.');
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

document.getElementById('join-btn').addEventListener('click', async () => {
  clearError('join-error');
  const name = document.getElementById('join-name').value.trim();
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!name) return showError('join-error', 'Enter your name first.');
  if (!code) return showError('join-error', 'Enter a room code.');

  const btn = document.getElementById('join-btn');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Joining...';
  try {
    const playerId = generatePlayerId();
    await joinRoom(code, { id: playerId, name });
    savePlayerSession(code, playerId, name);
    window.location.href = 'lobby.html';
  } catch (err) {
    showError('join-error', err.message === 'ROOM NOT FOUND' ? 'No room with that code.'
      : err.message === 'GAME ALREADY IN PROGRESS' ? 'That game already started.'
      : err.message === 'TIMED_OUT' ? "That took too long - check your connection and try again."
      : err.message || 'Could not join room.');
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});
