// Renders TikTok/Instagram embeds as a vertical scroll-snap feed (one clip
// per screen - see presenter.js) and enforces "only one clip plays audibly
// at a time." The active clip is whichever card the feed has snapped to
// (an IntersectionObserver in presenter.js calls activateContainer).
//
// TikTok clips use TikTok's official Embed Player
// (https://www.tiktok.com/player/v1/{id}), not the oEmbed blockquote used
// everywhere else in this app. The Embed Player is a real control surface:
// query params (autoplay=1&muted=1) start it automatically without a tap,
// and a documented postMessage channel (play/pause/mute/unMute) lets the
// host stop one clip and start another without touching the iframe itself.
// Verified directly against developers.tiktok.com/doc/embed-player - the
// message body must include `'x-tiktok-player': true` alongside
// `type`/`value`, and `onPlayerError`'s payload is `{ errorCode, errorType }`
// (3002 = AUTOPLAY_ERROR).
//
// SOUND - the game is sound-on by default wherever the browser physically
// allows it, with automatic muted fallback where it doesn't. The ground
// truth from live testing:
//   - A player loaded muted CANNOT be unmuted from the host page: user
//     activation does not propagate through postMessage, so a relayed
//     `unMute` gets silently reverted ~2ms after taking effect (Session 7,
//     reconfirmed Session 8). No error fires. The old attemptUnmute path
//     was removed for this reason - it never once held.
//   - A player loaded with muted=0 either (a) starts playing with sound -
//     the explicit play+unMute nudge after onPlayerReady is what makes its
//     unmuted state stick - or (b) wedges at "buffering" forever with NO
//     AUTOPLAY_ERROR event, a black card that ignores all commands. Which
//     one you get is the browser's autoplay-policy call (gesture history,
//     media-engagement, platform); it cannot be predicted from JS.
// So every muted=0 load is a GAMBLE, and it's played two ways:
//   1. the feed's first clip loads muted=0 outright (nothing to lose -
//      there's no already-playing player to disturb). A watchdog reloads
//      it muted if it isn't playing within the window.
//   2. an already-playing muted clip that should gain sound (the "Tap for
//      sound" tap, or snapping to a new clip once sound is on) gets a
//      DOUBLE-BUFFERED gamble (soundGamble): a second, invisible muted=0
//      iframe loads BEHIND the playing muted one. Only when the hidden
//      player is confirmed actually playing unmuted does it get promoted
//      (old iframe removed, new one revealed, seeked to where the muted
//      one was). If the gamble wedges, the hidden iframe is discarded and
//      the visible muted playback was never disturbed - the gamble costs
//      nothing. One gamble per clip; a loss (soundGambleFailed) opts that
//      clip out permanently.
//   3. AUTOPLAY_ERROR (3002) on a muted load → fallBackToTapToPlay.
//
// UPLOADED clips have NONE of that problem and are not gambled on. They
// render as a same-origin <video>, so "play this with sound" is a property
// we set and a promise the browser answers honestly - no relayed gesture,
// no silent revert, no wedging. startUploadPlayback below therefore always
// asks for sound first and falls back to muted only if actually refused,
// regardless of whether the user has opted in yet. See its own comment for
// why that ask usually succeeds.
//
// Dead end, do not revisit: preloading background players as
// unmuted-but-paused (muted=0&autoplay=0) so a snap only needs `play`.
// Tested live - a player/v1 iframe loaded with autoplay=0 renders black,
// never fires onPlayerReady, and ignores every postMessage command.
// autoplay=1 is effectively required for the player to initialize.
//
// Instagram has no equivalent. Its oEmbed response is a <blockquote> that
// Instagram's own embed.js turns into an iframe with zero configurability -
// no autoplay, no control channel. Instagram clips keep tap-to-play, and
// the only way to stop one is still tearing its container down and
// rebuilding it from the original blockquote markup. (Same applies to a
// TikTok clip that has fallen back to its own blockquote embed - see
// fallBackToTapToPlay.) Historical note: resetting `iframe.src` on a
// blockquote-built embed breaks it permanently (Session 4) - teardown to
// the original blockquote markup is the only working stop for those. Our
// own player/v1 iframes are plain URLs we control, so replacing them
// outright (reloadPlayer below) is safe.

