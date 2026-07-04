import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  collection,
  writeBatch,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

import {
  MAX_LINKS_PER_PLAYER,
  SUBMISSION_TIMER_SECONDS,
  VOTE_POINT_BUDGET,
  MERGE_VOTE_MULTIPLIER_PER_CONTRIBUTOR,
  PERSIST_SCORES_ACROSS_ROUNDS,
} from './config.js';

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
// rooms/{code} and everything nested under it, or every call below rejects
// with "Missing or insufficient permissions."

const app = initializeApp(FIREBASE_CONFIG);
const db = getFirestore(app);

const roomRef = code => doc(db, 'rooms', code);
const playersCol = code => collection(db, 'rooms', code, 'players');
const playerRef = (code, playerId) => doc(db, 'rooms', code, 'players', playerId);
const roundRef = (code, round) => doc(db, 'rooms', code, 'rounds', String(round));
const playerSubmissionsCol = (code, round) => collection(db, 'rooms', code, 'rounds', String(round), 'playerSubmissions');
const playerSubmissionRef = (code, round, playerId) => doc(db, 'rooms', code, 'rounds', String(round), 'playerSubmissions', playerId);
const submissionsCol = (code, round) => collection(db, 'rooms', code, 'rounds', String(round), 'submissions');
const submissionRef = (code, round, entryId) => doc(db, 'rooms', code, 'rounds', String(round), 'submissions', entryId);
const ballotsCol = (code, round) => collection(db, 'rooms', code, 'rounds', String(round), 'ballots');
const ballotRef = (code, round, playerId) => doc(db, 'rooms', code, 'rounds', String(round), 'ballots', playerId);

// ── Room / lobby ─────────────────────────────────────────────────────────────

export async function roomExists(code) {
  const snap = await getDoc(roomRef(code));
  return snap.exists();
}

export async function createRoom(code, hostPlayer) {
  await setDoc(roomRef(code), {
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
  });
  await setDoc(playerRef(code, hostPlayer.id), {
    name: hostPlayer.name,
    isHost: true,
    joinedAt: serverTimestamp(),
    ...(PERSIST_SCORES_ACROSS_ROUNDS ? { totalScore: 0 } : {}),
  });
}

export async function joinRoom(code, player) {
  const snap = await getDoc(roomRef(code));
  if (!snap.exists()) throw new Error('ROOM NOT FOUND');
  if (snap.data().status !== 'lobby') throw new Error('GAME ALREADY IN PROGRESS');

  await setDoc(playerRef(code, player.id), {
    name: player.name,
    isHost: false,
    joinedAt: serverTimestamp(),
    ...(PERSIST_SCORES_ACROSS_ROUNDS ? { totalScore: 0 } : {}),
  });
}

// Firestore has no server-side "on disconnect" primitive like Realtime
// Database does — presence would require a heartbeat + stale-player pruning
// scheme, which is more machinery than this build calls for. A player who
// closes their tab just stays listed; harmless for a short, host-supervised
// party game. Kept as named no-ops so lobby.js doesn't need two code paths.
export function armDisconnectCleanup() {}
export async function cancelDisconnectCleanup() {}

export async function removePlayer(code, playerId) {
  await deleteDoc(playerRef(code, playerId));
}

