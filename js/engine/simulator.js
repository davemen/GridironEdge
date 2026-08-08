import { optimizeLineup } from './lineup-optimizer.js';
import { REGULAR_WEEKS, slotList, playoffFieldSize, byeCount } from './lineup-rules.js';
import { WEEKLY_SD, WEATHER_RATE } from './scoring-model.js';
import { getWaiverRecommendations } from './roster-manager.js';
import { generateTradeProposals } from './trade-generator.js';

// Box-Muller Transform for Gaussian random values
function randomNormal(mean = 0, stdDev = 1) {
  let u = 0, v = 0;
  while(u === 0) u = Math.random(); // Converting [0,1) to (0,1)
  while(v === 0) v = Math.random();
  const num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return num * stdDev + mean;
}

/**
 * Play the bracket out, scored from the teams actually in it.
 *
 * The bracket was six randomNormal draws with hardcoded means -- 115 v 110,
 * 112 v 112, 116 v 114 -- that never read a roster, a projection or the
 * seed's identity. The champion was a coin flip between fixed indices, so
 * the "probability of winning the title" on the home page was noise wearing
 * the clothes of a forecast: exactly what CLAUDE.md exists to prevent, and
 * invisible on screen because invented output looks like real output.
 *
 * It also referenced only pTeams[0..3], so widening the field to six left
 * seeds 5 and 6 permanently unable to win.
 *
 * The per-week projections are computed by the caller, so each game uses the
 * two teams' own scoring with the same weekly spread as the regular
 * season. Top seeds get byes; the rest pair highest against lowest.
 */
export function playBracket(seeds, weekProj) {
  // No projection, no bracket. `randomNormal(undefined, sd)` is NaN,
  // `Math.max(50, NaN)` is NaN, and `NaN >= NaN` is false -- so every game went
  // to `b`, the LOWER seed, and the "championship probability" that came out
  // was the bracket's shape rather than anybody's roster. It read 97.6% for the
  // weakest roster in a ten-team league. Returning null says the question
  // cannot be answered, which is the same contract runSeasonSimulation uses
  // 300 lines below when a roster will not resolve.
  const proj = weekProj || {};
  if (!Array.isArray(seeds) || seeds.length === 0) return null;
  if (seeds.some((id) => typeof proj[id] !== 'number')) return null;
  const scoreOf = (id) => Math.max(50, randomNormal(proj[id], WEEKLY_SD));
  const beats = (a, b) => (scoreOf(a) >= scoreOf(b) ? a : b);
  // The byes rejoin after ONE round, not after the rest have been played down
  // to a single survivor.
  //
  // The first version looped the non-bye group to one team before the byes
  // came back, so seed 2 walked straight into the final: over 200,000
  // brackets with six identical teams, seed 2 won 50.1% and seed 1 24.9%,
  // while seeds 3-6 shared 6.2% each. That is not a seeding advantage, it is
  // a structural one, and team-strength implements the correct form 200 lines
  // away with a comment describing exactly this shape.
  //
  // Seeding is preserved between rounds so the highest survivor keeps meeting
  // the lowest, which is what a bye is worth.
  const rank = new Map(seeds.map((id, i) => [id, i]));
  const bySeed = (a, b) => rank.get(a) - rank.get(b);
  const playRound = (field) => {
    const next = [];
    const queue = field.slice();
    while (queue.length > 1) next.push(beats(queue.shift(), queue.pop()));
    if (queue.length) next.push(queue.shift());
    return next.sort(bySeed);
  };

  // Sized from THIS field, not a constant. See byeCount.
  const byes = seeds.slice(0, byeCount(seeds.length));
  const firstRound = playRound(seeds.slice(byeCount(seeds.length)));
  let alive = byes.concat(firstRound).sort(bySeed);
  while (alive.length > 1) alive = playRound(alive);
  return alive[0];
}

