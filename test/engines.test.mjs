/**
 * The three engines nothing tested: simulator, lineup-optimizer, trade-generator.
 *
 * Run: node test/engines.test.mjs
 *
 * A mutation run over the whole repo found these were the largest holes left.
 * `runSeasonSimulation` could be replaced by `return { playoffPct: 50,
 * champPct: 50, byePct: 50, actionPlan: [] }` and every suite passed,
 * because the only assertion anywhere near it was that the championship figure
 * on the home page contains a digit -- which "50%" does, and so does an
 * invented number. `optimizeLineup` could return null for every roster and
 * pass. `generateTradeProposals` had a live TypeError that three pages called
 * unguarded.
 *
 * So these assert BEHAVIOUR, not shape. A constant cannot satisfy a
 * monotonicity check: the whole point is that a stronger roster must score
 * higher than a weaker one, which no hardcoded answer can do.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
globalThis.localStorage = {
  getItem: () => null, setItem() {}, removeItem() {},
};
const projections = JSON.parse(readFileSync(join(ROOT, 'data/projections-2026.json'), 'utf8'));
globalThis.fetch = async () => ({ ok: true, json: async () => projections });

const { toPlayerDatabase } = await import(join(ROOT, 'js/player-database.js'));
const { runSeasonSimulation } = await import(join(ROOT, 'js/engine/simulator.js'));
const { optimizeLineup } = await import(join(ROOT, 'js/engine/lineup-optimizer.js'));
const { generateTradeProposals } = await import(join(ROOT, 'js/engine/trade-generator.js'));
const { slotList, starterSlots, openStarterSlots, flexCount, startersCount, rosterSize,
        DEFAULT_ROSTER_SETTINGS } = await import(join(ROOT, 'js/engine/lineup-rules.js'));
const { survivalProbability, survivalPct } = await import(join(ROOT, 'js/engine/survival.js'));

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const db = toPlayerDatabase(projections);
const board = Object.values(db).sort((a, b) => b.projectedPoints - a.projectedPoints);

const ROSTER_SETTINGS = {
  QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, 'D/ST': 1, K: 1, BE: 7,
  startersCount: 9, benchCount: 7,
};

/** A league where team 1 draws from `offset` down the board. */
function leagueWith(offset, teamCount = 10) {
  const teams = [];
  for (let i = 1; i <= teamCount; i++) {
    const from = i === 1 ? offset : 20 * i;
    teams.push({
      teamId: i, teamName: `Team ${i}`,
      roster: board.slice(from, from + 12).map((p) => p.id),
      faabRemaining: 100, record: { wins: 0, losses: 0, ties: 0 },
      pointsScored: 0, pointsAllowed: 0,
    });
  }
  const schedule = [];
  for (let w = 5; w <= 14; w++) {
    for (let i = 1; i < teamCount; i += 2) {
      schedule.push({ week: w, team1Id: i, team2Id: i + 1, completed: false });
    }
  }
  return {
    leagueId: 'ENG', leagueSize: teamCount, myTeamId: 1, teams, schedule,
    scoringFormat: 'PPR', rosterSettings: ROSTER_SETTINGS,
    waiverSettings: { faabBudget: 100, waiverType: 'FAAB', processingDays: [] },
    draftState: { draftType: 'auction', selections: [] },
    playerDatabase: db,
  };
}

console.log('\nthe simulator answers from the rosters, not from constants');
{
  const strong = runSeasonSimulation(leagueWith(0), 300);
  const weak = runSeasonSimulation(leagueWith(220), 300);

  // The assertion a hardcoded return cannot satisfy, whatever value it picks.
  check('a better roster wins the title more often',
    strong.champPct > weak.champPct,
    `strong ${strong.champPct}% vs weak ${weak.champPct}%`);
  check('a better roster makes the playoffs more often',
    strong.playoffPct > weak.playoffPct,
    `strong ${strong.playoffPct}% vs weak ${weak.playoffPct}%`);
  // The bracket used six hardcoded means and never read a roster, so the
  // championship number was noise wearing the clothes of a forecast.
  check('the title chance is a probability',
    strong.champPct >= 0 && strong.champPct <= 100
      && weak.champPct >= 0 && weak.champPct <= 100);
  check('winning the title is never likelier than reaching the playoffs',
    strong.champPct <= strong.playoffPct,
    `${strong.champPct}% champ vs ${strong.playoffPct}% playoff`);
  check('a bye is never likelier than a playoff berth',
    strong.byePct <= strong.playoffPct);
}

console.log('\nthe lineup optimizer fills the lineup and benches the injured');
{
  const league = leagueWith(0);
  const roster = league.teams[0].roster;

  const lineup = optimizeLineup(roster, db, ROSTER_SETTINGS, 'balanced');
  check('it returns a lineup at all', lineup && Array.isArray(lineup.starters),
    lineup === null ? 'returned null' : typeof lineup);

  if (lineup && lineup.starters) {
    // A CEILING is what this used to assert -- starters.length <= 9 -- and four
    // of the nine slots could then be deleted from the optimizer with the suite
    // still green: the second RB, the second WR, the kicker and the defense all
    // vanished undetected. Assert the exact slots the roster can actually fill.
    const want = slotList(ROSTER_SETTINGS).filter((slot) => {
      const eligible = slot.isFlex ? slot.pos : [slot.pos];
      return roster.some((id) => db[id] && eligible.includes(db[id].position));
    });
    check('it seats every slot the roster can fill, and no more',
      lineup.starters.length === want.length,
      `${lineup.starters.length} starters against ${want.length} fillable slots`);
    // Composition, not just the count: two RBs where the league starts one RB
    // and one TE is the same number of players and a different lineup.
    const wantPos = {};
    slotList(ROSTER_SETTINGS).filter((sl) => !sl.isFlex).forEach((sl) => {
      const have = roster.filter((id) => db[id] && db[id].position === sl.pos).length;
      if (have) wantPos[sl.pos] = (wantPos[sl.pos] || 0) + 1;
    });
    const gotPos = {};
    lineup.starters.forEach((p) => { gotPos[p.position] = (gotPos[p.position] || 0) + 1; });
    check('every fixed slot is filled by its own position',
      Object.keys(wantPos).every((pos) => (gotPos[pos] || 0) >= wantPos[pos]),
      `wanted at least ${JSON.stringify(wantPos)}, got ${JSON.stringify(gotPos)}`);
    const ids = lineup.starters.map((p) => p && p.id);
    check('it never starts the same player twice',
      new Set(ids).size === ids.length);
    check('every starter is on the roster',
      lineup.starters.every((p) => p && roster.includes(p.id)));

    // The best available quarterback must start. A silent off-by-one that
    // benched him would otherwise look like an ordinary lineup.
    const qbs = roster.map((id) => db[id]).filter((p) => p && p.position === 'QB')
      .sort((a, b) => b.projectedPoints - a.projectedPoints);
    if (qbs.length) {
      check('the best quarterback is a starter',
        ids.includes(qbs[0].id), `expected ${qbs[0].name}`);
    }
  }

  // An Out player must never be seated. The deduction that enforces this was
  // mutated to zero and every suite passed.
  const withOut = roster.slice();
  const outId = withOut[0];
  const patched = { ...db };
  patched[outId] = { ...db[outId], injuryStatus: 'Out' };
  const guarded = optimizeLineup(withOut, patched, ROSTER_SETTINGS, 'balanced');
  check('a player ruled Out is not started',
    guarded && guarded.starters
      && !guarded.starters.some((p) => p && p.id === outId),
    'an Out player was seated');
}

