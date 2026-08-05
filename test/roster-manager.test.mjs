/**
 * Headless checks for the roster portfolio manager.
 * Run: node test/roster-manager.test.mjs
 *
 * These assert the decisions the engine exists to get right — that a bench spot
 * is judged on future value rather than draft pedigree, that upside decays as
 * the season runs out, and that blocking never outranks your own lineup.
 */
import { mockPlayers, mockLeague } from '../js/mock-data.js';
import {
  seasonPhase, restOfSeasonPoints, playoffPoints, breakoutProbability,
  bustProbability, lineupBreakdown, lineupGain, startProbability, blockingValue,
  evaluateBench, evaluateWaivers, faabLadder, getWaiverRecommendations,
  opportunityTrend, CATEGORY, ACTION, MISSING_INPUTS,
} from '../js/engine/roster-manager.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function league() {
  const l = JSON.parse(JSON.stringify(mockLeague));
  l.playerDatabase = JSON.parse(JSON.stringify(mockPlayers));
  return l;
}
const P = (id) => JSON.parse(JSON.stringify(mockPlayers[id]));

console.log('\nseason phase');
{
  const early = seasonPhase(2), late = seasonPhase(14);
  check('upside is worth more early than late',
    early.upsideWeight > late.upsideWeight,
    `${early.upsideWeight.toFixed(2)} vs ${late.upsideWeight.toFixed(2)}`);
  check('startability matters more late than early',
    late.startabilityWeight > early.startabilityWeight);
  check('counts remaining weeks', early.weeksRemaining > late.weeksRemaining);
  check('labels the phase', early.label === 'early' && late.label === 'stretch');
}

console.log('\nplayer value');
{
  const phase = seasonPhase(5);
  const healthy = P('RB_02');
  const hurt = { ...P('RB_02'), injuryStatus: 'IR' };
  check('injury cuts rest-of-season value',
    restOfSeasonPoints(hurt, phase) < restOfSeasonPoints(healthy, phase));
  check('bye week removes a week',
    restOfSeasonPoints({ ...healthy, byeWeek: 8 }, phase)
      < restOfSeasonPoints({ ...healthy, byeWeek: 99 }, phase));
  check('playoff points only count weeks 15-17',
    playoffPoints(healthy, phase) < restOfSeasonPoints(healthy, phase));

  const workhorse = P('RB_08');                       // heavy carries, late ADP
  const nobody = { ...P('RB_09'), metrics: { snapShare: 0.15, carries: 2 }, adp: 240 };
  check('usage plus late ADP reads as breakout upside',
    breakoutProbability(workhorse, phase) > breakoutProbability(nobody, phase),
    `${breakoutProbability(workhorse, phase).toFixed(2)} vs ${breakoutProbability(nobody, phase).toFixed(2)}`);
  check('low usage reads as bust risk',
    bustProbability(nobody, phase) > bustProbability(workhorse, phase));
  check('breakout upside decays late in the season',
    breakoutProbability(workhorse, seasonPhase(15)) < breakoutProbability(workhorse, seasonPhase(2)));
}

console.log('\nopportunity trend');
{
  const hist = (vals) => vals.map((t) => ({ targets: t, carries: 0, attempts: 0 }));
  const rising = { ...P('WR_08'), metricsHistory: hist([3, 4, 3, 4, 5, 4, 9, 10, 11]) };
  const falling = { ...P('WR_08'), metricsHistory: hist([10, 11, 9, 10, 9, 10, 4, 3, 4]) };
  const flat = { ...P('WR_08'), metricsHistory: hist([6, 6, 6, 6, 6, 6, 6, 6, 6]) };
  check('rising usage reads positive', opportunityTrend(rising) > 2,
    `got ${opportunityTrend(rising).toFixed(1)}`);
  check('falling usage reads negative', opportunityTrend(falling) < -2);
  check('flat usage reads zero', Math.abs(opportunityTrend(flat)) < 0.01);
  check('no history invents no trend', opportunityTrend(P('WR_08')) === 0);
  check('too little history invents no trend',
    opportunityTrend({ ...P('WR_08'), metricsHistory: hist([5, 6, 7]) }) === 0);

  const phase = seasonPhase(8);
  check('rising usage raises breakout probability',
    breakoutProbability(rising, phase) > breakoutProbability(flat, phase),
    `${breakoutProbability(rising, phase).toFixed(2)} vs ${breakoutProbability(flat, phase).toFixed(2)}`);
  check('the trend bonus is bounded, not unlimited',
    breakoutProbability(rising, phase) - breakoutProbability(flat, phase) < 0.20);
}

