import { voteToSkip } from './firebase.js';
import { tallySkipVotes } from './scoring.js';

// Guest-facing "vote to skip this clip" button. Runs in BOTH play modes -
// in guess mode it sits under the who-submitted-this prompt, in funniest
// mode under the "eyes on the big screen" note - because wanting out of a
// bad clip has nothing to do with which mini-game the room picked.
//
// Scoped to whichever clip the host's feed is snapped to, via the same
// rounds.{round}.activeEntryId the guess prompt already keys off (written
// from presenter.js on every real active-clip change, first clip included).
//
// A vote is one-way and one-shot per clip: the button pops, turns red, and
// locks. It resets when activeEntryId moves to a different entry, which is
// structural rather than a flag anyone has to clear - the same locking
// pattern guessing.js uses.

let renderedKey = null; // `${round}:${activeEntryId}` - identifies the clip currently being voted on
let bound = false;
let pendingKey = null; // key whose write is in flight / optimistically shown as voted

function playPressAnimation(btn) {
  // Restart the keyframes rather than relying on class toggling alone - a
  // second press (after a failed write) would otherwise not re-animate.
  btn.classList.remove('pop');
  void btn.offsetWidth;
  btn.classList.add('pop');
}

export function render(room, ctx) {
  const panel = document.getElementById('skip-vote-panel');
  const btn = document.getElementById('skip-vote-btn');
  const label = document.getElementById('skip-vote-label');
  const tally = document.getElementById('skip-vote-tally');

  const round = room.round;
  const roundData = room.rounds?.[round] || {};
  const activeEntryId = roundData.activeEntryId || null;
  const entry = activeEntryId ? roundData.submissions?.[activeEntryId] : null;

  // The host runs the feed and gets the skip PROMPT instead (presenter.js).
  // With no clip active (before the feed starts, or on the end card) there's
  // nothing to vote on.
  if (ctx.isHost || !entry) {
    panel.classList.add('hidden');
    renderedKey = null;
    return;
  }
  panel.classList.remove('hidden');

  const key = `${round}:${activeEntryId}`;
  if (renderedKey !== key) {
    renderedKey = key;
    btn.classList.remove('pop');
  }

  if (!bound) {
    bound = true;
    btn.addEventListener('click', async () => {
      // Read the live snapshot rather than this render's closure - by the
      // time a tap lands, the feed may already have moved to another clip.
      const r = window.__totcCurrentRoom;
      const rnd = r?.round;
      const id = r?.rounds?.[rnd]?.activeEntryId;
      if (!id) return;
      const voteKey = `${rnd}:${id}`;
      if (pendingKey === voteKey) return;

      pendingKey = voteKey;
      playPressAnimation(btn);
      navigator.vibrate?.(35); // no-op on desktop and on iOS Safari
      applyVotedState(btn, label, true);

      try {
        await voteToSkip(ctx.code, rnd, id, ctx.playerId);
      } catch {
        // Hand the button back rather than leaving a red "requested" state
        // for a vote that never actually counted.
        if (pendingKey === voteKey) pendingKey = null;
        if (renderedKey === voteKey) {
          applyVotedState(btn, label, false);
          tally.textContent = "Couldn't register that - tap to try again.";
        }
      }
    });
  }

  const stats = tallySkipVotes(roundData, activeEntryId, room.players, room.host);
  const confirmed = !!roundData.skipVotes?.[activeEntryId]?.[ctx.playerId];
  const hasVoted = confirmed || pendingKey === key;
  if (confirmed && pendingKey === key) pendingKey = null;

  applyVotedState(btn, label, hasVoted);

  if (stats.reached) {
    const verb = stats.voted === 1 ? 'wants' : 'want';
    tally.textContent = `${stats.voted} of ${stats.eligible} ${verb} out - over to the host.`;
  } else if (stats.voted > 0) {
    const need = stats.threshold - stats.voted;
    tally.textContent = `${stats.voted} of ${stats.threshold} votes - ${need} more prompts the host.`;
  } else {
    tally.textContent = `Takes ${stats.threshold} of ${stats.eligible} to prompt the host.`;
  }
}

function applyVotedState(btn, label, voted) {
  btn.classList.toggle('voted', voted);
  btn.disabled = voted;
  label.textContent = voted ? 'Skip requested' : 'Skip this clip';
}
