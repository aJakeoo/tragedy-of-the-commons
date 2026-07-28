import { setRevealAttribution, startVoting, revealResults, setActiveEntry } from './firebase.js';
import { sortEntries, tallySkipVotes } from './scoring.js';
import { showPhaseError } from './uiError.js';
import { platformLabel } from './format.js';
import {
  buildTikTokPlayer,
  buildInstagramBlockquote,
  buildUploadVideo,
  processInstagramEmbeds,
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
let currentCode = null; // set on the host's client only - see the isHost guard in render()
let skipDismissed = new Set(); // entryIds the host chose to keep watching - see renderSkipPrompt

function buildCard(entryId, entry) {
  const card = document.createElement('div');
  card.className = 'presenter-card';
  card.dataset.entryId = entryId;

  const embedContainer = document.createElement('div');
  embedContainer.className = 'presenter-embed';
  card.appendChild(embedContainer);

  registerEmbedCard(embedContainer, {
    entryId,
    platform: entry.platform,
    embedHtml: entry.embedHtml,
    url: entry.url,
    canonicalId: entry.canonicalId,
  });

  if (entry.platform === 'tiktok' && entry.canonicalId) {
    embedContainer.appendChild(buildTikTokPlayer(embedContainer));
  } else if (entry.platform === 'upload') {
    embedContainer.appendChild(buildUploadVideo(embedContainer));
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
  badge.textContent = platformLabel(entry.platform);
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

// Advances the feed one slide, which is all "skip" means here - the feed's
// own snap detection (observeFeed above) picks the new card up and re-syncs
// activeEntryId/audio from there, so this deliberately doesn't call
// activateCard itself. Smooth-scrolling rather than jumping keeps it reading
// as the same gesture a swipe would make.
function skipToNextCard() {
  const feed = document.getElementById('presenter-grid');
  const cards = feed.querySelectorAll('.presenter-card');
  if (!cards.length) return;
  const index = Math.round(feed.scrollTop / feed.clientHeight);
  const next = Math.min(index + 1, cards.length - 1);
  const target = next * feed.clientHeight;
  feed.scrollTo({ top: target, behavior: 'smooth' });

  // Smooth scrolling is driven by the rendering pipeline, which this feed
  // has already been observed stalling (see observeFeed's poller note) - and
  // it doesn't run at all while the tab is backgrounded. A skip that
  // silently does nothing is the worst outcome for this button, so if the
  // feed hasn't actually moved by the time the animation should be well
  // underway, jump it there outright.
  setTimeout(() => {
    if (Math.abs(feed.scrollTop - target) > 4) feed.scrollTo({ top: target, behavior: 'auto' });
  }, 600);
}

// The banner that appears over the feed once enough guests have voted to
// skip whatever is currently playing (see tallySkipVotes / js/skipVote.js).
// It's a prompt, not an automatic skip: the host is the one casting to the
// shared screen and keeps the final call, so this offers "Skip it" and
// "Keep watching" rather than yanking the clip out from under them.
function renderSkipPrompt(roundData, players, hostId, activeEntryId) {
  const prompt = document.getElementById('skip-prompt');
  if (!activeEntryId || skipDismissed.has(activeEntryId)) {
    prompt.classList.add('hidden');
    return;
  }

  // Only prompt about the clip the host is ACTUALLY looking at. activeEntryId
  // makes a Firestore round trip, and that write has been observed lagging by
  // 15s+ on a slow connection (see output.md) - long enough for the feed to
  // have moved on, or reached the end card, while the field still names the
  // previous clip. Guests vote against whatever activeEntryId says, so the
  // tally is keyed correctly either way; this just holds the banner back
  // until the host's own screen agrees with it.
  const feed = document.getElementById('presenter-grid');
  const cards = feed.querySelectorAll('.presenter-card');
  const onScreen = cards[Math.round(feed.scrollTop / feed.clientHeight)];
  if (onScreen?.dataset.entryId !== activeEntryId) {
    prompt.classList.add('hidden');
    return;
  }

  const stats = tallySkipVotes(roundData, activeEntryId, players, hostId);
  prompt.classList.toggle('hidden', !stats.reached);
  if (!stats.reached) return;

  const noun = stats.voted === 1 ? 'player wants' : 'players want';
  document.getElementById('skip-prompt-text').textContent =
    `${stats.voted} of ${stats.eligible} ${noun} to skip this one.`;
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

  // The sound button is only meaningful for clips this app actually
  // controls playback/mute for - TikTok's Embed Player and uploaded
  // <video> elements. Instagram's blockquote embed has no such control.
  const soundBtn = document.getElementById('feed-sound-btn');
  const hasControllableClip = entries.some(
    ([, entry]) => (entry.platform === 'tiktok' && entry.canonicalId) || entry.platform === 'upload'
  );
  soundBtn.classList.toggle('hidden', !hasControllableClip || isSoundEnabled());

  for (const [entryId, entry] of entries) {
    feed.appendChild(buildCard(entryId, entry));
  }
  feed.appendChild(buildEndCard(entries));
  observeFeed(feed);

  // TikTok clips render as self-contained Embed Player iframes (see
  // embeds.js) - no loader script needed. One process() call still picks up
  // every Instagram blockquote in the feed.
  processInstagramEmbeds();
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
  currentCode = ctx.code;

  // Guess mode has no ballot phase - the feed's end card goes straight to
  // reveal instead of collecting votes first.
  const startBtnLabel = ctx.mode === 'guess' ? 'Reveal results' : 'Start voting';

  if (presenterRound !== round) {
    presenterRound = round;
    startingVoting = false;
    skipDismissed = new Set();
    const startBtn = document.getElementById('start-voting-btn');
    startBtn.disabled = entries.length === 0;
    startBtn.textContent = startBtnLabel;
  }

  if (!bound) {
    bound = true;
    document.getElementById('attribution-toggle').addEventListener('change', e => {
      const r = window.__totcCurrentRoom;
      setRevealAttribution(ctx.code, r.round, e.target.checked);
    });
    document.getElementById('start-voting-btn').addEventListener('click', async e => {
      const r = window.__totcCurrentRoom;
      const mode = r?.config?.mode;
      const label = mode === 'guess' ? 'Reveal results' : 'Start voting';
      startingVoting = true;
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = mode === 'guess' ? 'Revealing...' : 'Starting voting...';
      try {
        await (mode === 'guess' ? revealResults(ctx.code) : startVoting(ctx.code));
      } catch (err) {
        startingVoting = false;
        btn.disabled = false;
        btn.textContent = label;
        showPhaseError(err);
      }
    });
    document.getElementById('skip-prompt-skip-btn').addEventListener('click', () => {
      const r = window.__totcCurrentRoom;
      const activeId = r?.rounds?.[r.round]?.activeEntryId;
      // Dismiss on the way out too: the banner would otherwise sit there for
      // the length of the smooth scroll, since the tally for the clip we're
      // leaving stays over threshold until activeEntryId catches up.
      if (activeId) skipDismissed.add(activeId);
      document.getElementById('skip-prompt').classList.add('hidden');
      skipToNextCard();
    });
    document.getElementById('skip-prompt-keep-btn').addEventListener('click', () => {
      const r = window.__totcCurrentRoom;
      const activeId = r?.rounds?.[r.round]?.activeEntryId;
      // Per-clip and host-local: overruling the vote on this clip shouldn't
      // stop the room asking again on the next one.
      if (activeId) skipDismissed.add(activeId);
      document.getElementById('skip-prompt').classList.add('hidden');
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
    // Syncs "whichever clip the feed is snapped to" to Firestore so guests'
    // devices can drive the guess-the-submitter prompt (js/guessing.js).
    window.addEventListener('totc-active-clip-changed', e => {
      if (!currentCode || presenterRound === null) return;
      // Re-check the banner the moment the feed moves, rather than waiting
      // for the next Firestore snapshot: scrolling off a clip should drop
      // its skip prompt immediately (renderSkipPrompt's on-screen guard),
      // even though the round trip below hasn't landed yet.
      const r = window.__totcCurrentRoom;
      const rd = r?.rounds?.[r.round];
      if (rd) renderSkipPrompt(rd, r.players, r.host, rd.activeEntryId || null);
      setActiveEntry(currentCode, presenterRound, e.detail.entryId).catch(() => {});
    });
  }

  const entryIdsKey = entries.map(([id]) => id).sort().join(',');
  if (entryIdsKey !== renderedEntryIds) {
    renderedEntryIds = entryIdsKey;
    renderGrid(entries);
  }

  // Attribution is unconditionally hidden on the feed itself, regardless of
  // the toggle below: the feed IS the shared screen everyone in the room is
  // watching, so a name rendering here breaks the guessing mechanic for the
  // whole room at once. `revealAttribution`/the toggle stay wired up (write
  // still happens) in case a future, non-feed view wants to read it, but as
  // of this session nothing else consumes it - see output.md Session 10.
  document.querySelectorAll('#presenter-grid .presenter-card').forEach(card => {
    const entry = submissions[card.dataset.entryId];
    if (entry) renderContributors(card, entry, false);
  });

  renderSkipPrompt(roundData, room.players, room.host, roundData.activeEntryId || null);

  document.getElementById('host-presenter-controls').classList.remove('hidden');
  document.getElementById('attribution-toggle').checked = revealAttribution;
  if (!startingVoting) {
    document.getElementById('start-voting-btn').disabled = entries.length === 0;
  }
}
