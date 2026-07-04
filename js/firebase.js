import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  deleteField,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

import {
  MAX_LINKS_PER_PLAYER,
  SUBMISSION_TIMER_SECONDS,
  VOTE_POINT_BUDGET,
  MERGE_VOTE_MULTIPLIER_PER_CONTRIBUTOR,
  PERSIST_SCORES_ACROSS_ROUNDS,
  FIRESTORE_WRITE_TIMEOUT_MS,
} from './config.js';

// Firestore calls have been observed to intermittently hang with no thrown
// error on some networks (see output.md for the investigation) — every
// read/write below is wrapped in this so a stuck call surfaces a catchable
// TIMED_OUT error instead of leaving callers (and their UI) waiting forever.
function withTimeout(promise, ms = FIRESTORE_WRITE_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMED_OUT')), ms)),
  ]);
}

// ── Firebase config (Firestore) ──────────────────────────────────────────────
// Pulled from the "tragedy-of-the-commons" Firebase project. Loaded here via
// the gstatic CDN modular build (not an npm import) to keep this a
// zero-build static site, matching this project's stack — same values, just
// a different loading mechanism than the Firebase console's copy-paste
// snippet assumes.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBP1_nwrSmehoWb-27AFEStm_wLuBjJyVI',
  authDomain: 'tragedy-of-the-commons-4e239.firebaseapp.com',
  projectId: 'tragedy-of-the-commons-4e239',
  storageBucket: 'tragedy-of-the-commons-4e239.firebasestorage.app',
  messagingSenderId: '404036796231',
  appId: '1:404036796231:web:d23552688e478e591d5662',
};

// Firestore security rules (see firestore.rules) must allow read/write on
// rooms/{code}, or every call below rejects with
// "Missing or insufficient permissions."

const app = initializeApp(FIREBASE_CONFIG);
const db = getFirestore(app);

const roomRef = code => doc(db, 'rooms', code);

// Everything for a room — players, every round's submissions and ballots —
// lives as nested map fields on ONE Firestore document (rooms/{code}),
// instead of a fan of subcollections. This used to be split across up to
// six separate documents/collections (room, players, round, playerSubmissions,
// submissions, ballots), which meant subscribeToRoom() had to open up to six
// concurrent onSnapshot listeners per client. In testing that fan-out proved
// unreliable — writeBatch() commits touching multiple of those documents
// would intermittently hang for 10+ seconds or never resolve at all (no
// thrown error either), most likely because so many simultaneous
// long-polling Listen/Write channels from one client strains the connection,
// especially on mobile networks. A party game's whole room state (a handful
// of players, a handful of rounds, a few links each) is nowhere near
// Firestore's 1MB per-document limit, so collapsing it into one document
// (one listener, one write target) trades subcollection purity for a much
// more reliable client. Nested map fields are still updated surgically via
// dot-notation paths (e.g. `players.${playerId}`), so concurrent writes from
// different players to different keys don't clobber each other.

export async function roomExists(code) {
  const snap = await withTimeout(getDoc(roomRef(code)));
  return snap.exists();
}

export async function createRoom(code, hostPlayer) {
  await withTimeout(setDoc(roomRef(code), {
    host: hostPlayer.id,
    status: 'lobby',
    round: 0,
    createdAt: serverTimestamp(),
    config: {
      maxLinksPerPlayer: MAX_LINKS_PER_PLAYER,
      submissionTimerSeconds: SUBMISSION_TIMER_SECONDS,
      votePointBudget: VOTE_POINT_BUDGET,
      mergeMultiplierPerContributor: MERGE_VOTE_MULTIPLIER_PER_CONTRIBUTOR,
      persistScores: PERSIST_SCORES_ACROSS_ROUNDS,
    },
    players: {
      [hostPlayer.id]: {
        name: hostPlayer.name,
        isHost: true,
        joinedAt: serverTimestamp(),
        ...(PERSIST_SCORES_ACROSS_ROUNDS ? { totalScore: 0 } : {}),
      },
    },
    rounds: {},
  }));
}

