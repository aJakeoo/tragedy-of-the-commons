// Renders TikTok/Instagram embeds as a vertical scroll-snap feed (one clip
// per screen — see presenter.js) and enforces "only one clip plays audibly
// at a time." The active clip is whichever card the feed has snapped to
// (an IntersectionObserver in presenter.js calls activateContainer).
//
// TikTok clips use TikTok's official Embed Player
// (https://www.tiktok.com/player/v1/{id}), not the oEmbed blockquote used
// everywhere else in this app. The Embed Player is a real control surface:
// query params (autoplay=1&muted=1) start it automatically without a tap,
// and a documented postMessage channel (play/pause/mute/unMute) lets the
// host stop one clip and start another without touching the iframe itself.
// Verified directly against developers.tiktok.com/doc/embed-player — the
// message body must include `'x-tiktok-player': true` alongside
// `type`/`value`, and `onPlayerError`'s payload is `{ errorCode, errorType }`
// (3002 = AUTOPLAY_ERROR).
//
// SOUND — the game is sound-on by default wherever the browser physically
// allows it, with automatic muted fallback where it doesn't. The ground
// truth from live testing:
//   - A player loaded muted CANNOT be unmuted from the host page: user
//     activation does not propagate through postMessage, so a relayed
//     `unMute` gets silently reverted ~2ms after taking effect (Session 7,
//     reconfirmed Session 8). No error fires.
//   - A player loaded with muted=0 either (a) starts playing with sound —
//     the explicit play+unMute nudge after onPlayerReady is what makes its
//     unmuted state stick — or (b) wedges at "buffering" forever with NO
//     AUTOPLAY_ERROR event, a black card that ignores all commands. Which
//     one you get is the browser's autoplay-policy call (gesture history,
//     media-engagement, platform); it cannot be predicted from JS.
// So every muted=0 load is treated as a gamble with a watchdog
// (armUnmutedWatchdog): if it isn't PLAYING within the window, reload it
// muted — muted=1&autoplay=1 is the known-good configuration that always
// plays. The per-clip flow:
//   1. the feed's first clip loads muted=0 (sound-on by default when
//      allowed; watchdog cleans up when not);
//   2. a muted active clip gets the cheap postMessage `unMute` try; the
//      revert signature (onMute:false then instant onMute:true) or a
//      1.2s timer triggers ONE unmuted reload (muted=0&autoplay=1, again
//      watchdog-guarded);
//   3. AUTOPLAY_ERROR (3002) on an unmuted load → reload muted;
//      on a muted load → fallBackToTapToPlay. No retry loops anywhere:
//      each clip gets at most one unmuted gamble per activation, and a
//      failed gamble (soundReloadFailed) permanently opts that clip out.
//
// Dead end, do not revisit: preloading background players as
// unmuted-but-paused (muted=0&autoplay=0) so a snap only needs `play`.
// Tested live — a player/v1 iframe loaded with autoplay=0 renders black,
// never fires onPlayerReady, and ignores every postMessage command.
// autoplay=1 is effectively required for the player to initialize.
//
// Instagram has no equivalent. Its oEmbed response is a <blockquote> that
// Instagram's own embed.js turns into an iframe with zero configurability —
// no autoplay, no control channel. Instagram clips keep tap-to-play, and
// the only way to stop one is still tearing its container down and
// rebuilding it from the original blockquote markup. (Same applies to a
// TikTok clip that has fallen back to its own blockquote embed — see
// fallBackToTapToPlay.) Historical note: resetting `iframe.src` on a
// blockquote-built embed breaks it permanently (Session 4) — teardown to
// the original blockquote markup is the only working stop for those. Our
// own player/v1 iframes are plain URLs we control, so replacing them
// outright (reloadPlayer below) is safe.

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

// Called from a genuine click handler (the feed's sound button) — the tap
// gives the page sticky user activation, which is what makes an unmuted
// player reload allowed to autoplay with sound.
export function enableSound() {
  markSoundEnabled();
  const info = cardInfo.get(activeContainer);
  if (info?.platform === 'tiktok' && info.iframe) {
    info.reloadedForSound = false;
    attemptUnmute(activeContainer);
  }
}

function postToPlayer(iframe, type, value) {
  iframe?.contentWindow?.postMessage(
    { type, value, 'x-tiktok-player': true },
    TIKTOK_PLAYER_ORIGIN
  );
}

// autoplay is always 1 — see the "dead end" note in the header comment; a
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

