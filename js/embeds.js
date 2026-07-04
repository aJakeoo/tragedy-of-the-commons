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
// The workaround used below is the standard trick for cross-origin iframes
// with no control API: the browser fires `window.blur` when focus moves
// into an iframe (even though click/play events *inside* the iframe are
// invisible to the parent page), so a blur handler that checks
// `document.activeElement` can detect "the user just tapped into this
// specific iframe." When that happens, every *other* known clip iframe is
// force-stopped by resetting its `src` to itself — reloading an iframe
// discards whatever was playing, which is the closest available substitute
// for a real pause() call. This is a heuristic, not a guarantee (e.g. tabbing
// into an iframe via keyboard without starting playback would still reset
// the others), but it fails safe: resetting an iframe that wasn't actually
// playing has no visible downside.

const knownIframes = new Set();
let activeIframe = null;
let focusListenerBound = false;

function stopOtherIframes(justActivated) {
  activeIframe = justActivated;
  for (const iframe of knownIframes) {
    if (iframe === justActivated) continue;
    if (!iframe.isConnected) {
      knownIframes.delete(iframe);
      continue;
    }
    // eslint-disable-next-line no-self-assign
    iframe.src = iframe.src; // reload = force-stop whatever was playing
  }
}

function ensureFocusListener() {
  if (focusListenerBound) return;
  focusListenerBound = true;
  window.addEventListener('blur', () => {
    // The newly focused element isn't set until after blur fires.
    setTimeout(() => {
      const active = document.activeElement;
      if (active?.tagName === 'IFRAME' && knownIframes.has(active) && active !== activeIframe) {
        stopOtherIframes(active);
      }
    }, 0);
  });
}

// Call once per grid render (after clearing the grid) so stale references
// from a previous round/render don't linger.
export function resetKnownEmbeds() {
  knownIframes.clear();
  activeIframe = null;
}

// Watches a container for iframes appearing inside it (TikTok/Instagram's
// embed scripts create them asynchronously after processing blockquotes)
// and feeds them into the single-active-audio enforcement above.
export function watchForEmbedIframes(container) {
  ensureFocusListener();
  container.querySelectorAll('iframe').forEach(f => knownIframes.add(f));
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'IFRAME') knownIframes.add(node);
        node.querySelectorAll?.('iframe').forEach(f => knownIframes.add(f));
      });
    }
  });
  observer.observe(container, { childList: true, subtree: true });
  return observer;
}

let tiktokScriptTag = null;

// TikTok's oEmbed response includes ready-made embed HTML (a <blockquote>
// plus a loader script) — see linkValidation.js's `embedHtml` field. Their
// embed.js scans the DOM for ALL `.tiktok-embed` blockquotes present when it
// runs (not just one), so rendering every clip's blockquote up front and
// loading the script once processes the whole grid in one pass. It only
// scans once at load though, with no documented "reprocess" call — the
// standard trick for re-scanning after the DOM changes (e.g. a new round) is
// to swap in a fresh <script> element, which the browser re-runs from cache.
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
