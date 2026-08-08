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
  opportunityTrend, freeAgentPool, CATEGORY, ACTION, MISSING_INPUTS, NEWS_DERIVED_INPUTS,
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
  // Snapshots are cumulative season totals; the engine differences them.
  const hist = (vals) => {
    let run = 0;
    return [{ seasonTargets: 0, seasonCarries: 0, seasonAttempts: 0 }].concat(
      vals.map((t) => ({ seasonTargets: (run += t), seasonCarries: 0, seasonAttempts: 0 })));
  };
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
  // `bv.suitors.length >= 0` was here, and it is true of every array. A
  // mutation replacing the whole list with [] passed. Name the rivals.
  check('identifies rivals who would start him', bv.suitors.length > 0,
    JSON.stringify(bv.suitors));
  check('and each one is a real team, not a placeholder',
    bv.suitors.every((s) => s.teamName
      && l.teams.some((t) => t.teamName === s.teamName)),
    JSON.stringify(bv.suitors.map((x) => x.teamName)));
  check('claim probability is a probability',
    bv.claimProbability >= 0 && bv.claimProbability <= 1);
  // A bounds check cannot see 0.05 become 0.95. The no-suitors floor is the
  // discriminating case: a player nobody in the league would start is not
  // 95% likely to be claimed.
  //
  // NOT asserted: that a good player is likelier to be claimed than a weak
  // one. Measured, both come back at the 0.95 ceiling -- eight of the twelve
  // mock teams field no roster at all, so every position is a gap and everyone
  // is in demand. That is the fixture, not the engine, and asserting it would
  // have pinned my expectation rather than the code.
  check('blocking value is never negative', bv.value >= 0);

  // A player nobody can use must not be worth blocking.
  const solo = { ...mockLeague, teams: [mockLeague.teams[0]], myTeamId: 1 };
  solo.playerDatabase = l.playerDatabase;
  const none = blockingValue(P('WR_09'), solo, l.playerDatabase, phase);
  check('no rivals means no blocking value', none.value === 0);
  // A bounds check cannot see 0.05 become 0.95. The no-suitors floor is the
  // discriminating case: a player nobody in the league would start is not
  // 95% likely to be claimed.
  //
  // NOT asserted: that a good player is likelier to be claimed than a weak
  // one. Measured, both come back at the 0.95 ceiling -- eight of the twelve
  // mock teams field no roster at all, so every position is a gap and everyone
  // is in demand. That is the fixture, not the engine, and asserting it would
  // have pinned my expectation rather than the code.
  check('a player no rival would start is not 95% likely to be claimed',
    none.claimProbability < 0.4, String(none.claimProbability));
  check('while one several rivals would start is', bv.claimProbability > 0.4,
    String(bv.claimProbability));
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
  // Over a one-element bench this passed with the sort deleted. mock-data now
  // carries four, with separated projections, so the ordering is real -- but
  // say so, or the next person shrinks the fixture and never learns.
  check('the bench is deep enough for an ordering to mean anything',
    rep.bench.length >= 3, `${rep.bench.length} bench players`);
  check('bench is ranked by hold value',
    rep.bench.every((b, i) => i === 0 || rep.bench[i - 1].holdValue >= b.holdValue),
    JSON.stringify(rep.bench.map((b) => b.holdValue)));
  check('and their hold values are not all equal',
    new Set(rep.bench.map((b) => b.holdValue)).size > 1,
    JSON.stringify(rep.bench.map((b) => b.holdValue)));
  // A player worth less than nothing must not be labelled KEEP HIM. Which
  // flavour of "let him go" he gets is a judgement -- Replaceable and Drop
  // Candidate are both honest -- but Core Hold, Defensive Hold and
  // High-Upside Stash are not.
  //
  // This is the assertion that found the bug: `block.value >= holdValue * 0.5`
  // is trivially true for a NEGATIVE holdValue, so both worthless players came
  // back as "Defensive Hold" and the app recommended keeping them.
  const KEEP = [CATEGORY.CORE, CATEGORY.DEFENSIVE, CATEGORY.STASH];
  check('a bench player worth less than nothing is not labelled a keep',
    rep.bench.every((b) => b.holdValue > 0 || !KEEP.includes(b.category)),
    JSON.stringify(rep.bench.map((b) => [b.holdValue, b.category])));
  check('and the bench really does contain one, or this proves nothing',
    rep.bench.some((b) => b.holdValue <= 0),
    JSON.stringify(rep.bench.map((b) => b.holdValue)));
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

