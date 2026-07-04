// ── Link format + liveness validation ───────────────────────────────────────
//
// Platform capability note (confirmed empirically, not just assumed):
// - TikTok's public oEmbed endpoint (https://www.tiktok.com/oembed) sends
//   `Access-Control-Allow-Origin: *` on success, so it's callable directly
//   from browser JS. It also resolves short links (vm./vt.tiktok.com),
//   returns a canonical video ID (`embed_product_id`) and a thumbnail, and
//   returns an HTTP error for a dead/nonexistent video. That one call covers
//   format validation, liveness resolution, canonicalization, and thumbnail.
// - Instagram's oEmbed now requires a Meta Graph API access token (app
//   review required) and does not send CORS headers for anonymous requests.
//   There is no client-only way to verify an Instagram Reels link is alive
//   or fetch its thumbnail. Instagram links are therefore format-validated
//   only (regex + shortcode extraction) and accepted without a liveness
//   check or thumbnail. This is a real platform constraint, not an
//   oversight — flagged in output.md.

const TIKTOK_VIDEO_RE = /^https?:\/\/(?:www\.)?tiktok\.com\/@[\w.\-]+\/video\/(\d+)\/?(?:\?.*)?$/i;
const TIKTOK_SHORT_RE = /^https?:\/\/(?:vm|vt|m)\.tiktok\.com\/[\w\-]+\/?(?:\?.*)?$/i;
const TIKTOK_T_RE = /^https?:\/\/(?:www\.)?tiktok\.com\/t\/[\w\-]+\/?(?:\?.*)?$/i;

const INSTAGRAM_RE = /^https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels)\/([\w\-]+)\/?(?:\?.*)?$/i;
const INSTAGRAM_SHORT_RE = /^https?:\/\/instagr\.am\/(?:reel|reels)\/([\w\-]+)\/?(?:\?.*)?$/i;

export function detectPlatform(rawUrl) {
  const url = (rawUrl || '').trim();
  if (TIKTOK_VIDEO_RE.test(url) || TIKTOK_SHORT_RE.test(url) || TIKTOK_T_RE.test(url)) return 'tiktok';
  if (INSTAGRAM_RE.test(url) || INSTAGRAM_SHORT_RE.test(url)) return 'instagram';
  return null;
}

function extractInstagramShortcode(url) {
  const match = url.match(INSTAGRAM_RE) || url.match(INSTAGRAM_SHORT_RE);
  return match ? match[1] : null;
}

// Resolves a link: validates format, then (TikTok only) verifies it's live
// and pulls a canonical ID + thumbnail via oEmbed. Never throws — always
// resolves to a result object so callers can render a clean invalid state.
export async function validateAndResolveLink(rawUrl) {
  const url = (rawUrl || '').trim();
  if (!url) return { ok: false, error: 'Paste a link first.' };

  const platform = detectPlatform(url);
  if (!platform) {
    return { ok: false, error: 'Not a recognized TikTok or Instagram Reels link.' };
  }

  if (platform === 'tiktok') {
    try {
      const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
      if (!res.ok) {
        return { ok: false, platform, error: "This link didn't work — try another." };
      }
      const data = await res.json();
      return {
        ok: true,
        platform,
        url,
        canonicalId: data.embed_product_id || url,
        thumbnail: data.thumbnail_url || null,
        title: data.title || '',
        author: data.author_name || '',
      };
    } catch {
      return { ok: false, platform, error: "This link didn't work — try another." };
    }
  }

  // Instagram: format-valid is the best we can verify client-side.
  const shortcode = extractInstagramShortcode(url);
  if (!shortcode) {
    return { ok: false, platform, error: 'Not a recognized Instagram Reels link.' };
  }
  return {
    ok: true,
    platform,
    url,
    canonicalId: shortcode,
    thumbnail: null,
    title: '',
    author: '',
    unverifiable: true,
  };
}