console.log('\nthe playoff bracket gives no seed a structural advantage');
{
  // The byes used to rejoin only after the rest had been played down to ONE
  // survivor, so the second seed walked straight into the final: over 200,000
  // brackets with six identical teams, seed 2 won 50.1% and seed 1 24.9%, and
  // seeds 3-6 shared 6.2% each. team-strength implements the correct shape 200
  // lines away, and both engines write the same three spans on screen.
  //
  // Six identical rosters, so any spread in the result is the bracket's doing.
  const identical = leagueWith(0, 6);
  const shared = identical.teams[0].roster;
  identical.teams.forEach((t) => { t.roster = shared; });
  identical.draftState.selections = identical.teams.flatMap((t) =>
    t.roster.map((id) => ({ playerId: id, teamId: t.teamId })));

  const pct = identical.teams.map((t) => {
    const l = { ...identical, myTeamId: t.teamId };
    return runSeasonSimulation(l, 1500).champPct;
  });
  const par = 100 / identical.teams.length;
  check('no team wins the title far more often than par',
    Math.max(...pct) < par * 2,
    `par ${par.toFixed(1)}%, spread ${JSON.stringify(pct)}`);

  // By SEED, and at EVERY field size. The by-team check above cannot see this:
  // with identical teams the seeding is random, so no seat consistently gets
  // seed 2. And round 6 fixed only the six-team case -- at four teams the
  // second seed still took 50.0% against the first seed's 25.3%, because the
  // bye count was a flat two whatever the field.
  const { playBracket } = await import(join(ROOT, 'js/engine/simulator.js'));
  const { byeCount } = await import(join(ROOT, 'js/engine/lineup-rules.js'));
  const RUNS = 20000;

  for (const n of [4, 5, 6, 8]) {
    const SEEDS = Array.from({ length: n }, (_, i) => i + 1);
    const equal = Object.fromEntries(SEEDS.map((id) => [id, 100]));
    const titles = Object.fromEntries(SEEDS.map((id) => [id, 0]));
    for (let r = 0; r < RUNS; r++) titles[playBracket(SEEDS, equal)] += 1;
    const pct = SEEDS.map((id) => (titles[id] / RUNS) * 100);
    const byes = byeCount(n);

    // Within a bye tier, equal teams must be equal. Across tiers, a bye is
    // worth something -- but one round, not a walkover.
    const withBye = pct.slice(0, byes);
    const without = pct.slice(byes);
    if (withBye.length > 1) {
      check(`field ${n}: the ${byes} byes are worth the same as each other`,
        Math.max(...withBye) - Math.min(...withBye) < 3,
        JSON.stringify(withBye.map((x) => Number(x.toFixed(1)))));
    }
    check(`field ${n}: teams without a bye are equal to each other`,
      Math.max(...without) - Math.min(...without) < 3,
      JSON.stringify(without.map((x) => Number(x.toFixed(1)))));
    if (byes > 0) {
      check(`field ${n}: and a bye is worth something`,
        Math.min(...withBye) > Math.max(...without),
        JSON.stringify(pct.map((x) => Number(x.toFixed(1)))));
    }
    check(`field ${n}: no seed is a structural favourite`,
      Math.max(...pct) < (100 / n) * 2.5,
      JSON.stringify(pct.map((x) => Number(x.toFixed(1)))));
  }

  // The bye count itself: whatever reaches the next power of two, so the teams
  // that play in the first round reduce evenly alongside the byes.
  check('a power-of-two field needs no byes', byeCount(4) === 0 && byeCount(8) === 0);
  check('and a six-team field needs two', byeCount(6) === 2);
  check('and a five-team field needs three', byeCount(5) === 3);
}

console.log('\nthe simulator declines rather than substituting a constant');
{
  // Every team projection fell back to the literal 105.0 when a roster could
  // not be read, and a league loaded over the ESPN API resolved zero players on
  // every team -- so the Championship page showed playoff odds, championship
  // odds, a bye percentage and a named top rival, none of which came from a
  // projection. 105.0 does not look like a missing value on screen.
  const blind = leagueWith(0);
  blind.teams.forEach((t) => { t.roster = []; });
  const out = runSeasonSimulation(blind, 50);
  check('a league with no readable roster returns unknown, not a percentage',
    out.unknown === true, JSON.stringify(out).slice(0, 120));
  check('and no odds at all', out.champPct === null && out.playoffPct === null
    && out.byePct === null, `${out.champPct}/${out.playoffPct}/${out.byePct}`);
  check('and says which teams it could not read',
    /No roster in this league/.test(out.reason || ''), out.reason);

  // Ids that resolve to nobody are the API case exactly: rosters full of
  // numeric ESPN ids against a database keyed some other way.
  const unresolved = leagueWith(0);
  unresolved.teams.forEach((t) => { t.roster = ['9000001', '9000002']; });
  check('rosters of unresolvable ids are unknown too',
    runSeasonSimulation(unresolved, 50).unknown === true);

  // One blind team is enough: every game it plays would be decided by a
  // substituted score, and it plays half the league.
  const partly = leagueWith(0);
  partly.teams[3].roster = [];
  const half = runSeasonSimulation(partly, 50);
  check('one unreadable team is enough to decline', half.unknown === true);
  check('and it says how many', /1 of 10 teams/.test(half.reason || ''), half.reason);

  // And the ordinary case still answers.
  check('a readable league still returns real odds',
    typeof runSeasonSimulation(leagueWith(0), 50).champPct === 'number');
}

console.log('\nthe league\'s own slot counts drive the lineup');
{
  const roster = leagueWith(0).teams[0].roster;
  const wide = { QB: 2, RB: 2, WR: 3, TE: 1, FLEX: 2, 'D/ST': 1, K: 1, benchCount: 5 };
  const thin = { QB: 1, RB: 1, WR: 1, TE: 0, FLEX: 0, 'D/ST': 0, K: 0, benchCount: 9 };

  const a = optimizeLineup(roster, db, wide, 'floor');
  const b = optimizeLineup(roster, db, thin, 'floor');
  // `settings` was accepted and never read: these two produced byte-identical
  // starters, and three callers passed real league settings into it.
  check('two incompatible leagues do not get the same lineup',
    JSON.stringify(a.starters.map((p) => p.id)) !== JSON.stringify(b.starters.map((p) => p.id)));
  check('a 2QB league starts two quarterbacks',
    a.starters.filter((p) => p.position === 'QB').length === 2,
    `${a.starters.filter((p) => p.position === 'QB').length} QBs`);
  check('a 1QB/1RB/1WR league starts three players',
    b.starters.length === 3, `${b.starters.length} starters`);

  // The flex is ONE slot shared across RB/WR/TE. Counting it per position
  // claimed eight flex-eligible starters where the lineup has six, so a
  // complete roster still reported an open slot.
  const full = openStarterSlots({ QB: 1, RB: 2, WR: 2, TE: 1, 'D/ST': 1, K: 1 });
  check('a full standard roster reports one open slot, the flex',
    Object.values(full).every((n) => n <= 1) && (full.RB === 1 && full.WR === 1 && full.TE === 1),
    JSON.stringify(full));
  const complete = openStarterSlots({ QB: 1, RB: 3, WR: 2, TE: 1, 'D/ST': 1, K: 1 });
  check('and none once the flex is filled', Object.keys(complete).length === 0,
    JSON.stringify(complete));

  // The constants themselves, so a mutation to any of them is caught.
  check('the default shape is 9 starters and 7 bench',
    startersCount() === 9 && rosterSize({}) === 16,
    `${startersCount()} + bench = ${rosterSize({})}`);
  check('a 3-WR 2-flex league is 12 starters', startersCount(wide) === 12,
    String(startersCount(wide)));
  check('slotList numbers duplicate slots and labels the flex',
    slotList().map((sl) => sl.label).join(',') === 'QB,RB1,RB2,WR1,WR2,TE,D/ST,K,FLEX',
    slotList().map((sl) => sl.label).join(','));
  check('two flex slots are labelled apart',
    slotList(wide).filter((sl) => sl.isFlex).map((sl) => sl.label).join(',') === 'FLEX1,FLEX2');
  check('the default settings and the default constants agree',
    startersCount(DEFAULT_ROSTER_SETTINGS) === DEFAULT_ROSTER_SETTINGS.startersCount
      && flexCount(DEFAULT_ROSTER_SETTINGS) === 1);
  check('a league that starts no kicker has no kicker slot',
    slotList(thin).every((sl) => sl.pos !== 'K'));
}

