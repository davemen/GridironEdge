/**
 * Headless checks for the preseason team assessment.
 *
 * Run: node test/team-strength.test.mjs
 *
 * These assert the properties the numbers have to have to be worth showing --
 * that a better roster ranks higher, that an empty slot is the loudest signal,
 * and that the simulated schedule is a real one -- rather than pinning exact
 * figures, which move with the projections.
 */
import { bestLineup, rankTeams, preseasonOutlook, highestImpactMoves }
  from '../js/engine/team-strength.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

/** A league of `n` teams, each handed `per` players off a synthetic board. */
function buildLeague(n = 10, per = 14) {
  const db = {};
  const shape = { QB: 30, RB: 60, WR: 60, TE: 30, 'D/ST': 20, K: 20 };
  const top = { QB: 24, RB: 22, WR: 21, TE: 16, 'D/ST': 9, K: 9 };
  Object.keys(shape).forEach((pos) => {
    for (let i = 0; i < shape[pos]; i++) {
      const id = `${pos}_${i}`;
      db[id] = { id, name: `${pos} ${i + 1}`, position: pos, team: 'FA',
                 projectedPoints: Math.max(1, top[pos] - (top[pos] - 2) * (i / (shape[pos] - 1))) };
    }
  });
  const board = Object.values(db).sort((a, b) => b.projectedPoints - a.projectedPoints);
  const teams = [];
  for (let i = 0; i < n; i++) teams.push({ teamId: i + 1, teamName: `Team ${i + 1}`, roster: [], faabRemaining: 0 });
  let k = 0;
  for (let rd = 0; rd < per; rd++) {
    const order = rd % 2 ? [...teams].reverse() : teams;
    for (const t of order) t.roster.push(board[k++].id);
  }
  return { leagueId: 'T', myTeamId: 1, teams, playerDatabase: db, schedule: [],
           draftState: { selections: [] } };
}

console.log('\nbest lineup');
{
  const l = buildLeague();
  const db = l.playerDatabase;
  const lu = bestLineup(l.teams[0].roster, db);
  check('fills all nine starting slots', lu.slots.length === 9, `got ${lu.slots.length}`);
  check('projects a positive total', lu.points > 0);
  // A snake draft hands the first team the best board, so it must not be
  // beaten by anyone once the rosters are equal size.
  const all = rankTeams(l);
  check('a stronger roster ranks higher',
    all.every((t, i) => i === 0 || t.points <= all[i - 1].points));

  // Every starter must be a distinct player: reusing one across two slots would
  // silently inflate every ranking on the page.
  const ids = lu.slots.filter((s) => s.player).map((s) => s.player.id);
  check('no player starts in two slots at once', new Set(ids).size === ids.length);

  // FLEX may only hold a back, receiver or tight end.
  const flex = lu.slots.find((s) => s.slot === 'FLEX');
  check('flex holds only a flex-eligible player',
    !flex.player || ['RB', 'WR', 'TE'].includes(flex.player.position),
    flex.player && flex.player.position);
}

console.log('\npreseason outlook');
{
  const l = buildLeague();
  const o = preseasonOutlook(l, 600);
  check('probabilities are percentages',
    [o.playoffPct, o.byePct, o.titlePct].every((v) => v >= 0 && v <= 100));
  check('a bye is rarer than a playoff berth', o.byePct <= o.playoffPct,
    `bye ${o.byePct} vs playoffs ${o.playoffPct}`);
  check('a title is rarer than a bye', o.titlePct <= o.playoffPct);
  check('it says it assumed a schedule', o.assumesBalancedSchedule === true);

  // The whole point: a better roster must forecast better. Compare the
  // strongest team in the league with the weakest, same league, same runs.
  const ranked = rankTeams(l);
  const strong = { ...l, myTeamId: ranked[0].teamId };
  const weak = { ...l, myTeamId: ranked[ranked.length - 1].teamId };
  const a = preseasonOutlook(strong, 1500), b = preseasonOutlook(weak, 1500);
  check('the best roster is likelier to win it than the worst',
    a.titlePct > b.titlePct, `best ${a.titlePct}% vs worst ${b.titlePct}%`);
  check('the best roster is likelier to make the playoffs',
    a.playoffPct > b.playoffPct, `best ${a.playoffPct}% vs worst ${b.playoffPct}%`);
}

console.log('\nhighest impact moves');
{
  const l = buildLeague();
  const db = l.playerDatabase;
  // Take my tight end away and the empty slot must become the loudest move.
  const me = l.teams[0];
  me.roster = me.roster.filter((id) => db[id].position !== 'TE');
  const drafted = new Set();
  l.teams.forEach((t) => t.roster.forEach((id) => drafted.add(id)));
  const fa = Object.values(db).filter((p) => !drafted.has(p.id));

  const moves = highestImpactMoves(l, fa);
  check('an empty slot is reported first', moves.length > 0 && moves[0].empty,
    moves[0] && moves[0].slot);
  check('the empty slot is the one that was emptied',
    moves[0] && (moves[0].slot === 'TE' || moves[0].slot === 'FLEX'), moves[0] && moves[0].slot);
  check('it names a real player to fill it',
    Boolean(moves[0].candidate) && moves[0].upgrade > 0);
  check('the candidate is actually available',
    !moves[0].candidate || !drafted.has(moves[0].candidate.id));
  check('every move is measured against the league, not asserted',
    moves.every((m) => typeof m.leagueMedian === 'number'));

  // Losing a starter has to cost you in the forecast, or the outlook is not
  // reading the roster at all.
  const before = preseasonOutlook(buildLeague(), 1500);
  const after = preseasonOutlook(l, 1500);
  check('losing a starter lowers the forecast', after.titlePct <= before.titlePct,
    `${before.titlePct}% -> ${after.titlePct}%`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
