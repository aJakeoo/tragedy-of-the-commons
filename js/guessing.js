import { submitGuess } from './firebase.js';

// Guest-facing "who submitted this one?" prompt, synced to whichever clip
// the host's feed is currently snapped to (rounds.{round}.activeEntryId,
// written from presenter.js/embeds.js). Host-only, mirroring the host-only
// feed itself - the host is busy watching the shared screen, not guessing.
//
// Locking is structural, not a write/flag: once activeEntryId moves to a
// different entry, this module's next render rebuilds the options for the
// NEW entry - there is no remaining UI path back to the old entry's
// buttons, so whatever was last written for it simply stands. A guess
// submitted after the fact (there is no server-side check preventing a
// stale write) has no UI to fire from, so this holds in practice without
// needing a lock field.

let renderedKey = null; // `${round}:${activeEntryId}` - rebuild options only when this changes

export function render(room, ctx) {
  const placeholder = document.getElementById('guess-placeholder');
  const panel = document.getElementById('guess-panel');
  const optionsWrap = document.getElementById('guess-options');
  const ownNote = document.getElementById('guess-own-note');

  if (ctx.isHost) {
    // presenter.js already hides #guest-compiling-view entirely for the
    // host; nothing to render here.
    panel.classList.add('hidden');
    return;
  }

  const round = room.round;
  const roundData = room.rounds?.[round] || {};
  const submissions = roundData.submissions || {};
  const activeEntryId = roundData.activeEntryId || null;
  const entry = activeEntryId ? submissions[activeEntryId] : null;

  if (!entry) {
    placeholder.classList.remove('hidden');
    panel.classList.add('hidden');
    renderedKey = null;
    return;
  }
  placeholder.classList.add('hidden');
  panel.classList.remove('hidden');

  const isContributor = (entry.contributors || []).some(c => c.id === ctx.playerId);
  if (isContributor) {
    optionsWrap.classList.add('hidden');
    ownNote.classList.remove('hidden');
    return;
  }
  ownNote.classList.add('hidden');
  optionsWrap.classList.remove('hidden');

  const key = `${round}:${activeEntryId}`;
  if (renderedKey !== key) {
    renderedKey = key;
    optionsWrap.innerHTML = '';
    const players = room.players || {};
    Object.entries(players).forEach(([playerId, player]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'guess-option';
      btn.textContent = player.name;
      btn.dataset.playerId = playerId;
      btn.addEventListener('click', () => {
        optionsWrap.querySelectorAll('.guess-option').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        submitGuess(ctx.code, round, activeEntryId, ctx.playerId, playerId).catch(() => {});
      });
      optionsWrap.appendChild(btn);
    });
  }

  const myGuess = roundData.guesses?.[activeEntryId]?.[ctx.playerId];
  optionsWrap.querySelectorAll('.guess-option').forEach(b => {
    b.classList.toggle('selected', b.dataset.playerId === myGuess);
  });
}
