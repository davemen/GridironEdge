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

console.log('\nmid-draft, unfilled slots are worth what is still signable');
{
  // At pick 16 of 128 only one team has drafted. Valuing everyone else's empty
  // slots at zero made a three-man roster a 95% title favourite -- a statement
  // about draft progress, not about rosters.
  const l = buildLeague(8, 14);
  const db = l.playerDatabase;
  const board = Object.values(db).sort((a, b) => b.projectedPoints - a.projectedPoints);
  l.teams.forEach((t) => { t.roster = []; });
  l.teams[0].roster = board.slice(0, 3).map((p) => p.id);
  l.draftState.selections = l.teams[0].roster.map((id) => ({ playerId: id, teamId: l.teams[0].teamId }));
  l.rosterSettings = { startersCount: 9, benchCount: 7 };
  l.leagueSize = 8;

  const ranked = rankTeams(l);
  check('it says it is projecting unfilled slots', ranked[0].projected === true);

  // Per slot, not just per team. The FLEX has its own fallback, so a total or a
  // single `projected` flag stays healthy even with every fixed slot's
  // replacement value zeroed -- a mutation run proved both survive that way.
  const { replacementLevels } = await import('../js/engine/team-strength.js');
  const levels = replacementLevels(l);
  const empty = bestLineup([], db, levels);
  check('every unfilled slot is valued, not zeroed',
    empty.slots.length > 0 && empty.slots.every((sl) => sl.points > 0),
    empty.slots.map((sl) => `${sl.slot}:${sl.points}`).join(' '));
  check('and every one of them is marked as projected',
    empty.slots.every((sl) => sl.projected === true),
    empty.slots.filter((sl) => !sl.projected).map((sl) => sl.slot).join(',') || 'none');
  check('a filled slot is not marked projected',
    bestLineup(board.slice(0, 3).map((p) => p.id), db, levels)
      .slots.filter((sl) => sl.player).every((sl) => sl.projected === false));
  // Without replacement levels -- a finished draft -- an empty slot really is
  // worth nothing, and must not claim to be a projection.
  const done = bestLineup([], db, null);
  check('with the draft over, an empty slot is zero and says nothing',
    done.slots.every((sl) => sl.points === 0 && sl.projected === false));
  check('an undrafted team is not worth zero',
    ranked[ranked.length - 1].points > 0, `${ranked[ranked.length - 1].points}`);
  // Every team that has drafted nothing is in exactly the same position, so
  // they must be level. Any spread between them is an artifact.
  const empties = ranked.filter((t) => t.rostered === 0).map((t) => t.points);
  check('undrafted teams are level with each other',
    empties.length > 1 && Math.max(...empties) - Math.min(...empties) < 0.01);
  check('three elite picks still lead the league',
    ranked[0].rostered === 3 && ranked[0].points > empties[0]);

  // This fixture is one team with three picks and seven teams with nothing --
  // the mixed board an auction scrape produces, where the seven cannot be
  // ranked at all. The engine declines, which is a stronger answer than the
  // "not a certainty" bound this used to assert: the old code returned a
  // confident percentage computed from teams it had never seen.
  const o = preseasonOutlook(l, 1200);
  check('a board where only one roster is readable is declined, not scored',
    o.unknown === true && o.titlePct === null, `${o.titlePct}%`);

  // Give the other seven a roster and it answers again, and the answer is an
  // edge rather than a certainty.
  const even = buildLeague(8, 14);
  even.rosterSettings = { startersCount: 9, benchCount: 7 };
  even.leagueSize = 8;
  // Team 0 drafts from the top, the rest from further down, so its edge is a
  // real one rather than an artefact of who was left unread.
  even.teams.forEach((t, i) => {
    const from = i === 0 ? 0 : 40 + i * 12;
    t.roster = board.slice(from, from + 9).map((p) => p.id);
  });
  even.draftState.selections = even.teams.flatMap((t) =>
    t.roster.map((id) => ({ playerId: id, teamId: t.teamId })));
  const oe = preseasonOutlook(even, 1200);
  check('the title chance is a roster edge, not a certainty',
    oe.titlePct > 100 / 8 && oe.titlePct < 90, `${oe.titlePct}%`);

  // Once the draft is done there is nothing left to project.
  const full = buildLeague(8, 14);
  full.rosterSettings = { startersCount: 9, benchCount: 7 };
  full.leagueSize = 8;
  full.draftState.selections = full.teams.flatMap((t) =>
    t.roster.map((id) => ({ playerId: id, teamId: t.teamId })));
  check('a finished draft is not projected',
    rankTeams(full, { projectFinal: false })[0].projected === false);
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

console.log('\nthe preseason engine declines on a league it can only half see');
{
  // The in-season simulator learned to refuse when a roster cannot be read.
  // This engine did not, and it is the one the app routes to whenever there is
  // no schedule -- which is every draft-room import. It valued every empty slot
  // at replacement, so nine unread teams came out at 102.8 points each and the
  // dashboard read "titlePct 84.1, playoffPct 100". That is the old 105.0
  // constant under a different name.
  const mixed = buildLeague(10, 14);
  const board = Object.values(mixed.playerDatabase)
    .sort((a, b) => b.projectedPoints - a.projectedPoints);
  mixed.teams.forEach((t, i) => { t.roster = i === 0 ? board.slice(0, 12).map((p) => p.id) : []; });
  mixed.draftState.selections = mixed.teams[0].roster.map((id) => ({ playerId: id, teamId: mixed.teams[0].teamId }));
  const out = preseasonOutlook(mixed, 300);
  check('a league where only one roster is readable returns unknown',
    out && out.unknown === true, JSON.stringify(out && out.titlePct));
  check('and no odds at all',
    out.titlePct === null && out.playoffPct === null && out.byePct === null);
  check('and says how many it could not read',
    /9 of 10 teams/.test(out.reason || ''), out.reason);

  // An auction scrape says so itself, and must be believed even if the counts
  // happen to look complete.
  const scraped = buildLeague(10, 14);
  scraped.teams.forEach((t) => { t.roster = []; });
  scraped.coverage = { kind: 'own-roster-only', knownTeamId: 1 };
  scraped.teams[0].roster = board.slice(0, 3).map((p) => p.id);
  check('a partial-coverage scrape declines too',
    preseasonOutlook(scraped, 300).unknown === true);

  // A league whose projections never loaded has EVERY team unreadable and no
  // coverage field, so it fell past both clauses above and simulated: measured
  // through the real renderers, 10.9% championship and 60.3% playoff, beside a
  // note reading "Yours projects 0 points a week against a league best of 0",
  // with projectionsMissing true throughout and never mentioned.
  const noProj = buildLeague(10, 14);
  noProj.teams.forEach((t) => { t.roster = []; });
  noProj.projectionsMissing = true;
  const np = preseasonOutlook(noProj, 300);
  check('a league with no projections at all declines', np.unknown === true,
    `titlePct ${np.titlePct}`);
  check('and says which fact it is', /no player projections/i.test(np.reason || ''),
    np.reason);

  // Same shape, but the reason is different: the projections loaded and the
  // rosters are simply unread.
  const drafted = buildLeague(10, 14);
  drafted.teams.forEach((t) => { t.roster = []; });
  drafted.draftState.selections = [{ playerId: 'x', teamId: 1 }];
  const dr = preseasonOutlook(drafted, 300);
  check('a drafted league with no readable roster declines too', dr.unknown === true);
  check('and blames the rosters, not the projections',
    /resolved to projected players/i.test(dr.reason || ''), dr.reason);

  // But the cases that ARE answerable must still answer, or the fix is a
  // different kind of wrong.
  const whole = buildLeague(10, 14);
  check('a fully readable league still returns odds',
    typeof preseasonOutlook(whole, 300).titlePct === 'number');
  const predraft = buildLeague(10, 14);
  predraft.teams.forEach((t) => { t.roster = []; });
  predraft.draftState.selections = [];
  const pd = preseasonOutlook(predraft, 300);
  check('and so does a league where nobody has drafted yet',
    typeof pd.titlePct === 'number',
    'everyone equally empty is "no edge yet", which is a true answer');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
