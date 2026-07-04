// Renders TikTok/Instagram's own official embed widgets inline in the
// presenter view, so the host can play a clip without leaving the app.
// Neither widget autoplays — both platforms require a tap on the embedded
// player before video starts. That's a platform/browser restriction (silent
// autoplay is blocked broadly, and neither embed SDK exposes an autoplay
// option), not something client code can work around.

let tiktokScriptTag = null;

// TikTok's oEmbed response includes ready-made embed HTML (a <blockquote>
// plus a loader script) — see linkValidation.js's `embedHtml` field. Their
// embed.js only scans the DOM for `.tiktok-embed` blockquotes once, at load,
// with no documented "reprocess" call. The standard trick for re-rendering
// in a single-page app is to swap in a fresh <script> element each time —
// the browser re-runs it (served from cache, so this is fast) and it
// rescans whatever's in the DOM right now.
export function renderTikTokEmbed(container, embedHtml) {
  container.innerHTML = embedHtml;
  if (tiktokScriptTag) tiktokScriptTag.remove();
  tiktokScriptTag = document.createElement('script');
  tiktokScriptTag.async = true;
  tiktokScriptTag.src = 'https://www.tiktok.com/embed.js';
  document.body.appendChild(tiktokScriptTag);
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

// Instagram's embed.js exposes a documented `Embeds.process()` call that
// rescans the DOM for new `.instagram-media` blockquotes, unlike TikTok's —
// so no script-tag-swapping trick is needed here, just call it after
// inserting a fresh blockquote.
export async function renderInstagramEmbed(container, url) {
  container.innerHTML = '';
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
  container.appendChild(blockquote);

  await loadInstagramScript();
  window.instgrm?.Embeds?.process();
}
