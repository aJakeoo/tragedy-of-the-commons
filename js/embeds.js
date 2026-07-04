// Renders TikTok/Instagram's own official embed widgets inline for every
// clip in a round at once (no next/prev — see presenter.js), and enforces
// "only one clip plays audibly at a time."
//
// Neither widget autoplays — both require a tap on the embedded player,
// which then plays with sound in one motion (that's each platform's own
// default embed behavior, not something built here). Silent autoplay is
// blocked broadly by browsers, and neither embed SDK exposes an autoplay
// flag, so a single tap-to-play-with-sound is the practical floor.
//
// "Only one plays at a time" is harder: both embeds render as cross-origin
// iframes (tiktok.com / instagram.com), and neither platform publishes a
// postMessage control API for third-party embeds (unlike, say, YouTube's
// IFrame API) — there is no `iframe.contentWindow.pause()` available here.
//
// The first approach tried here was resetting `iframe.src = iframe.src` to
// force a reload on every OTHER playing clip when a new one gets focus.
// That turned out to actively break TikTok's embed: once reloaded in place,
// the iframe never recovered (confirmed in testing — it stayed on a blank
// loading state indefinitely, well past the ~10-15s TikTok's embeds
// normally take to render). What DOES reliably work — because it's exactly
// what happens on first render — is tearing the card's embed container back
// down to the original <blockquote> markup and letting the platform's embed
// script build a fresh iframe from scratch, the same path used the first
// time each clip renders. That's what `stopAllExcept` below does. It costs
// the same ~10-15s re-render delay as any TikTok/Instagram embed's first
// load, on every card that gets stopped this way — a real, visible cost,
// but the alternative (the src-reset trick) left clips permanently dead,
// which is worse.

const cardInfo = new Map(); // embedContainer -> { platform, embedHtml, url }
let activeContainer = null;
let focusListenerBound = false;

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

function stopAllExcept(activeIframe) {
  const nextActiveContainer = activeIframe.closest('.presenter-embed');
  if (!nextActiveContainer) return;
  activeContainer = nextActiveContainer;

  let anyTikTokRebuilt = false;
  let anyInstagramRebuilt = false;
  for (const [container, info] of cardInfo) {
    if (container === nextActiveContainer) continue;
    if (!container.querySelector('iframe')) continue; // nothing rendered there to stop
    rebuildContainer(container);
    if (info.platform === 'tiktok' && info.embedHtml) anyTikTokRebuilt = true;
    else anyInstagramRebuilt = true;
  }
  if (anyTikTokRebuilt) loadTikTokEmbedScript();
  if (anyInstagramRebuilt) processInstagramEmbeds();
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
      if (container && cardInfo.has(container) && container !== activeContainer) {
        stopAllExcept(active);
      }
    }, 0);
  });
}

// Call once per card when the grid is (re)built, so this module knows how
// to rebuild that card's embed from scratch if another card takes over.
export function registerEmbedCard(container, info) {
  ensureFocusListener();
  cardInfo.set(container, info);
}

// Call once per grid render (after clearing the grid) so stale references
// from a previous round/render don't linger.
export function resetKnownEmbeds() {
  cardInfo.clear();
  activeContainer = null;
}

let tiktokScriptTag = null;

// TikTok's oEmbed response includes ready-made embed HTML (a <blockquote>
// plus a loader script) — see linkValidation.js's `embedHtml` field. Their
// embed.js scans the DOM for ALL `.tiktok-embed` blockquotes present when it
// runs (not just one), so rendering every clip's blockquote up front and
// loading the script once processes the whole grid in one pass. It only
// scans once at load though, with no documented "reprocess" call — the
// standard trick for re-scanning after the DOM changes (e.g. a rebuilt card,
// or a new round) is to swap in a fresh <script> element, which the browser
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
