import { optimizeLineup } from './lineup-optimizer.js';
import { PLAYOFF_TEAMS, BYE_TEAMS, REGULAR_WEEKS, slotList } from './lineup-rules.js';
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

export function runSeasonSimulation(league, runs = 1000) {
  const db = league.playerDatabase;
  const teams = league.teams;
  const schedule = league.schedule || [];

  if (!teams || teams.length === 0) {
    return { playoffPct: 0, champPct: 0, byePct: 0, actionPlan: [] };
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
   * The per-week projections are already computed above, so each game uses the
   * two teams' own scoring with the same 12-point weekly spread as the regular
   * season. Top seeds get byes; the rest pair highest against lowest.
   */
  function playBracket(seeds, weekProj) {
    const scoreOf = (id) => Math.max(50, randomNormal((weekProj || {})[id], 12));
    const beats = (a, b) => (scoreOf(a) >= scoreOf(b) ? a : b);
    const byes = seeds.slice(0, BYE_TEAMS);
    let rest = seeds.slice(BYE_TEAMS);
    while (rest.length > 1) {
      const next = [];
      while (rest.length > 1) next.push(beats(rest.shift(), rest.pop()));
      if (rest.length) next.push(rest.shift());
      rest = next;
    }
    let alive = byes.concat(rest);
    while (alive.length > 1) {
      const next = [];
      while (alive.length > 1) next.push(beats(alive.shift(), alive.pop()));
      if (alive.length) next.push(alive.shift());
      alive = next;
    }
    return alive[0];
  }

  // Pre-calculate normal and windy projections per week for all teams (Weeks 5-14)
  const teamProjectionsPerWeek = {};
  const unprojectable = [];
  for (let w = 5; w <= 14; w++) {
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

  // Determine current week from schedule
  const currentWeek = 5;

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
      const team1 = teams.find(t => t.teamId === matchup.team1Id);
      const team2 = teams.find(t => t.teamId === matchup.team2Id);

      if (!team1 || !team2) return;

      // Simulate a 10% chance of adverse weather (high wind/rain) for each matchup
      const isWindyMatchup = Math.random() < 0.10;
      const weekProjections = teamProjectionsPerWeek[matchup.week] || { normal: {}, windy: {} };
      const projections = isWindyMatchup ? weekProjections.windy : weekProjections.normal;

      // Both are present: a team that could not be projected returned early
      // above rather than being given a stand-in score here.
      let team1Proj = projections[matchup.team1Id];
      let team2Proj = projections[matchup.team2Id];
      if (typeof team1Proj !== 'number' || typeof team2Proj !== 'number') return;

      // Apply Home-Field Advantage (+2.0 points to home team, which is team1)
      team1Proj += 2.0;

      // Simulate scores with volatility variance
      const score1 = Math.max(50, randomNormal(team1Proj, 12));
      const score2 = Math.max(50, randomNormal(team2Proj, 12));

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
    const playoffSize = PLAYOFF_TEAMS;
    const madePlayoffs = myRank <= playoffSize;

    if (madePlayoffs) {
      playoffReaches++;
      if (myRank <= BYE_TEAMS) {
        byeReaches++;
      }

      const pTeams = standings.slice(0, playoffSize).map(s => s.teamId);
      const championId = playBracket(
        pTeams, (teamProjectionsPerWeek[REGULAR_WEEKS] || {}).normal);

      champWinsCount[championId]++;
      if (championId === league.myTeamId) {
        championshipWins++;
      }
    } else {
      // Simulate playoffs for other teams to see who wins
      // Scored the same way, so champWinsCount is one consistent distribution
      // rather than two models disagreeing about who is likely to win.
      const pTeams = standings.slice(0, playoffSize).map(s => s.teamId);
      champWinsCount[playBracket(
        pTeams, (teamProjectionsPerWeek[REGULAR_WEEKS] || {}).normal)]++;
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
  } else {
    actionPlan.push({
      type: 'immediate',
      title: 'Maintain current lineup configuration',
      desc: 'All starters are projected healthy and optimized for the next matchup.'
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
        desc: `Utilizes excess roster depth. Offer ${topTrade.givePlayer.name} to ${topTrade.opponentName} (${topTrade.probability}% acceptance rate).`
      });
    }
  } catch (e) {
    console.error("Failed to generate trade actions in simulator:", e);
  }

  return {
    playoffPct,
    champPct,
    byePct,
    rivalName: rivalTeam ? rivalTeam.teamName : 'Fumble Recovery',
    competitors: competitors.slice(0, 3), // Return top 3 rivals
    actionPlan
  };
}