// Swaps in a brand-new player iframe (fresh load = fresh autoplay-policy
// evaluation, which is the whole point when muted=false).
function reloadPlayer(container, muted) {
  const info = cardInfo.get(container);
  if (!info?.iframe || !info.canonicalId) return;
  clearTimeout(info.unmuteTimer);
  clearTimeout(info.watchdogTimer);
  info.unmutePending = false;
  info.sawUnmuteEffect = false;
  const fresh = playerIframe(info.canonicalId, muted);
  info.iframe.replaceWith(fresh);
  info.iframe = fresh;
  info.ready = false;
  info.loadedMuted = muted;
  info.muteState = undefined;
  info.lastState = undefined;
  if (!muted) armUnmutedWatchdog(container);
}

// An unmuted load is a gamble the browser can lose silently: when its
// autoplay policy blocks sound-on playback it does NOT reliably surface
// AUTOPLAY_ERROR — the player just wedges at "buffering" forever (observed
// live). So every muted=0 iframe gets a watchdog: if it isn't actually
// PLAYING (state 1) within the window, reload it muted — muted autoplay is
// the known-good configuration — and stop gambling on this clip.
function armUnmutedWatchdog(container) {
  const info = cardInfo.get(container);
  if (!info) return;
  clearTimeout(info.watchdogTimer);
  info.watchdogTimer = setTimeout(() => {
    if (!cardInfo.has(container)) return;
    if (info.loadedMuted !== false || info.fellBack) return;
    if (info.lastState === 1) return; // playing — the gamble paid off
    info.soundReloadFailed = true;
    reloadPlayer(container, true);
  }, 8000);
}

// Cheap unmute first, unmuted reload as the fallback. The player reports
// its real mute state via onMute events, and the failure signature —
// onMute:false then an instant onMute:true revert — is detected in the
// message listener, which calls soundReloadIfAllowed immediately. This
// timer is only the backstop for "no onMute events arrived at all."
function attemptUnmute(container) {
  const info = cardInfo.get(container);
  if (!info?.iframe || !info.ready || info.unmutePending) return;
  info.unmutePending = true;
  info.sawUnmuteEffect = false;
  postToPlayer(info.iframe, 'unMute');
  clearTimeout(info.unmuteTimer);
  info.unmuteTimer = setTimeout(() => {
    info.unmutePending = false;
    if (info.muteState === false) return; // unmute held — done
    soundReloadIfAllowed(container);
  }, 1200);
}