console.log('\nroster size is asked, not re-derived');
{
  // `startersCount + benchCount` was inlined at four sites, and 7 of 9 league
  // shapes disagreed with lineup-rules.rosterSize: a scraped league with slot
  // counts and no totals gave 16 against NaN, one with no rosterSettings at all
  // gave 16 against a throw, and a startersCount stored as a string gave 16
  // against 97 -- "9" + "7". At store.js the consequence was a silently no-op
  // guard, because pickNumber > NaN is false.
  const SHAPES = [
    ['the standard shape', { startersCount: 9, benchCount: 7 }, 16],
    ['slots only, no totals', { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, 'D/ST': 1, K: 1, BE: 7 }, 16],
    ['a 3-WR league', { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 2, 'D/ST': 1, K: 1, BE: 5 }, 16],
    ['totals stored as strings', { startersCount: '9', benchCount: '7' }, 16],
    ['no rosterSettings at all', undefined, 16],
  ];
  SHAPES.forEach(([name, settings, want]) => {
    const l = settings === undefined ? {} : { rosterSettings: settings };
    check(`${name}: rosterSize is ${want}`, rosterSize(l) === want, String(rosterSize(l)));
  });
  check('and it never returns NaN', SHAPES.every(([, settings]) =>
    Number.isFinite(rosterSize(settings === undefined ? {} : { rosterSettings: settings }))));
}

console.log('\nevery engine describes the same lineup for the same league');
{
  // lineup-rules exported settings-aware functions AND frozen constants, and
  // four engines imported the constants -- so the module that exists to hold
  // ONE definition shipped two contradicting ones. Measured then: on a
  // 3-WR/2-FLEX league the optimizer seated 11 and team-strength seated 9; on a
  // 2-QB superflex board the optimizer started two quarterbacks and
  // team-strength benched the second. The constants are gone; this is what
  // stops them coming back under another name.
  const { bestLineup, rankTeams } = await import(join(ROOT, 'js/engine/team-strength.js'));
  const { lineupBreakdown } = await import(join(ROOT, 'js/engine/roster-manager.js'));

  const SHAPES = [
    { name: '3-WR, 2-FLEX', s: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 2, 'D/ST': 1, K: 1, benchCount: 5 } },
    { name: '2-QB superflex', s: { QB: 2, RB: 2, WR: 2, TE: 1, FLEX: 1, 'D/ST': 1, K: 1, benchCount: 6 } },
    { name: 'the standard shape', s: ROSTER_SETTINGS },
  ];

  for (const { name, s } of SHAPES) {
    const want = slotList(s);
    // A roster deep enough to fill any of these shapes.
    const roster = [];
    ['QB', 'RB', 'WR', 'TE', 'D/ST', 'K'].forEach((pos) => {
      roster.push(...board.filter((p) => p.position === pos).slice(0, 5).map((p) => p.id));
    });

    const opt = optimizeLineup(roster, db, s, 'floor');
    check(`${name}: the optimizer seats ${want.length}`,
      opt.starters.length === want.length,
      `${opt.starters.length} against ${want.length}`);

    const players = roster.map((id) => db[id]);
    const bl = bestLineup(roster, db, null, s);
    check(`${name}: team-strength agrees on the slot count`,
      bl.slots.length === want.length, `${bl.slots.length} against ${want.length}`);
    const blPos = bl.slots.filter((sl) => !/FLEX/.test(sl.slot)).map((sl) => sl.slot).sort();
    const wantPos = want.filter((sl) => !sl.isFlex).map((sl) => sl.pos).sort();
    check(`${name}: and on which positions they are`,
      JSON.stringify(blPos) === JSON.stringify(wantPos),
      `${JSON.stringify(blPos)} against ${JSON.stringify(wantPos)}`);

    const bd = lineupBreakdown(players, s);
    check(`${name}: roster-manager seats the same number`,
      bd.starters.length === want.length, `${bd.starters.length} against ${want.length}`);

    // Through the PUBLIC entry point, not the helper. Calling bestLineup with
    // settings directly cannot see a caller that forgets to pass them, which is
    // exactly how four engines came to be using the frozen shape: the argument
    // was optional, so omitting it was invisible.
    const lg = leagueWith(0);
    lg.rosterSettings = s;
    lg.teams[0].roster = roster;
    const ranked = rankTeams(lg);
    const mine = ranked.find((t) => t.teamId === lg.teams[0].teamId);
    check(`${name}: rankTeams reports ${want.length} slots for the league it was given`,
      mine.slots.length === want.length, `${mine.slots.length} against ${want.length}`);
    check(`${name}: and ${s.QB} quarterback slot(s)`,
      mine.slots.filter((sl) => sl.slot === 'QB').length === s.QB,
      String(mine.slots.filter((sl) => sl.slot === 'QB').length));

    // The one that actually bit: a 2-QB league must start two quarterbacks
    // everywhere, or the auction engine prices a position the lineup does not
    // have.
    const qbWant = s.QB;
    check(`${name}: the optimizer starts ${qbWant} QB(s)`,
      opt.starters.filter((p) => p.position === 'QB').length === qbWant);
    check(`${name}: and so does team-strength`,
      bl.slots.filter((sl) => sl.slot === 'QB').length === qbWant);
  }
}

