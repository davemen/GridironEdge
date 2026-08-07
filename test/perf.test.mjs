/**
 * The auction engine's answers are pinned, and the hot path stays fast.
 *
 * Run: node test/perf.test.mjs
 *
 * The previous version of this file claimed to pin outputs and did not: its only
 * assertion was a regex on the *shape* of the result string. Two independent
 * auditors proved it — one inflated every bid ceiling by 15%, the other changed
 * BENCH_WEIGHT — and it reported 6 passed both times, while CLAUDE.md and the
 * README both cited it as proof the optimisation changed no answer. The
 * equivalence had in fact been checked, by hand, in a throwaway script; the
 * guard was theatre.
 *
 * So the comparison now lives in the repo. test/fixtures/auction-golden.json
 * holds 360 recommendBid results and 6 planValue plans (value, spend, and the
 * full shopping list) captured across 30 league states. Any change to the
 * planner's answer moves these, and regenerating the fixture
 * (node test/fixtures/regenerate.mjs) is a deliberate, reviewable act.
 *
 * The timing budgets are deliberately loose — this runs on whatever machine
 * executes it, and under coverage instrumentation everything is slower — so they
 * catch a regression of the order the audit found, not milliseconds.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { toPlayerDatabase, findPlayer } from '../js/player-database.js';
import { recommendBid, targetBoard, planValue, lineupPoints }
  from '../js/engine/auction-advisor.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const db = toPlayerDatabase(JSON.parse(readFileSync(join(ROOT, 'data/projections-2026.json'), 'utf8')));
const golden = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/auction-golden.json'), 'utf8'));
const all = Object.values(db).sort((a, b) => b.projectedPoints - a.projectedPoints);

// Coverage instrumentation roughly triples wall-clock, so the budgets relax
// rather than the suite going red on a command the README tells people to run.
const INSTRUMENTED = Boolean(process.env.NODE_V8_COVERAGE);
const budget = (ms) => (INSTRUMENTED ? ms * 4 : ms);

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

/** Must match regenerate.mjs exactly, or the fixture means nothing. */
function league(picks, size, seed) {
  const teams = [];
  for (let i = 0; i < size; i++) {
    teams.push({ teamId: i + 1, teamName: `T${i + 1}`, roster: [], faabRemaining: 200 });
  }
  const selections = [];
  for (let i = 0; i < picks; i++) {
    const t = teams[(i * 7 + seed) % size];
    const p = all[i];
    t.roster.push(p.id);
    const bid = ((i * 13 + seed) % 40) + 1;
    t.faabRemaining -= bid;
    selections.push({ playerId: p.id, teamId: t.teamId, bidAmount: bid });
  }
  return {
    leagueId: 'GOLD', myTeamId: 1, leagueSize: size, teams, playerDatabase: db, schedule: [],
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

console.log('\nevery pinned auction answer still holds');
{
  check('the fixture is substantial', golden.cases.length >= 300, `${golden.cases.length} cases`);
  const byState = new Map();
  let mismatches = [];
  for (const c of golden.cases) {
    const key = `${c.size}|${c.picks}|${c.seed}`;
    if (!byState.has(key)) byState.set(key, league(c.picks, c.size, c.seed));
    const l = byState.get(key);
    const player = all.find((p) => p.name === c.player);
    if (!player) { mismatches.push(`${c.player} missing from the database`); continue; }
    const r = recommendBid(l, player, c.bid);
    const got = [r.maxBid, r.recommendedBid, r.expectedPrice, r.action, r.mustBuy,
                 Math.round(r.lossIfMissed * 100) / 100, r.budgetAfterWin, r.inflation];
    if (JSON.stringify(got) !== JSON.stringify(c.out)) {
      if (mismatches.length < 5) {
        mismatches.push(`${c.player} @$${c.bid} (${c.size}t, ${c.picks} picks): ${JSON.stringify(c.out)} -> ${JSON.stringify(got)}`);
      } else mismatches.push('…');
    }
  }
  check(`all ${golden.cases.length} recommendBid results match the fixture`,
    mismatches.length === 0, mismatches.slice(0, 5).join(' | '));
}

console.log('\nthe planner buys the same players for the same money');
{
  const bad = [];
  for (const plan of golden.plans) {
    const l = league(plan.picks, plan.size, 1);
    const board = all.slice(0, 110).map((p) => ({
      player: p, price: Math.max(1, Math.round(p.projectedSeason / 12)),
    }));
    const d = planValue(l.teams[0].roster.map((id) => db[id]), 140, 9, board, null, true);
    const value = Math.round(d.value * 1e6) / 1e6;
    const bought = d.bought.map((b) => `${b.player.name}@${b.price}`);
    if (value !== plan.value) bad.push(`value ${plan.value} -> ${value}`);
    if (d.spend !== plan.spend) bad.push(`spend ${plan.spend} -> ${d.spend}`);
    if (JSON.stringify(bought) !== JSON.stringify(plan.bought)) {
      bad.push(`shopping list changed at ${plan.size}t/${plan.picks}`);
    }
  }
  check('value, spend and the shopping list are unchanged', bad.length === 0, bad.slice(0, 3).join(' | '));
}

console.log('\nthe lineup value is order-independent');
{
  let worst = 0;
  for (let trial = 0; trial < 200; trial++) {
    const roster = [];
    for (let i = 0; i < 1 + (trial % 16); i++) roster.push(all[(trial * 7 + i * 13) % all.length]);
    worst = Math.max(worst, Math.abs(lineupPoints(roster) - lineupPoints([...roster].reverse())));
  }
  check('shuffling a roster does not change its lineup value', worst < 1e-9, `worst ${worst}`);
}

console.log('\nname resolution is indexed, and actually resolves');
{
  // The previous version measured plain property access on a literal key, so it
  // passed with findPlayer entirely broken. Resolve real names and count hits.
  const names = all.slice(0, 200).map((p) => p.name);
  let resolved = 0;
  const ms = fastest(() => {
    resolved = 0;
    names.forEach((n) => { if (findPlayer(db, n)) resolved++; });
  });
  check('findPlayer resolves the names it is given', resolved >= 195, `${resolved}/200`);
  check('200 lookups stay under budget', ms < budget(8), `${ms.toFixed(1)}ms`);

  // A record with no key must not defeat the index: it once cost 51ms per 190.
  const polluted = { ...db, NO_KEY: { id: 'NO_KEY', name: 'Keyless', position: 'WR' } };
  const dirty = fastest(() => names.forEach((n) => findPlayer(polluted, n)));
  check('one keyless record does not collapse the index', dirty < budget(12), `${dirty.toFixed(1)}ms`);
}

console.log('\nthe hot path stays within budget');
{
  const l = league(12, 12, 0);
  const player = all.find((x) => !l.draftState.selections.some((s) => s.playerId === x.id));
  const tb = fastest(() => targetBoard(l, 8));
  check('targetBoard stays under 250ms', tb < budget(250), `${tb.toFixed(1)}ms`);
  const rb = fastest(() => recommendBid(l, player, 0));
  check('recommendBid stays under 12ms', rb < budget(12), `${rb.toFixed(1)}ms`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
