// Shared error surfacing for every screen in the app.
//
// Firestore's error strings are written for developers, and passing them
// through reaches players verbatim: the live site showed a party guest
// "Missing or insufficient permissions." under the Create room button when
// the project's security rules were rejecting every request. That sentence
// tells a player nothing they can act on, and it tells the person running
// the game nothing about where to look either.
//
// So nothing raw from the SDK is ever shown. A known failure gets a plain
// sentence; the developer-facing detail (including what to actually fix)
// goes to the console, where whoever is debugging will look and a player
// never will.

const FRIENDLY = {
  'permission-denied': "Can't reach the game - its database turned the request away.",
  'unavailable': "Can't reach the game right now - check your connection.",
  'deadline-exceeded': "That took too long - check your connection and try again.",
  'resource-exhausted': 'The game has hit its database limits for now - try again later.',
  'unauthenticated': "Can't reach the game - its database turned the request away.",
};

const CONSOLE_HINTS = {
  'permission-denied':
    "Firestore rejected the request. rooms/{code} must allow read and write - the rules in " +
    "this repo (firestore.rules) do, but they only take effect once deployed to the Firebase " +
    "project:\n  firebase deploy --only firestore:rules --project tragedy-of-the-commons-4e239\n" +
    "Note that a database created in test mode starts with rules that EXPIRE, which looks " +
    "exactly like this once the date passes.",
};

// Sentinels this app throws itself (js/firebase.js), as opposed to anything
// the SDK produces - these are already player-readable by design.
const OWN_ERRORS = {
  'TIMED_OUT': "That took too long - check your connection and try again.",
  'ROOM NOT FOUND': 'No room with that code.',
  'GAME ALREADY IN PROGRESS': 'That game already started.',
};

// `fallback` is what to say when the failure isn't one we recognise -
// deliberately a caller-supplied, screen-appropriate sentence rather than
// err.message, which is how the raw SDK text used to get out.
export function describeError(err, fallback = 'Something went wrong - try again.') {
  if (err?.message && OWN_ERRORS[err.message]) return OWN_ERRORS[err.message];

  // FirebaseError carries a stable `code` ('permission-denied', ...). The
  // message check behind it is a belt-and-braces path for anywhere the code
  // doesn't survive.
  const code = err?.code
    || (/insufficient permissions/i.test(err?.message || '') ? 'permission-denied' : null);

  if (code && CONSOLE_HINTS[code]) console.error(`[totc] ${CONSOLE_HINTS[code]}`, err);
  else if (err) console.error('[totc]', err);

  return (code && FRIENDLY[code]) || fallback;
}

// All four game phases share the single #game-error element, so a stuck
// host action always shows up in the same place instead of failing silently.
export function showPhaseError(err) {
  const el = document.getElementById('game-error');
  el.textContent = describeError(err);
  el.classList.remove('hidden');
}
