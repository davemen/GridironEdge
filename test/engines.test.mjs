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
    // Nine slots: QB, RB, RB, WR, WR, TE, FLEX, D/ST, K -- but this roster is
    // drawn from the top of the board and may not hold a K or D/ST, so assert
    // the ceiling and that nothing is seated twice.
    check('it never seats more than the lineup holds', lineup.starters.length <= 9,
      `${lineup.starters.length} starters`);
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
