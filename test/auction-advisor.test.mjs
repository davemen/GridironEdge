/**
 * Headless checks for the market-adaptive auction advisor.
 *
 * Run: node test/auction-advisor.test.mjs
 *
 * These assert the behaviours the engine exists to produce -- that the ceiling
 * responds to the state of the room, not just to the player -- rather than
 * pinning exact dollar figures, which are expected to move as projections do.
 */
import { mockPlayers, mockLeague } from '../js/mock-data.js';
import {
  buildLeagueState, parValues, marketInflation, forecastPrice,
  lineupPoints, planValue, recommendBid, targetBoard,
} from '../js/engine/auction-advisor.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

/** Fresh auction league: nobody drafted, everyone holds $200. */
function freshLeague() {
  const l = JSON.parse(JSON.stringify(mockLeague));
  l.playerDatabase = JSON.parse(JSON.stringify(mockPlayers));
  l.draftState = { draftType: 'auction', selections: [], currentPick: 1, currentNomination: null };
  l.teams.forEach((t) => { t.faabRemaining = 200; t.roster = []; });
  return l;
}

const P = (id) => JSON.parse(JSON.stringify(mockPlayers[id]));

console.log('\nleague state');
{
  const l = freshLeague();
  const s = buildLeagueState(l);
  check('tracks every team', s.teams.length === l.teams.length);
  check('roster size from settings', s.rosterSize === 16, `got ${s.rosterSize}`);
  check('max bid reserves $1 per open slot',
    s.me.maxBid === 200 - (s.rosterSize - 1), `got ${s.me.maxBid}`);
  check('starter needs detected on an empty roster',
    s.me.needs.QB === 1 && s.me.needs.RB === 3 && s.me.needs.WR === 3);
  check('league money totals', s.moneyLeft === 200 * l.teams.length);
}

console.log('\nlineup value');
{
  const one = lineupPoints([P('RB_01')]);
  const two = lineupPoints([P('RB_01'), P('RB_02')]);
  const three = lineupPoints([P('RB_01'), P('RB_02'), P('RB_03')]);
  check('adding startable RBs raises lineup value', two > one && three > two);
  const withQB = lineupPoints([P('QB_01')]);
  const twoQB = lineupPoints([P('QB_01'), P('QB_02')]);
  check('a second QB adds far less than the first',
    (twoQB - withQB) < (withQB * 0.25), `first ${withQB.toFixed(0)}, delta ${(twoQB - withQB).toFixed(0)}`);
}

console.log('\nmarket pricing');
{
  const l = freshLeague();
  const s = buildLeagueState(l);
  const avail = Object.values(l.playerDatabase);
  const par = parValues(avail, s);
  const byId = new Map(avail.map((p, i) => [p.id, par[i]]));
  check('elite RB priced above replacement RB',
    byId.get('RB_01') > byId.get('RB_09'), `${byId.get('RB_01').toFixed(0)} vs ${byId.get('RB_09').toFixed(0)}`);
  check('par values stay inside the league budget',
    par.reduce((a, b) => a + b, 0) <= s.leagueSize * 200 * 1.05);

  const infl = marketInflation(s, par.reduce((a, b) => a + b, 0));
  check('inflation defined and sane', infl > 0.3 && infl < 2.6, `got ${infl}`);

  // Drain every rival's budget; the same player must get cheaper.
  const rich = forecastPrice(P('RB_01'), byId.get('RB_01'), s, 1.0);
  const poor = (() => {
    const l2 = freshLeague();
    l2.teams.forEach((t) => { if (t.teamId !== l2.myTeamId) t.faabRemaining = 2; });
    const s2 = buildLeagueState(l2);
    return forecastPrice(P('RB_01'), byId.get('RB_01'), s2, 1.0);
  })();
  check('price falls when rivals cannot pay', poor < rich, `rich $${rich.toFixed(0)} vs broke $${poor.toFixed(0)}`);
}

console.log('\nbid recommendation');
{
  const l = freshLeague();
  const rec = recommendBid(l, P('RB_01'), 0);
  check('returns a ceiling for an elite player', rec.maxBid > 1, `got $${rec.maxBid}`);
  check('ceiling within what we can actually pay', rec.maxBid <= 200 - 15, `got $${rec.maxBid}`);
  check('reports every field the interface needs',
    ['action', 'maxBid', 'mustBuy', 'confidence', 'reason', 'expectedPrice',
     'budgetAfterWin', 'budgetToCompleteRoster', 'inflation', 'tradeoff']
      .every((k) => k in rec));
  check('action is one of BID/HOLD/EXIT', ['BID', 'HOLD', 'EXIT'].includes(rec.action));

  const high = recommendBid(l, P('RB_01'), rec.maxBid + 5);
  check('exits once the bid passes the ceiling', high.action === 'EXIT');

}