// Reload this clip's player unmuted (the path that actually produces sound
// in Chrome) — once per activation, never after an unmuted load already
// failed autoplay, and only while it's the active clip with sound on.
function soundReloadIfAllowed(container) {
  const info = cardInfo.get(container);
  if (!info || container !== activeContainer || !soundEnabled) return;
  if (info.reloadedForSound || info.soundReloadFailed) return;
  info.reloadedForSound = true;
  reloadPlayer(container, false);
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
// matches how it's currently rendered — postMessage for a live TikTok
// Embed Player, tear-down/rebuild for Instagram or a TikTok clip that has
// already fallen back to the blockquote embed. Pause only, no mute: an
// already-unmuted player that resumes later via `play` keeps its sound
// without needing another unmute round-trip.
function stopContainer(container) {
  const info = cardInfo.get(container);
  if (!info) return;

  if (info.platform === 'tiktok' && info.iframe) {
    // If the player isn't ready yet, there's nothing playing to stop — and
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

// Starts `container` playing audibly. Only meaningful for TikTok — Instagram
// has no autoplay or control channel, so a guest/host's own tap on the
// blockquote is what starts it, same as always.
function startContainer(container) {
  const info = cardInfo.get(container);
  if (!info || info.platform !== 'tiktok' || !info.iframe) return;
  if (info.ready) {
    postToPlayer(info.iframe, 'play');
    // A player that loaded unmuted already has sound permission — `play`
    // alone resumes it audibly. Only muted-loaded players need the
    // unmute-attempt/reload dance.
    if (soundEnabled && info.loadedMuted !== false) {
      info.reloadedForSound = false; // fresh activation earns one reload
      attemptUnmute(container);
    }
  }
  // If not ready yet, onPlayerReady checks `container === activeContainer`
  // itself — nothing to queue here.
}

// The feed's IntersectionObserver (presenter.js) calls this as cards snap
// into view; the window-blur focus trick below also calls it when the user
// taps directly into a clip's iframe.
export function activateContainer(container) {
  if (container === activeContainer || !cardInfo.has(container)) return;
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
    for (const [c, i] of cardInfo) {
      if (i.iframe && i.iframe.contentWindow === event.source) {
        container = c;
        info = i;
        break;
      }
    }
    if (!info) return;

    if (data.type === 'onPlayerReady') {
      info.ready = true;
      if (container === activeContainer) {
        if (info.loadedMuted === false) {
          // Unmuted load: nudge it. The explicit play+unMute after ready is
          // what makes the unmuted state stick when it's going to stick at
          // all (verified live); if it doesn't start, the watchdog armed at
          // load time reloads this clip muted.
          postToPlayer(info.iframe, 'play');
          postToPlayer(info.iframe, 'unMute');
        } else if (soundEnabled) {
          attemptUnmute(container);
        }
      } else {
        // A background clip that autoplayed muted on render but never
        // became the active one — stop it now instead of leaving it
        // running silently for the rest of the round.
        postToPlayer(info.iframe, 'pause');
        postToPlayer(info.iframe, 'mute');
      }
    } else if (data.type === 'onMute') {
      info.muteState = data.value;
      if (data.value === false) {
        // Unmuted WHILE actually playing = sound is really on (the user's
        // speaker-icon tap, or an unmuted load that took). A wedged
        // unmuted load also reports onMute:false without ever playing —
        // that must not count, so gate on lastState. (onStateChange
        // handles the arrival orders where playing starts after this.)
        if (info.lastState === 1) markSoundEnabled();
        if (info.unmutePending) info.sawUnmuteEffect = true;
      } else if (info.unmutePending && info.sawUnmuteEffect) {
        // The confirmed failure signature: our unMute took effect and the
        // browser instantly reverted it. No point waiting for the timer —
        // reload unmuted now.
        clearTimeout(info.unmuteTimer);
        info.unmutePending = false;
        soundReloadIfAllowed(container);
      }
    } else if (data.type === 'onStateChange') {
      info.lastState = data.value;
      if (data.value === 1 && info.loadedMuted === false) {
        // The unmuted gamble paid off — it's playing; call off the
        // watchdog.
        clearTimeout(info.watchdogTimer);
      }
      // Actually playing while unmuted — the session's sound opt-in, for
      // whichever of the two events (playing / unmuted) arrived second.
      if (data.value === 1 && info.muteState === false) markSoundEnabled();
      // 1 = playing. Safety net in case autoplay actually kicks in after
      // onPlayerReady fires (ready just means loaded, not yet playing).
      if (
        data.value === 1 &&
        container === activeContainer &&
        soundEnabled &&
        info.loadedMuted !== false &&
        info.muteState !== false
      ) {
        attemptUnmute(container);
      }
    } else if (data.type === 'onPlayerError') {
      if (data.value?.errorCode === 3002) {
        if (info.loadedMuted === false) {
          // The unmuted reload itself got autoplay-blocked. Go back to the
          // known-good muted autoplay for this clip and stop trying — the
          // player's own speaker icon is the remaining path to sound.
          info.soundReloadFailed = true;
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
// this one clip back to the known-working oEmbed blockquote — a normal
// tap-to-play state, same as Instagram.
function fallBackToTapToPlay(container) {
  const info = cardInfo.get(container);
  if (!info || info.fellBack) return;
  clearTimeout(info.unmuteTimer);
  clearTimeout(info.watchdogTimer);
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
    iframe: null,
    loadedMuted: true,
    muteState: undefined,
    lastState: undefined,
    unmutePending: false,
    unmuteTimer: 0,
    watchdogTimer: 0,
    sawUnmuteEffect: false,
    reloadedForSound: false,
    soundReloadFailed: false,
    ...info,
  });
}

// Call once per feed render (after clearing it) so stale references from a
// previous round/render don't linger. soundEnabled deliberately survives —
// the user's opt-in covers the whole session.
export function resetKnownEmbeds() {
  for (const info of cardInfo.values()) {
    clearTimeout(info.unmuteTimer);
    clearTimeout(info.watchdogTimer);
  }
  cardInfo.clear();
  activeContainer = null;
}

// Builds a TikTok Embed Player iframe for the card already registered at
// `container` (via registerEmbedCard) and wires it into the playback
// tracking above. Every clip autoplays the moment it renders — muted,
// except the feed's first clip once the user has already opted into sound
// (soundEnabled), which loads unmuted directly.
export function buildTikTokPlayer(container) {
  const info = cardInfo.get(container);
  const first = activeContainer === null;
  // The feed's first clip always tries to load unmuted — sound-on by
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

// Only used now as a fallback path (see fallBackToTapToPlay and the
// Instagram-style teardown in stopContainer) — TikTok's Embed Player iframe
// above needs no loader script of its own.
//
// TikTok's oEmbed response includes ready-made embed HTML (a <blockquote>
// plus a loader script) — see linkValidation.js's `embedHtml` field. Their
// embed.js scans the DOM for ALL `.tiktok-embed` blockquotes present when it
// runs (not just one). It only scans once at load though, with no
// documented "reprocess" call — the standard trick for re-scanning after
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
// rescans the DOM for new `.instagram-media` blockquotes, unlike TikTok's —
// so no script-tag-swapping trick is needed, just call this after inserting
// fresh blockquotes (works for one or many at once).
export async function processInstagramEmbeds() {
  await loadInstagramScript();
  window.instgrm?.Embeds?.process();
}
