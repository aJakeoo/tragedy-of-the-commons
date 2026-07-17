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
// Dead end, do not revisit: preloading background players as
// unmuted-but-paused (muted=0&autoplay=0) so a snap only needs `play`.
// Tested live - a player/v1 iframe loaded with autoplay=0 renders black,
// never fires onPlayerReady, and ignores every postMessage command.
// autoplay=1 is effectively required for the player to initialize.
//
// Instagram has no equivalent, and that ceiling is now verified at the
// source, not assumed (Session 10): the embed page registers ZERO usable
// `message` listeners (only a setImmediate-polyfill self-listener), and
// embed.js's own protocol is iframe->parent only (MEASURE/MOUNTED/
// UNMOUNTING height reports). There is no autoplay, no play/pause/mute
// command, nothing. Instagram clips are tap-to-play, full stop.
//
// What DID change in Session 10: Instagram cards now skip the blockquote +
// embed.js dance entirely and render our own iframe pointed straight at
// instagram.com/p/{shortcode}/embed/ - the exact URL embed.js would have
// generated anyway (verified: /p/ serves reels too, identical render).
// That removes the loader script, the process() re-scan, and the SPA
// timing risk, and makes the iframe a plain URL WE control - so stopping
// a clip is replacing our own iframe, same class of operation as TikTok's
// reloadPlayer, not the fragile blockquote teardown. A dead/private reel
// renders Instagram's own "this post may have been removed" card inside
// the iframe, which is exactly the right failure UX and costs us nothing.
// (Historical note kept for the TikTok fallback path below: resetting
// `iframe.src` on an EMBED.JS-BUILT iframe breaks it permanently
// (Session 4) - that teardown-to-blockquote rule still applies to TikTok
// clips that have fallen back to their blockquote embed.)
//
// Because Instagram cannot autoplay, an Instagram card that was never
// tapped is never playing - so scroll-away only tears down cards the user
// actually tapped into (`info.tapped`, set by the window-blur focus trick
// when a tap lands inside a card's iframe). Untapped cards keep their
// loaded poster untouched, which kills the old rebuild-every-card-on-
// every-snap reload storm.

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

function rebuildContainer(container) {
  const info = cardInfo.get(container);
  if (!info) return;
  if (info.platform === 'tiktok' && info.embedHtml) {
    container.innerHTML = '';
    container.appendChild(buildTikTokBlockquote(info.embedHtml));
  } else if (info.platform === 'instagram') {
    container.innerHTML = '';
    container.appendChild(buildInstagramPlayer(container));
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

  // Tap-to-play embeds (Instagram, and TikTok clips fallen back to their
  // blockquote) cannot autoplay, so a card the user never tapped into is
  // guaranteed silent - leave its loaded poster alone. Only a tapped card
  // might be playing, and teardown/rebuild is the only stop that exists
  // for it.
  if (info.tapped && container.querySelector('iframe')) {
    rebuildContainer(container);
    info.tapped = false;
    if (info.platform === 'tiktok') loadTikTokEmbedScript();
  }
}

// Starts `container` playing audibly. Only meaningful for TikTok - Instagram
// has no autoplay or control channel, so a guest/host's own tap on the
// blockquote is what starts it, same as always.
function startContainer(container) {
  const info = cardInfo.get(container);
  if (!info || info.platform !== 'tiktok' || !info.iframe) return;
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
// into view; the window-blur focus trick below also calls it (with
// viaTap) when the user taps directly into a clip's iframe. viaTap is
// what marks a tap-to-play embed as possibly-playing (`info.tapped`), so
// it must be recorded even when the tapped card is already the active one
// - that's the normal case: snap to a card, then tap its play button.
export function activateContainer(container, viaTap = false) {
  const info = cardInfo.get(container);
  if (!info) return;
  if (viaTap) info.tapped = true;
  if (container === activeContainer) return;
  activeContainer = container;
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
  for (const c of cardInfo.keys()) stopContainer(c);
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
      if (container) activateContainer(container, true);
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
    ready: false,
    fellBack: false,
    tapped: false,
    iframe: null,
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
    armUnmutedWatchdog(container);
  }
  return iframe;
}

let tiktokScriptTag = null;

// Only used now as a fallback path (see fallBackToTapToPlay, and the
// tapped-card teardown in stopContainer re-rendering such a fallen-back
// clip) - TikTok's Embed Player iframe above needs no loader script of
// its own.
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

// Builds an Instagram embed iframe for the card already registered at
// `container` (via registerEmbedCard). /p/{shortcode}/embed/ is the same
// URL Instagram's embed.js generates from a blockquote, minus the loader
// script and its SPA re-scan dance - and it serves reels and video posts
// alike (verified live, Session 10). Tap-to-play is the ceiling: the
// embed page has no autoplay and accepts no commands, so all this iframe
// needs is to exist. A dead or private link renders Instagram's own
// "post may have been removed" card inside the frame. If the entry
// somehow has no shortcode, fall back to a plain outbound link.
export function buildInstagramPlayer(container) {
  const info = cardInfo.get(container);
  if (!info?.canonicalId) {
    const wrap = document.createElement('div');
    const link = document.createElement('a');
    link.href = info?.url || 'https://www.instagram.com/';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = info?.platform === 'tiktok' ? 'Open on TikTok' : 'Open on Instagram';
    wrap.appendChild(link);
    return wrap;
  }
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.instagram.com/p/${encodeURIComponent(info.canonicalId)}/embed/`;
  iframe.allow = 'encrypted-media; fullscreen';
  iframe.allowFullscreen = true;
  iframe.style.border = 'none';
  iframe.title = 'Instagram video player';
  return iframe;
}