console.log('\nfull-size player pool');
{
  // The mock database holds 22 players for a 12-team league that needs 192
  // roster spots, which makes literally everyone scarce. Real imports are deep,
  // so build a realistic pool to test the parts that depend on having options.
  const deep = freshLeague();
  const db = {};
  const shape = { QB: [24, 8], RB: [22, 4], WR: [21, 4], TE: [16, 3] };
  Object.keys(shape).forEach((pos) => {
    const [top, floor] = shape[pos];
    const n = pos === 'QB' || pos === 'TE' ? 30 : 60;
    for (let i = 0; i < n; i++) {
      const id = `${pos}_D${i}`;
      db[id] = {
        id, name: `${pos} Player ${i + 1}`, position: pos, team: 'FA',
        projectedPoints: Math.max(2, top - (top - floor) * (i / (n - 1))),
        volatility: 3, injuryStatus: 'Healthy', byeWeek: 5 + (i % 9),
        adp: i * 2 + 1, metrics: { snapShare: 0.7, targetShare: 0.15 },
      };
    }
  });
  deep.playerDatabase = db;

  const elite = recommendBid(deep, db.RB_D0, 0);
  const scrub = recommendBid(deep, db.RB_D55, 0);
  check('elite player commands a real ceiling', elite.maxBid > 20, `got $${elite.maxBid}`);
  check('replacement-level player gets a low ceiling',
    scrub.maxBid < elite.maxBid / 4, `scrub $${scrub.maxBid} vs elite $${elite.maxBid}`);
  check('elite is flagged Must Buy more readily than a scrub',
    !(scrub.mustBuy && !elite.mustBuy));

  // Same elite player, but every rival is broke: he should get cheaper.
  const broke = JSON.parse(JSON.stringify(deep));
  broke.teams.forEach((t) => { if (t.teamId !== broke.myTeamId) t.faabRemaining = 3; });
  const cheap = recommendBid(broke, db.RB_D0, 0);
  check('market forecast drops when the room is broke',
    cheap.expectedPrice < elite.expectedPrice,
    `broke $${cheap.expectedPrice} vs rich $${elite.expectedPrice}`);
}

console.log('\nroster context changes the answer');
{
  // Already holding three quarterbacks: a fourth must be refused outright.
  const l = freshLeague();
  ['QB_01', 'QB_02', 'QB_03'].forEach((id, i) => {
    l.draftState.selections.push({ pick: i + 1, playerId: id, teamId: l.myTeamId, bidAmount: 5 });
  });
  const rec = recommendBid(l, P('QB_04'), 0);
  check('refuses a player past the positional cap', rec.maxBid === 0 && rec.action === 'EXIT');

  // Nearly out of money: ceiling must collapse to what is affordable.
  const broke = freshLeague();
  broke.teams.find((t) => t.teamId === broke.myTeamId).faabRemaining = 20;
  const r2 = recommendBid(broke, P('RB_01'), 0);
  check('ceiling respects a depleted budget', r2.maxBid <= 20 - 15 + 1, `got $${r2.maxBid}`);
}

console.log('\nregressions');
{
  // Build a realistic deep pool once for both checks.
  const deep = freshLeague();
  const db = {};
  const shape = { QB: [24, 8], RB: [22, 4], WR: [21, 4], TE: [16, 3] };
  Object.keys(shape).forEach((pos) => {
    const [top, floor] = shape[pos];
    const n = pos === 'QB' || pos === 'TE' ? 30 : 60;
    for (let i = 0; i < n; i++) {
      db[`${pos}_D${i}`] = {
        id: `${pos}_D${i}`, name: `${pos} ${i + 1}`, position: pos, team: 'FA',
        projectedPoints: Math.max(2, top - (top - floor) * (i / (n - 1))),
        volatility: 3, injuryStatus: 'Healthy', byeWeek: 5 + (i % 9), adp: i * 2 + 1,
      };
    }
  });
  deep.playerDatabase = db;

  // REGRESSION: the planner used to clamp a player's price down to whatever cash
  // was left, so it could "buy" a $50 stud for $1. Budget stopped mattering and
  // every ceiling pinned to the maximum possible bid.
  const opening = recommendBid(deep, db.RB_D0, 0);
  check('opening ceiling is near market, not the max possible bid',
    opening.maxBid < 100, `got $${opening.maxBid} (max possible is $185)`);
  check('nothing is a Must Buy while the board is still full',
    !opening.mustBuy && !recommendBid(deep, db.QB_D0, 0).mustBuy);
  check('a quarterback is not priced like an elite back',
    recommendBid(deep, db.QB_D0, 0).maxBid < opening.maxBid,
    `QB $${recommendBid(deep, db.QB_D0, 0).maxBid} vs RB $${opening.maxBid}`);

  // Must Buy has to fire once scarcity is real: elite backs gone, cash still out.
  const late = JSON.parse(JSON.stringify(deep));
  let pick = 1;
  for (let i = 1; i < 12; i++) {
    late.draftState.selections.push({ pick: pick++, playerId: `RB_D${i}`, teamId: (i % 11) + 2, bidAmount: 40 });
  }
  late.teams.forEach((t) => { if (t.teamId !== late.myTeamId) t.faabRemaining = 160; });
  const scarce = recommendBid(late, db.RB_D0, 0);
  check('Must Buy fires when the position runs dry', scarce.mustBuy,
    `maxBid $${scarce.maxBid}, loss ${scarce.lossIfMissed}`);
  check('Must Buy allows a premium over market',
    scarce.maxBid > scarce.expectedPrice,
    `ceiling $${scarce.maxBid} vs market $${scarce.expectedPrice}`);
  check('the premium is bounded, not unlimited',
    scarce.maxBid < scarce.expectedPrice * 2, `ceiling $${scarce.maxBid}`);
}

console.log('\nplanner and targets');
{
  const l = freshLeague();
  const s = buildLeagueState(l);
  const avail = Object.values(l.playerDatabase);
  const par = parValues(avail, s);
  const board = avail.map((p, i) => ({ player: p, price: Math.max(1, par[i]) }))
    .sort((a, b) => b.price - a.price).slice(0, 30);
  const plan = planValue([], 200, s.rosterSize, board, null, true);
  check('planner spends within budget', plan.spend <= 200, `spent $${plan.spend}`);
  check('planner produces a real lineup', plan.value > 0);
  check('planner fills roster spots', plan.bought.length > 0);

  const targets = targetBoard(l, 5);
  check('target board returns candidates', targets.length > 0, `got ${targets.length}`);
  check('targets carry a ceiling and market price',
    targets.every((t) => typeof t.maxBid === 'number' && typeof t.expectedPrice === 'number'));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
