import { submitBallot, revealResults } from './firebase.js';
import { VOTE_POINT_BUDGET } from './config.js';
import { showPhaseError } from './uiError.js';

let draft = {}; // { [entryId]: points }
let boundRound = null;

function budgetSpent() {
  return Object.values(draft).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

function renderEntries(entries, budget) {
  const container = document.getElementById('ballot-entries');
  container.innerHTML = '';
  const remaining = budget - budgetSpent();

  entries.forEach(([entryId, entry]) => {
    const div = document.createElement('div');
    div.className = 'ballot-entry';

    const title = document.createElement('div');
    title.textContent = `${entry.platform === 'tiktok' ? 'TikTok' : 'Instagram Reels'} — ${entry.title || entry.url}`;
    div.appendChild(title);

    if ((entry.contributors || []).length > 1) {
      const badge = document.createElement('span');
      badge.className = 'weight-badge';
      badge.textContent = `×${entry.contributors.length} weight`;
      div.appendChild(badge);
    }

    const link = document.createElement('a');
    link.href = entry.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open clip';
    div.appendChild(link);

    const points = draft[entryId] || 0;

    const row = document.createElement('div');
    row.className = 'points-control';

    const decBtn = document.createElement('button');
    decBtn.type = 'button';
    decBtn.className = 'point-btn';
    decBtn.textContent = '–';
    decBtn.disabled = points <= 0;
    decBtn.setAttribute('aria-label', 'Remove a point');
    decBtn.addEventListener('click', () => {
      if (draft[entryId] > 0) draft[entryId]--;
      renderEntries(entries, budget);
      updateBudgetDisplay(budget);
    });

    const pointsDisplay = document.createElement('span');
    pointsDisplay.className = 'points-display';
    pointsDisplay.textContent = points;

    const incBtn = document.createElement('button');
    incBtn.type = 'button';
    incBtn.className = 'point-btn';
    incBtn.textContent = '+';
    incBtn.disabled = remaining <= 0;
    incBtn.setAttribute('aria-label', 'Add a point');
    incBtn.addEventListener('click', () => {
      if (budget - budgetSpent() > 0) draft[entryId] = (draft[entryId] || 0) + 1;
      renderEntries(entries, budget);
      updateBudgetDisplay(budget);
    });

    row.append(decBtn, pointsDisplay, incBtn);
    div.appendChild(row);

    container.appendChild(div);
  });
}

function updateBudgetDisplay(budget) {
  const remaining = budget - budgetSpent();
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

  renderEntries(eligible, budget);
  updateBudgetDisplay(budget);

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