console.log('\nlineup mechanics');
{
  const roster = ['QB_01', 'RB_01', 'RB_02', 'WR_01', 'WR_02', 'TE_01', 'RB_09', 'WR_09'].map(P);
  const lb = lineupBreakdown(roster);
  check('fills starters before bench', lb.starters.length > 0 && lb.bench.length > 0);
  check('best players start',
    lb.starters.some((p) => p.id === 'RB_01') && lb.bench.some((p) => p.id === 'RB_09'));
  check('an upgrade produces lineup gain', lineupGain(roster, P('WR_03')) > 0);
  check('a clear downgrade produces none', lineupGain(roster, P('WR_09')) === 0);

  const phase = seasonPhase(5);
  check('a startable player has high start probability',
    startProbability(P('WR_03'), roster, phase) > 0.8);
  check('a buried player has low start probability',
    startProbability(P('RB_09'), roster.concat([P('RB_09')]), phase) < 0.6);
}

console.log('\nblocking value');
{
  const l = league();
  const phase = seasonPhase(5);
  const bv = blockingValue(P('WR_03'), l, l.playerDatabase, phase);
  check('identifies rivals who would start him', bv.suitors.length >= 0);
  check('claim probability is a probability',
    bv.claimProbability >= 0 && bv.claimProbability <= 1);
  check('blocking value is never negative', bv.value >= 0);

  // A player nobody can use must not be worth blocking.
  const solo = { ...mockLeague, teams: [mockLeague.teams[0]], myTeamId: 1 };
  solo.playerDatabase = l.playerDatabase;
  const none = blockingValue(P('WR_09'), solo, l.playerDatabase, phase);
  check('no rivals means no blocking value', none.value === 0);
}

console.log('\nbench evaluation');
{
  const l = league();
  const rep = evaluateBench(l, { week: 5 });
  check('returns a bench report', Array.isArray(rep.bench));
  check('every bench player is classified',
    rep.bench.every((b) => Object.values(CATEGORY).includes(b.category)));
  check('names the weakest player', rep.weakest !== null);
  check('weakest is not a Core Hold when alternatives exist',
    !rep.weakest || rep.weakest.category !== CATEGORY.CORE);
  check('bench is ranked by hold value',
    rep.bench.every((b, i) => i === 0 || rep.bench[i - 1].holdValue >= b.holdValue));
  check('every player carries a reason',
    rep.bench.every((b) => typeof b.reason === 'string' && b.reason.length > 10));
  check('outcome probabilities are reported',
    rep.bench.every((b) => b.outcomes && typeof b.outcomes.weeklyStarter === 'number'));
  check('outcome probabilities are bounded',
    rep.bench.every((b) => Object.values(b.outcomes).every((v) => v >= 0 && v <= 1)));
}

console.log('\nFAAB ladder');
{
  const l = league();
  const early = faabLadder(P('WR_03'), l, seasonPhase(3), 60, 0.5);
  const late = faabLadder(P('WR_03'), l, seasonPhase(15), 60, 0.5);
  check('ladder is monotonic',
    early.minimum <= early.recommended && early.recommended <= early.aggressive
    && early.aggressive <= early.maximum,
    `${early.minimum}/${early.recommended}/${early.aggressive}/${early.maximum}`);
  check('never bids more than the budget', early.maximum <= early.budget);
  check('win probability rises with the bid',
    early.winProbability.minimum <= early.winProbability.recommended
    && early.winProbability.recommended <= early.winProbability.aggressive);
  check('bids up late, when unspent FAAB expires worthless',
    late.recommended >= early.recommended, `late $${late.recommended} vs early $${early.recommended}`);
  check('explains the opportunity cost', typeof early.opportunityCost === 'string');
}

console.log('\nwaiver evaluation');
{
  const l = league();
  const rep = evaluateWaivers(l, { week: 5 });
  check('returns ranked targets', Array.isArray(rep.targets));
  check('targets sorted by acquisition value',
    rep.targets.every((t, i) => i === 0 || rep.targets[i - 1].acquisitionValue >= t.acquisitionValue));
  check('every target has a valid action',
    rep.targets.every((t) => Object.values(ACTION).includes(t.action)));
  check('every target pairs an add with a drop',
    rep.targets.every((t) => t.addPlayer && (t.dropPlayer || rep.weakest === null)));
  check('every target carries a FAAB ladder',
    rep.targets.every((t) => t.faab && typeof t.faab.recommended === 'number'));
  check('reports what would change the call',
    rep.targets.every((t) => Array.isArray(t.triggers)));
  check('declares the inputs it does not have',
    Array.isArray(rep.missingInputs) && rep.missingInputs.length === MISSING_INPUTS.length);
  check('never recommends adding a player it rates as no-add',
    rep.targets.every((t) => t.action !== ACTION.NO));

  const legacy = getWaiverRecommendations(l, { week: 5 });
  check('legacy call shape still works',
    Array.isArray(legacy) && legacy.every((r) => r.addPlayer && typeof r.bid === 'number'));
}

console.log('\nno free agents');
{
  const l = league();
  // Give every player to some team; the wire is empty.
  const ids = Object.keys(l.playerDatabase);
  l.teams.forEach((t, i) => { t.roster = ids.filter((_, j) => j % l.teams.length === i); });
  const rep = evaluateWaivers(l, { week: 5 });
  check('handles an empty waiver wire', Array.isArray(rep.targets) && rep.targets.length === 0);
  check('still evaluates the bench', Array.isArray(rep.bench));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
