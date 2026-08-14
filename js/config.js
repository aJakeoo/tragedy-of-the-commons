// ── Game identity ────────────────────────────────────────────────────────────
// Working title only. Keep every user-facing string sourced from here so a
// rename ("Tragedy of the Commons") never requires touching game logic.
export const GAME_NAME = 'Tragedy of the Commons';
export const GAME_TAGLINE = 'A party game of terrible taste and shared blame.';

// ── Play modes ───────────────────────────────────────────────────────────────
// Chosen once by the host in the lobby (see lobby.js), before the room's
// first round starts. Fixed for the whole room after that - nothing writes
// config.mode again once the game is underway.
export const PLAY_MODE_FUNNIEST = 'funniest'; // weighted-point ballot on which clip is funniest
export const PLAY_MODE_GUESS = 'guess'; // guess-the-submitter mini-game, no ballot
export const DEFAULT_PLAY_MODE = PLAY_MODE_FUNNIEST;

// ── Playback destination ─────────────────────────────────────────────────────
// The room's second pre-game setting, host-only and lobby-only exactly like
// the play mode above. 'cast' is how this app has always worked: only the
// host's client builds the compiled feed, and everyone watches THAT (a TV,
// a laptop on the table). 'synced' instead builds the same feed on every
// device, with the host's client acting as the conductor - it publishes
// which clip is playing and how far into it, and every other device follows
// (see PLAYBACK_SYNC_* below and js/embeds.js applyPlaybackSync).
export const PLAYBACK_CAST = 'cast';
export const PLAYBACK_SYNCED = 'synced';
export const DEFAULT_PLAYBACK = PLAYBACK_CAST;

// How often the host republishes its playback position in synced mode. Each
// tick is one Firestore write on the room doc (which every client is already
// listening to), so this is a "smooth enough vs chatty" trade: 2.5s keeps a
// follower within a couple of seconds of the host without turning the room
// document into a firehose.
export const PLAYBACK_SYNC_INTERVAL_MS = 2500;

// How far a follower may drift from the host's mark before it seeks. Kept
// deliberately loose - a correction is a visible jump, so chasing tenths of
// a second would be worse to watch than being slightly behind. Uploaded
// clips are a same-origin <video> (cheap, accurate seeks) so they get the
// tighter number; TikTok's Embed Player only reports its position on its own
// schedule and only seeks via postMessage, so it gets more slack.
export const PLAYBACK_SYNC_DRIFT_UPLOAD_SECONDS = 1.2;
export const PLAYBACK_SYNC_DRIFT_TIKTOK_SECONDS = 2.5;
export const PLAYBACK_SYNC_SEEK_COOLDOWN_MS = 3000;

// A follower extrapolates forward from the host's last published mark. Past
// this age the mark is treated as stale (host tab backgrounded, connection
// dropped) and the follower just keeps playing rather than chasing a
// position that stopped being true a while ago.
export const PLAYBACK_SYNC_STALE_SECONDS = 15;

// ── Tunables ─────────────────────────────────────────────────────────────────
export const MAX_LINKS_PER_PLAYER = 3;
export const SUBMISSION_TIMER_SECONDS = 60; // soft nudge only - never locks submission or auto-submits
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
// some networks (see output.md) - this bounds that wait so the UI can always
// recover to a retryable state.
export const FIRESTORE_WRITE_TIMEOUT_MS = 12000;

// Uploaded video clips - the alternative to pasting a TikTok/Instagram
// link, toggled per slot in submission.js. Originally built against
// Firebase Storage (Session 12), but that requires upgrading the Firebase
// project to the Blaze plan before its rules can even deploy. Swapped to
// Cloudinary (Session 13) - unsigned, browser-direct upload with no
// backend and no billing upgrade required. See js/cloudinaryUpload.js.
export const UPLOAD_ENABLED = true;
export const MAX_UPLOAD_SIZE_MB = 100;
export const UPLOAD_TIMEOUT_MS = 180000; // uploads take much longer than a Firestore write

// Cloudinary (video upload host for the "upload a video" submission mode).
// CLOUDINARY_UPLOAD_PRESET must be an UNSIGNED preset (Cloudinary console:
// Settings -> Upload -> Upload presets, Signing Mode = Unsigned) - that's
// what makes a direct browser upload possible with no backend and no API
// secret exposed client-side.
export const CLOUDINARY_CLOUD_NAME = 'frr3iqfm';
export const CLOUDINARY_UPLOAD_PRESET = 'tragedy-uploads';

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