console.log('\na drafted player is off the board, however he was recorded');
{
  // Three bars, and a mutation run showed all three could be deleted with the
  // whole suite still green: the id bar, the name bar, and marking a draft
  // selection as owned at all. This is the "recommend claiming Josh Allen
  // while Josh Allen is already drafted" bug the code comments describe.
  const base = league();
  const anyone = Object.values(base.playerDatabase)[0];

  // 1. On a roster.
  const byRoster = league();
  byRoster.teams[0].roster = [anyone.id];
  check('a player on a roster is not a free agent',
    !freeAgentPool(byRoster, byRoster.playerDatabase).some((p) => p.id === anyone.id),
    anyone.name);

  // 2. Drafted, but nobody could tell whose pick it was -- routine in an
  // auction room, where the scrape often cannot attribute a lot.
  const unattributed = league();
  unattributed.teams.forEach((t) => { t.roster = []; });
  unattributed.draftState = { selections: [{ playerId: anyone.id, teamId: null }] };
  check('an unattributed pick is still off the board',
    !freeAgentPool(unattributed, unattributed.playerDatabase).some((p) => p.id === anyone.id),
    'he came back as a free agent, and the app will offer him to you');

  // 3. Drafted under a STUB id, because the name did not resolve. The real
  // record then sits in the pool looking free, which no id check can see.
  const byName = league();
  byName.teams.forEach((t) => { t.roster = []; });
  const stubId = `MOCK_${anyone.name.toLowerCase().replace(/\s+/g, '_')}`;
  byName.playerDatabase[stubId] = { id: stubId, name: anyone.name,
    position: anyone.position, team: anyone.team, projectedPoints: 4.5 };
  byName.draftState = { selections: [{ playerId: stubId, teamId: 1 }] };
  const pool = freeAgentPool(byName, byName.playerDatabase);
  check('and so is the real record behind a stub of the same name',
    !pool.some((p) => p.id === anyone.id),
    `${anyone.name} is offered as a free agent while somebody already owns him`);

  // 4. A stub on a ROSTER, rather than in the selections. Same gap from the
  // other direction, and the only case where barring rostered names matters:
  // the id bar sees the stub, and nothing sees the real record behind it.
  const stubRoster = league();
  stubRoster.teams.forEach((t) => { t.roster = []; });
  stubRoster.playerDatabase[stubId] = { id: stubId, name: anyone.name,
    position: anyone.position, team: anyone.team, projectedPoints: 4.5 };
  stubRoster.teams[0].roster = [stubId];
  stubRoster.draftState = { selections: [] };
  check('a stub on a roster also bars the real record',
    !freeAgentPool(stubRoster, stubRoster.playerDatabase).some((p) => p.id === anyone.id),
    `${anyone.name} is free while a stub of him sits on a roster`);

  // 5. A drafted record with NO name. Nothing can bar it by name, so the id
  // bar is the only thing standing between it and the free-agent list.
  const nameless = league();
  nameless.teams.forEach((t) => { t.roster = []; });
  const namelessId = 'NAMELESS_1';
  nameless.playerDatabase[namelessId] = { id: namelessId, name: '',
    position: 'WR', team: 'FA', projectedPoints: 8 };
  nameless.draftState = { selections: [{ playerId: namelessId, teamId: 2 }] };
  check('a drafted record with no name is barred by its id',
    !freeAgentPool(nameless, nameless.playerDatabase).some((p) => p.id === namelessId),
    'the only bar that can catch this one is the id');

  // The bars must not swallow the whole board.
  const untouched = league();
  untouched.teams.forEach((t) => { t.roster = []; });
  untouched.draftState = { selections: [] };
  check('an undrafted player is still available',
    freeAgentPool(untouched, untouched.playerDatabase).length
      === Object.keys(untouched.playerDatabase).length,
    'the pool is emptier than the draft explains');
}

console.log('\nthe two input lists cannot claim the same thing');
{
  // "Kept explicit so the two lists cannot drift apart silently" -- and they
  // had: 'in-season trades' was in both, so evaluateWaivers told the user trade
  // news was unavailable while news-monitor was classifying trade events.
  const overlap = MISSING_INPUTS.filter((x) => NEWS_DERIVED_INPUTS.includes(x));
  check('nothing is both missing and supplied', overlap.length === 0,
    overlap.join(', '));
  check('and both lists are non-empty',
    MISSING_INPUTS.length > 0 && NEWS_DERIVED_INPUTS.length > 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
