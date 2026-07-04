import { submitBallot, revealResults } from './firebase.js';
import { VOTE_POINT_BUDGET } from './config.js';
import { showPhaseError } from './uiError.js';

let draft = {}; // { [entryId]: points }
let boundRound = null;

function renderEntries(entries, budget, ctx) {
  const container = document.getElementById('ballot-entries');
  container.innerHTML = '';

  entries.forEach(([entryId, entry]) => {
    const div = document.createElement('div');
    div.className = 'ballot-entry';

    const title = document.createElement('div');
    title.textContent = `${entry.platform === 'tiktok' ? 'TikTok' : 'Instagram Reels'} — ${entry.title || entry.url}`;
    div.appendChild(title);

    const link = document.createElement('a');
    link.href = entry.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open clip';
    div.appendChild(link);

    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = 'Points:';
    label.style.margin = '0';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = String(budget);
    input.className = 'points-input';
    input.value = draft[entryId] || 0;
    input.addEventListener('input', () => {
      const val = Math.max(0, parseInt(input.value, 10) || 0);
      draft[entryId] = val;
      updateBudgetDisplay(entries, budget);
    });
    row.append(label, input);
    div.appendChild(row);

    container.appendChild(div);
  });
}

function budgetSpent() {
  return Object.values(draft).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

function updateBudgetDisplay(entries, budget) {
  const spent = budgetSpent();
  const remaining = budget - spent;
  const el = document.getElementById('budget-remaining');
  el.textContent = `${remaining} / ${budget}`;
  el.classList.toggle('over', remaining < 0);
  document.getElementById('submit-ballot-btn').disabled = remaining < 0;
}

export function render(room, ctx) {
  const round = room.round;
  const roundData = room.rounds?.[round] || {};
  const submissions = roundData.submissions || {};
  const ballots = roundData.ballots || {};
  const budget = room.config?.votePointBudget ?? VOTE_POINT_BUDGET;

  const eligible = Object.entries(submissions).filter(
    ([, entry]) => !(entry.contributors || []).some(c => c.id === ctx.playerId)
  );

  if (boundRound !== round) {
    boundRound = round;
    draft = { ...(ballots[ctx.playerId] || {}) };
    document.getElementById('ballot-submitted-note').classList.toggle('hidden', !ballots[ctx.playerId]);
    const revealBtn = document.getElementById('reveal-results-btn');
    revealBtn.disabled = false;
    revealBtn.textContent = 'Reveal results';
  }

  renderEntries(eligible, budget, ctx);
  updateBudgetDisplay(eligible, budget);

  const submitBtn = document.getElementById('submit-ballot-btn');
  submitBtn.onclick = async () => {
    const cleanBallot = {};
    for (const [entryId, points] of Object.entries(draft)) {
      if (points > 0) cleanBallot[entryId] = points;
    }
    try {
      await submitBallot(ctx.code, round, ctx.playerId, cleanBallot);
      document.getElementById('ballot-submitted-note').classList.remove('hidden');
    } catch (err) {
      showPhaseError(err);
    }
  };

  const players = room.players || {};
  const totalPlayers = Object.keys(players).length;
  const submittedCount = Object.keys(ballots).length;
  document.getElementById('voting-progress').textContent =
    `${submittedCount} of ${totalPlayers} player${totalPlayers === 1 ? '' : 's'} have voted.`;

  document.getElementById('host-reveal-controls').classList.toggle('hidden', !ctx.isHost);
  const revealBtn = document.getElementById('reveal-results-btn');
  revealBtn.onclick = async () => {
    revealBtn.disabled = true;
    revealBtn.textContent = 'Revealing...';
    try {
      await revealResults(ctx.code);
    } catch (err) {
      revealBtn.disabled = false;
      revealBtn.textContent = 'Reveal results';
      showPhaseError(err);
    }
  };
}