console.log('\none answer to "will he last until my next pick"');
{
  // Three implementations, two of them 110 lines apart in one file, answered
  // 2%, 5% and 9% for the same player on the same board. survival.js prints
  // that comparison in its header; this pins the column that still exists, so
  // the surviving side of it cannot drift while the header goes on quoting it.
  // The manager on the clock at pick 25 of a 10-team snake is seat 5, whose
  // next pick is 36 -- that is the board the header's table is computed on.
  check('the header table\'s own column still reads 9 / 75 / 91',
    [30, 40, 45].map((adp) => survivalPct({ adp }, 36)).join('/') === '9/75/91',
    [30, 40, 45].map((adp) => survivalPct({ adp }, 36)).join('/'));

  const early = { adp: 10 }, late = { adp: 200 };
  check('a player long past his ADP is unlikely to last',
    survivalPct(early, 60) < 5, String(survivalPct(early, 60)));
  check('a player far ahead of his ADP is likely to last',
    survivalPct(late, 60) > 95, String(survivalPct(late, 60)));
  check('the curve is monotonic in the pick number',
    survivalProbability(late, 40) > survivalProbability(late, 120));
  check('it is a probability', survivalProbability(early, 60) >= 0
    && survivalProbability(early, 60) <= 1);
  // An unknown ADP used to be read as 200 -- late enough to be treated as
  // certain to last, which is a claim, not an absence.
  check('an unknown ADP has no answer', survivalProbability({ adp: null }, 60) === null
    && survivalPct({}, 60) === null);

  // One curve was not enough: the draft board went on computing the next pick
  // as currentPick + leagueSize -- a LINEAR assumption on a snake board, which
  // is the thing this module's header names as the reason the old copy was
  // wrong. Same player, same board, 50% against 80%: a coin flip shown as a
  // near-certainty. `nextPickFor`'s doc block said 41 and 43%, and neither
  // number was reachable, so both are asserted here now.
  const { nextPickFor } = await import(join(ROOT, 'js/engine/survival.js'));
  const snake = (seat, size, currentPick) => ({
    leagueSize: size,
    myTeamId: seat + 1,
    teams: Array.from({ length: size }, (_, i) => ({ teamId: i + 1 })),
    draftState: { draftType: 'snake', draftOrder: Array.from({ length: size }, (_, i) => i + 1) },
  });
  // Seat 1 of 10, on pick 25: round 3 is odd-indexed, so the seat picks last.
  check('a snake board is not a linear one',
    nextPickFor(snake(0, 10, 25), 25) !== 25 + 10,
    `${nextPickFor(snake(0, 10, 25), 25)} -- the linear answer is 35`);
  // Seat 1 of 10 picks 1, then 20 and 21 on the turn, then 40. After pick 25
  // the next one is 40 -- and 35, the linear answer, is a pick that seat never
  // has.
  check('and the answer is a pick this seat actually holds',
    nextPickFor(snake(0, 10, 25), 25) === 40,
    String(nextPickFor(snake(0, 10, 25), 25)));
  check('and that is the difference the doc block claims: 50% against 80%',
    survivalPct({ adp: 40 }, nextPickFor(snake(0, 10, 25), 25)) === 50
      && survivalPct({ adp: 40 }, 35) === 80,
    `${survivalPct({ adp: 40 }, nextPickFor(snake(0, 10, 25), 25))} vs ${survivalPct({ adp: 40 }, 35)}`);
  check('a seat that is about to pick gets that pick',
    nextPickFor(snake(3, 10, 3), 3) === 4, String(nextPickFor(snake(3, 10, 3), 3)));
  // An auction room carries no draft order, and one full turn is the honest
  // fallback rather than a snake answer invented from a seat we do not have.
  const auction = { leagueSize: 12, myTeamId: 1, teams: [], draftState: { draftType: 'auction' } };
  check('an auction falls back to one turn of the wheel',
    nextPickFor(auction, 40) === 52, String(nextPickFor(auction, 40)));
  // ...and it must be the draft TYPE that decides, not merely a missing seat.
  // A room that carries a draft order and calls itself an auction still has no
  // snake to walk, and reading one off the order invents a pick number.
  const auctionWithOrder = {
    leagueSize: 12, myTeamId: 3,
    teams: Array.from({ length: 12 }, (_, i) => ({ teamId: i + 1 })),
    draftState: { draftType: 'auction',
      draftOrder: Array.from({ length: 12 }, (_, i) => i + 1) },
  };
  check('an auction that does carry an order is still not a snake',
    nextPickFor(auctionWithOrder, 40) === 52,
    String(nextPickFor(auctionWithOrder, 40)));

  // The pick you are ON is not the pick you are next on. `>=` here answered
  // "you pick at 25" to a manager standing at pick 25 with the clock running,
  // so the survival curve compared every player against the present.
  check('a seat on the clock is told its NEXT pick, not this one',
    nextPickFor(snake(4, 10, 25), 25) === 36,
    String(nextPickFor(snake(4, 10, 25), 25)));

  // MIN_SD is the floor under the spread, and it only ever binds for a player
  // drafted in the first twenty picks: 0.15 x ADP is under 3 up to ADP 20.
  // Without it a player with ADP 2 has a spread of 0.3 picks and the curve
  // becomes a step function -- 100% at pick 2, 0% at pick 3.
  check('the earliest picks keep a floor under their spread',
    survivalPct({ adp: 2 }, 4) >= 20 && survivalPct({ adp: 2 }, 4) <= 80,
    `${survivalPct({ adp: 2 }, 4)}% at pick 4 for an ADP-2 player`);

  // The percentage is clamped because the erf approximation overshoots at the
  // tails: without it survivalPct reports 101 and -0, and a panel printing
  // "101%" is a bug the reader can see.
  const extremes = [];
  for (let adp = 1; adp <= 300; adp += 1) {
    for (const pick of [1, 2, 5, 50, 200, 400]) {
      const v = survivalPct({ adp }, pick);
      if (v !== null && (v < 0 || v > 100)) extremes.push(`adp ${adp} @ ${pick} = ${v}`);
    }
  }
  check('no percentage is outside 0..100 anywhere on the board',
    extremes.length === 0, extremes.slice(0, 3).join('; '));
  check('and none of them is NaN', extremes.length === 0
    && [1, 60, 300].every((a) => Number.isFinite(survivalPct({ adp: a }, 60))));
  // `typeof adp === 'number'` admitted Infinity and NaN, and either ran the
  // whole curve to NaN -- printed as "NaN%".
  check('an infinite or NaN ADP has no answer, like a missing one',
    survivalPct({ adp: Infinity }, 60) === null
      && survivalPct({ adp: -Infinity }, 60) === null
      && survivalPct({ adp: NaN }, 60) === null,
    `${survivalPct({ adp: Infinity }, 60)} / ${survivalPct({ adp: NaN }, 60)}`);
}

console.log('\none coercion from "whatever the payload held" to a number');
{
  // Five engines each declared `const num = (v, d = 0) =>
  // (typeof v === 'number' && isFinite(v) ? v : d)`, and a SIXTH num() with the
  // same name and a different contract lives in js/escape.js, where it formats
  // a figure for markup and returns a string.
  const { finite, clamp } = await import(join(ROOT, 'js/engine/numbers.js'));
  const { num } = await import(join(ROOT, 'js/escape.js'));
  check('the two jobs return two types, so they cannot be swapped',
    typeof finite('12.4') === 'number' && typeof num(12.4) === 'string',
    `${typeof finite('12.4')} / ${typeof num(12.4)}`);

  // The typeof test was the substantive bug, not just the duplication. Every
  // payload this app reads is JSON, and JSON produces "12.4" as readily as
  // 12.4 -- whereupon the projection became 0, which is not "unknown", it is a
  // measurement saying the player is worth nothing.
  check('a numeric string is a number, not a zero', finite('12.4') === 12.4,
    String(finite('12.4')));
  check('and it survives into a projection',
    finite('12.4') * 17 > 200, String(finite('12.4') * 17));
  check('an unknown value still takes the fallback',
    finite(null) === 0 && finite(undefined) === 0 && finite('Questionable') === 0
      && finite(NaN) === 0 && finite(Infinity) === 0);
  // Number(true) is 1 and Number('') is 0, both finite, and neither is a
  // projection anybody wrote down.
  check('a boolean is not a figure', finite(true, -1) === -1 && finite('', -1) === -1,
    `${finite(true, -1)} / ${finite('', -1)}`);
  check('the fallback is honoured', finite(undefined, 5) === 5);
  check('clamp is the same one everywhere',
    clamp(9, 1, 5) === 5 && clamp(-9, 1, 5) === 1 && clamp(3, 1, 5) === 3);

  // The end-to-end version: a scraped roster whose projections came back as
  // strings must not price out as a roster of worthless players.
  const { buildLeagueState } =
    await import(join(ROOT, 'js/engine/auction-advisor.js'));
  const asStrings = leagueWith(0);
  Object.values(asStrings.playerDatabase).forEach((p) => {
    p.projectedPoints = String(p.projectedPoints);
  });
  const asNumbers = leagueWith(0);
  check('a database of numeric strings values the same as one of numbers',
    JSON.stringify(buildLeagueState(asStrings).par)
      === JSON.stringify(buildLeagueState(asNumbers).par),
    JSON.stringify(buildLeagueState(asStrings).par));
}