export async function joinRoom(code, player) {
  const snap = await withTimeout(getDoc(roomRef(code)));
  if (!snap.exists()) throw new Error('ROOM NOT FOUND');
  if (snap.data().status !== 'lobby') throw new Error('GAME ALREADY IN PROGRESS');

  await withTimeout(updateDoc(roomRef(code), {
    [`players.${player.id}`]: {
      name: player.name,
      isHost: false,
      joinedAt: serverTimestamp(),
      ...(PERSIST_SCORES_ACROSS_ROUNDS ? { totalScore: 0 } : {}),
    },
  }));
}

// Firestore has no server-side "on disconnect" primitive like Realtime
// Database does — presence would require a heartbeat + stale-player pruning
// scheme, which is more machinery than this build calls for. A player who
// closes their tab just stays listed; harmless for a short, host-supervised
// party game. Kept as named no-ops so lobby.js doesn't need two code paths.
export function armDisconnectCleanup() {}
export async function cancelDisconnectCleanup() {}

export async function removePlayer(code, playerId) {
  await withTimeout(updateDoc(roomRef(code), { [`players.${playerId}`]: deleteField() }));
}

// Fires cb with the room document's data (or null if it doesn't exist) on
// every change. A single listener for the whole room — see the note above
// on why this replaced a multi-listener fan-out.
export function subscribeToRoom(code, cb) {
  return onSnapshot(roomRef(code), snap => cb(snap.exists() ? snap.data() : null));
}

// ── Round lifecycle ──────────────────────────────────────────────────────────

export async function startRound(code, round) {
  await withTimeout(updateDoc(roomRef(code), {
    status: 'submitting',
    round,
    [`rounds.${round}`]: {
      startedAt: serverTimestamp(),
      // Who submitted each clip is visible to everyone by default — the
      // host can still hide it via the presenter view's toggle if they want
      // more anonymity, but that's now an opt-in, not the starting state.
      revealAttribution: true,
      playerSubmissions: {},
      submissions: {},
      ballots: {},
    },
  }));
}

export async function submitPlayerLinks(code, round, playerId, playerName, links) {
  await withTimeout(updateDoc(roomRef(code), {
    [`rounds.${round}.playerSubmissions.${playerId}`]: {
      name: playerName,
      links,
      submittedAt: serverTimestamp(),
    },
  }));
}

export async function closeSubmissionsAndCompile(code, round, mergedEntries) {
  await withTimeout(updateDoc(roomRef(code), {
    status: 'compiling',
    [`rounds.${round}.submissions`]: mergedEntries,
  }));
}

export async function setRevealAttribution(code, round, revealed) {
  await withTimeout(updateDoc(roomRef(code), { [`rounds.${round}.revealAttribution`]: revealed }));
}

export async function startVoting(code) {
  await withTimeout(updateDoc(roomRef(code), { status: 'voting' }));
}

export async function submitBallot(code, round, playerId, ballot) {
  await withTimeout(updateDoc(roomRef(code), { [`rounds.${round}.ballots.${playerId}`]: ballot }));
}

export async function revealResults(code) {
  await withTimeout(updateDoc(roomRef(code), { status: 'reveal' }));
}

// Applies a round's weighted results to each contributing player's running
// total. Only ever called when config.persistScores is true (see
// PERSIST_SCORES_ACROSS_ROUNDS in config.js) — stubbed for a future toggle,
// not required by the current build.
export async function applyRoundResultsToScores(code, results, players) {
  const updates = {};
  for (const result of results) {
    const share = Math.round(result.weightedPoints / result.contributors.length);
    for (const contributor of result.contributors) {
      const current = players[contributor.id]?.totalScore || 0;
      updates[`players.${contributor.id}.totalScore`] = current + share;
    }
  }
  await withTimeout(updateDoc(roomRef(code), updates));
}

export async function startNewRound(code, previousRound) {
  await startRound(code, previousRound + 1);
}