export function runSeasonSimulation(league, runs = 1000) {
  const db = league.playerDatabase;
  const teams = league.teams;
  const schedule = league.schedule || [];

  // The SAME decline shape as the one below, not zeros. This returned
  // playoffPct: 0 with no `unknown` and no `reason`, 180 lines above the
  // decline it should have matched, and "0%" on screen is a forecast saying
  // you cannot make the playoffs -- not "there is no league here to simulate".
  if (!teams || teams.length === 0) {
    return {
      unknown: true, unprojectableTeamIds: [],
      reason: 'This league has no teams to simulate.',
      playoffPct: null, champPct: null, byePct: null,
      actionPlan: [], competitors: [],
    };
  }

  // Helper to calculate a team's dynamic weekly projected score
  /**
   * A team's weekly score, or null when there is no roster to compute it from.
   *
   * This returned the constant 105.0 in that case, and 105.0 does not look like
   * a missing value on screen -- it looks like a forecast. A league loaded over
   * the ESPN API resolved zero players on every team, because the view list
   * does not request the player catalogue, so every projection in the model was
   * that constant: the Championship page showed playoff odds, championship
   * odds, a first-round bye percentage and a named top rival, and not one
   * figure came from a projection. Null propagates instead, and the caller
   * declines to answer.
   */
  const calculateTeamProjection = (team, week = null, isWindy = false) => {
    if (!team || !team.roster || team.roster.length === 0) return null;

    const rosterPlayers = team.roster.map(pid => db[pid]).filter(Boolean);
    if (rosterPlayers.length === 0) return null;

    const slots = slotList(league.rosterSettings);

    const allocatedIds = new Set();
    let totalTeamProj = 0;

    slots.forEach(slot => {
      let bestPlayer = null;
      let bestScore = -999;

      rosterPlayers.forEach(p => {
        if (allocatedIds.has(p.id)) return;

        // Skip players on bye weeks
        if (week !== null && p.byeWeek === week) return;
        
        // Match position
        const isMatch = slot.isFlex 
          ? slot.pos.includes(p.position) 
          : p.position === slot.pos;
          
        if (isMatch) {
          let injuryDeduction = 0;
          if (p.injuryStatus === 'Questionable') injuryDeduction = 2.0;
          if (p.injuryStatus === 'Doubtful') injuryDeduction = 6.0;
          if (p.injuryStatus === 'Out' || p.injuryStatus === 'IR') return;

          let playerProj = p.projectedPoints - injuryDeduction;

          // Usage adjustments
          if (p.metrics) {
            const m = p.metrics;
            let usageMultiplier = 1.0;
            if (m.snapShare !== undefined) {
              if (m.snapShare >= 0.85) usageMultiplier += 0.05;
              if (m.snapShare < 0.50) usageMultiplier -= 0.10;
            }
            if (['WR', 'TE', 'RB'].includes(p.position) && m.targetShare !== undefined) {
              if (m.targetShare >= 0.25) usageMultiplier += 0.08;
              if (m.targetShare < 0.12) usageMultiplier -= 0.05;
            }
            if (p.position === 'RB' && m.carries !== undefined) {
              if (m.carries >= 16) usageMultiplier += 0.05;
              if (m.carries < 8) usageMultiplier -= 0.08;
            } else if (p.position === 'QB' && m.carries !== undefined) {
              if (m.carries >= 6) usageMultiplier += 0.08;
            }
            playerProj = playerProj * usageMultiplier;

            if (m.redZoneTargets) playerProj += m.redZoneTargets * 0.5;
            if (m.redZoneCarries) playerProj += m.redZoneCarries * 0.4;
          }

          // Matchup adjustments
          let matchupAdjustment = 1.0;
          if (p.opponent && db) {
            const opponentDefense = Object.values(db).find(
              def => def.position === 'D/ST' && def.team === p.opponent
            );
            if (opponentDefense) {
              if (opponentDefense.projectedPoints >= 8.2) {
                matchupAdjustment = 0.94;
              } else if (opponentDefense.projectedPoints <= 6.8) {
                matchupAdjustment = 1.06;
              }
            }
          }
          playerProj = playerProj * matchupAdjustment;

          // Weather adjustments (windy/rainy conditions impact passing/kicking, boost rushing)
          if (isWindy) {
            if (['QB', 'WR', 'TE', 'K'].includes(p.position)) {
              playerProj = playerProj * 0.92; // 8% penalty
            } else if (p.position === 'RB') {
              playerProj = playerProj * 1.05; // 5% boost
            }
          }

          if (playerProj > bestScore) {
            bestScore = playerProj;
            bestPlayer = p;
          }
        }
      });

      if (bestPlayer) {
        allocatedIds.add(bestPlayer.id);
        totalTeamProj += Math.max(0, bestScore);
      }
    });

    // Zero means not one player on the roster resolved to a projection, which
    // is the same "we cannot see this team" as an empty roster.
    return totalTeamProj > 0 ? totalTeamProj : null;
  };




  // Projections for every week that is still to be played. This ran 5..14
  // regardless, matching the hardcoded currentWeek below it; both are derived
  // now, and from the same place, so a league in week 11 no longer costs ten
  // weeks of projection to use four.
  // Never past REGULAR_WEEKS: the playoff bracket scores its games off the
  // final regular-season week, so that week is needed even when the regular
  // season is already over. Without the clamp a finished league produced no
  // projections at all and playBracket had nothing to score with.
  const projectFrom = Math.min(REGULAR_WEEKS, Math.max(1,
    Math.max(0, ...teams.map((t) => (t.record?.wins || 0)
      + (t.record?.losses || 0) + (t.record?.ties || 0))) + 1));
  const teamProjectionsPerWeek = {};
  const unprojectable = [];
  for (let w = projectFrom; w <= REGULAR_WEEKS; w++) {
    teamProjectionsPerWeek[w] = {
      normal: {},
      windy: {}
    };
    teams.forEach(t => {
      const normal = calculateTeamProjection(t, w, false);
      const windy = calculateTeamProjection(t, w, true);
      if (normal === null || windy === null) {
        if (!unprojectable.includes(t.teamId)) unprojectable.push(t.teamId);
      }
      teamProjectionsPerWeek[w].normal[t.teamId] = normal;
      teamProjectionsPerWeek[w].windy[t.teamId] = windy;
    });
  }

  // A season is simulated against opponents. If any of them cannot be
  // projected, every game they play is decided by a substituted constant, and
  // an odds figure built that way is indistinguishable on screen from one built
  // from real rosters. Say which teams could not be read instead.
  if (unprojectable.length) {
    return {
      unknown: true,
      unprojectableTeamIds: unprojectable,
      reason: unprojectable.length === teams.length
        ? 'No roster in this league resolved to projected players.'
        : `${unprojectable.length} of ${teams.length} teams have no roster the app can read.`,
      playoffPct: null, champPct: null, byePct: null,
      actionPlan: [], competitors: [],
    };
  }

  // Count wins/losses from initial record state
  const initialWins = {};
  const initialPoints = {};
  teams.forEach(t => {
    initialWins[t.teamId] = t.record?.wins || 0;
    initialPoints[t.teamId] = t.pointsScored || 0;
  });

  /* -----------------------------------------------------------------------
   * Where the season actually is.
   *
   * This was `const currentWeek = 5` under a comment reading "Determine
   * current week from schedule", which it did not do. Five is right for
   * mock-data.js -- every team there is 4 games in -- which is why nothing
   * caught it. On a real league in week 12 the simulator replayed weeks 5
   * through 11 ON TOP of the record those weeks had already produced, so a
   * team's simulated season ran to 17 games and its wins were counted twice.
   *
   * Games played is the one thing every team's record states, so the week is
   * derived from it rather than assumed. The max across teams, not the min: a
   * league mid-week has some teams a game ahead, and re-simulating a game
   * already in the record is the failure being fixed.
   * --------------------------------------------------------------------- */
  const gamesPlayed = teams.map((t) => (t.record?.wins || 0)
    + (t.record?.losses || 0) + (t.record?.ties || 0));
  const currentWeek = Math.max(1, Math.max(0, ...gamesPlayed) + 1);

  // Filter schedule for remaining weeks (>= currentWeek)
  const remainingMatchups = schedule.filter(m => m.week >= currentWeek);

  let playoffReaches = 0;
  let byeReaches = 0;
  let championshipWins = 0;

  // Initialize stats trackers
  const champWinsCount = {};
  teams.forEach(t => { champWinsCount[t.teamId] = 0; });

  // Run 1000 season simulations
  for (let r = 0; r < runs; r++) {
    const simWins = { ...initialWins };
    const simPoints = { ...initialPoints };

    // 1. Simulate remaining regular season weeks (e.g. Weeks 5-14)
    remainingMatchups.forEach(matchup => {
      // No `teams.find` here. Two of them stood at the top of this loop, and
      // their results were used for one thing: `if (!team1 || !team2) return;`.
      // That guard is entirely subsumed by the projection check below --
      // `teamProjectionsPerWeek[w].normal` is keyed by teamId and populated
      // only for teams that exist, so a matchup naming a team the league does
      // not have has no projection either and returns there.
      //
      // Round 8 mutated both lookups to `!==` and neither mutant could be
      // killed, which is what an EQUIVALENT mutant looks like: the code had no
      // observable effect to break. Two O(teams) scans per matchup per run --
      // 400 runs x 60 matchups x 2 scans x 12 teams -- for a guard that never
      // decided anything.

      /* -------------------------------------------------------------------
       * The weather coin flip, kept, and here is what it is worth.
       *
       * A 10% chance of an adverse-weather game, applying -8% to QB/WR/TE/K
       * and +5% to RB. Neither the rate nor the effects appear in BACKTEST.md.
       * Forced to never and to always over 20,000 seasons of a balanced
       * twelve-team league, the whole switch moved the first-round-bye figure
       * from 91.4% to 91.0% and the championship figure from 25.4% to 26.1% --
       * both inside run-to-run noise at that sample size.
       *
       * So it is retained rather than tuned: it is not carrying a claim, and
       * removing it would be a change to shipped output on no better evidence
       * than adding it was. What it must not do is grow a confidence it has
       * not earned. NOT MEASURED, and the sentence above says by how much.
       * ----------------------------------------------------------------- */
      const isWindyMatchup = Math.random() < WEATHER_RATE;
      const weekProjections = teamProjectionsPerWeek[matchup.week] || { normal: {}, windy: {} };
      const projections = isWindyMatchup ? weekProjections.windy : weekProjections.normal;

      // Both are present: a team that could not be projected returned early
      // above rather than being given a stand-in score here.
      let team1Proj = projections[matchup.team1Id];
      let team2Proj = projections[matchup.team2Id];
      if (typeof team1Proj !== 'number' || typeof team2Proj !== 'number') return;

      /* -------------------------------------------------------------------
       * No home-field advantage, deliberately.
       *
       * This added +2.0 points to team1 of every matchup, described as the
       * home team. Fantasy scoring has no home field -- a roster's points are
       * the same building whoever is hosting -- and `team1Id` is whichever
       * side the mapper happened to write first, so the bonus went to a team
       * chosen by payload ordering. Measured over 20,000 seasons of a balanced
       * twelve-team league it was worth 1.6 points of first-round-bye
       * probability, which is small, invented, and systematically pointed at
       * one side of every game.
       * ----------------------------------------------------------------- */

      // Simulate scores with volatility variance
      const score1 = Math.max(50, randomNormal(team1Proj, WEEKLY_SD));
      const score2 = Math.max(50, randomNormal(team2Proj, WEEKLY_SD));

      simPoints[matchup.team1Id] += score1;
      simPoints[matchup.team2Id] += score2;

      if (score1 > score2) {
        simWins[matchup.team1Id]++;
      } else {
        simWins[matchup.team2Id]++;
      }
    });

    // 2. Compute final regular season standings
    // Sort teams by Wins, then Points Scored
    const standings = [...teams].map(t => ({
      teamId: t.teamId,
      wins: simWins[t.teamId],
      points: simPoints[t.teamId]
    })).sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.points - a.points;
    });

    // Find indices
    const myRankIdx = standings.findIndex(s => s.teamId === league.myTeamId);
    const myRank = myRankIdx + 1;

    // 3. Playoff evaluations.
    //
    // This was `const playoffSize = 4` with a bye for the top 2, against
    // PLAYOFF_TEAMS = 6 in lineup-rules.js -- and BOTH engines write the same
    // three spans (#sim-playoff-pct, #sim-champ-pct, #sim-bye-pct), so the
    // same roster read 0% here and a positive number from the preseason model
    // depending only on which page drew last. lineup-rules.js's own header
    // describes this exact drift in the past tense; it was still shipping.
    const playoffSize = playoffFieldSize(teams.length);
    const madePlayoffs = myRank <= playoffSize;

    if (madePlayoffs) {
      playoffReaches++;
      // The bye tier of THIS playoff field, the same derivation the bracket
      // itself uses -- a flat two disagreed with the bracket at every field
      // size but six, while both wrote the same span on screen.
      if (myRank <= byeCount(playoffSize)) {
        byeReaches++;
      }

      const pTeams = standings.slice(0, playoffSize).map(s => s.teamId);
      const championId = playBracket(
        pTeams, (teamProjectionsPerWeek[REGULAR_WEEKS] || {}).normal);

      // null means the bracket declined. Counting it would make `null` the
      // most successful team in the league.
      if (championId !== null) {
        champWinsCount[championId]++;
        if (championId === league.myTeamId) {
          championshipWins++;
        }
      }
    } else {
      // Simulate playoffs for other teams to see who wins
      // Scored the same way, so champWinsCount is one consistent distribution
      // rather than two models disagreeing about who is likely to win.
      const pTeams = standings.slice(0, playoffSize).map(s => s.teamId);
      const winner = playBracket(
        pTeams, (teamProjectionsPerWeek[REGULAR_WEEKS] || {}).normal);
      if (winner !== null) champWinsCount[winner]++;
    }
  }

  // Find most dangerous rival (opponent team with highest championship rate)
  const competitors = teams
    .map(t => {
      const wins = champWinsCount[t.teamId] || 0;
      const pct = Math.round((wins / runs) * 1000) / 10;
      return {
        teamId: t.teamId,
        teamName: t.teamName,
        managerName: t.managerName,
        pct: pct
      };
    })
    .filter(c => c.teamId !== league.myTeamId)
    .sort((a, b) => b.pct - a.pct);

  const rivalTeam = competitors[0];

  // Compute final percentages
  const playoffPct = Math.round((playoffReaches / runs) * 1000) / 10;
  const champPct = Math.round((championshipWins / runs) * 1000) / 10;
  const byePct = Math.round((byeReaches / runs) * 1000) / 10;

  // Build Dynamic Actions List
  const actionPlan = [];
  const myTeam = teams.find(t => t.teamId === league.myTeamId);
  const myRoster = myTeam ? myTeam.roster.map(pid => db[pid]).filter(Boolean) : [];

  // Identify starters and bench dynamically. Second verbatim copy of the
  // lineup shape in this file; both read lineup-rules now, so a league that
  // starts three receivers is described the same way in both.
  const slots = slotList(league.rosterSettings);

  const allocatedIds = new Set();
  const starters = [];

  slots.forEach(slot => {
    const match = myRoster.find(p => {
      if (allocatedIds.has(p.id)) return false;
      if (slot.isFlex) {
        return slot.pos.includes(p.position);
      }
      return p.position === slot.pos;
    });

    if (match) {
      allocatedIds.add(match.id);
      starters.push(match);
    }
  });

  const outStarter = starters.find(p => p.injuryStatus === 'Out' || p.injuryStatus === 'IR');
  const questionableStarter = starters.find(p => p.injuryStatus === 'Questionable' || p.injuryStatus === 'Doubtful');

  if (outStarter) {
    actionPlan.push({
      type: 'immediate',
      title: `Swap out ${outStarter.name} (${outStarter.position})`,
      desc: `${outStarter.name} is ruled OUT/IR. Select a healthy bench replacement immediately to prevent a 0-point slot.`
    });
  } else if (questionableStarter) {
    actionPlan.push({
      type: 'immediate',
      title: `Set up backup for ${questionableStarter.name}`,
      desc: `Currently ${questionableStarter.injuryStatus}. Ensure a conditional backup starter is designated in Matchups.`
    });
  } else if (starters.length) {
    // Says how many, and only when there are any. This fired for a team with
    // ZERO starters, announcing that all of them were projected healthy and
    // optimised -- a fixed sentence that reads as a check having been run.
    actionPlan.push({
      type: 'immediate',
      title: 'Maintain current lineup configuration',
      // What was actually checked, which is the injury flags. The bye half was
      // a claim about a field this branch never reads -- printed while four
      // starters were on bye.
      desc: `All ${starters.length} starters are free of injury flags.`
    });
  } else {
    actionPlan.push({
      type: 'immediate',
      title: 'No lineup to assess',
      desc: 'No player on this roster resolved to a projection, so there is '
        + 'nothing to check.'
    });
  }

  // Waiver Claim Recommendation
  try {
    const waiverRecs = getWaiverRecommendations(league);
    if (waiverRecs && waiverRecs.length > 0) {
      const topWaiver = waiverRecs[0];
      actionPlan.push({
        type: 'immediate',
        title: `Submit ${topWaiver.addPlayer.name} (${topWaiver.addPlayer.position}) waiver claim`,
        desc: `Adds critical depth. Recommended bid of $${topWaiver.bid} FAAB, dropping ${topWaiver.dropPlayer ? topWaiver.dropPlayer.name : 'bench'}.`
      });
    }
  } catch (e) {
    console.error("Failed to generate waiver actions in simulator:", e);
  }

  // Trade Swap Recommendation
  try {
    const tradeProposals = generateTradeProposals(league);
    if (tradeProposals && tradeProposals.length > 0) {
      const topTrade = tradeProposals[0];
      actionPlan.push({
        type: 'longterm',
        title: `Target ${topTrade.getPlayer.name} via trade swap`,
        // No acceptance rate. trade-generator deleted the invented `probability`
        // it used to carry -- 75 minus twelve times the points gap, measured by
        // nothing -- and this consumer was left reading the field, so the page
        // rendered the literal string "undefined% acceptance rate".
        desc: `Utilizes excess roster depth. Offer ${topTrade.givePlayer.name} `
          + `to ${topTrade.opponentName}: ${topTrade.myImpact}.`
      });
    }
  } catch (e) {
    console.error("Failed to generate trade actions in simulator:", e);
  }

  return {
    playoffPct,
    champPct,
    byePct,
    // Null when there is no rival to name. This defaulted to 'Fumble Recovery',
    // which is a team out of mock-data.js -- a real league would have been
    // told its chief threat was a team from the sandbox. Nothing reads this
    // field, which made it dead code AND a landmine.
    rivalName: rivalTeam ? rivalTeam.teamName : null,
    competitors: competitors.slice(0, 3), // Return top 3 rivals
    actionPlan
  };
}
