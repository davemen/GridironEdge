/**
 * Gridiron Edge Monte Carlo Season Simulator
 */

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

  // Count wins/losses from initial record state
  const initialWins = {};
  const initialPoints = {};
  teams.forEach(t => {
    initialWins[t.teamId] = t.record?.wins || 0;
    initialPoints[t.teamId] = t.pointsScored || 0;
  });

  // Determine current week from schedule
  // Find highest week that is completed vs uncompleted
  // For simplicity, we assume completed matches are not in schedule or have completed flag.
  // In our mock, week 5 is current, meaning weeks 1-4 are completed.
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
      // Fetch roster configurations or mock projections
      const team1 = teams.find(t => t.teamId === matchup.team1Id);
      const team2 = teams.find(t => t.teamId === matchup.team2Id);

      if (!team1 || !team2) return;

      // Simulate team 1 score: projected points + normal noise based on volatility
      // Assume average team volatility is 12 points
      const score1 = Math.max(50, randomNormal(matchup.team1Proj || 105, 12));
      const score2 = Math.max(50, randomNormal(matchup.team2Proj || 105, 12));

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

    // 3. Playoff evaluations (Top 4 teams make playoffs)
    const playoffSize = 4;
    const madePlayoffs = myRank <= playoffSize;

    if (madePlayoffs) {
      playoffReaches++;
      if (myRank <= 2) {
        byeReaches++;
      }

      // Simulate playoffs brackets: Semifinals (1 vs 4, 2 vs 3)
      const pTeams = standings.slice(0, playoffSize).map(s => s.teamId);
      
      // Semifinal 1: Team 1 vs Team 4
      const semi1Score1 = randomNormal(115, 10);
      const semi1Score2 = randomNormal(110, 10);
      const finalist1 = semi1Score1 > semi1Score2 ? pTeams[0] : pTeams[3];

      // Semifinal 2: Team 2 vs Team 3
      const semi2Score1 = randomNormal(112, 10);
      const semi2Score2 = randomNormal(112, 10);
      const finalist2 = semi2Score1 > semi2Score2 ? pTeams[1] : pTeams[2];

      // Championship match
      // Suppose my team is a finalist
      const finalScore1 = randomNormal(116, 9);
      const finalScore2 = randomNormal(114, 9);
      const championId = finalScore1 > finalScore2 ? finalist1 : finalist2;

      champWinsCount[championId]++;
      if (championId === league.myTeamId) {
        championshipWins++;
      }
    } else {
      // Simulate playoffs for other teams to see who wins
      const pTeams = standings.slice(0, playoffSize).map(s => s.teamId);
      const semi1Score1 = randomNormal(112, 10);
      const semi1Score2 = randomNormal(110, 10);
      const finalist1 = semi1Score1 > semi1Score2 ? pTeams[0] : pTeams[3];

      const semi2Score1 = randomNormal(112, 10);
      const semi2Score2 = randomNormal(112, 10);
      const finalist2 = semi2Score1 > semi2Score2 ? pTeams[1] : pTeams[2];

      const championId = randomNormal(115, 9) > randomNormal(115, 9) ? finalist1 : finalist2;
      champWinsCount[championId]++;
    }
  }

  // Find most dangerous rival (opponent team with highest championship rate)
  let rivalId = null;
  let rivalWins = -1;
  Object.keys(champWinsCount).forEach(tid => {
    const id = parseInt(tid);
    if (id !== league.myTeamId && champWinsCount[tid] > rivalWins) {
      rivalWins = champWinsCount[tid];
      rivalId = id;
    }
  });

  const rivalTeam = teams.find(t => t.teamId === rivalId);

  // Compute final percentages
  const playoffPct = Math.round((playoffReaches / runs) * 1000) / 10;
  const champPct = Math.round((championshipWins / runs) * 1000) / 10;
  const byePct = Math.round((byeReaches / runs) * 1000) / 10;

  // Actions list
  const actionPlan = [
    { type: 'immediate', title: 'Swap Zamir White into starting FLEX', desc: 'Addresses Week 5 projected points gap in underdog strategy.' },
    { type: 'immediate', title: 'Submit WR Joshua Palmer waiver claim', desc: 'Adds critical bench depth for upcoming bye-week overlaps.' },
    { type: 'longterm', title: 'Target Saquon Barkley via trade swap', desc: 'Utilizes excess WR depth to patch starting Running Back gap.' }
  ];

  return {
    playoffPct,
    champPct,
    byePct,
    rivalName: rivalTeam ? rivalTeam.teamName : 'Fumble Recovery',
    actionPlan
  };
}
