/**
 * Checks for the NFL news monitor.
 * Run: node test/news-monitor.test.mjs
 *
 * Network is not touched. The feeds are stubbed, because what needs pinning is
 * the reasoning — that a headline becomes the right value change, that the
 * unnamed backup gets promoted, and that a dead feed degrades to "no news"
 * rather than to a wrong answer.
 */
import { mockLeague, mockPlayers } from '../js/mock-data.js';
import {
  classifyHeadline, normalizeName, applyNews, EVENT_IMPACT,
} from '../js/engine/news-monitor.js';
import {
  breakoutProbability, blockingValue, effectivePpg, seasonPhase, evaluateWaivers,
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

/**
 * The mock league rosters almost every player, which leaves no waiver wire and
 * makes everyone look maximally contested. This trims rosters so free agents
 * actually exist, and adds a second back on one team so an injury has somebody
 * to promote.
 */
function sparseLeague() {
  const l = league();
  l.playerDatabase.RB_10 = {
    id: 'RB_10', name: 'Backup Back', position: 'RB', team: 'SF',
    projectedPoints: 7.5, volatility: 3, injuryStatus: 'Healthy', byeWeek: 9,
    adp: 190, metrics: { snapShare: 0.3, carries: 4 },
  };
  l.teams.forEach((t, i) => { t.roster = i === 0 ? ['QB_01', 'RB_01', 'WR_03'] : []; });
  l.teams[1].roster = ['QB_02', 'RB_02', 'WR_02'];
  return l;
}

console.log('\nheadline classification');
{
  const cases = [
    ['Christian McCaffrey placed on IR with torn ACL', 'injury_out'],
    ['Report: Saquon Barkley suspended six games', 'suspension'],
    ['Breece Hall traded to the Chiefs', 'trade'],
    ['Zamir White named starter for Week 5', 'promotion'],
    ['Jahmyr Gibbs benched, loses the starting job', 'demotion'],
    ['Travis Kelce returns from injury, cleared to play', 'returning'],
    ['Tyreek Hill questionable with a hamstring strain', 'injury_risk'],
    ['Chiefs beat Raiders 27-20 in a thriller', null],
  ];
  cases.forEach(([text, want]) => {
    check(`"${text.slice(0, 44)}..." -> ${want}`, classifyHeadline(text) === want,
      `got ${classifyHeadline(text)}`);
  });
  check('name normalisation handles punctuation and suffixes',
    normalizeName("Ja'Marr Chase Jr.") === 'ja marr chase');
}

console.log('\nnews maps onto the right players');
{
  const l = sparseLeague();
  const news = [{
    type: 'injury_out', team: 'SF', players: ['Christian McCaffrey'],
    headline: 'Christian McCaffrey placed on IR', published: null, source: 'ESPN',
  }];
  const res = applyNews(l, news, { adds: [], drops: [] });
  const cmc = l.playerDatabase.RB_01;
  check('the injured player is downgraded',
    cmc.newsImpact && cmc.newsImpact.selfImpact < 0,
    `got ${cmc.newsImpact && cmc.newsImpact.selfImpact}`);
  check('urgency is flagged high', cmc.newsImpact.urgency === 'high');
  check('the event is recorded with its headline',
    cmc.newsImpact.events[0].headline.includes('IR'));
  check('reports how many players were affected', res.playersAffected >= 1);

  // Nobody wrote an article about the backup, which is the whole point.
  const heir = Object.values(l.playerDatabase).find(
    (p) => p.newsImpact && p.newsImpact.events.some((e) => e.type.endsWith('_beneficiary')));
  check('the unnamed beneficiary is promoted', !!heir,
    'no beneficiary found');
  if (heir) {
    check('beneficiary is the same position and team',
      heir.position === 'RB' && heir.team === 'SF');
    check('beneficiary is upgraded, not downgraded', heir.newsImpact.selfImpact > 0);
  }
}

console.log('\nnews changes the decisions');
{
  const l = league();
  const phase = seasonPhase(6);
  const before = breakoutProbability(l.playerDatabase.RB_08, phase);
  const ppgBefore = effectivePpg(l.playerDatabase.RB_01);

  applyNews(l, [{
    type: 'promotion', team: 'LV', players: ['Zamir White'],
    headline: 'Zamir White named starter', source: 'ESPN',
  }, {
    type: 'injury_out', team: 'SF', players: ['Christian McCaffrey'],
    headline: 'McCaffrey ruled out', source: 'ESPN',
  }], { adds: [], drops: [] });

  check('a promotion raises breakout probability',
    breakoutProbability(l.playerDatabase.RB_08, phase) > before,
    `${before.toFixed(2)} -> ${breakoutProbability(l.playerDatabase.RB_08, phase).toFixed(2)}`);
  check('bad news cuts effective output before the status field catches up',
    effectivePpg(l.playerDatabase.RB_01) < ppgBefore,
    `${ppgBefore.toFixed(1)} -> ${effectivePpg(l.playerDatabase.RB_01).toFixed(1)}`);
}

console.log('\nmarket heat drives claim probability');
{
  const l = sparseLeague();
  const phase = seasonPhase(6);
  const cold = blockingValue(l.playerDatabase.WR_09, l, l.playerDatabase, phase);
  applyNews(l, [], { adds: [{ name: 'Tyler Boyd', adds: 50000 }], drops: [] });
  const hot = blockingValue(l.playerDatabase.WR_09, l, l.playerDatabase, phase);
  check('a heavily-added player is far likelier to be claimed',
    hot.claimProbability > cold.claimProbability,
    `${cold.claimProbability.toFixed(2)} -> ${hot.claimProbability.toFixed(2)}`);
  check('claim probability stays a probability',
    hot.claimProbability > 0 && hot.claimProbability <= 1);
  check('add volume is recorded for the interface',
    l.playerDatabase.WR_09.newsImpact.addsLast24h === 50000);
}

console.log('\nnews reaches the waiver recommendations');
{
  const l = sparseLeague();
  applyNews(l, [{
    type: 'injury_out', team: 'LAC', players: ['Joshua Palmer'],
    headline: 'Joshua Palmer out for the season', source: 'ESPN',
  }], { adds: [{ name: 'Tyler Boyd', adds: 30000 }], drops: [] });
  const rep = evaluateWaivers(l, { week: 6 });
  check('waiver evaluation still runs with news attached', Array.isArray(rep.targets));
  const boyd = rep.targets.find((t) => t.addPlayer.name === 'Tyler Boyd');
  if (boyd) {
    check('a trending player shows a high claim probability',
      boyd.claimProbability > 0.5, `got ${boyd.claimProbability}`);
    check('the headline surfaces as something to watch',
      boyd.triggers.some((s) => /added him in 24h/.test(s)));
  } else {
    check('trending player appears among targets', false, 'Tyler Boyd not in targets');
  }
}

console.log('\ndegrades safely');
{
  const l = sparseLeague();
  const res = applyNews(l, [], { adds: [], drops: [] });
  check('no news means no impact anywhere',
    Object.values(l.playerDatabase).every((p) => !p.newsImpact));
  check('and it says so plainly', res.playersAffected === 0);

  const l2 = sparseLeague();
  applyNews(l2, [{ type: 'injury_out', team: 'XX',
                   players: ['Nobody Whoexists'], headline: 'x', source: 'ESPN' }],
            { adds: [{ name: 'Also Nobody', adds: 9 }], drops: [] });
  check('unknown players are ignored rather than guessed at',
    Object.values(l2.playerDatabase).every((p) => !p.newsImpact));

  check('every event type declares an impact and urgency',
    Object.values(EVENT_IMPACT).every(
      (v) => typeof v.self === 'number' && typeof v.urgency === 'string'));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
