// Shared error surfacing for game.html's phase modules — all four phases
// share the single #game-error element, so a stuck host action always shows
// up in the same place instead of failing silently.
export function showPhaseError(err) {
  const el = document.getElementById('game-error');
  el.textContent = err?.message === 'TIMED_OUT'
    ? "That took too long — check your connection and try again."
    : 'Something went wrong — try again.';
  el.classList.remove('hidden');
}
