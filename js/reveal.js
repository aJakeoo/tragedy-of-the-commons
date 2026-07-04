import { tallyResults } from './scoring.js';
import { startNewRound } from './firebase.js';

let animatedForRound = null;
let cachedResults = null;
let tallyRafId = null;

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

function renderLeaderboard(results) {
  const list = document.getElementById('reveal-list');
  list.innerHTML = '';

  // Reveal order is lowest rank to highest, winner last, per spec.
  const revealOrder = [...results].reverse();

  revealOrder.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = 'reveal-entry' + (r.rank === 1 ? ' winner' : '');
    li.style.animationDelay = `${i * 0.45}s`;

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
    subLine.textContent = contributorsLabel(r) + (r.multiplier > 1 ? ` (${r.multiplier}x weight)` : '');
    info.append(titleLine, subLine);

    const points = document.createElement('span');
    points.className = 'points';
    points.textContent = `${r.weightedPoints} pt${r.weightedPoints === 1 ? '' : 's'}`;

    li.append(rank, info, points);
    list.appendChild(li);
  });

  return revealOrder.length * 0.45 * 1000 + 700; // ms until last entry's animation settles
}

export function render(room, ctx) {
  const round = room.round;
  const roundData = room.rounds?.[round] || {};
  const submissions = roundData.submissions || {};
  const ballots = roundData.ballots || {};

  document.getElementById('host-next-round-controls').classList.toggle('hidden', !ctx.isHost);
  const nextBtn = document.getElementById('next-round-btn');
  nextBtn.onclick = () => {
    nextBtn.disabled = true;
    nextBtn.textContent = 'Starting...';
    startNewRound(ctx.code, round);
  };

  if (animatedForRound === round) {
    // Already played this round's reveal — leave the finished leaderboard as-is
    // instead of replaying it on unrelated snapshot updates (e.g. a stray write).
    return;
  }
  animatedForRound = round;
  if (tallyRafId) cancelAnimationFrame(tallyRafId);

  cachedResults = tallyResults(submissions, ballots);
  const totalRawPoints = cachedResults.reduce((sum, r) => sum + r.rawPoints, 0);

  document.getElementById('reveal-list').innerHTML = '';
  nextBtn.disabled = true;

  runTallyCountUp(totalRawPoints, () => {
    document.getElementById('tally-stage').innerHTML = '';
    const settleMs = renderLeaderboard(cachedResults);
    setTimeout(() => { nextBtn.disabled = false; }, settleMs);
  });
}
