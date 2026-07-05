// Renders TikTok/Instagram embeds inline for every clip in a round at once
// (no next/prev — see presenter.js), and enforces "only one clip plays
// audibly at a time."
//
// TikTok clips use TikTok's official Embed Player
// (https://www.tiktok.com/player/v1/{id}), not the oEmbed blockquote used
// everywhere else in this app. The Embed Player is a real control surface:
// query params (autoplay=1&muted=1) start it automatically without a tap,
// and a documented postMessage channel (play/pause/mute/unMute) lets the
// host stop one clip and start another without touching the iframe itself.
// Verified directly against developers.tiktok.com/doc/embed-player before
// building this — the message body must include `'x-tiktok-player': true`
// alongside `type`/`value`, and `onPlayerError`'s payload is
// `{ errorCode, errorType }` (error 3002/AUTOPLAY_ERROR is the one we
// actually handle — see fallBackToTapToPlay below).
//
// The auto-unmute this enables is a real attempt, not a guaranteed result —
// tested live against the actual player and confirmed the `unMute` command
// arrives and briefly takes effect (`onMute:false` fires) but gets silently
// reverted a couple milliseconds later (`onMute:true`), with no error event
// to react to. This reproduced even after a genuine, focus-confirmed click
// directly into that clip's iframe, so it isn't just "needs a real tap."
// The likely cause is a browser platform constraint, not a bug here: user
// activation (the "a real tap authorized this") doesn't propagate through
// `postMessage` — a `message` handler is never treated as a gesture, so the
// browser's audio-unmute policy can block the relayed unmute even though
// TikTok's own script is the one calling it. Left in because it's harmless
// and may work in browsers/versions with different policies, but the UI
// copy (game.html) doesn't promise it — the honest fallback is still a tap
// on the clip's own speaker icon, which is a first-party click and works.
//
// Instagram has no equivalent. Its oEmbed response is a <blockquote> that
// Instagram's own embed.js turns into an iframe with zero configurability —
// no autoplay, no control channel, cross-origin like TikTok's. Instagram
// clips keep the original tap-to-play-with-sound behavior, and the only way
// to stop one is still tearing its container down and rebuilding it from
// the original blockquote markup (see the Session 4 note below) — that
// applies to any TikTok clip that has fallen back to its own blockquote
// embed too (see fallBackToTapToPlay), since at that point it's in the same
// no-control-channel boat as Instagram.
//
// The original tear-down approach (before the Embed Player existed) tried
// resetting `iframe.src = iframe.src` to force a reload on whichever clip
// was losing focus. That broke TikTok's oEmbed blockquote embed permanently
// — once reloaded in place, the iframe never recovered (confirmed in
// testing — it stayed on a blank loading state indefinitely, well past the
// ~10-15s TikTok's embeds normally take to render). What reliably works
// instead is tearing the card's embed container back down to the original
// <blockquote> markup and letting the platform's embed script build a fresh
// iframe from scratch — the same path used on first render. That's still
// what `rebuildContainer` below does, now only needed for Instagram and for
// TikTok clips that have fallen back off the Embed Player.

const TIKTOK_PLAYER_ORIGIN = 'https://www.tiktok.com';

const cardInfo = new Map(); // embedContainer -> { platform, embedHtml, url, canonicalId, iframe, ready, fellBack }
let activeContainer = null;
let focusListenerBound = false;
let tiktokMessageListenerBound = false;

function postToPlayer(iframe, type, value) {
  iframe?.contentWindow?.postMessage(
    { type, value, 'x-tiktok-player': true },
    TIKTOK_PLAYER_ORIGIN
  );
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
// already fallen back to the blockquote embed.
function stopContainer(container) {
  const info = cardInfo.get(container);
  if (!info) return;

  if (info.platform === 'tiktok' && info.iframe) {
    // If the player isn't ready yet, there's nothing playing to stop — and
    // its own onPlayerReady handler (below) will pause+mute it on arrival
    // once it sees it isn't the active container.
    if (info.ready) {
      postToPlayer(info.iframe, 'pause');
      postToPlayer(info.iframe, 'mute');
    }
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
    postToPlayer(info.iframe, 'unMute');
  }
  // If not ready yet, onPlayerReady checks `container === activeContainer`
  // itself and unmutes on arrival — nothing to queue here.
}

function activateContainer(container) {
  if (container === activeContainer || !cardInfo.has(container)) return;
  activeContainer = container;
  for (const c of cardInfo.keys()) {
    if (c !== container) stopContainer(c);
  }
  startContainer(container);
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
        postToPlayer(info.iframe, 'unMute');
      } else {
        // A background clip that autoplayed muted on render but never
        // became the active one — stop it now instead of leaving it
        // running silently for the rest of the round.
        postToPlayer(info.iframe, 'pause');
        postToPlayer(info.iframe, 'mute');
      }
    } else if (data.type === 'onStateChange') {
      // 1 = playing. Safety net in case autoplay actually kicks in after
      // onPlayerReady fires (ready just means loaded, not yet playing).
      if (data.value === 1 && container === activeContainer) {
        postToPlayer(info.iframe, 'unMute');
      }
    } else if (data.type === 'onPlayerError') {
      if (data.value?.errorCode === 3002) fallBackToTapToPlay(container);
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

// Call once per card when the grid is (re)built, so this module knows how
// to rebuild/stop that card's embed later.
export function registerEmbedCard(container, info) {
  ensureFocusListener();
  cardInfo.set(container, { ready: false, fellBack: false, iframe: null, ...info });
}

// Call once per grid render (after clearing the grid) so stale references
// from a previous round/render don't linger.
export function resetKnownEmbeds() {
  cardInfo.clear();
  activeContainer = null;
}

// Builds a TikTok Embed Player iframe for the card already registered at
// `container` (via registerEmbedCard) and wires it into the playback
// tracking above. autoplay=1&muted=1 is what lets every clip start playing
// the instant it renders with no tap — muted, so it's silent until it
// becomes the active clip (the first TikTok card in a round defaults to
// active; see below).
export function buildTikTokPlayer(container) {
  const info = cardInfo.get(container);
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.tiktok.com/player/v1/${encodeURIComponent(info.canonicalId)}?autoplay=1&muted=1&rel=0`;
  iframe.allow = 'autoplay; encrypted-media; fullscreen';
  iframe.allowFullscreen = true;
  iframe.style.border = 'none';
  iframe.title = 'TikTok video player';
  info.iframe = iframe;
  info.ready = false;
  info.fellBack = false;
  ensureTikTokMessageListener();
  if (activeContainer === null) activeContainer = container;
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