import {
  PLAYBACK_SYNC_DRIFT_UPLOAD_SECONDS,
  PLAYBACK_SYNC_DRIFT_TIKTOK_SECONDS,
  PLAYBACK_SYNC_SEEK_COOLDOWN_MS,
  PLAYBACK_SYNC_STALE_SECONDS,
} from './config.js';

const TIKTOK_PLAYER_ORIGIN = 'https://www.tiktok.com';

const cardInfo = new Map(); // embedContainer -> per-clip state, see registerEmbedCard
let activeContainer = null;
let focusListenerBound = false;
let tiktokMessageListenerBound = false;

// Sticky for the whole session (not reset per round): once the user has
// opted into sound with a real tap, later rounds' feeds can load their
// first clip unmuted straight away with no new tap.
let soundEnabled = false;

export function isSoundEnabled() {
  return soundEnabled;
}

function markSoundEnabled() {
  if (soundEnabled) return;
  soundEnabled = true;
  // Lets the presenter hide its "tap for sound" button, including when the
  // user unmuted via the player's own speaker icon instead of our button.
  window.dispatchEvent(new CustomEvent('totc-sound-enabled'));
}

// Lets presenter.js sync "whichever clip the feed is snapped to" up to
// Firestore (see setActiveEntry), which is what drives guests' guess-the-
// submitter prompt in js/guessing.js. Fired on every real activeContainer
// change - including the direct assignment in buildTikTokPlayer's `first`
// branch below, which bypasses activateContainer() entirely and would
// otherwise leave every round's first clip un-synced.
function emitActiveClipChanged(container) {
  const info = container ? cardInfo.get(container) : null;
  window.dispatchEvent(new CustomEvent('totc-active-clip-changed', {
    detail: { entryId: info?.entryId ?? null },
  }));
}

// Called from a genuine click handler (the feed's sound button). Starting
// the gamble iframe's load synchronously inside the tap maximizes the
// chance the browser honors autoplay delegation for it (transient
// activation is still live, on top of the sticky activation the tap
// grants the page).
export function enableSound() {
  markSoundEnabled();
  const info = cardInfo.get(activeContainer);
  if (info?.platform === 'tiktok' && info.iframe && info.loadedMuted) {
    info.soundGambleFailed = false; // an explicit tap earns a fresh try
    soundGamble(activeContainer);
  } else if (info?.platform === 'upload') {
    startUploadPlayback(info);
  }
}

function postToPlayer(iframe, type, value) {
  iframe?.contentWindow?.postMessage(
    { type, value, 'x-tiktok-player': true },
    TIKTOK_PLAYER_ORIGIN
  );
}

