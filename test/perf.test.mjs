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
 *
 * They are measured as a MEDIAN, not a best-of. A minimum discards exactly the
 * runs that matter: every DOM and scrape finding here has been about a tail,
 * and a best-of-three cannot see one. Two budgets moved when the measurement
 * changed, and they moved because the old numbers described a best case.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { toPlayerDatabase, findPlayer, linearScanCount as linearScans, noteChange, dbRevision, cloneDatabase }
  from '../js/player-database.js';
import { recommendBid, targetBoard, planValue, lineupPoints, targetBoardRecomputes as recomputes,
         lineupShapeBuilds as shapeBuilds }
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

/**
 * A representative time, not a best case.
 *
 * This took the minimum of three runs. A best-of cannot see the regression it
 * is meant to guard against: every DOM and scrape finding in this repo has
 * been about a tail -- the tick where layout was forced, the render that
 * landed on a sale -- and a minimum discards exactly those. The median over
 * nine is stable enough to keep the budgets meaningful while still ignoring
 * the one-off scheduling spike that a strict maximum would trip on.
 */
const fastest = (fn, n = 9) => {
  const runs = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn();
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
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
  // Counted, not timed. `ms < budget(8)` against a measured 0.4ms was 20x of
  // slack, and it was timing the machine: the thing it exists to catch is the
  // index being bypassed, and that IS the linear scan. 200 indexed lookups
  // should scan zero times.
  const scansBefore = linearScans();
  names.forEach((n) => findPlayer(db, n));
  check('and does it from the index, without a linear scan',
    linearScans() - scansBefore <= 5,
    `${linearScans() - scansBefore} full-board scans for 200 known names`);

  // A record with no key must not defeat the index: it once cost 51ms per 190.
  const polluted = { ...db, NO_KEY: { id: 'NO_KEY', name: 'Keyless', position: 'WR' } };
  const dirtyBefore = linearScans();
  names.forEach((n) => findPlayer(polluted, n));
  check('one keyless record does not collapse the index',
    linearScans() - dirtyBefore <= 5,
    `${linearScans() - dirtyBefore} full-board scans with a keyless record present`);
  // The timings stay visible, because a change in the constant factor is worth
  // seeing even when it is not the gate.
  console.log(`       (200 indexed lookups ${ms.toFixed(2)}ms, `
    + `with a keyless record ${fastest(() => names.forEach((n) => findPlayer(polluted, n))).toFixed(2)}ms`
    + ` -- reported, not asserted)`);
}

console.log('\nthe hot path stays within budget');
{
  const l = league(12, 12, 0);
  const player = all.find((x) => !l.draftState.selections.some((s) => s.playerId === x.id));
  // A DISTINCT league per run, or this measures the cache.
  //
  // It called targetBoard nine times on one league, so runs 2-9 were hits and
  // the median was the hit -- 0.02ms against a 250ms budget, a dead assertion
  // with 898x headroom. Moving from min-of-3 to median-of-9 made it strictly
  // worse: with a cache, both the minimum and the median are hits. The header
  // above argues that a best-of cannot see a regression; the same is true of a
  // median taken over a warm cache.
  let coldN = 0;
  const tb = fastest(() => {
    const fresh = league(12, 12, 0);
    fresh.leagueId = `COLD_${coldN++}`;
    targetBoard(fresh, 8);
  });
  /* -------------------------------------------------------------------------
   * Count the work, do not time it.
   *
   * This was `a cold targetBoard stays under 900ms`, and it failed both ways
   * at once. BLIND: round 8 re-introduced the exact regression the old comment
   * named -- the lineup shape allocated inside lineupPointsFromGroups -- and
   * the budget passed 3 runs in 5 at a median of 588ms. FLAKY: on a healthy
   * tree it was red 2 runs in 5 standalone, and six UNMUTATED copies of the
   * tree run in parallel came back six of six red, at 1021-1151ms. That
   * flakiness is not cosmetic -- it made a whole mutation campaign report 224
   * of 224 mutants killed, because every mutant "failed" the suite.
   *
   * The same call is 115ms in a warm process and 664ms as the first thing a
   * process does. The budget was measuring JIT warm-up and machine load.
   *
   * The count is not. Hoisted: 234 shape builds per cold board, one per
   * planValue. Inside the loop: 271,273. A ceiling of 1,000 is two orders of
   * magnitude below the regression and four above the correct value, so it
   * cannot flake and cannot miss.
   * --------------------------------------------------------------------- */
  const shapesBefore = shapeBuilds();
  const coldLeague = JSON.parse(JSON.stringify(l));
  coldLeague.leagueId = `COLD_COUNT_${coldN++}`;
  targetBoard(coldLeague, 8);
  const built = shapeBuilds() - shapesBefore;
  check('a cold targetBoard builds one lineup shape per plan, not per lineup',
    built > 0 && built < 1000, `${built} shape builds`);
  // The timings are still measured and still printed, because a 10x regression
  // is worth seeing -- they are just no longer the gate. Anything the counter
  // cannot see is a change in the constant factor, and this is where it shows.
  console.log(`       (cold targetBoard ${tb.toFixed(0)}ms, `
    + `recommendBid ${fastest(() => recommendBid(l, player, 0)).toFixed(1)}ms `
    + `-- reported, not asserted: see the comment above)`);
}