// Fires cb with a merged room object (or null if the room doesn't exist) on
// every change to the room doc, its players, or the current round's nested
// data (round doc, playerSubmissions, submissions, ballots). Firestore has
// no single-path "give me this whole subtree" listener the way Realtime
// Database does, so this fans out to several onSnapshot listeners and
// assembles their results into the same shape the rest of the app expects:
// { ...roomFields, players: {id: {...}}, rounds: { [round]: { ...roundFields,
// playerSubmissions: {...}, submissions: {...}, ballots: {...} } } }
export function subscribeToRoom(code, cb) {
  const state = { players: {}, rounds: {} };
  let roomExistsFlag = true;
  let currentRound = null;
  let roundUnsubs = [];

  function emit() {
    cb(roomExistsFlag ? { ...state } : null);
  }

  function teardownRoundListeners() {
    roundUnsubs.forEach(u => u());
    roundUnsubs = [];
  }

  function setupRoundListeners(round) {
    teardownRoundListeners();
    currentRound = round;
    if (round === null || round === undefined) return;
    state.rounds[round] = state.rounds[round] || {};

    roundUnsubs.push(onSnapshot(roundRef(code, round), snap => {
      state.rounds[round] = { ...state.rounds[round], ...(snap.exists() ? snap.data() : {}) };
      emit();
    }));
    roundUnsubs.push(onSnapshot(playerSubmissionsCol(code, round), snap => {
      const obj = {};
      snap.forEach(d => { obj[d.id] = d.data(); });
      state.rounds[round] = { ...state.rounds[round], playerSubmissions: obj };
      emit();
    }));
    roundUnsubs.push(onSnapshot(submissionsCol(code, round), snap => {
      const obj = {};
      snap.forEach(d => { obj[d.id] = d.data(); });
      state.rounds[round] = { ...state.rounds[round], submissions: obj };
      emit();
    }));
    roundUnsubs.push(onSnapshot(ballotsCol(code, round), snap => {
      const obj = {};
      snap.forEach(d => { obj[d.id] = d.data(); });
      state.rounds[round] = { ...state.rounds[round], ballots: obj };
      emit();
    }));
  }

  const unsubRoom = onSnapshot(roomRef(code), snap => {
    if (!snap.exists()) {
      roomExistsFlag = false;
      emit();
      return;
    }
    roomExistsFlag = true;
    Object.assign(state, snap.data());
    if (state.round !== currentRound) setupRoundListeners(state.round);
    emit();
  });

  const unsubPlayers = onSnapshot(playersCol(code), snap => {
    const obj = {};
    snap.forEach(d => { obj[d.id] = d.data(); });
    state.players = obj;
    emit();
  });

  return () => {
    unsubRoom();
    unsubPlayers();
    teardownRoundListeners();
  };
}

// ── Round lifecycle ──────────────────────────────────────────────────────────

export async function startRound(code, round) {
  const batch = writeBatch(db);
  batch.set(roomRef(code), { status: 'submitting', round }, { merge: true });
  batch.set(roundRef(code, round), {
    startedAt: serverTimestamp(),
    presentIndex: 0,
    revealAttribution: false,
  });
  await batch.commit();
}

export async function submitPlayerLinks(code, round, playerId, playerName, links) {
  await setDoc(playerSubmissionRef(code, round, playerId), {
    name: playerName,
    links,
    submittedAt: serverTimestamp(),
  });
}

export async function closeSubmissionsAndCompile(code, round, mergedEntries) {
  const batch = writeBatch(db);
  for (const [entryId, entry] of Object.entries(mergedEntries)) {
    batch.set(submissionRef(code, round, entryId), entry);
  }
  batch.update(roomRef(code), { status: 'compiling' });
  batch.update(roundRef(code, round), { presentIndex: 0 });
  await batch.commit();
}

export async function setPresentIndex(code, round, index) {
  await updateDoc(roundRef(code, round), { presentIndex: index });
}

export async function setRevealAttribution(code, round, revealed) {
  await updateDoc(roundRef(code, round), { revealAttribution: revealed });
}

export async function startVoting(code) {
  await updateDoc(roomRef(code), { status: 'voting' });
}

export async function submitBallot(code, round, playerId, ballot) {
  await setDoc(ballotRef(code, round, playerId), ballot);
}

export async function revealResults(code) {
  await updateDoc(roomRef(code), { status: 'reveal' });
}

// Applies a round's weighted results to each contributing player's running
// total. Only ever called when config.persistScores is true (see
// PERSIST_SCORES_ACROSS_ROUNDS in config.js) — stubbed for a future toggle,
// not required by the current build.
export async function applyRoundResultsToScores(code, results, players) {
  const batch = writeBatch(db);
  for (const result of results) {
    const share = Math.round(result.weightedPoints / result.contributors.length);
    for (const contributor of result.contributors) {
      const current = players[contributor.id]?.totalScore || 0;
      batch.update(playerRef(code, contributor.id), { totalScore: current + share });
    }
  }
  await batch.commit();
}

export async function startNewRound(code, previousRound) {
  await startRound(code, previousRound + 1);
}