console.log('\nthe future-roster line describes the roster, not the position taken');
{
  // It read: "Secures anchoring <POS> slot. Plan to target <Running Backs if he
  // is a WR, else Wide Receivers> in rounds N+2 and N+3." Every clause was
  // invented -- it flipped on the recommended player's position whether or not
  // either slot was open, and the two round numbers were arithmetic on the
  // current round with nothing behind them. A hardcoded string that reads like
  // analysis, printed under the heading "Future Roster Plan".
  const { getDraftRecommendations } =
    await import(join(ROOT, 'js/engine/draft-assistant.js'));
  const { mockLeague, mockPlayers } = await import(join(ROOT, 'js/mock-data.js'));

  const board = (picks) => {
    const l = JSON.parse(JSON.stringify(mockLeague));
    l.playerDatabase = JSON.parse(JSON.stringify(mockPlayers));
    const byPos = {};
    Object.values(l.playerDatabase).forEach((p) => {
      (byPos[p.position] = byPos[p.position] || []).push(p);
    });
    const mine = picks.map(([pos, i]) => byPos[pos][i]).filter(Boolean);
    l.draftState = { ...l.draftState, draftType: 'snake', currentPick: mine.length + 1,
      selections: mine.map((p, i) => ({ teamId: l.myTeamId, playerId: p.id, pickNumber: i + 1 })) };
    const avail = Object.values(l.playerDatabase).filter((p) => !mine.includes(p));
    return getDraftRecommendations(l, avail);
  };

  const empty = board([]);
  check('an empty roster is told which starting slots are open',
    /Still open after this pick:/.test(empty.planChange), empty.planChange);
  check('and the flex is named once, not folded into every position',
    (empty.planChange.match(/WR/g) || []).length <= 1
      && /flex/.test(empty.planChange), empty.planChange);
  // The old line printed a bare figure. This one says what the figure measures.
  check('and every figure it prints says what it measures',
    !/\+\d/.test(empty.planChange) || /season lineup points/.test(empty.planChange),
    empty.planChange);

  const full = board([['QB', 0], ['RB', 0], ['RB', 1], ['WR', 0], ['WR', 1],
                      ['TE', 0], ['D/ST', 0], ['K', 0], ['WR', 2]]);
  check('a full starting lineup is told that, not told to target a position',
    /Every starting slot is filled/.test(full.planChange), full.planChange);
  // The precise old failure: it named RB whenever the pick was a WR, so a
  // manager with no room for another back was told to draft one.
  check('and it never recommends a position with no slot open',
    !/Running Backs|Wide Receivers/.test(String(full.planChange)), full.planChange);
}

console.log('\nthe simulator reads where the season is, instead of assuming week 5');
{
  // `const currentWeek = 5` sat under a comment reading "Determine current week
  // from schedule". Five is right for mock-data.js -- every team there is four
  // games in -- which is why nothing caught it. A real league in week 12 had
  // weeks 5 through 11 replayed ON TOP of the record those weeks produced.
  //
  // The decisive case is a season that is over. With every game played there is
  // nothing left to simulate, so the standings ARE the answer: a team that lost
  // all fourteen cannot make the playoffs, and one that won all fourteen cannot
  // miss. Under the hardcoded 5 there were ten more games to play and both
  // figures came out in the middle.
  // Team 1 has the BEST roster on the board and lost every game; the others
  // have the worst and won nine. If the ten remaining weeks are replayed, the
  // best roster wins most of them and climbs into the field. If the season is
  // read as over, it finishes last, which is what its record says.
  const finished = leagueWith(0);
  finished.teams.forEach((t) => {
    t.record = t.teamId === 1
      ? { wins: 0, losses: 14, ties: 0 }
      : { wins: 9, losses: 5, ties: 0 };
    t.pointsScored = t.teamId === 1 ? 900 : 1600;
  });
  const over = runSeasonSimulation(finished, 500);
  check('a season already played out is not replayed',
    over.playoffPct === 0,
    `0-14 with every game played, and the model still gives ${over.playoffPct}%`);

  // The mirror: the worst roster, 14-0. Replaying drags it back down.
  const champion = leagueWith(300);
  champion.teams.forEach((t) => {
    t.record = t.teamId === 1
      ? { wins: 14, losses: 0, ties: 0 }
      : { wins: 5, losses: 9, ties: 0 };
    t.pointsScored = t.teamId === 1 ? 1700 : 1200;
  });
  const won = runSeasonSimulation(champion, 1000);
  check('and a 14-0 team is not made to play ten more games',
    won.playoffPct === 100, `${won.playoffPct}%`);
  // ...and it still has to WIN the bracket with the roster it has. When the
  // regular season was over, no week was projected at all, playBracket scored
  // every game as NaN, `NaN >= NaN` is false so every game went to `b` -- the
  // lower seed -- and the weakest roster in a ten-team league was handed a
  // 97.6% championship probability by the bracket's shape.
  check('and the bracket is still played with projections, not with NaN',
    won.champPct > 0 && won.champPct < 40, `${won.champPct}%`);

  // The same contract the simulator uses when a roster will not resolve: say
  // the question cannot be answered rather than answer it from a substitute.
  const { playBracket } = await import(join(ROOT, 'js/engine/simulator.js'));
  check('a bracket with no projections declines', playBracket([1, 2, 3, 4]) === null);
  check('and so does one missing a single team', playBracket([1, 2], { 1: 110 }) === null);
  check('while a complete one names a winner',
    [1, 2].includes(playBracket([1, 2], { 1: 110, 2: 120 })));

  // The decisive case, because a record lead survives extra games: the worst
  // roster in the league, one win ahead of everybody, with 13 of 14 played.
  // One game left and it holds the lead. Ten games replayed and nine stronger
  // rosters go past it. Measured: 100% against 0%.
  const lateSeason = leagueWith(400);
  lateSeason.teams.forEach((t) => {
    t.record = t.teamId === 1
      ? { wins: 7, losses: 6, ties: 0 }
      : { wins: 6, losses: 7, ties: 0 };
    t.pointsScored = 1300;
  });
  for (let w = 1; w <= 4; w++) {
    for (let i = 1; i < 10; i += 2) {
      lateSeason.schedule.push({ week: w, team1Id: i, team2Id: i + 1, completed: true });
    }
  }
  const late = runSeasonSimulation(lateSeason, 800);
  check('a one-game lead with one game left is not thrown back to week 5',
    late.playoffPct === 100,
    `${late.playoffPct}% -- ten already-played games are being replayed`);

  // Mid-season, the week has to come from the record too: 8 games played means
  // 6 to go, so the remaining schedule is weeks 9-14 and not 5-14.
  const midway = leagueWith(0);
  midway.teams.forEach((t) => { t.record = { wins: 4, losses: 4, ties: 0 }; });
  const mid = runSeasonSimulation(midway, 300);
  check('a league mid-season still answers', typeof mid.playoffPct === 'number'
    && mid.playoffPct >= 0 && mid.playoffPct <= 100, String(mid.playoffPct));
}

console.log('\nboth engines model weekly scoring noise with the same number');
{
  // simulator.js drew a team's week as projection + normal(0, 12) and
  // team-strength.js as projection + normal(0, 22). Same model, same three
  // spans on the Championship page, two different leagues. Worth 20 points of
  // first-round-bye probability.
  const simSrc = readFileSync(join(ROOT, 'js/engine/simulator.js'), 'utf8');
  const tsSrc = readFileSync(join(ROOT, 'js/engine/team-strength.js'), 'utf8');
  check('neither engine declares its own weekly SD',
    !/WEEKLY_SD\s*=/.test(simSrc) && !/WEEKLY_SD\s*=/.test(tsSrc));
  check('and both import the one that exists',
    /scoring-model\.js/.test(simSrc) && /scoring-model\.js/.test(tsSrc));
  const { WEEKLY_SD, WEATHER_RATE } = await import(join(ROOT, 'js/engine/scoring-model.js'));
  check('the shared SD is a plausible weekly spread, not a placeholder',
    WEEKLY_SD >= 15 && WEEKLY_SD <= 35, String(WEEKLY_SD));
  check('and the weather rate is a probability', WEATHER_RATE >= 0 && WEATHER_RATE <= 1);
  // The bonus that went to whichever team the mapper wrote first.
  check('no home-field advantage is added to team1',
    !/team1Proj\s*\+=/.test(simSrc),
    'fantasy scoring has no home field, and team1Id is payload ordering');
}