console.log('\nthe watchlist is not recomputed for a bid that cannot change it');
{
  // targetBoard never reads currentNominationBid, yet it ran on every tick and
  // was 96% of the draft render -- 1,514ms of blocked main thread per
  // nomination against 458ms. Two things have to hold: a bid tick must reuse
  // the answer, and a sale must NOT, or the board goes stale mid-auction and
  // recommends a player somebody just bought.
  const L = league(12, 12, 84);
  L.draftState.currentNomination = 'X';
  L.draftState.currentNominationBid = 1;

  const first = targetBoard(L, 6);
  L.draftState.currentNominationBid = 27;
  const recomputesBefore = recomputes();
  const second = targetBoard(L, 6);

  check('a bid tick returns the identical board',
    JSON.stringify(first) === JSON.stringify(second));
  // Counted, not timed. `tickMs < 2` was a single raw sample standing in for
  // "the cache was used" -- it fails on a slow machine and passes on a fast one
  // with no cache at all, and it is the assertion that flaked at 42.6ms. The
  // board is deterministic, so an identical answer proves nothing about
  // caching either; the recompute count does.
  check('and did not recompute', recomputes() === recomputesBefore,
    `${recomputes() - recomputesBefore} recomputes for a bid that cannot change the board`);

  // An UNATTRIBUTED pick: off the board, but no budget moves, because the
  // scraper could not tell who bought him -- routine in a live auction room.
  // Deliberately not an ordinary sale: that changes a budget too, so it would
  // pass even if the key ignored the pick count entirely. This is the case
  // that isolates it, and it is the case where a stale board would offer a
  // player somebody already owns.
  const sold = Object.values(L.playerDatabase)
    .find((p) => !L.draftState.selections.some((s) => s.playerId === p.id));
  L.draftState.selections.push({ pick: 85, playerId: sold.id, teamId: null, bidAmount: 9 });
  const beforeSale = recomputes();
  const sold2 = targetBoard(L, 6);
  check('a sale forces a recompute rather than serving a stale board',
    recomputes() > beforeSale,
    'the cached board was served for a league that had changed');
  check('and the board it returns reflects the sale',
    !sold2.some((r) => r.player && r.player.id === sold.id),
    'the player who just sold is still on the watchlist');
}

