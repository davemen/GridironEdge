/**
 * Checks for the bracket strategy engine.
 * Run: node test/bracket-strategy.test.mjs
 *
 * The behaviour that matters is counterintuitive and easy to get backwards, so
 * the tests pin the direction explicitly: favourites play the floor, underdogs
 * play the ceiling, and neither applies outside the playoffs.
 */
import { mockLeague, mockPlayers } from '../js/mock-data.js';
import { recommendLineupStrategy, winProbability, playoffValue }
  from '../js/engine/bracket-strategy.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function league({ week = 15, myPoints = 1400, oppPoints = 1200 } = {}) {
  const l = JSON.parse(JSON.stringify(mockLeague));
  l.playerDatabase = JSON.parse(JSON.stringify(mockPlayers));
  l.teams[0].pointsScored = myPoints;
  l.teams[0].record = { wins: 7, losses: 7, ties: 0 };
  l.teams[1].pointsScored = oppPoints;
  l.teams[1].record = { wins: 7, losses: 7, ties: 0 };
  l.schedule = [{ week, matchupId: 1, team1Id: 1, team2Id: 2 }];
  return l;
}

console.log('\nwin probability');
{
  const strong = winProbability({ pointsScored: 1600, record: { wins: 7, losses: 7 } },
                                { pointsScored: 1200, record: { wins: 7, losses: 7 } });
  const weak = winProbability({ pointsScored: 1200, record: { wins: 7, losses: 7 } },
                              { pointsScored: 1600, record: { wins: 7, losses: 7 } });
  check('outscoring your opponent makes you the favourite', strong > 0.5, `got ${strong.toFixed(2)}`);
  check('being outscored makes you the underdog', weak < 0.5, `got ${weak.toFixed(2)}`);
  check('the two are symmetric', Math.abs((strong + weak) - 1) < 0.02);
  check('probabilities stay bounded', strong < 1 && weak > 0);
  const even = winProbability({ pointsScored: 1400, record: { wins: 7, losses: 7 } },
                              { pointsScored: 1400, record: { wins: 7, losses: 7 } });
  check('equal teams are a coin flip', Math.abs(even - 0.5) < 0.01);
}

console.log('\nthe bracket decision');
{
  const fav = recommendLineupStrategy(league({ myPoints: 1600, oppPoints: 1150 }));
  check('playoff week is detected', fav.isPlayoffs);
  check('FAVOURITE plays the floor', fav.strategy === 'floor',
    `got ${fav.strategy} at ${Math.round(fav.winProbability * 100)}%`);
  check('favourite is flagged as such', fav.favoured === true);
  check('reason explains the floor', /floor/i.test(fav.reason));

  const dog = recommendLineupStrategy(league({ myPoints: 1150, oppPoints: 1600 }));
  check('UNDERDOG plays the ceiling', dog.strategy === 'ceiling',
    `got ${dog.strategy} at ${Math.round(dog.winProbability * 100)}%`);
  check('underdog is flagged as such', dog.favoured === false);
  check('reason explains the ceiling', /ceiling/i.test(dog.reason));

  check('a big mismatch reads as high confidence', fav.confidence === 'high',
    `got ${fav.confidence}`);
  const close = recommendLineupStrategy(league({ myPoints: 1405, oppPoints: 1400 }));
  check('a close game reads as low confidence', close.confidence === 'low',
    `got ${close.confidence}`);
}

console.log('\noutside the playoffs');
{
  const reg = recommendLineupStrategy(league({ week: 8, myPoints: 1150, oppPoints: 1600 }));
  check('week 8 is not a playoff week', reg.isPlayoffs === false);
  check('regular season does not chase variance', reg.strategy === 'floor',
    `got ${reg.strategy}`);
  check('regular-season reasoning says why', /regular season/i.test(reg.reason));
}

console.log('\ndegrades safely');
{
  const noOpp = JSON.parse(JSON.stringify(mockLeague));
  noOpp.schedule = [];
  const r = recommendLineupStrategy(noOpp, { week: 16 });
  check('no opponent still returns a usable strategy',
    ['floor', 'ceiling'].includes(r.strategy));
  check('and says it is unsure', r.confidence === 'low');

  const empty = recommendLineupStrategy({ teams: [], myTeamId: 1 }, { week: 16 });
  check('an empty league does not throw', typeof empty.strategy === 'string');
}

console.log('\nplayoff value');
{
  const p = { projectedPoints: 15, playoffMatchup: 1.2 };
  const q = { projectedPoints: 15, playoffMatchup: 0.8 };
  const n = { projectedPoints: 15 };
  check('a soft playoff schedule is worth more',
    playoffValue(p).titleWeightedValue > playoffValue(q).titleWeightedValue);
  check('equal players differ only by schedule',
    playoffValue(p).seasonPoints === playoffValue(q).seasonPoints);
  check('missing schedule data is reported, not invented',
    playoffValue(n).hasScheduleData === false && playoffValue(n).matchupMultiplier === 1.0);
  check('neutral schedule leaves value unchanged',
    Math.abs(playoffValue(n).titleWeightedValue - playoffValue(n).seasonPoints) < 1e-9);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