console.log('\nthe trade generator reads the league\'s own starting slots');
{
  const { generateTradeProposals } =
    await import(join(ROOT, 'js/engine/trade-generator.js'));
  // `league.rosterSettings[pos] || 2` threw TypeError on any league without
  // rosterSettings -- every scraped auction room -- and simulator.js wraps the
  // call in a try/catch, so the trade line vanished from the action plan with
  // a console.error nobody was reading.
  const bare = {
    playerDatabase: { A: { id: 'A', name: 'A', position: 'QB', projectedPoints: 20 } },
    myTeamId: 1, teams: [{ teamId: 1, roster: ['A'] }, { teamId: 2, roster: [] }],
  };
  let threw = null;
  try { generateTradeProposals(bare); } catch (e) { threw = e; }
  check('a league with no rosterSettings does not throw', threw === null,
    threw && threw.message);

  // And where it did not throw it invented a starting limit of 2 for every
  // position, so a one-QB league was told it had a surplus only at three
  // quarterbacks. Two strong QBs in a one-QB league IS a surplus.
  const qbHeavy = {
    rosterSettings: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, 'D/ST': 1, K: 1, BE: 7 },
    myTeamId: 1,
    playerDatabase: {
      Q1: { id: 'Q1', name: 'Q One', position: 'QB', projectedPoints: 22 },
      Q2: { id: 'Q2', name: 'Q Two', position: 'QB', projectedPoints: 20 },
      W1: { id: 'W1', name: 'W One', position: 'WR', projectedPoints: 19 },
      W2: { id: 'W2', name: 'W Two', position: 'WR', projectedPoints: 18 },
      W3: { id: 'W3', name: 'W Three', position: 'WR', projectedPoints: 17 },
    },
    teams: [
      { teamId: 1, teamName: 'Mine', roster: ['Q1', 'Q2'] },
      { teamId: 2, teamName: 'Theirs', roster: ['W1', 'W2', 'W3'] },
    ],
  };
  const swaps = generateTradeProposals(qbHeavy);
  check('two strong QBs in a one-QB league is a surplus worth trading',
    Array.isArray(swaps) && swaps.length > 0
      && swaps[0].givePlayer && swaps[0].givePlayer.position === 'QB',
    JSON.stringify(swaps));

  // And the same board with the settings REMOVED must reach the same answer,
  // because a scraped auction room does not publish its slot counts and
  // `starterSlots` is where the default lives. `rosterSettings || {}` would
  // leave every limit undefined, every comparison false, and no proposal at
  // all -- silence that looks exactly like "there is no good trade here".
  const noSettings = { ...qbHeavy };
  delete noSettings.rosterSettings;
  const same = generateTradeProposals(noSettings);
  check('and it finds the same trade with no rosterSettings at all',
    JSON.stringify(same) === JSON.stringify(swaps),
    JSON.stringify(same));
}

console.log('\nthe lineup optimizer\'s thirteen adjustments, none of which ran');
{
  // A mutation run left every one of these alive: the injury deductions, the
  // six usage thresholds, the red-zone bonuses, the two matchup multipliers
  // and the volatility half-step. All thirteen could be deleted and the suite
  // stayed green, because no test drove a player carrying `metrics`, an
  // `opponent` or an injury status other than Healthy. And `replacementPlans`
  // -- a whole output branch that app.js renders -- was never produced at all.
  const SETTINGS = { QB: 1, RB: 1, WR: 1, TE: 0, FLEX: 0, 'D/ST': 0, K: 0, BE: 5 };
  const mk = (over) => ({ id: over.id, name: over.id, position: over.position,
    team: 'FA', projectedPoints: 20, injuryStatus: 'Healthy', volatility: 4, ...over });
  const lineupOf = (players, strategy = 'floor') => {
    const d = {}; players.forEach((p) => { d[p.id] = p; });
    return optimizeLineup(players.map((p) => p.id), d, SETTINGS, strategy);
  };

  // Injury deductions: 2.0 Questionable, 6.0 Doubtful, and Out is unplayable.
  // Both sides carry the same volatility, so the floor half-step is a constant
  // offset and the boundary is exactly the deduction.
  const beats = (a, bPoints) => lineupOf([mk({ ...a, id: 'A', position: a.position || 'RB' }),
    mk({ id: 'B', position: a.position || 'RB', projectedPoints: bPoints })])
    .starters[0].id === 'A';
  check('a questionable starter projecting 20 still beats 17.5',
    beats({ injuryStatus: 'Questionable' }, 17.5));
  check('and loses to 18.5, because the deduction is 2 and not 1',
    !beats({ injuryStatus: 'Questionable' }, 18.5));
  check('a doubtful one beats 13.5 but not 14.5',
    beats({ injuryStatus: 'Doubtful' }, 13.5) && !beats({ injuryStatus: 'Doubtful' }, 14.5));
  const out = [mk({ id: 'RB_out', position: 'RB', injuryStatus: 'Out', projectedPoints: 40 }),
               mk({ id: 'RB_ok', position: 'RB', projectedPoints: 3 })];
  check('and one who is Out never starts, whatever he projects',
    lineupOf(out).starters[0].id === 'RB_ok', lineupOf(out).starters[0].id);

  // The six usage thresholds, each side of its own boundary. `bPoints` is set
  // so that only the adjustment under test can decide the slot -- equal scores
  // would leave A first by sort order and every one of these would pass
  // whether the threshold fired or not.
  const usage = (metrics, bPoints, position = 'RB') =>
    lineupOf([mk({ id: 'A', position, metrics }),
      mk({ id: 'B', position, projectedPoints: bPoints })]).starters[0].id === 'A';
  check('an 85% snap share is worth +5%, taking 20 past 20.5',
    usage({ snapShare: 0.85 }, 20.5));
  check('and 84% is not', !usage({ snapShare: 0.84 }, 20.5));
  check('under 50% costs 10%, so 20 falls behind 18.5',
    !usage({ snapShare: 0.49 }, 18.5) && usage({ snapShare: 0.50 }, 18.5));
  check('a 25% target share is worth +8%', usage({ targetShare: 0.25 }, 21));
  check('and 24% is not', !usage({ targetShare: 0.24 }, 21));
  check('under 12% costs 5%', !usage({ targetShare: 0.11 }, 19.5)
    && usage({ targetShare: 0.12 }, 19.5));
  check('16 carries is a workhorse, worth +5%', usage({ carries: 16 }, 20.5));
  check('and 15 is not', !usage({ carries: 15 }, 20.5));
  check('under 8 costs 8%', !usage({ carries: 7 }, 18.8)
    && usage({ carries: 8 }, 18.8));
  check('and for a QB the threshold is 6 carries, not 16',
    usage({ carries: 6 }, 21, 'QB') && !usage({ carries: 5 }, 21, 'QB'));
  check('a QB does not get the RB committee penalty either',
    usage({ carries: 2 }, 19.9, 'QB'));
  check('red-zone targets are worth half a point each',
    usage({ redZoneTargets: 2 }, 20.9) && !usage({ redZoneTargets: 2 }, 21.1));
  check('and red-zone carries 0.4',
    usage({ redZoneCarries: 2 }, 20.7) && !usage({ redZoneCarries: 2 }, 20.9));

  // The two matchup multipliers, which need a D/ST in the database to fire.
  const withDefense = (dstPoints, oppTeam, bPoints) => {
    const a = mk({ id: 'A', position: 'RB', opponent: 'XYZ' });
    const b = mk({ id: 'B', position: 'RB', projectedPoints: bPoints });
    const dst = mk({ id: 'D', position: 'D/ST', team: oppTeam, projectedPoints: dstPoints });
    return optimizeLineup(['A', 'B'], { A: a, B: b, D: dst }, SETTINGS, 'floor')
      .starters[0].id;
  };
  check('a tough defence costs 6%, dropping 20 below 19.5',
    withDefense(8.2, 'XYZ', 19.5) === 'B', withDefense(8.2, 'XYZ', 19.5));
  check('and 8.1 is not tough enough',
    withDefense(8.1, 'XYZ', 19.5) === 'A', withDefense(8.1, 'XYZ', 19.5));
  check('a weak one adds 6%, taking 20 past 20.5',
    withDefense(6.8, 'XYZ', 20.5) === 'A', withDefense(6.8, 'XYZ', 20.5));
  check('and 6.9 is not weak enough',
    withDefense(6.9, 'XYZ', 20.5) === 'B', withDefense(6.9, 'XYZ', 20.5));
  check('and a defence for some other team changes nothing',
    withDefense(8.2, 'OTHER', 19.5) === 'A', withDefense(8.2, 'OTHER', 19.5));

  // Floor and ceiling are the same board read two ways.
  const vol = [mk({ id: 'steady', position: 'RB', volatility: 1 }),
               mk({ id: 'swingy', position: 'RB', volatility: 7 })];
  check('floor prefers the steady player', lineupOf(vol, 'floor').starters[0].id === 'steady');
  check('ceiling prefers the volatile one', lineupOf(vol, 'ceiling').starters[0].id === 'swingy');
  check('and the explanation says which was done',
    /subtracted/.test(lineupOf(vol, 'floor').explanation[0])
      && /added/.test(lineupOf(vol, 'ceiling').explanation[0]),
    lineupOf(vol, 'floor').explanation[0]);

  // replacementPlans: the branch app.js renders and nothing produced.
  const plans = lineupOf([
    mk({ id: 'RB_q', position: 'RB', injuryStatus: 'Questionable' }),
    mk({ id: 'RB_bench', position: 'RB', projectedPoints: 8 }),
    mk({ id: 'QB1', position: 'QB' }), mk({ id: 'WR1', position: 'WR' }),
  ]).replacementPlans;
  check('a questionable starter gets a named replacement plan',
    plans.length === 1 && plans[0].starter.id === 'RB_q'
      && plans[0].backup.id === 'RB_bench', JSON.stringify(plans));
  check('and the condition names both players, not a template',
    /RB_q/.test(plans[0].condition) && /RB_bench/.test(plans[0].condition),
    plans[0].condition);
  check('a healthy lineup produces no plans',
    lineupOf([mk({ id: 'RB1', position: 'RB' }), mk({ id: 'RB2', position: 'RB' }),
      mk({ id: 'QB1', position: 'QB' }), mk({ id: 'WR1', position: 'WR' })])
      .replacementPlans.length === 0);
  // The backup must be healthy: slotting in a player who is himself Out is
  // advice that cannot be followed.
  const hurtBench = lineupOf([
    mk({ id: 'RB_q', position: 'RB', injuryStatus: 'Questionable' }),
    mk({ id: 'RB_out', position: 'RB', projectedPoints: 8, injuryStatus: 'Out' }),
    mk({ id: 'WR_ok', position: 'WR', projectedPoints: 5 }),
    mk({ id: 'QB1', position: 'QB' }), mk({ id: 'WR1', position: 'WR' }),
  ]).replacementPlans;
  check('and an injured bench player is not offered as the fix',
    hurtBench.length === 0 || hurtBench[0].backup.injuryStatus !== 'Out',
    JSON.stringify(hurtBench));
}