// autoplay is always 1 - see the "dead end" note in the header comment; a
// player loaded with autoplay=0 never initializes at all.
function playerIframe(canonicalId, muted) {
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.tiktok.com/player/v1/${encodeURIComponent(canonicalId)}?autoplay=1&muted=${muted ? 1 : 0}&rel=0`;
  iframe.allow = 'autoplay; encrypted-media; fullscreen';
  iframe.allowFullscreen = true;
  iframe.style.border = 'none';
  iframe.title = 'TikTok video player';
  return iframe;
}

// Swaps in a brand-new player iframe in place (fresh load = fresh
// autoplay-policy evaluation). Only used for the first clip's direct
// unmuted load and its muted recovery - everything else goes through the
// non-destructive soundGamble below.
function reloadPlayer(container, muted) {
  const info = cardInfo.get(container);
  if (!info?.iframe || !info.canonicalId) return;
  clearTimeout(info.watchdogTimer);
  cancelGamble(container);
  const fresh = playerIframe(info.canonicalId, muted);
  info.iframe.replaceWith(fresh);
  info.iframe = fresh;
  info.ready = false;
  info.loadedMuted = muted;
  info.muteState = undefined;
  info.lastState = undefined;
  info.currentTime = 0;
  if (!muted) armUnmutedWatchdog(container);
}

// An unmuted load is a gamble the browser can lose silently: when its
// autoplay policy blocks sound-on playback it does NOT reliably surface
// AUTOPLAY_ERROR - the player just wedges at "buffering" forever (observed
// live). This watchdog covers the feed's FIRST clip, which loads muted=0
// in place: if it isn't actually PLAYING (state 1) within the window,
// reload it muted - the known-good configuration - and stop gambling on
// this clip.
function armUnmutedWatchdog(container) {
  const info = cardInfo.get(container);
  if (!info) return;
  clearTimeout(info.watchdogTimer);
  info.watchdogTimer = setTimeout(() => {
    if (!cardInfo.has(container)) return;
    if (info.loadedMuted !== false || info.fellBack) return;
    if (info.lastState === 1) return; // playing - the gamble paid off
    info.soundGambleFailed = true;
    reloadPlayer(container, true);
  }, 8000);
}

// The double-buffered sound gamble: load a SECOND, invisible muted=0
// player behind the visible muted one. Promote it only once it's
// confirmed playing unmuted (see the message listener); discard it on
// timeout/error with the visible playback never disturbed. The visible
// muted player keeps running the whole time, so a lost gamble costs the
// viewer nothing.
function soundGamble(container) {
  const info = cardInfo.get(container);
  if (!info || info.platform !== 'tiktok' || !info.iframe) return;
  if (info.fellBack || info.soundGambleFailed || info.pending) return;
  if (info.loadedMuted === false) return; // already an unmuted player
  if (container !== activeContainer) return;

  const pending = playerIframe(info.canonicalId, false);
  pending.style.position = 'absolute';
  pending.style.inset = '0';
  pending.style.width = '100%';
  pending.style.height = '100%';
  pending.style.opacity = '0';
  pending.style.pointerEvents = 'none';
  info.pending = pending;
  info.pendingReady = false;
  info.pendingMute = undefined;
  info.pendingState = undefined;
  container.appendChild(pending);

  clearTimeout(info.gambleTimer);
  info.gambleTimer = setTimeout(() => {
    if (info.pending) {
      cancelGamble(container);
      info.soundGambleFailed = true;
    }
  }, 10000);
}

function cancelGamble(container) {
  const info = cardInfo.get(container);
  if (!info) return;
  clearTimeout(info.gambleTimer);
  info.pending?.remove();
  info.pending = null;
}

// The hidden gamble player is playing unmuted - swap it in: reveal it,
// drop the old muted player, and pick up roughly where the muted playback
// was.
function promotePending(container) {
  const info = cardInfo.get(container);
  if (!info?.pending) return;
  clearTimeout(info.gambleTimer);
  const old = info.iframe;
  const resumeAt = Math.floor(info.currentTime || 0);
  info.iframe = info.pending;
  info.pending = null;
  info.iframe.style.position = '';
  info.iframe.style.inset = '';
  info.iframe.style.opacity = '';
  info.iframe.style.pointerEvents = '';
  old?.remove();
  info.ready = true;
  info.loadedMuted = false;
  info.muteState = false;
  info.lastState = 1;
  info.currentTime = 0;
  if (resumeAt > 1) postToPlayer(info.iframe, 'seekTo', resumeAt);
  markSoundEnabled();
}

// Uploaded clips render as a plain same-origin-controllable <video>, not a
// cross-origin iframe - no postMessage relay, no "does the browser trust
// this gesture" gamble like TikTok's Embed Player. Not autoplayed until
// this card actually becomes the active one (startContainer below); a
// video sitting off-screen in the feed shouldn't be pulling bandwidth.
// Starts (or restarts) an uploaded clip WITH SOUND, falling back to muted
// only if the browser actually refuses. No gamble machinery: a same-origin
// <video> answers `play()` with a promise that rejects when the autoplay
// policy blocks a sound-on start, so the outcome is known rather than
// guessed at - the exact thing TikTok's Embed Player cannot give us.
//
// The ask succeeds more often than the policy might suggest, because
// game.html is ONE document for every phase of the round: by the time the
// compiled feed is built, the host has clicked "Close submissions &
// compile" and most guests have clicked "Submit my clips" in that same
// document. That's sticky user activation - precisely what the autoplay
// policy is looking for. Where it isn't there, the muted fallback plays on
// and the next tap anywhere reclaims sound (see ensureGestureUnmuteListener).
function startUploadPlayback(info) {
  const video = info?.videoEl;
  if (!video) return;
  video.muted = false;
  video.play().then(() => {
    // A resolved play() that left the element paused or re-muted is a
    // refusal in all but name - treat it as one rather than reporting
    // sound the viewer can't hear.
    if (video.paused || video.muted) throw new Error('SOUND_REFUSED');
    markSoundEnabled();
  }).catch(() => {
    video.muted = true;
    video.play().catch(() => {});
  });
}

// When the unmuted start IS refused, the next real interaction anywhere on
// the page is a fresh grant of user activation. Spend it on sound rather
// than making the viewer hunt for the "Tap for sound" button. Scoped hard:
// it only ever touches an uploaded clip that is currently the active one
// and currently muted, so it can't disturb a TikTok player mid-gamble or
// start anything the viewer didn't expect. Capture phase, so a handler that
// stops propagation (the guess options, the skip button) doesn't eat it.
let gestureUnmuteBound = false;
function ensureGestureUnmuteListener() {
  if (gestureUnmuteBound) return;
  gestureUnmuteBound = true;
  const reclaimSound = () => {
    const info = activeContainer ? cardInfo.get(activeContainer) : null;
    if (info?.platform !== 'upload' || !info.videoEl || !info.videoEl.muted) return;
    startUploadPlayback(info);
  };
  document.addEventListener('pointerdown', reclaimSound, true);
  document.addEventListener('keydown', reclaimSound, true);
}

export function buildUploadVideo(container) {
  const info = cardInfo.get(container);
  const video = document.createElement('video');
  video.src = info.url;
  video.className = 'presenter-video';
  video.playsInline = true;
  video.loop = true;
  // Muted at construction only so a card sitting off-screen in the feed is
  // silent no matter what; the active card is unmuted by startUploadPlayback.
  video.muted = true;
  video.preload = 'metadata';
  info.videoEl = video;
  ensureGestureUnmuteListener();
  if (activeContainer === null) {
    activeContainer = container;
    emitActiveClipChanged(container);
    startContainer(container);
  }
  return video;
}

function rebuildContainer(container) {
  const info = cardInfo.get(container);
  if (!info) return;
  container.innerHTML = '';
  if (info.platform === 'tiktok' && info.embedHtml) {
    container.appendChild(buildTikTokBlockquote(info.embedHtml));
  } else {
    container.appendChild(buildInstagramBlockquote(info.url));
  }
}

// Stops whatever is playing in `container`, using whichever mechanism
// matches how it's currently rendered - postMessage for a live TikTok
// Embed Player, tear-down/rebuild for Instagram or a TikTok clip that has
// already fallen back to the blockquote embed. Pause only, no mute: an
// already-unmuted player that resumes later via `play` keeps its sound
// without needing another unmute round-trip.
function stopContainer(container) {
  const info = cardInfo.get(container);
  if (!info) return;

  if (info.platform === 'upload') {
    info.videoEl?.pause();
    return;
  }

  if (info.platform === 'tiktok' && info.iframe) {
    // Scrolled away mid-gamble: discard the hidden attempt (it hasn't
    // proven itself, and it would start making noise for the wrong card).
    cancelGamble(container);
    // If the player isn't ready yet, there's nothing playing to stop - and
    // its own onPlayerReady handler (below) will pause+mute it on arrival
    // once it sees it isn't the active container.
    if (info.ready) postToPlayer(info.iframe, 'pause');
    return;
  }

  if (container.querySelector('iframe')) {
    rebuildContainer(container);
    if (info.platform === 'tiktok') loadTikTokEmbedScript();
    else processInstagramEmbeds();
  }
}

// Starts `container` playing audibly. Only meaningful for TikTok - Instagram
// has no autoplay or control channel, so a guest/host's own tap on the
// blockquote is what starts it, same as always.
function startContainer(container) {
  const info = cardInfo.get(container);
  if (!info) return;

  // Uploaded clips always start with sound, opt-in or not - see
  // startUploadPlayback. `soundEnabled` doesn't gate them: it exists to
  // record that the user has cleared the sound bar for TikTok's relayed
  // players, and an uploaded clip never needed that permission slip.
  if (info.platform === 'upload') {
    startUploadPlayback(info);
    return;
  }

  if (info.platform !== 'tiktok' || !info.iframe) return;
  if (info.ready) {
    postToPlayer(info.iframe, 'play');
    // A player that loaded unmuted already has sound permission - `play`
    // alone resumes it audibly. A muted one gets the non-destructive
    // sound gamble (no-op if this clip already lost one).
    if (soundEnabled && info.loadedMuted) soundGamble(container);
  }
  // If not ready yet, onPlayerReady checks `container === activeContainer`
  // itself - nothing to queue here.
}

// The feed's IntersectionObserver (presenter.js) calls this as cards snap
// into view; the window-blur focus trick below also calls it when the user
// taps directly into a clip's iframe.
export function activateContainer(container) {
  if (container === activeContainer || !cardInfo.has(container)) return;
  activeContainer = container;
  emitActiveClipChanged(container);
  for (const c of cardInfo.keys()) {
    if (c !== container) stopContainer(c);
  }
  startContainer(container);
}

// Snapping to the end card (no embed): silence everything, so the round's
// wrap-up isn't scored by whichever clip was last playing.
export function deactivateFeed() {
  if (activeContainer === null) return;
  activeContainer = null;
  emitActiveClipChanged(null);
  for (const c of cardInfo.keys()) stopContainer(c);
}

// ── Synced playback (config.playback === 'synced') ───────────────────────────
// One client - the host - is the conductor: getPlaybackState() reads where
// its active clip actually is, presenter.js publishes that to Firestore on a
// timer, and every other device feeds the result back in through
// applyPlaybackSync() and nudges its own copy of the same clip into line.
//
// Followers deliberately never compare wall clocks. Two phones' Date.now()
// can disagree by seconds with nobody at fault, which would bake a constant
// error into every correction. Instead a follower stamps each mark with its
// OWN monotonic clock on arrival (performance.now()) and extrapolates from
// there, so the only error left is one-way network latency - a few hundred
// milliseconds, well under the drift thresholds below.
//
// Per-platform reality, unchanged from everything above: an uploaded clip is
// a same-origin <video> we can read and seek precisely. A TikTok clip only
// reports its position when its player feels like emitting onCurrentTime,
// and only seeks by postMessage, so it syncs loosely. An Instagram
// blockquote exposes neither - synced rooms still move everyone onto the
// same Instagram clip at the same time, but where they are inside it is
// each viewer's own business. This is the reason the settings copy points
// at uploads.

let remoteMark = null; // { entryId, position, playing, seq, receivedAt }
let syncTicker = 0;
let lastSeekAt = 0;

// The conductor's answer to "what is playing, and where are we in it".
// position is null for a clip whose player won't tell us (Instagram) - the
// entry id still syncs, the offset just can't.
export function getPlaybackState() {
  const info = activeContainer ? cardInfo.get(activeContainer) : null;
  if (!info) return { entryId: null, position: null, playing: false };
  if (info.platform === 'upload') {
    return {
      entryId: info.entryId ?? null,
      position: info.videoEl?.currentTime ?? 0,
      playing: !!info.videoEl && !info.videoEl.paused,
    };
  }
  if (info.platform === 'tiktok' && !info.fellBack) {
    return {
      entryId: info.entryId ?? null,
      position: info.currentTime || 0,
      playing: info.lastState === 1,
    };
  }
  return { entryId: info.entryId ?? null, position: null, playing: false };
}

// Called by a follower on every room snapshot with whatever the host last
// published (or null when there's nothing to follow).
export function applyPlaybackSync(mark) {
  if (!mark || !mark.entryId) {
    remoteMark = null;
    return;
  }
  // Re-anchor only on a genuinely new mark. The same mark arrives repeatedly
  // - any other field on the room document changing re-fires every client's
  // listener - and re-stamping receivedAt each time would freeze the
  // extrapolation clock at an increasingly old position.
  if (remoteMark && remoteMark.seq === mark.seq && remoteMark.entryId === mark.entryId) return;
  remoteMark = { ...mark, receivedAt: performance.now() };
  if (!syncTicker) syncTicker = setInterval(correctDrift, 1000);
  correctDrift();
}

// Called when the compiled feed goes away (phase change, see
// presenter.leaveCompiling) so a stale mark can't drive seeks into a feed
// nobody is watching any more.
export function stopPlaybackSync() {
  clearInterval(syncTicker);
  syncTicker = 0;
  remoteMark = null;
  lastSeekAt = 0;
}

function correctDrift() {
  if (!remoteMark || remoteMark.position == null) return;
  const age = (performance.now() - remoteMark.receivedAt) / 1000;
  if (age > PLAYBACK_SYNC_STALE_SECONDS) return; // conductor went quiet - stop chasing it
  const info = activeContainer ? cardInfo.get(activeContainer) : null;
  // Not on the host's clip yet: presenter.js is what moves the feed, and it
  // works off the same snapshot, so this just waits for the next tick.
  if (!info || info.entryId !== remoteMark.entryId) return;
  const target = remoteMark.position + age;

  if (info.platform === 'upload') {
    const video = info.videoEl;
    if (!video || video.readyState < 1) return; // no metadata yet - nothing to seek against
    if (video.paused) video.play().catch(() => {});
    // Past the end of the clip means the extrapolation has run over a loop
    // boundary the host has already crossed (or is about to). Seeking to a
    // clamped end would just stutter - the host's next mark, which will read
    // near zero again, re-syncs both sides cleanly. Only checkable when the
    // browser actually reports a duration: a file with no duration in its
    // metadata (some in-browser-recorded WebM, live-ish sources) reports
    // Infinity, and gating the whole correction on a finite duration would
    // silently mean such a clip never syncs at all.
    if (Number.isFinite(video.duration) && target > video.duration) return;
    if (Math.abs(video.currentTime - target) > PLAYBACK_SYNC_DRIFT_UPLOAD_SECONDS) {
      video.currentTime = target;
    }
    return;
  }

  if (info.platform === 'tiktok' && info.ready && info.iframe && !info.fellBack) {
    // A seek costs a reload-ish stutter in the Embed Player, and its own
    // position reports lag, so a correction that fired every tick would
    // re-trigger itself off its own stale reading.
    if (performance.now() - lastSeekAt < PLAYBACK_SYNC_SEEK_COOLDOWN_MS) return;
    if (Math.abs((info.currentTime || 0) - target) <= PLAYBACK_SYNC_DRIFT_TIKTOK_SECONDS) return;
    lastSeekAt = performance.now();
    postToPlayer(info.iframe, 'seekTo', Math.max(0, target));
    info.currentTime = target; // assume it took, until onCurrentTime says otherwise
  }
}

function ensureFocusListener() {
  if (focusListenerBound) return;
  focusListenerBound = true;
  window.addEventListener('blur', () => {
    // The newly focused element isn't set until after blur fires.
    setTimeout(() => {
      const active = document.activeElement;
      if (active?.tagName !== 'IFRAME') return;
      const container = active.closest('.presenter-embed');
      if (container) activateContainer(container);
    }, 0);
  });
}

function ensureTikTokMessageListener() {
  if (tiktokMessageListenerBound) return;
  tiktokMessageListenerBound = true;
  window.addEventListener('message', event => {
    if (event.origin !== TIKTOK_PLAYER_ORIGIN) return;
    const data = event.data;
    if (!data || data['x-tiktok-player'] !== true) return;

    let container = null;
    let info = null;
    let fromPending = false;
    for (const [c, i] of cardInfo) {
      if (i.iframe && i.iframe.contentWindow === event.source) {
        container = c;
        info = i;
        break;
      }
      if (i.pending && i.pending.contentWindow === event.source) {
        container = c;
        info = i;
        fromPending = true;
        break;
      }
    }
    if (!info) return;

    if (fromPending) {
      // Events from a hidden sound-gamble player. It only graduates to
      // visible once confirmed playing unmuted; anything else eventually
      // hits the gamble timeout and gets discarded, with the visible
      // muted playback never disturbed.
      if (data.type === 'onPlayerReady') {
        info.pendingReady = true;
        if (container !== activeContainer) {
          cancelGamble(container); // user scrolled on - moot
        } else {
          postToPlayer(info.pending, 'play');
          postToPlayer(info.pending, 'unMute');
        }
      } else if (data.type === 'onMute') {
        info.pendingMute = data.value;
        if (data.value === false && info.pendingState === 1) promotePending(container);
      } else if (data.type === 'onStateChange') {
        info.pendingState = data.value;
        if (data.value === 1 && info.pendingMute === false) promotePending(container);
      } else if (data.type === 'onPlayerError') {
        if (data.value?.errorCode === 3002) {
          cancelGamble(container);
          info.soundGambleFailed = true;
        }
      }
      return;
    }

    if (data.type === 'onPlayerReady') {
      info.ready = true;
      if (container === activeContainer) {
        if (info.loadedMuted === false) {
          // The first clip's direct unmuted load: nudge it. The explicit
          // play+unMute after ready is what makes the unmuted state stick
          // when it's going to stick at all (verified live); if it doesn't
          // start, the watchdog armed at load time reloads this clip muted.
          postToPlayer(info.iframe, 'play');
          postToPlayer(info.iframe, 'unMute');
        } else if (soundEnabled) {
          soundGamble(container);
        }
      } else {
        // A background clip that autoplayed muted on render but never
        // became the active one - stop it now instead of leaving it
        // running silently for the rest of the round.
        postToPlayer(info.iframe, 'pause');
        postToPlayer(info.iframe, 'mute');
      }
    } else if (data.type === 'onMute') {
      info.muteState = data.value;
      if (data.value === false) {
        // Unmuted WHILE actually playing = sound is really on (the user's
        // speaker-icon tap, or an unmuted load that took). A wedged
        // unmuted load also reports onMute:false without ever playing -
        // that must not count, so gate on lastState. (onStateChange
        // handles the arrival orders where playing starts after this.)
        if (info.lastState === 1) {
          markSoundEnabled();
          cancelGamble(container); // sound achieved without the gamble
        }
      }
    } else if (data.type === 'onStateChange') {
      info.lastState = data.value;
      if (data.value === 1 && info.loadedMuted === false) {
        // The unmuted gamble paid off - it's playing; call off the
        // watchdog.
        clearTimeout(info.watchdogTimer);
      }
      // Actually playing while unmuted - the session's sound opt-in, for
      // whichever of the two events (playing / unmuted) arrived second.
      if (data.value === 1 && info.muteState === false) markSoundEnabled();
    } else if (data.type === 'onCurrentTime') {
      // Tracked so a promoted sound player can pick up where the muted
      // playback was (see promotePending).
      info.currentTime = data.value?.currentTime || 0;
    } else if (data.type === 'onPlayerError') {
      if (data.value?.errorCode === 3002) {
        if (info.loadedMuted === false) {
          // The first clip's direct unmuted load got autoplay-blocked with
          // an actual error for once - recover to muted right away.
          info.soundGambleFailed = true;
          reloadPlayer(container, true);
        } else {
          fallBackToTapToPlay(container);
        }
      }
    }
  });
}

// Browsers can still block autoplay outright even when muted (TikTok's own
// documented AUTOPLAY_ERROR / 3002). Rather than retry or get stuck, drop
// this one clip back to the known-working oEmbed blockquote - a normal
// tap-to-play state, same as Instagram.
function fallBackToTapToPlay(container) {
  const info = cardInfo.get(container);
  if (!info || info.fellBack) return;
  clearTimeout(info.watchdogTimer);
  cancelGamble(container);
  info.fellBack = true;
  info.iframe = null;
  container.innerHTML = '';
  if (info.embedHtml) {
    container.appendChild(buildTikTokBlockquote(info.embedHtml));
    loadTikTokEmbedScript();
  } else {
    const wrap = document.createElement('div');
    const link = document.createElement('a');
    link.href = info.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open on TikTok';
    wrap.appendChild(link);
    container.appendChild(wrap);
  }
}

// Call once per card when the feed is (re)built, so this module knows how
// to rebuild/stop that card's embed later.
export function registerEmbedCard(container, info) {
  ensureFocusListener();
  cardInfo.set(container, {
    entryId: null,
    ready: false,
    fellBack: false,
    iframe: null,
    videoEl: null,
    loadedMuted: true,
    muteState: undefined,
    lastState: undefined,
    currentTime: 0,
    watchdogTimer: 0,
    pending: null,
    pendingReady: false,
    pendingMute: undefined,
    pendingState: undefined,
    gambleTimer: 0,
    soundGambleFailed: false,
    ...info,
  });
}

// Call once per feed render (after clearing it) so stale references from a
// previous round/render don't linger. soundEnabled deliberately survives -
// the user's opt-in covers the whole session.
export function resetKnownEmbeds() {
  for (const info of cardInfo.values()) {
    clearTimeout(info.watchdogTimer);
    clearTimeout(info.gambleTimer);
  }
  cardInfo.clear();
  activeContainer = null;
}

// Builds a TikTok Embed Player iframe for the card already registered at
// `container` (via registerEmbedCard) and wires it into the playback
// tracking above. Every clip autoplays the moment it renders - muted,
// except the feed's first clip once the user has already opted into sound
// (soundEnabled), which loads unmuted directly.
export function buildTikTokPlayer(container) {
  const info = cardInfo.get(container);
  const first = activeContainer === null;
  // The feed's first clip always tries to load unmuted - sound-on by
  // default wherever the browser's autoplay policy allows it (and the
  // watchdog reloads it muted within seconds where it doesn't, so the
  // worst case is a brief black card before muted autoplay). Background
  // clips always load muted (their onPlayerReady pauses them); they go
  // unmuted via the reload path when snapped to.
  const muted = !first;
  const iframe = playerIframe(info.canonicalId, muted);
  info.iframe = iframe;
  info.ready = false;
  info.fellBack = false;
  info.loadedMuted = muted;
  info.lastState = undefined;
  ensureTikTokMessageListener();
  if (first) {
    activeContainer = container;
    emitActiveClipChanged(container);
    armUnmutedWatchdog(container);
  }
  return iframe;
}

let tiktokScriptTag = null;

// Only used now as a fallback path (see fallBackToTapToPlay and the
// Instagram-style teardown in stopContainer) - TikTok's Embed Player iframe
// above needs no loader script of its own.
//
// TikTok's oEmbed response includes ready-made embed HTML (a <blockquote>
// plus a loader script) - see linkValidation.js's `embedHtml` field. Their
// embed.js scans the DOM for ALL `.tiktok-embed` blockquotes present when it
// runs (not just one). It only scans once at load though, with no
// documented "reprocess" call - the standard trick for re-scanning after
// the DOM changes is to swap in a fresh <script> element, which the browser
// re-runs from cache.
export function loadTikTokEmbedScript() {
  if (tiktokScriptTag) tiktokScriptTag.remove();
  tiktokScriptTag = document.createElement('script');
  tiktokScriptTag.async = true;
  tiktokScriptTag.src = 'https://www.tiktok.com/embed.js';
  document.body.appendChild(tiktokScriptTag);
}

export function buildTikTokBlockquote(embedHtml) {
  const wrap = document.createElement('div');
  wrap.innerHTML = embedHtml;
  return wrap.firstElementChild;
}

let instagramScriptPromise = null;

function loadInstagramScript() {
  if (window.instgrm) return Promise.resolve();
  if (!instagramScriptPromise) {
    instagramScriptPromise = new Promise(resolve => {
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://www.instagram.com/embed.js';
      script.onload = resolve;
      document.body.appendChild(script);
    });
  }
  return instagramScriptPromise;
}

export function buildInstagramBlockquote(url) {
  const blockquote = document.createElement('blockquote');
  blockquote.className = 'instagram-media';
  blockquote.setAttribute('data-instgrm-permalink', url);
  blockquote.setAttribute('data-instgrm-version', '14');
  blockquote.style.margin = '0';
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'View on Instagram';
  blockquote.appendChild(link);
  return blockquote;
}

// Instagram's embed.js exposes a documented `Embeds.process()` call that
// rescans the DOM for new `.instagram-media` blockquotes, unlike TikTok's -
// so no script-tag-swapping trick is needed, just call this after inserting
// fresh blockquotes (works for one or many at once).
export async function processInstagramEmbeds() {
  await loadInstagramScript();
  window.instgrm?.Embeds?.process();
}
