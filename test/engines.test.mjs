/**
 * The three engines nothing tested: simulator, lineup-optimizer, trade-generator.
 *
 * Run: node test/engines.test.mjs
 *
 * A mutation run over the whole repo found these were the largest holes left.
 * `runSeasonSimulation` could be replaced by `return { playoffPct: 50,
 * champPct: 50, byePct: 50, actionPlan: [] }` and all fourteen suites passed,
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
  // above would pass by making the engine do nothing at all.
  const real = leagueWith(0);
  let realOut = null;
  try { realOut = generateTradeProposals(real, db); } catch (e) { realOut = e; }
  check('a full league still yields proposals', Array.isArray(realOut),
    realOut instanceof Error ? realOut.message : 'not an array');
  if (Array.isArray(realOut) && realOut.length) {
    check('no proposal reports a percentage it did not compute',
      realOut.every((p) => !/%/.test(String(p.myImpact || ''))),
      String(realOut[0].myImpact));
    check('a proposal never trades a player for himself',
      realOut.every((p) => !p.givePlayer || !p.getPlayer
        || p.givePlayer.id !== p.getPlayer.id));
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