console.log('\nthe simulator is checked on its shape, not only its ordering');
{
  /* -------------------------------------------------------------------------
   * Round 8 mutated this engine eleven times and killed none of them, at
   * 86.89% line coverage. Executed is not observed.
   *
   * The two worst survivors say why the existing assertions cannot see them:
   * `teams.find(t => t.teamId === matchup.team2Id)` flipped to `!==` makes
   * every simulated matchup play the WRONG opponent, and `if (winner !== null)`
   * flipped to `=== null` makes champWinsCount[null]++ so every rival's
   * championship rate reads 0% forever. Both preserve "a better roster wins
   * the title more often", which is all this file asserted.
   *
   * So these assert things a monotonicity check cannot: that the championship
   * is awarded exactly once per run and to somebody real, that the rival panel
   * is a distribution rather than a column of zeros, and that the schedule
   * decides who plays whom.
   * --------------------------------------------------------------------- */
  const RUNS = 400;
  const out = runSeasonSimulation(leagueWith(0), RUNS);
  check('the simulation answers at all', !out.unknown, out.reason);

  // champWinsCount is the source of `competitors`. If the title were awarded to
  // `null`, or twice, or never, the rates would not sum to 100.
  const rivalPct = (out.competitors || []).reduce((a, c) => a + c.pct, 0);
  const total = rivalPct + (out.champPct || 0);
  check('every run crowns exactly one champion, and a real one',
    total > 97 && total < 103,
    `mine ${out.champPct}% + rivals ${rivalPct.toFixed(1)}% = ${total.toFixed(1)}%`);
  check('and the rival panel is a distribution, not a column of zeros',
    (out.competitors || []).some((c) => c.pct > 0),
    JSON.stringify((out.competitors || []).map((c) => c.pct)));
  check('every named rival is a team in this league',
    (out.competitors || []).every((c) => leagueWith(0).teams
      .some((t) => t.teamId === c.teamId)),
    JSON.stringify((out.competitors || []).map((c) => c.teamId)));

  // Who you play is read from the schedule. `teams.find(t => t.teamId ===
  // matchup.team2Id)` flipped to `!==` returns the first team that is NOT the
  // opponent -- usually team 1 -- so a team ends up playing itself and every
  // game becomes a coin flip. A board where one team is fed the weakest
  // opponent every week catches that, because a coin flip is not what feeding
  // looks like.
  const fedTheWeakest = () => {
    const l = leagueWith(0, 4);
    // Team 4 is drawn from 80 places down the board; teams 1-3 are close.
    l.teams.forEach((t) => { t.record = { wins: 0, losses: 0, ties: 0 }; });
    l.schedule = [];
    for (let w = 5; w <= 14; w++) {
      l.schedule.push({ week: w, team1Id: 1, team2Id: 4 });
      l.schedule.push({ week: w, team1Id: 2, team2Id: 3 });
    }
    return runSeasonSimulation(l, RUNS);
  };
  const fed = fedTheWeakest();
  check('a team fed the weakest opponent every week beats the field',
    fed.playoffPct > 70,
    `${fed.playoffPct}% -- ten games against the worst roster should not be a coin flip`);

  /* -------------------------------------------------------------------------
   * The weekly draw is normal with the SD scoring-model.js publishes, and that
   * is checkable to a fraction of a point rather than by a loose band.
   *
   * Two independent draws at N(0, sd) differ by N(0, sd*sqrt2), so a favourite
   * ahead by k sigma wins with probability Phi(k / sqrt2). Measured against
   * that curve at four separations, the engine tracks it within 0.3pp -- so a
   * 1pp tolerance is tight enough to catch a corrupted Box-Muller (the cosine's
   * 2*PI becoming PI) or a mis-scaled SD, and loose enough not to flake at
   * 20,000 samples.
   * --------------------------------------------------------------------- */
  const { playBracket } = await import(join(ROOT, 'js/engine/simulator.js'));
  const { WEEKLY_SD } = await import(join(ROOT, 'js/engine/scoring-model.js'));
  const erf = (x) => {
    const sgn = x < 0 ? -1 : 1, a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
    return sgn * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
      - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
  };
  const winRate = (k, n) => {
    // 500 keeps both scores far above the Math.max(50, ...) floor, which would
    // otherwise truncate the left tail and flatter the favourite.
    const proj = { 1: 500 + k * WEEKLY_SD, 2: 500 };
    let w = 0;
    for (let i = 0; i < n; i++) if (playBracket([1, 2], proj) === 1) w++;
    return w / n;
  };
  const offBy = [0, 0.5, 1, 2, 4].map((k) => {
    const theory = 0.5 * (1 + erf((k / Math.SQRT2) / Math.SQRT2));
    return { k, theory, measured: winRate(k, 20000) };
  });
  const worst = offBy.reduce((a, o) =>
    Math.max(a, Math.abs(o.measured - o.theory)), 0);
  check('the bracket draws from the published weekly SD, at every separation',
    worst < 0.01,
    offBy.map((o) => `${o.k}s ${(100 * o.measured).toFixed(1)}% vs `
      + `${(100 * o.theory).toFixed(1)}%`).join(', '));
}

