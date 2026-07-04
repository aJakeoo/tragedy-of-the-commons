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

function goToGame() {
  if (navigated) return;
  navigated = true;
  if (unsubscribe) unsubscribe();
  // Cancel the lobby's armed disconnect cleanup before leaving — otherwise
  // this navigation's connection drop can race the cancel and delete the
  // player mid-transition. game.js re-arms cleanup once settled there.
  cancelDisconnectCleanup(code, playerId).finally(() => {
    window.location.href = 'game.html';
  });
}

unsubscribe = subscribeToRoom(code, room => {
  if (!room) {
    document.getElementById('lobby-error').textContent = 'This room no longer exists.';
    document.getElementById('lobby-error').classList.remove('hidden');
    return;
  }

  const players = room.players || {};
  const playerIds = Object.keys(players);
  const isHost = players[playerId]?.isHost;

  // Guests rely on this listener to notice the host started the game and
  // navigate along. The host does NOT navigate from here — see the comment
  // in the click handler below for why that caused the actual write to
  // silently never reach the server.
  if (room.status !== 'lobby' && !isHost) {
    goToGame();
    return;
  }

  const list = document.getElementById('player-list');
  list.innerHTML = '';
  for (const id of playerIds) {
    const player = players[id];
    const li = document.createElement('li');

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = (player.name?.[0] || '?').toUpperCase();
    li.appendChild(avatar);

    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = player.name;
    li.appendChild(name);

    if (player.isHost) {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = 'Host';
      li.appendChild(badge);
    }

    list.appendChild(li);
  }

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
      document.getElementById('lobby-error').classList.add('hidden');
      try {
        await startRound(code, 1);
        // Navigate directly off this resolved promise, which only resolves
        // after the write is server-acknowledged. This used to instead wait
        // for this same subscribeToRoom listener to notice the status flip —
        // but Firestore applies writes to the local cache optimistically
        // *before* the network round trip completes, so that listener could
        // fire (and this page navigate away via a full page load) while the
        // write was still in flight. Navigating tears down this page's
        // Firestore client along with the pending outbound request, so the
        // write would silently never actually reach the server — the room
        // stayed on 'lobby' forever with no error, which is exactly the bug
        // reported live. Waiting on the write's own promise guarantees the
        // server has it before we ever leave this page.
        goToGame();
      } catch (err) {
        starting = false;
        startBtn.disabled = false;
        startBtn.textContent = 'Start game';
        const errEl = document.getElementById('lobby-error');
        errEl.textContent = err.message === 'TIMED_OUT'
          ? "That took too long — check your connection and try again."
          : 'Could not start the game — try again.';
        errEl.classList.remove('hidden');
      }
    };
  }
});
