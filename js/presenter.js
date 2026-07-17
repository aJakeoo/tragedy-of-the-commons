import { setRevealAttribution, startVoting } from './firebase.js';
import { sortEntries } from './scoring.js';
import { showPhaseError } from './uiError.js';
import {
  buildTikTokPlayer,
  buildInstagramPlayer,
  registerEmbedCard,
  resetKnownEmbeds,
  activateContainer,
  deactivateFeed,
  enableSound,
  isSoundEnabled,
} from './embeds.js';

let bound = false;
let startingVoting = false;
let presenterRound = null;
let renderedEntryIds = null; // sorted, joined - identifies the current feed's contents
let feedObserver = null;
let feedPoller = 0;

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
    // Instagram cards (and, as a last resort, a TikTok entry that somehow
    // has no video ID - buildInstagramPlayer degrades to an outbound link
    // when there's no shortcode to embed).
    embedContainer.appendChild(buildInstagramPlayer(embedContainer));
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

// Whichever card the feed has snapped to becomes the active (audible) clip
// - or, on the end card (which has no embed), everything pauses. Two
// detection paths, both cheap and idempotent: an IntersectionObserver
// (0.6 visibility), plus a scroll-position fallback. The fallback matters:
// IO notifications ride the rendering-frame pipeline, and with several
// heavy platform iframes running, that pipeline can stall long enough that
// IO callbacks simply never arrive (observed live in QA) - while plain
// scroll events still fire. Each card is exactly one feed-viewport tall
// (CSS), so round(scrollTop / clientHeight) IS the snapped card index.
function activateCard(card) {
  const container = card?.querySelector('.presenter-embed');
  if (container) activateContainer(container);
  else deactivateFeed(); // snapped to the end card - silence the clips
}

function activateCardAt(feed, index) {
  const cards = feed.querySelectorAll('.presenter-card');
  activateCard(cards[Math.max(0, Math.min(cards.length - 1, index))]);
}

function observeFeed(feed) {
  feedObserver?.disconnect();
  feedObserver = new IntersectionObserver(
    obsEntries => {
      for (const e of obsEntries) {
        if (e.isIntersecting && e.intersectionRatio >= 0.6) activateCard(e.target);
      }
    },
    { root: feed, threshold: 0.6 }
  );
  feed.querySelectorAll('.presenter-card').forEach(card => feedObserver.observe(card));

  let scrollTimer = 0;
  const onSettled = () => {
    clearTimeout(scrollTimer);
    activateCardAt(feed, Math.round(feed.scrollTop / feed.clientHeight));
  };
  feed.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(onSettled, 150);
  });
  // scrollend fires once snapping fully settles (Chrome 114+); the timer
  // above is the fallback for browsers without it.
  feed.addEventListener('scrollend', onSettled);

  // Last-resort poller: scroll events ALSO ride the rendering pipeline and
  // were observed going silent right alongside IO during a long renderer
  // stall - while plain timers kept running. Polling the snap position is
  // stall-proof, and activateCardAt is a no-op when nothing changed.
  clearInterval(feedPoller);
  feedPoller = setInterval(() => {
    if (!feed.isConnected) {
      clearInterval(feedPoller);
      return;
    }
    activateCardAt(feed, Math.round(feed.scrollTop / feed.clientHeight));
  }, 500);
}

// The final feed slide: after the last clip, snapping down lands on the
// "what happens next" card - the host's attribution toggle + Start voting
// button, or the guest's waiting note. Those elements live in game.html
// (render() below toggles them by id), so they're MOVED into this slide
// rather than cloned.
function buildEndCard(entries) {
  const card = document.createElement('div');
  card.className = 'presenter-card feed-endcard';
  const inner = document.createElement('div');
  inner.className = 'feed-endcard-inner';
  if (entries.length === 0) {
    const none = document.createElement('p');
    none.className = 'feed-empty';
    none.textContent = 'No clips were submitted this round.';
    inner.appendChild(none);
  } else {
    const done = document.createElement('p');
    done.className = 'feed-endcard-title';
    done.textContent = "That's every clip.";
    inner.appendChild(done);
  }
  inner.appendChild(document.getElementById('host-presenter-controls'));
  card.appendChild(inner);
  return card;
}

// Rebuilds the whole feed - only called when the actual set of entries for
// this round changes, not on every snapshot (e.g. toggling attribution
// shouldn't reload every embed and reset any playback in progress).
function renderGrid(entries) {
  const feed = document.getElementById('presenter-grid');
  // The host controls live inside the end card between renders - park
  // them back on the section before wiping the feed so innerHTML=''
  // doesn't destroy them.
  const phase = document.getElementById('phase-compiling');
  phase.appendChild(document.getElementById('host-presenter-controls'));
  feed.innerHTML = '';
  resetKnownEmbeds();
  feedObserver?.disconnect();
  feedObserver = null;
  clearInterval(feedPoller);

  const soundBtn = document.getElementById('feed-sound-btn');
  const hasTikTokPlayer = entries.some(
    ([, entry]) => entry.platform === 'tiktok' && entry.canonicalId
  );
  soundBtn.classList.toggle('hidden', !hasTikTokPlayer || isSoundEnabled());

  for (const [entryId, entry] of entries) {
    feed.appendChild(buildCard(entryId, entry));
  }
  feed.appendChild(buildEndCard(entries));
  observeFeed(feed);
  // Both platforms now render as self-contained iframes built in
  // embeds.js - no loader scripts, no post-render processing pass.
}

export function render(room, ctx) {
  const round = room.round;
  const roundData = room.rounds?.[round] || {};
  const submissions = roundData.submissions || {};
  // Random compile-time order (see mergeSubmissions), NOT submitter order.
  const entries = sortEntries(Object.entries(submissions)); // [entryId, entry][]
  const revealAttribution = !!roundData.revealAttribution;

  // The compiled feed is host-only: the host is the one casting to the
  // shared screen, and everyone else watches THAT, not their own phone.
  // Guests get a lightweight "eyes on the big screen" view and never load
  // a single platform iframe - which also keeps their devices quiet and
  // cheap during the round.
  document.getElementById('presenter-feed-wrap').classList.toggle('hidden', !ctx.isHost);
  document.getElementById('guest-compiling-view').classList.toggle('hidden', ctx.isHost);
  if (!ctx.isHost) return;

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
    // player's own speaker icon) - the button is then redundant.
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

  document.getElementById('host-presenter-controls').classList.remove('hidden');
  document.getElementById('attribution-toggle').checked = revealAttribution;
  if (!startingVoting) {
    document.getElementById('start-voting-btn').disabled = entries.length === 0;
  }
}