console.log('\nevery input the board reads is in the cache key');
{
  // The block above proves the cache invalidates on a sale. It proved nothing
  // about the other inputs, and an audit found five of them missing from the
  // key: the board was recomputed for a pick and served stale for everything
  // else. These are behavioural, not timed -- a stale serve returns the
  // *identical* board, so "did the answer move" is the assertion that catches
  // it, and a timing threshold is not.
  const mutations = [
    // Read by marketInflation, which declines to answer at all on a partial
    // board. Scraped fresh on every tick.
    ['coverage', (L) => { L.coverage = { kind: 'own-roster-only' }; }],
    // Caps every ceiling on the board, and is scraped from a "max $..."
    // element that flickers number/null as ESPN re-renders around it.
    ['the room maximum', (L) => { L.draftState.currentNominationMax = 5; }],
    ['league size', (L) => { L.leagueSize = 10; }],
    // Changes how many slots the remaining money has to cover.
    ['bench size', (L) => { L.rosterSettings.benchCount = 3; }],
    // The count is unchanged; only the owner moved. This is what a scrape does
    // when it finally learns who bought a lot it could not attribute.
    ['a pick re-attributed', (L) => {
      const s = L.draftState.selections[0];
      s.teamId = s.teamId === 1 ? 2 : 1;
    }],
  ];
  for (const [name, mutate] of mutations) {
    const L = league(12, 12, 84);
    const before = JSON.stringify(targetBoard(L, 6));
    mutate(L);
    check(`${name} moves the board`, JSON.stringify(targetBoard(L, 6)) !== before,
      'the cached board was served for a league that had changed');
  }

  // Two leagues, two player pools. This returned the first room's board.
  const A = league(12, 12, 84);
  const B = league(12, 12, 84);
  B.leagueId = 'OTHER';
  B.playerDatabase = { ...db };
  Object.keys(B.playerDatabase).slice(0, 40).forEach((k) => delete B.playerDatabase[k]);
  check('a second league gets its own board',
    JSON.stringify(targetBoard(A, 6)) !== JSON.stringify(targetBoard(B, 6)));

  // One entry meant two rooms alternating never hit -- worse than no cache,
  // because it paid for the key and recomputed anyway.
  // Counted, not timed. This was `alt < budget(20)` against a measured 0.1ms --
  // 200x of slack, on an assertion whose exact instrument was already imported
  // at the top of this file. WATCHLIST_CACHE_MAX 4 -> 1, the precise regression
  // the comment at auction-advisor.js:844 describes ("0% hit rate and 127.9ms
  // per tick"), passed it.
  targetBoard(A, 6); targetBoard(B, 6);
  const altBefore = recomputes();
  for (let i = 0; i < 20; i++) { targetBoard(A, 6); targetBoard(B, 6); }
  check('two rooms alternating still hit the cache',
    recomputes() === altBefore, `${recomputes() - altBefore} recomputes over 40 calls`);

  // A rewrite of every projection at the SAME key count must move the board.
  //
  // This is the boot sequence: the app renders from stored state, then the real
  // projections resolve and refreshStoredDatabase replaces every record in
  // place. The count does not change, so a key built on Object.keys(db).length
  // served the previous board -- a different player at the top, with a
  // different ceiling, on the page whose whole job is the ceiling.
  {
    const L = league(12, 12, 84);
    L.playerDatabase = { ...db };
    const before = JSON.stringify(targetBoard(L, 6));
    Object.keys(L.playerDatabase).forEach((id) => {
      const p = L.playerDatabase[id];
      L.playerDatabase[id] = { ...p, projectedPoints: p.projectedPoints * (1 + (Number(id.length % 7) / 10)) };
    });
    noteChange(L.playerDatabase);
    check('rewriting every projection at the same count moves the board',
      JSON.stringify(targetBoard(L, 6)) !== before,
      'the cached board survived a database it no longer describes');
    check('and the pool size really was unchanged',
      Object.keys(L.playerDatabase).length === Object.keys(db).length);
  }

  // A fresh database object per tick must NOT look like a fresh database.
  //
  // The mapper builds its pool with a copy on every sync. Object.assign and
  // spread drop non-enumerable properties, so the revision fell back to 0 each
  // time -- and 0 then meant both "nobody has written to this" and "the pool
  // from the last thirty ticks". The cache served a board computed before the
  // boot-time heal: a different player at the top, with a different ceiling.
  {
    const base = league(12, 12, 84);
    base.playerDatabase = cloneDatabase(db);
    noteChange(base.playerDatabase);          // as the boot heal does
    const healed = JSON.stringify(targetBoard(base, 6));
    const healedRev = dbRevision(base.playerDatabase);

    // The next sync tick: same content, a brand-new object.
    const tick = { ...base, playerDatabase: cloneDatabase(base.playerDatabase) };
    check('a copy carries the revision of what it copied',
      dbRevision(tick.playerDatabase) === healedRev,
      `${dbRevision(tick.playerDatabase)} against ${healedRev}`);
    check('so the same content still hits the cache',
      JSON.stringify(targetBoard(tick, 6)) === healed);

    // And two databases each written to once are not the same database.
    const a = {}, b = {};
    noteChange(a); noteChange(b);
    check('two independently-written databases get different revisions',
      dbRevision(a) !== dbRevision(b), `${dbRevision(a)} and ${dbRevision(b)}`);
    check('and an unwritten database is not revision-equal to a written one',
      dbRevision({}) !== dbRevision(a));
  }

  // The board is handed to renderers that sort it. Returning the cached array
  // itself let one caller rewrite what every later caller received.
  const L = league(12, 12, 84);
  const handed = targetBoard(L, 6);
  const expected = JSON.stringify(handed);
  handed.reverse();
  check('a caller sorting the board cannot poison the cache',
    JSON.stringify(targetBoard(L, 6)) === expected);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
