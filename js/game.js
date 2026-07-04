import { subscribeToRoom } from './firebase.js';
import { GAME_NAME } from './config.js';
import * as submission from './submission.js';
import * as presenter from './presenter.js';
import * as voting from './voting.js';
import * as reveal from './reveal.js';

document.title = GAME_NAME;
document.getElementById('game-title').textContent = GAME_NAME;

const code = sessionStorage.getItem('totc_roomCode');
const playerId = sessionStorage.getItem('totc_playerId');
const playerName = sessionStorage.getItem('totc_playerName');

if (!code || !playerId) {
  window.location.href = 'index.html';
}

const PHASES = {
  submitting: 'phase-submitting',
  compiling: 'phase-compiling',
  voting: 'phase-voting',
  reveal: 'phase-reveal',
};

function showPhase(status) {
  for (const [key, elId] of Object.entries(PHASES)) {
    document.getElementById(elId).classList.toggle('hidden', key !== status);
  }
}

subscribeToRoom(code, room => {
  if (!room) {
    document.getElementById('game-error').textContent = 'This room no longer exists.';
    document.getElementById('game-error').classList.remove('hidden');
    return;
  }

  if (room.status === 'lobby') {
    window.location.href = 'lobby.html';
    return;
  }

  // Exposed for handlers that need the latest snapshot outside a render
  // callback (e.g. a button click reading current submissions to merge).
  window.__totcCurrentRoom = room;

  document.getElementById('round-label').textContent = `Round ${room.round}`;

  const ctx = {
    code,
    playerId,
    playerName,
    isHost: room.players?.[playerId]?.isHost === true,
  };

  showPhase(room.status);

  switch (room.status) {
    case 'submitting': submission.render(room, ctx); break;
    case 'compiling': presenter.render(room, ctx); break;
    case 'voting': voting.render(room, ctx); break;
    case 'reveal': reveal.render(room, ctx); break;
  }
});