console.log('\nthe trade generator survives a roster it cannot trade from');
{
  // The reproducible crash: `give` was dereferenced before the guard that
  // checks it, so a roster with nobody in the 10-16 point band threw a
  // TypeError -- and all three callers render unguarded, so the exception
  // aborted the page mid-DOM.
  const thin = {
    leagueId: 'T', leagueSize: 2, myTeamId: 1,
    teams: [
      { teamId: 1, teamName: 'Me', roster: ['x'], faabRemaining: 100 },
      { teamId: 2, teamName: 'Opp', roster: ['y'], faabRemaining: 100 },
    ],
    rosterSettings: ROSTER_SETTINGS, schedule: [],
    draftState: { draftType: 'auction', selections: [] },
    playerDatabase: {
      x: { id: 'x', name: 'Low', position: 'RB', projectedPoints: 9.0, team: 'ATL' },
      y: { id: 'y', name: 'Mid', position: 'WR', projectedPoints: 12.0, team: 'BUF' },
    },
  };
  let threw = null;
  let out = null;
  try { out = generateTradeProposals(thin, thin.playerDatabase); }
  catch (e) { threw = e; }
  check('no roster in the tradeable band does not throw', !threw,
    threw && `${threw.constructor.name}: ${threw.message}`);
  check('and it proposes nothing rather than something invented',
    Array.isArray(out) && out.length === 0, out && `${out.length} proposals`);

  // A real league should still be able to produce proposals, or the guard
  // above passes by making the engine do nothing at all.
  //
  // `Array.isArray(realOut)` was that guard, and [] is an array: the fixture
  // produced ZERO proposals, so both assertions below sat inside `if
  // (realOut.length)` and had never run -- and they are the ones guarding the
  // fields whose previous versions were the invented "85% Acceptance
  // Probability" and "+2% Championship Prob". Neither proposal-construction
  // path in trade-generator.js was executed by anything.
  //
  // The fixture needs COMPLEMENTARY surpluses: the engine looks for a position
  // where I am deep and you are thin, and another where the reverse holds.
  const real = leagueWith(0);
  const byPos = (pos, n, from) => board.filter((p) => p.position === pos)
    .slice(from, from + n).map((p) => p.id);
  real.teams[0].roster = [...byPos('RB', 5, 0), ...byPos('WR', 1, 0),
                          ...byPos('QB', 1, 0), ...byPos('TE', 1, 0)];
  real.teams[1].roster = [...byPos('WR', 5, 1), ...byPos('RB', 1, 5),
                          ...byPos('QB', 1, 1), ...byPos('TE', 1, 1)];
  real.draftState.selections = real.teams.flatMap((t) =>
    t.roster.map((id) => ({ playerId: id, teamId: t.teamId })));

  let realOut = null;
  try { realOut = generateTradeProposals(real, db); } catch (e) { realOut = e; }
  check('a league with complementary surpluses yields proposals',
    Array.isArray(realOut) && realOut.length > 0,
    realOut instanceof Error ? realOut.message : `${realOut && realOut.length} proposals`);
  if (Array.isArray(realOut) && realOut.length) {
    check('no proposal reports a percentage it did not compute',
      realOut.every((p) => !/%/.test(String(p.myImpact || ''))),
      String(realOut[0].myImpact));
    check('and none carries an acceptance probability at all',
      realOut.every((p) => p.probability === undefined),
      JSON.stringify(realOut[0].probability));
    check('a proposal never trades a player for himself',
      realOut.every((p) => !p.givePlayer || !p.getPlayer
        || p.givePlayer.id !== p.getPlayer.id));
    check('the negotiation lines name the actual players',
      realOut.every((p) => p.negotiation
        && p.negotiation.open.includes(p.givePlayer.name)
        && p.negotiation.open.includes(p.getPlayer.name)),
      realOut[0].negotiation && realOut[0].negotiation.open);
  }
}

console.log('\npartial coverage is not treated as a complete board');
{
  // An auction room renders ONE team's roster, so a scrape often resolves only
  // the user's own. The scraper has always said so in a `coverage` field and
  // nothing read it, so the engines were handed that as a full draft: every
  // rival's slotsLeft was their entire roster, because their picks are unknown
  // rather than absent, and the league looked as though it had far more left to
  // buy than it did. Inflation was pushed to the floor on a fiction.
  const { marketInflation, buildLeagueState } =
    await import(join(ROOT, 'js/engine/auction-advisor.js'));

  const partial = leagueWith(0);
  partial.teams.forEach((t, i) => { if (i > 0) t.roster = []; });
  partial.coverage = { kind: 'own-roster-only', knownTeamId: 1 };

  const full = leagueWith(0);
  full.teams.forEach((t, i) => { if (i > 0) t.roster = []; });
  full.coverage = { kind: 'full-board' };

  const pState = buildLeagueState(partial);
  const fState = buildLeagueState(full);
  check('coverage reaches the league state',
    pState.coverageKind === 'own-roster-only', pState.coverageKind);

  // A sweep that GAVE UP partway is not a swept board either. The scraper
  // reports that and nothing read it, so a sweep that saw 2 of 12 teams was
  // priced exactly like a complete league -- every rival budget computed over
  // ten rosters that are empty because they are UNKNOWN.
  const truncated = leagueWith(0);
  truncated.teams.forEach((t, i) => { if (i > 0) t.roster = []; });
  truncated.coverage = { kind: 'swept-rosters', sweptAt: Date.now(), partial: true };
  const complete = leagueWith(0);
  complete.teams.forEach((t, i) => { if (i > 0) t.roster = []; });
  complete.coverage = { kind: 'swept-rosters', sweptAt: Date.now(), partial: false };
  const tState = buildLeagueState(truncated);
  check('a truncated sweep reaches the league state', tState.coveragePartial === true);
  check('and it declines to price the market, like an own-roster scrape',
    marketInflation(tState, 400) === 1.0, String(marketInflation(tState, 400)));
  check('while a complete sweep still computes one',
    marketInflation(buildLeagueState(complete), 400) !== 1.0,
    String(marketInflation(buildLeagueState(complete), 400)));

  const pInfl = marketInflation(pState, 400);
  const fInfl = marketInflation(fState, 400);
  check('an own-roster-only scrape reports neutral inflation rather than a guess',
    pInfl === 1.0, String(pInfl));
  check('and a full board still computes a real one',
    fInfl !== 1.0 || fState.slotsLeft <= 0, String(fInfl));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
