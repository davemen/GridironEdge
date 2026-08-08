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

  // By SEED, which is where the bug actually lived and which the by-team check
  // above cannot see: with identical teams the seeding is random, so no seat
  // consistently gets seed 2. Driving the bracket directly with fixed seeds and
  // equal scoring is what exposes it.
  const { playBracket } = await import(join(ROOT, 'js/engine/simulator.js'));
  const SEEDS = [1, 2, 3, 4, 5, 6];
  const equal = Object.fromEntries(SEEDS.map((id) => [id, 100]));
  const titles = Object.fromEntries(SEEDS.map((id) => [id, 0]));
  const RUNS = 20000;
  for (let r = 0; r < RUNS; r++) titles[playBracket(SEEDS, equal)] += 1;
  const seedPct = SEEDS.map((id) => (titles[id] / RUNS) * 100);
  // Seeds 1 and 2 hold byes, so they SHOULD win more often -- but a bye is
  // worth one round, not a walkover. Seed 2 used to take 50.1% against seed
  // 1's 24.9% while seeds 3-6 shared 6.2% each.
  check('the two byes are worth the same as each other',
    Math.abs(seedPct[0] - seedPct[1]) < 4,
    `seed 1 ${seedPct[0].toFixed(1)}%, seed 2 ${seedPct[1].toFixed(1)}%`);
  check('and no seed is a structural favourite',
    Math.max(...seedPct) < 40, JSON.stringify(seedPct.map((p) => Number(p.toFixed(1)))));
  check('while a bye is still worth something',
    Math.min(seedPct[0], seedPct[1]) > Math.max(...seedPct.slice(2)),
    JSON.stringify(seedPct.map((p) => Number(p.toFixed(1)))));
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
  // 2%, 5% and 9% for the same player on the same board.
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
  // wrong. Same player, same board, 43% against 80%.
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
  check('a seat that is about to pick gets that pick',
    nextPickFor(snake(3, 10, 3), 3) === 4, String(nextPickFor(snake(3, 10, 3), 3)));
  // An auction room carries no draft order, and one full turn is the honest
  // fallback rather than a snake answer invented from a seat we do not have.
  const auction = { leagueSize: 12, myTeamId: 1, teams: [], draftState: { draftType: 'auction' } };
  check('an auction falls back to one turn of the wheel',
    nextPickFor(auction, 40) === 52, String(nextPickFor(auction, 40)));
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

  const pInfl = marketInflation(pState, 400);
  const fInfl = marketInflation(fState, 400);
  check('an own-roster-only scrape reports neutral inflation rather than a guess',
    pInfl === 1.0, String(pInfl));
  check('and a full board still computes a real one',
    fInfl !== 1.0 || fState.slotsLeft <= 0, String(fInfl));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
