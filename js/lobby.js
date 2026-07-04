import { subscribeToRoom, armDisconnectCleanup, cancelDisconnectCleanup, startRound } from './firebase.js';
import { GAME_NAME } from './config.js';

document.title = `Lobby — ${GAME_NAME}`;
document.getElementById('game-title').textContent = `Lobby — ${GAME_NAME}`;

const code = sessionStorage.getItem('totc_roomCode');
const playerId = sessionStorage.getItem('totc_playerId');
const playerName = sessionStorage.getItem('totc_playerName');

if (!code || !playerId) {
  window.location.href = 'index.html';
}

document.getElementById('room-code').textContent = code;

armDisconnectCleanup(code, playerId);

let unsubscribe = null;
let navigated = false;
let starting = false;

unsubscribe = subscribeToRoom(code, room => {
  if (!room) {
    document.getElementById('lobby-error').textContent = 'This room no longer exists.';
    document.getElementById('lobby-error').classList.remove('hidden');
    return;
  }

  if (room.status !== 'lobby' && !navigated) {
    navigated = true;
    if (unsubscribe) unsubscribe();
    // Cancel the lobby's armed disconnect cleanup before leaving — otherwise
    // this navigation's connection drop can race the cancel and delete the
    // player mid-transition. game.js re-arms cleanup once settled there.
    cancelDisconnectCleanup(code, playerId).finally(() => {
      window.location.href = 'game.html';
    });
    return;
  }

  const players = room.players || {};
  const playerIds = Object.keys(players);
  const list = document.getElementById('player-list');
  list.innerHTML = '';
  for (const id of playerIds) {
    const li = document.createElement('li');
    li.textContent = players[id].name;
    if (players[id].isHost) li.classList.add('host');
    list.appendChild(li);
  }

  const isHost = players[playerId]?.isHost;
  document.getElementById('host-controls').classList.toggle('hidden', !isHost);
  document.getElementById('guest-controls').classList.toggle('hidden', isHost);

  if (isHost) {
    const startBtn = document.getElementById('start-btn');
    if (!starting) {
      startBtn.disabled = playerIds.length < 1;
      startBtn.textContent = 'Start game';
      document.getElementById('start-hint').textContent =
        playerIds.length < 2 ? 'You can start solo to test, but this plays best with 2+ people.' : '';
    }

    startBtn.onclick = async () => {
      starting = true;
      startBtn.disabled = true;
      startBtn.textContent = 'Starting...';
      await startRound(code, 1);
      // Navigation + disconnect-cleanup cancellation happens in the
      // subscribeToRoom callback above once `status` flips, same as guests.
    };
  }
});
