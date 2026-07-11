import { setRevealAttribution, startVoting } from './firebase.js';
import { showPhaseError } from './uiError.js';
import {
  buildTikTokPlayer,
  buildInstagramBlockquote,
  processInstagramEmbeds,
  registerEmbedCard,
  resetKnownEmbeds,
  activateContainer,
  enableSound,
  isSoundEnabled,
} from './embeds.js';

let bound = false;
let startingVoting = false;
let presenterRound = null;
let renderedEntryIds = null; // sorted, joined — identifies the current feed's contents
let feedObserver = null;

function buildCard(entryId, entry) {
  const card = document.createElement('div');
  card.className = 'presenter-card';
  card.dataset.entryId = entryId;

  const embedContainer = document.createElement('div');
  embedContainer.className = 'presenter-embed';
  card.appendChild(embedContainer);

  registerEmbedCard(embedContainer, {
    platform: entry.platform,
    embedHtml: entry.embedHtml,
    url: entry.url,
    canonicalId: entry.canonicalId,
  });

  if (entry.platform === 'tiktok' && entry.canonicalId) {
    embedContainer.appendChild(buildTikTokPlayer(embedContainer));
  } else {
    // Instagram links (and a TikTok entry with no video ID for some
    // reason) fall back to Instagram's own embed widget.
    embedContainer.appendChild(buildInstagramBlockquote(entry.url));
  }

  // TikTok-style overlay chrome on top of the clip: platform badge up top,
  // caption block (title + contributors) pinned to the bottom. All
  // pointer-events:none in CSS so taps land on the clip underneath.
  const badge = document.createElement('p');
  badge.className = 'feed-badge';
  badge.textContent = entry.platform === 'tiktok' ? 'TikTok' : 'Instagram Reels';
  card.appendChild(badge);

  const caption = document.createElement('div');
  caption.className = 'feed-caption';
  if (entry.title) {
    const title = document.createElement('p');
    title.className = 'feed-title';
    title.textContent = entry.title;
    caption.appendChild(title);
  }
  const contributorsWrap = document.createElement('div');
  contributorsWrap.className = 'presenter-contributors';
  caption.appendChild(contributorsWrap);
  card.appendChild(caption);

  return card;
}

function renderContributors(card, entry, revealAttribution) {
  const wrap = card.querySelector('.presenter-contributors');
  if (!wrap) return;
  wrap.innerHTML = '';
  const isMerged = (entry.contributors || []).length > 1;

  if (revealAttribution) {
    (entry.contributors || []).forEach(c => {
      const tag = document.createElement('span');
      tag.className = 'contributor-tag';
      tag.textContent = c.name;
      wrap.appendChild(tag);
    });
  } else {
    const hidden = document.createElement('span');
    hidden.className = 'feed-hidden-note';
    hidden.textContent = 'Submitted by: hidden';
    wrap.appendChild(hidden);
  }

  if (isMerged) {
    const badge = document.createElement('span');
    badge.className = 'weight-badge';
    badge.textContent = `×${entry.contributors.length} weight`;
    wrap.appendChild(badge);
  }
}

// Whichever card the feed has snapped to becomes the active (audible) clip.
// scroll-snap guarantees one card fills the feed viewport at rest, so a
// 0.6 visibility threshold cleanly identifies it mid-scroll too.
function observeFeed(feed) {
  feedObserver?.disconnect();
  feedObserver = new IntersectionObserver(
    obsEntries => {
      for (const e of obsEntries) {
        if (e.isIntersecting) {
          const container = e.target.querySelector('.presenter-embed');
          if (container) activateContainer(container);
        }
      }
    },
    { root: feed, threshold: 0.6 }
  );
  feed.querySelectorAll('.presenter-card').forEach(card => feedObserver.observe(card));
}

// Rebuilds the whole feed — only called when the actual set of entries for
// this round changes, not on every snapshot (e.g. toggling attribution
// shouldn't reload every embed and reset any playback in progress).
function renderGrid(entries) {
  const feed = document.getElementById('presenter-grid');
  feed.innerHTML = '';
  resetKnownEmbeds();
  feedObserver?.disconnect();
  feedObserver = null;

  const soundBtn = document.getElementById('feed-sound-btn');
  const hasTikTokPlayer = entries.some(
    ([, entry]) => entry.platform === 'tiktok' && entry.canonicalId
  );
  soundBtn.classList.toggle('hidden', !hasTikTokPlayer || isSoundEnabled());

  if (entries.length === 0) {
    feed.innerHTML = '<p class="feed-empty">No clips were submitted this round.</p>';
    return;
  }

  for (const [entryId, entry] of entries) {
    feed.appendChild(buildCard(entryId, entry));
  }
  observeFeed(feed);

  // TikTok clips render as self-contained Embed Player iframes (see
  // embeds.js) — no loader script needed. One process() call still picks up
  // every Instagram blockquote in the feed.
  processInstagramEmbeds();
}

export function render(room, ctx) {
  const round = room.round;
  const roundData = room.rounds?.[round] || {};
  const submissions = roundData.submissions || {};
  const entries = Object.entries(submissions); // [entryId, entry][]
  const revealAttribution = !!roundData.revealAttribution;

  if (presenterRound !== round) {
    presenterRound = round;
    startingVoting = false;
    const startBtn = document.getElementById('start-voting-btn');
    startBtn.disabled = entries.length === 0;
    startBtn.textContent = 'Start voting';
  }

  if (!bound) {
    bound = true;
    document.getElementById('attribution-toggle').addEventListener('change', e => {
      const r = window.__totcCurrentRoom;
      setRevealAttribution(ctx.code, r.round, e.target.checked);
    });
    document.getElementById('start-voting-btn').addEventListener('click', async e => {
      startingVoting = true;
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Starting voting...';
      try {
        await startVoting(ctx.code);
      } catch (err) {
        startingVoting = false;
        btn.disabled = false;
        btn.textContent = 'Start voting';
        showPhaseError(err);
      }
    });
    const soundBtn = document.getElementById('feed-sound-btn');
    soundBtn.addEventListener('click', () => {
      enableSound();
      soundBtn.classList.add('hidden');
    });
    // Fires when sound gets enabled some other way (e.g. the user tapped a
    // player's own speaker icon) — the button is then redundant.
    window.addEventListener('totc-sound-enabled', () => {
      soundBtn.classList.add('hidden');
    });
  }

  const entryIdsKey = entries.map(([id]) => id).sort().join(',');
  if (entryIdsKey !== renderedEntryIds) {
    renderedEntryIds = entryIdsKey;
    renderGrid(entries);
  }

  document.querySelectorAll('#presenter-grid .presenter-card').forEach(card => {
    const entry = submissions[card.dataset.entryId];
    if (entry) renderContributors(card, entry, revealAttribution);
  });

  document.getElementById('host-presenter-controls').classList.toggle('hidden', !ctx.isHost);
  document.getElementById('guest-watching-note').classList.toggle('hidden', ctx.isHost);

  if (ctx.isHost) {
    document.getElementById('attribution-toggle').checked = revealAttribution;
    if (!startingVoting) {
      document.getElementById('start-voting-btn').disabled = entries.length === 0;
    }
  }
}
