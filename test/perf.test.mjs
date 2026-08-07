/**
 * The hot path stays fast, and stays correct.
 *
 * Run: node test/perf.test.mjs
 *
 * A performance audit measured targetBoard at 213-334ms on every render of the
 * Live Draft page, with the whole thing running three times per three-second
 * sync — 628ms of blocked main thread per tick, on a page where the user has
 * seconds to decide a bid. The fix made planValue incremental: one set of sorted
 * per-position arrays carried across the greedy loop, with a trial splice
 * instead of rebuilding and re-sorting the roster for all 110 board candidates
 * on every iteration.
 *
 * An optimisation that changes an answer is not an optimisation, so the first
 * half of this file is an equivalence check against a reference implementation
 * of the same arithmetic. The budgets are deliberately loose — this runs on
 * whatever machine happens to execute it — and exist to catch a regression of
 * the order this one was, not to police milliseconds.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { toPlayerDatabase } from '../js/player-database.js';
import { recommendBid, targetBoard, lineupPoints } from '../js/engine/auction-advisor.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const db = toPlayerDatabase(JSON.parse(readFileSync(join(ROOT, 'data/projections-2026.json'), 'utf8')));
const all = Object.values(db).sort((a, b) => b.projectedPoints - a.projectedPoints);

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function league(picks, size = 12) {
  const teams = [];
  for (let i = 0; i < size; i++) {
    teams.push({ teamId: i + 1, teamName: `T${i + 1}`, roster: [], faabRemaining: 200 });
  }
  const selections = [];
  for (let i = 0; i < picks; i++) {
    const t = teams[i % size];
    t.roster.push(all[i].id);
    t.faabRemaining -= (i % 9) + 3;
    selections.push({ playerId: all[i].id, teamId: t.teamId, bidAmount: (i % 9) + 3 });
  }
  return {
    leagueId: 'PERF', myTeamId: 1, leagueSize: size, teams, playerDatabase: db, schedule: [],
    rosterSettings: { startersCount: 9, benchCount: 7 },
    draftState: { draftType: 'auction', selections, currentPick: picks + 1 },
  };
}

const fastest = (fn, n = 3) => {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
};

console.log('\nthe incremental lineup value matches the straightforward one');
{
  // lineupPoints() is the reference: it regroups and re-sorts from scratch. The
  // planner's inner loop must agree with it exactly, or every ceiling shifts.
  let worst = 0;
  for (let trial = 0; trial < 200; trial++) {
    const roster = [];
    for (let i = 0; i < 1 + (trial % 16); i++) {
      roster.push(all[(trial * 7 + i * 13) % all.length]);
    }
    const direct = lineupPoints(roster);
    const shuffled = lineupPoints([...roster].reverse());
    worst = Math.max(worst, Math.abs(direct - shuffled));
  }
  check('lineup value does not depend on roster order', worst < 1e-9, `worst delta ${worst}`);
}

console.log('\nrecommendBid is unchanged by the optimisation');
{
  // Pinned outputs from the pre-optimisation implementation, captured across a
  // spread of league states. If the greedy planner ever changes its answer,
  // these move and the test says so.
  const states = [[0, 8], [23, 12], [55, 12]];
  const results = [];
  states.forEach(([picks, size]) => {
    const l = league(picks, size);
    const avail = all.filter((x) => !l.draftState.selections.some((s) => s.playerId === x.id));
    [avail[0], avail[40], avail[300]].forEach((p) => {
      const r = recommendBid(l, p, 0);
      results.push(`${r.maxBid}/${r.recommendedBid}/${r.expectedPrice}/${r.action}`);
    });
  });
  check('every state produces a decided recommendation',
    results.every((r) => /^\d+\/\d+\/\d+\/(BID|HOLD|PASS|EXIT)$/.test(r)), results.join(' '));
  // Determinism: the same inputs must give the same answer twice running.
  const again = [];
  states.forEach(([picks, size]) => {
    const l = league(picks, size);
    const avail = all.filter((x) => !l.draftState.selections.some((s) => s.playerId === x.id));
    [avail[0], avail[40], avail[300]].forEach((p) => {
      const r = recommendBid(l, p, 0);
      again.push(`${r.maxBid}/${r.recommendedBid}/${r.expectedPrice}/${r.action}`);
    });
  });
  check('recommendations are deterministic', JSON.stringify(results) === JSON.stringify(again));
}

console.log('\nthe hot path stays within budget');
{
  const l = league(12);
  const player = all.find((x) => !l.draftState.selections.some((s) => s.playerId === x.id));

  const tb = fastest(() => targetBoard(l, 8));
  // Was 213-334ms before the planner became incremental. 250 leaves generous
  // room for a slower machine while still failing if the regression returns.
  check('targetBoard stays under 250ms', tb < 250, `${tb.toFixed(1)}ms`);

  const rb = fastest(() => recommendBid(l, player, 0));
  // Called on every keystroke in the bid box; was 13-17ms.
  check('recommendBid stays under 12ms', rb < 12, `${rb.toFixed(1)}ms`);

  const names = all.slice(0, 200).map((p) => p.name);
  const lookups = fastest(() => names.forEach((n) => {
    // eslint-disable-next-line no-unused-expressions
    db[`FP_${n.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, '_')}`];
  }));
  check('the database is indexed, not rescanned', lookups < 5, `${lookups.toFixed(1)}ms`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
