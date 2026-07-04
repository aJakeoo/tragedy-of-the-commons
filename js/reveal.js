import { tallyResults } from './scoring.js';
import { startNewRound } from './firebase.js';
import { showPhaseError } from './uiError.js';

let animatedForRound = null;
let cachedResults = null;
let tallyRafId = null;
const pendingTimers = [];

const ROW_STAGGER_MS = 450; // matches each <li>'s own CSS entrance stagger
const ROW_ENTRANCE_BUFFER_MS = 600; // let the row's entrance animation settle first
const VOTER_STEP_MS = 350; // delay between each "Name +N" line appearing
const FLOURISH_BUFFER_MS = 400; // pause after the last voter before the weighted-total flourish

function contributorsLabel(entry) {
  const names = (entry.contributors || []).map(c => c.name);
  if (names.length === 0) return '';
  if (names.length === 1) return `Submitted by ${names[0]}`;
  if (names.length === 2) return `${names[0]} & ${names[1]} — submitted this together`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]} — submitted this together`;
}

function runTallyCountUp(totalRawPoints, onDone) {
  const stage = document.getElementById('tally-stage');
  stage.innerHTML = '<p class="muted" style="text-align:center">Tallying votes&hellip;</p><div class="tally-count" id="tally-number">0</div>';
  const numberEl = document.getElementById('tally-number');
  const durationMs = 900;
  const start = performance.now();

  function frame(now) {
    const t = Math.min(1, (now - start) / durationMs);
    numberEl.textContent = Math.round(t * totalRawPoints);
    if (t < 1) {
      tallyRafId = requestAnimationFrame(frame);
    } else {
      onDone();
    }
  }
  tallyRafId = requestAnimationFrame(frame);
}

// Reveals a single row's voter breakdown ("Tommy +4", then "Randy +2")
// one at a time, bumping the row's displayed total after each — the point
// is to show votes *flowing into* the total rather than an abstract number
// counting up on its own. Voter identity is always shown here regardless of
// the presenter phase's submitter-attribution toggle — that toggle only
// ever hides who *submitted* a clip, a separate concern from who voted for
// it, which is public at reveal time. Returns ms until this row's sequence
// (including the final weighted-total flourish) is fully settled.
function revealVoterBreakdown(row, result, players, startDelayMs) {
  const breakdownEl = row.querySelector('.voter-breakdown');
  const pointsEl = row.querySelector('.points');
  const voters = result.voterBreakdown || [];

  if (voters.length === 0) {
    pendingTimers.push(setTimeout(() => {
      pointsEl.textContent = '0 pts';
    }, startDelayMs));
    return startDelayMs;
  }

  let runningRaw = 0;
  voters.forEach((v, i) => {
    const delay = startDelayMs + i * VOTER_STEP_MS;
    pendingTimers.push(setTimeout(() => {
      const name = players?.[v.playerId]?.name || 'Someone';
      const line = document.createElement('div');
      line.className = 'voter-line';
      line.textContent = `${name} +${v.points}`;
      breakdownEl.appendChild(line);
      runningRaw += v.points;
      pointsEl.textContent = `${runningRaw} pt${runningRaw === 1 ? '' : 's'}`;
    }, delay));
  });

  const lastVoterDelay = startDelayMs + (voters.length - 1) * VOTER_STEP_MS;
  const flourishDelay = lastVoterDelay + FLOURISH_BUFFER_MS;
  pendingTimers.push(setTimeout(() => {
    if (result.multiplier > 1) {
      const multiplierNote = document.createElement('div');
      multiplierNote.className = 'muted';
      multiplierNote.textContent = `${result.rawPoints} raw × ${result.multiplier} weight`;
      breakdownEl.appendChild(multiplierNote);
    }
    pointsEl.textContent = `${result.weightedPoints} pt${result.weightedPoints === 1 ? '' : 's'}`;
    pointsEl.classList.add('points-final');
  }, flourishDelay));

  return flourishDelay + 300;
}

function renderLeaderboard(results, players) {
  const list = document.getElementById('reveal-list');
  list.innerHTML = '';

  // Reveal order is lowest rank to highest, winner last, per spec.
  const revealOrder = [...results].reverse();
  let maxSettleMs = 0;

  revealOrder.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = 'reveal-entry' + (r.rank === 1 ? ' winner' : '');
    const rowDelayMs = i * ROW_STAGGER_MS;
    li.style.animationDelay = `${rowDelayMs / 1000}s`;

    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = `#${r.rank}`;

    const info = document.createElement('span');
    info.style.flex = '1';
    info.style.margin = '0 0.75rem';
    const titleLine = document.createElement('div');
    titleLine.textContent = `${r.platform === 'tiktok' ? 'TikTok' : 'Instagram Reels'} — ${r.title || r.url}`;
    const subLine = document.createElement('div');
    subLine.className = 'muted';
    subLine.textContent = contributorsLabel(r);
    const breakdown = document.createElement('div');
    breakdown.className = 'voter-breakdown';
    info.append(titleLine, subLine, breakdown);

    const points = document.createElement('span');
    points.className = 'points';
    points.textContent = '0 pts';

    li.append(rank, info, points);
    list.appendChild(li);

    const voterStartDelay = rowDelayMs + ROW_ENTRANCE_BUFFER_MS;
    const settleMs = revealVoterBreakdown(li, r, players, voterStartDelay);
    maxSettleMs = Math.max(maxSettleMs, settleMs);
  });

  return maxSettleMs;
}

export function render(room, ctx) {
  const round = room.round;
  const roundData = room.rounds?.[round] || {};
  const submissions = roundData.submissions || {};
  const ballots = roundData.ballots || {};
  const players = room.players || {};

  document.getElementById('host-next-round-controls').classList.toggle('hidden', !ctx.isHost);
  const nextBtn = document.getElementById('next-round-btn');
  nextBtn.onclick = async () => {
    nextBtn.disabled = true;
    nextBtn.textContent = 'Starting...';
    try {
      await startNewRound(ctx.code, round);
    } catch (err) {
      nextBtn.disabled = false;
      nextBtn.textContent = 'Start next round';
      showPhaseError(err);
    }
  };

  if (animatedForRound === round) {
    // Already played this round's reveal — leave the finished leaderboard as-is
    // instead of replaying it on unrelated snapshot updates (e.g. a stray write).
    return;
  }
  animatedForRound = round;
  if (tallyRafId) cancelAnimationFrame(tallyRafId);
  pendingTimers.forEach(clearTimeout);
  pendingTimers.length = 0;

  cachedResults = tallyResults(submissions, ballots);
  const totalRawPoints = cachedResults.reduce((sum, r) => sum + r.rawPoints, 0);

  document.getElementById('reveal-list').innerHTML = '';
  nextBtn.disabled = true;

  runTallyCountUp(totalRawPoints, () => {
    document.getElementById('tally-stage').innerHTML = '';
    const settleMs = renderLeaderboard(cachedResults, players);
    pendingTimers.push(setTimeout(() => { nextBtn.disabled = false; }, settleMs));
  });
}
