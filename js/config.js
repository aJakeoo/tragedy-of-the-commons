// ── Game identity ────────────────────────────────────────────────────────────
// Working title only. Keep every user-facing string sourced from here so a
// rename ("Tragedy of the Commons") never requires touching game logic.
export const GAME_NAME = 'Tragedy of the Comments';
export const GAME_TAGLINE = 'A party game of terrible taste and shared blame.';

// ── Tunables ─────────────────────────────────────────────────────────────────
export const MAX_LINKS_PER_PLAYER = 3;
export const SUBMISSION_TIMER_SECONDS = 60; // soft nudge only — never locks submission or auto-submits
export const VOTE_POINT_BUDGET = 6; // points each player distributes across a round's entries
export const MERGE_VOTE_MULTIPLIER_PER_CONTRIBUTOR = 1; // weighted points = raw ballot points * (contributors * this)

// Score persistence across rounds is not required for this build. Stubbed as
// an easy toggle: flip to true and totals accumulate on players/{id}/totalScore
// in Firebase (see firebase.js applyRoundResultsToScores). Left off by default
// since the spec treats each round as self-contained.
export const PERSIST_SCORES_ACROSS_ROUNDS = false;

// How long to wait on a Firestore write before giving up and surfacing an
// error instead of leaving a button stuck on "Loading..." forever. Firestore
// writes have been observed to intermittently hang with no thrown error on
// some networks (see output.md) — this bounds that wait so the UI can always
// recover to a retryable state.
export const FIRESTORE_WRITE_TIMEOUT_MS = 12000;

export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

export function generateRoomCode() {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

export function generatePlayerId() {
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
