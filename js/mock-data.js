/**
 * Gridiron Edge Mock Data Generator
 * Provides realistic player databases, league rosters, and standings.
 */

export const mockPlayers = {
  // Quarterbacks
  "QB_01": { id: "QB_01", name: "Patrick Mahomes", position: "QB", team: "KC", projectedPoints: 19.5, volatility: 3.2, injuryStatus: "Healthy", byeWeek: 6, adp: 35.2, matchProjs: { w1: 18.5, w2: 21.0, w3: 19.0, w4: 17.5, w5: 22.0 }, opponent: "LV", metrics: { snapShare: 1.0, targetShare: 0, redZoneTargets: 0, carries: 4, redZoneCarries: 1 } },
  "QB_02": { id: "QB_02", name: "Josh Allen", position: "QB", team: "BUF", projectedPoints: 21.2, volatility: 4.8, injuryStatus: "Healthy", byeWeek: 12, adp: 28.5, matchProjs: { w1: 23.5, w2: 19.2, w3: 22.0, w4: 20.8, w5: 18.2 }, opponent: "MIA", metrics: { snapShare: 1.0, targetShare: 0, redZoneTargets: 0, carries: 8, redZoneCarries: 3 } },
  "QB_03": { id: "QB_03", name: "Lamar Jackson", position: "QB", team: "BAL", projectedPoints: 20.5, volatility: 5.1, injuryStatus: "Healthy", byeWeek: 14, adp: 32.1, matchProjs: { w1: 17.2, w2: 24.5, w3: 21.0, w4: 18.9, w5: 23.1 }, opponent: "CLE", metrics: { snapShare: 1.0, targetShare: 0, redZoneTargets: 0, carries: 11, redZoneCarries: 2 } },
  "QB_04": { id: "QB_04", name: "C.J. Stroud", position: "QB", team: "HOU", projectedPoints: 18.2, volatility: 3.8, injuryStatus: "Healthy", byeWeek: 7, adp: 48.0, matchProjs: { w1: 16.5, w2: 17.8, w3: 20.2, w4: 18.5, w5: 21.0 }, opponent: "IND", metrics: { snapShare: 1.0, targetShare: 0, redZoneTargets: 0, carries: 2, redZoneCarries: 0 } },
  "QB_05": { id: "QB_05", name: "Anthony Richardson", position: "QB", team: "IND", projectedPoints: 17.8, volatility: 6.5, injuryStatus: "Questionable", byeWeek: 11, adp: 62.4, matchProjs: { w1: 14.2, w2: 22.0, w3: 13.5, w4: 24.0, w5: 15.0 }, opponent: "HOU", metrics: { snapShare: 0.88, targetShare: 0, redZoneTargets: 0, carries: 9, redZoneCarries: 4 } },
  
  // Running Backs
  "RB_01": { id: "RB_01", name: "Christian McCaffrey", position: "RB", team: "SF", projectedPoints: 21.8, volatility: 3.5, injuryStatus: "Questionable", byeWeek: 9, adp: 1.2, matchProjs: { w1: 22.5, w2: 20.0, w3: 23.0, w4: 18.5, w5: 21.5 }, opponent: "LAR", metrics: { snapShare: 0.82, targetShare: 0.18, redZoneTargets: 2, carries: 16, redZoneCarries: 4 } },
  "RB_02": { id: "RB_02", name: "Breece Hall", position: "RB", team: "NYJ", projectedPoints: 19.5, volatility: 4.1, injuryStatus: "Healthy", byeWeek: 12, adp: 4.5, matchProjs: { w1: 18.0, w2: 19.5, w3: 21.2, w4: 17.4, w5: 20.5 }, opponent: "NE", metrics: { snapShare: 0.74, targetShare: 0.15, redZoneTargets: 1, carries: 15, redZoneCarries: 3 } },
  "RB_03": { id: "RB_03", name: "Bijan Robinson", position: "RB", team: "ATL", projectedPoints: 18.9, volatility: 3.9, injuryStatus: "Healthy", byeWeek: 12, adp: 5.8, matchProjs: { w1: 17.5, w2: 19.0, w3: 18.5, w4: 21.0, w5: 16.8 }, opponent: "CAR", metrics: { snapShare: 0.71, targetShare: 0.14, redZoneTargets: 1, carries: 14, redZoneCarries: 2 } },
  "RB_04": { id: "RB_04", name: "Saquon Barkley", position: "RB", team: "PHI", projectedPoints: 17.4, volatility: 4.3, injuryStatus: "Healthy", byeWeek: 5, adp: 11.2, matchProjs: { w1: 19.2, w2: 16.5, w3: 18.0, w4: 22.0, w5: 15.0 }, opponent: "NYG", metrics: { snapShare: 0.78, targetShare: 0.08, redZoneTargets: 0, carries: 18, redZoneCarries: 5 } },
  "RB_05": { id: "RB_05", name: "Kyren Williams", position: "RB", team: "LAR", projectedPoints: 16.8, volatility: 4.0, injuryStatus: "Healthy", byeWeek: 6, adp: 15.4, matchProjs: { w1: 15.0, w2: 18.2, w3: 17.5, w4: 14.8, w5: 18.0 }, opponent: "SF", metrics: { snapShare: 0.81, targetShare: 0.09, redZoneTargets: 1, carries: 17, redZoneCarries: 4 } },
  "RB_06": { id: "RB_06", name: "Jahmyr Gibbs", position: "RB", team: "DET", projectedPoints: 16.2, volatility: 4.6, injuryStatus: "Healthy", byeWeek: 5, adp: 13.9, matchProjs: { w1: 14.5, w2: 17.0, w3: 15.8, w4: 18.5, w5: 16.0 }, opponent: "CHI", metrics: { snapShare: 0.54, targetShare: 0.13, redZoneTargets: 2, carries: 11, redZoneCarries: 2 } },
  "RB_07": { id: "RB_07", name: "Travis Etienne Jr.", position: "RB", team: "JAX", projectedPoints: 15.4, volatility: 4.2, injuryStatus: "Healthy", byeWeek: 12, adp: 22.0, matchProjs: { w1: 14.0, w2: 16.8, w3: 14.5, w4: 17.0, w5: 13.5 }, opponent: "TEN", metrics: { snapShare: 0.68, targetShare: 0.11, redZoneTargets: 1, carries: 13, redZoneCarries: 3 } },
  "RB_08": { id: "RB_08", name: "Zamir White", position: "RB", team: "LV", projectedPoints: 11.2, volatility: 3.1, injuryStatus: "Healthy", byeWeek: 10, adp: 78.5, matchProjs: { w1: 9.8, w2: 12.0, w3: 10.5, w4: 13.5, w5: 8.5 }, opponent: "KC", metrics: { snapShare: 0.62, targetShare: 0.04, redZoneTargets: 0, carries: 16, redZoneCarries: 2 } },
  "RB_09": { id: "RB_09", name: "Joshua Kelley", position: "RB", team: "LAC", projectedPoints: 6.5, volatility: 2.8, injuryStatus: "Healthy", byeWeek: 5, adp: 165.0, matchProjs: { w1: 5.5, w2: 7.2, w3: 6.0, w4: 9.0, w5: 4.8 }, opponent: "DEN", metrics: { snapShare: 0.35, targetShare: 0.03, redZoneTargets: 0, carries: 7, redZoneCarries: 1 } },
  
  // Wide Receivers
  "WR_01": { id: "WR_01", name: "CeeDee Lamb", position: "WR", team: "DAL", projectedPoints: 20.8, volatility: 3.8, injuryStatus: "Healthy", byeWeek: 7, adp: 2.1, matchProjs: { w1: 19.5, w2: 22.0, w3: 20.8, w4: 18.2, w5: 23.5 }, opponent: "NYG", metrics: { snapShare: 0.92, targetShare: 0.30, redZoneTargets: 3, carries: 1, redZoneCarries: 0 } },
  "WR_02": { id: "WR_02", name: "Tyreek Hill", position: "WR", team: "MIA", projectedPoints: 20.5, volatility: 4.6, injuryStatus: "Healthy", byeWeek: 6, adp: 3.0, matchProjs: { w1: 22.0, w2: 18.5, w3: 24.0, w4: 17.5, w5: 21.0 }, opponent: "BUF", metrics: { snapShare: 0.86, targetShare: 0.32, redZoneTargets: 2, carries: 1, redZoneCarries: 0 } },
  "WR_03": { id: "WR_03", name: "Justin Jefferson", position: "WR", team: "MIN", projectedPoints: 19.8, volatility: 4.2, injuryStatus: "Healthy", byeWeek: 6, adp: 3.8, matchProjs: { w1: 18.2, w2: 21.5, w3: 19.0, w4: 17.8, w5: 22.5 }, opponent: "GB", metrics: { snapShare: 0.95, targetShare: 0.28, redZoneTargets: 2, carries: 0, redZoneCarries: 0 } },
  "WR_04": { id: "WR_04", name: "Amon-Ra St. Brown", position: "WR", team: "DET", projectedPoints: 18.5, volatility: 3.0, injuryStatus: "Healthy", byeWeek: 5, adp: 7.2, matchProjs: { w1: 17.0, w2: 19.2, w3: 18.0, w4: 20.5, w5: 18.0 }, opponent: "CHI", metrics: { snapShare: 0.90, targetShare: 0.29, redZoneTargets: 3, carries: 0, redZoneCarries: 0 } },
  "WR_05": { id: "WR_05", name: "A.J. Brown", position: "WR", team: "PHI", projectedPoints: 17.2, volatility: 4.5, injuryStatus: "Healthy", byeWeek: 5, adp: 12.5, matchProjs: { w1: 16.0, w2: 18.5, w3: 15.0, w4: 21.0, w5: 15.8 }, opponent: "NYG", metrics: { snapShare: 0.88, targetShare: 0.26, redZoneTargets: 1, carries: 0, redZoneCarries: 0 } },
  "WR_06": { id: "WR_06", name: "Puka Nacua", position: "WR", team: "LAR", projectedPoints: 16.5, volatility: 4.4, injuryStatus: "Healthy", byeWeek: 6, adp: 14.8, matchProjs: { w1: 15.2, w2: 17.5, w3: 16.0, w4: 14.5, w5: 19.0 }, opponent: "SF", metrics: { snapShare: 0.87, targetShare: 0.27, redZoneTargets: 2, carries: 1, redZoneCarries: 0 } },
  "WR_07": { id: "WR_07", name: "Garrett Wilson", position: "WR", team: "NYJ", projectedPoints: 15.9, volatility: 3.6, injuryStatus: "Healthy", byeWeek: 12, adp: 16.1, matchProjs: { w1: 14.8, w2: 16.2, w3: 17.0, w4: 14.0, w5: 17.5 }, opponent: "NE", metrics: { snapShare: 0.91, targetShare: 0.27, redZoneTargets: 1, carries: 0, redZoneCarries: 0 } },
  "WR_08": { id: "WR_08", name: "Drake London", position: "WR", team: "ATL", projectedPoints: 13.8, volatility: 3.5, injuryStatus: "Healthy", byeWeek: 12, adp: 26.3, matchProjs: { w1: 12.0, w2: 14.5, w3: 13.0, w4: 15.2, w5: 14.0 }, opponent: "CAR", metrics: { snapShare: 0.89, targetShare: 0.24, redZoneTargets: 1, carries: 0, redZoneCarries: 0 } },
  "WR_09": { id: "WR_09", name: "Tyler Boyd", position: "WR", team: "TEN", projectedPoints: 8.5, volatility: 2.1, injuryStatus: "Healthy", byeWeek: 5, adp: 138.0, matchProjs: { w1: 8.0, w2: 9.2, w3: 8.0, w4: 7.5, w5: 9.8 }, opponent: "JAX", metrics: { snapShare: 0.65, targetShare: 0.14, redZoneTargets: 1, carries: 0, redZoneCarries: 0 } },
  "WR_10": { id: "WR_10", name: "Joshua Palmer", position: "WR", team: "LAC", projectedPoints: 10.4, volatility: 3.4, injuryStatus: "Healthy", byeWeek: 5, adp: 122.0, matchProjs: { w1: 9.2, w2: 11.5, w3: 10.0, w4: 12.8, w5: 8.5 }, opponent: "DEN", metrics: { snapShare: 0.78, targetShare: 0.18, redZoneTargets: 1, carries: 0, redZoneCarries: 0 } },
  
  // Tight Ends
  "TE_01": { id: "TE_01", name: "Travis Kelce", position: "TE", team: "KC", projectedPoints: 14.8, volatility: 2.9, injuryStatus: "Healthy", byeWeek: 6, adp: 22.4, matchProjs: { w1: 13.5, w2: 16.0, w3: 14.2, w4: 13.0, w5: 17.5 }, opponent: "LV", metrics: { snapShare: 0.79, targetShare: 0.22, redZoneTargets: 3, carries: 0, redZoneCarries: 0 } },
  "TE_02": { id: "TE_02", name: "Sam LaPorta", position: "TE", team: "DET", projectedPoints: 14.2, volatility: 3.3, injuryStatus: "Healthy", byeWeek: 5, adp: 26.8, matchProjs: { w1: 13.0, w2: 15.2, w3: 13.8, w4: 16.0, w5: 13.0 }, opponent: "CHI", metrics: { snapShare: 0.83, targetShare: 0.19, redZoneTargets: 2, carries: 0, redZoneCarries: 0 } },
  "TE_03": { id: "TE_03", name: "Trey McBride", position: "TE", team: "ARI", projectedPoints: 13.5, volatility: 3.5, injuryStatus: "Healthy", byeWeek: 11, adp: 38.9, matchProjs: { w1: 11.8, w2: 14.2, w3: 13.0, w4: 15.5, w5: 12.8 }, opponent: "SF", metrics: { snapShare: 0.85, targetShare: 0.23, redZoneTargets: 2, carries: 0, redZoneCarries: 0 } },
  
  // Defense / Special Teams
  "DF_01": { id: "DF_01", name: "Ravens D/ST", position: "D/ST", team: "BAL", projectedPoints: 8.5, volatility: 3.0, injuryStatus: "Healthy", byeWeek: 14, adp: 110.0, matchProjs: { w1: 8.0, w2: 9.5, w3: 8.2, w4: 7.5, w5: 9.0 }, opponent: "CLE", metrics: { snapShare: 1.0 } },
  "DF_02": { id: "DF_02", name: "49ers D/ST", position: "D/ST", team: "SF", projectedPoints: 8.2, volatility: 2.8, injuryStatus: "Healthy", byeWeek: 9, adp: 115.0, matchProjs: { w1: 9.0, w2: 7.5, w3: 8.5, w4: 7.2, w5: 8.8 }, opponent: "LAR", metrics: { snapShare: 1.0 } },
  
  // Kickers
  "K_01": { id: "K_01", name: "Justin Tucker", position: "K", team: "BAL", projectedPoints: 8.8, volatility: 2.1, injuryStatus: "Healthy", byeWeek: 14, adp: 125.0, matchProjs: { w1: 8.0, w2: 9.5, w3: 8.5, w4: 8.2, w5: 9.8 }, opponent: "CLE", metrics: { snapShare: 1.0 } },
  "K_02": { id: "K_02", name: "Harrison Butker", position: "K", team: "KC", projectedPoints: 8.4, volatility: 1.9, injuryStatus: "Healthy", byeWeek: 6, adp: 130.0, matchProjs: { w1: 7.8, w2: 9.0, w3: 8.2, w4: 7.5, w5: 9.5 }, opponent: "LV", metrics: { snapShare: 1.0 } }
};

export const mockLeague = {
  leagueId: "48317-espn-mock",
  leagueName: "Antigravity Championship League",
  leagueSize: 12,
  myTeamId: 1,
  scoringFormat: "PPR", // Standard, Half-PPR, PPR
  rosterSettings: {
    QB: 1,
    RB: 2,
    WR: 2,
    TE: 1,
    FLEX: 1,
    "D/ST": 1,
    K: 1,
    BE: 7,
    IR: 1,
    startersCount: 9,
    benchCount: 7
  },
  waiverSettings: {
    faabBudget: 100,
    processingDays: ["Wednesday", "Thursday"],
    waiverType: "FAAB"
  },
  teams: [
    { teamId: 1, teamName: "Championship Bound", managerName: "Dave", faabRemaining: 100, roster: ["QB_01", "RB_01", "RB_08", "WR_03", "WR_10", "TE_02", "DF_01", "K_01", "RB_09", "WR_09"], record: { wins: 3, losses: 1, ties: 0 }, pointsScored: 452.8, pointsAllowed: 412.3 },
    { teamId: 2, teamName: "Fumble Recovery", managerName: "Sarah", faabRemaining: 92, roster: ["QB_02", "RB_02", "RB_05", "WR_02", "WR_07", "TE_03", "DF_02", "K_02"], record: { wins: 2, losses: 2, ties: 0 }, pointsScored: 432.1, pointsAllowed: 440.5 },
    { teamId: 3, teamName: "Red Zone Threat", managerName: "Michael", faabRemaining: 100, roster: ["QB_03", "RB_03", "RB_04", "WR_01", "WR_04", "TE_01"], record: { wins: 4, losses: 0, ties: 0 }, pointsScored: 489.2, pointsAllowed: 395.1 },
    { teamId: 4, teamName: "Hail Marys", managerName: "Emily", faabRemaining: 85, roster: ["QB_04", "RB_06", "RB_07", "WR_05", "WR_06", "WR_08"], record: { wins: 1, losses: 3, ties: 0 }, pointsScored: 390.4, pointsAllowed: 420.2 },
    { teamId: 5, teamName: "Blitz Patrol", managerName: "John", faabRemaining: 100, roster: [], record: { wins: 2, losses: 2, ties: 0 }, pointsScored: 410.5, pointsAllowed: 415.8 },
    { teamId: 6, teamName: "Gridiron Giants", managerName: "Jessica", faabRemaining: 95, roster: [], record: { wins: 2, losses: 2, ties: 0 }, pointsScored: 422.3, pointsAllowed: 418.9 },
    { teamId: 7, teamName: "Pass Rushers", managerName: "David", faabRemaining: 100, roster: [], record: { wins: 1, losses: 3, ties: 0 }, pointsScored: 388.2, pointsAllowed: 412.0 },
    { teamId: 8, teamName: "Goal Line Stand", managerName: "Ashley", faabRemaining: 100, roster: [], record: { wins: 3, losses: 1, ties: 0 }, pointsScored: 441.9, pointsAllowed: 420.5 },
    { teamId: 9, teamName: "Safety Valve", managerName: "Chris", faabRemaining: 100, roster: [], record: { wins: 0, losses: 4, ties: 0 }, pointsScored: 360.5, pointsAllowed: 450.2 },
    { teamId: 10, teamName: "Pocket Passers", managerName: "Amanda", faabRemaining: 88, roster: [], record: { wins: 2, losses: 2, ties: 0 }, pointsScored: 415.0, pointsAllowed: 411.2 },
    { teamId: 11, teamName: "Audible Callers", managerName: "James", faabRemaining: 100, roster: [], record: { wins: 2, losses: 2, ties: 0 }, pointsScored: 409.8, pointsAllowed: 414.0 },
    { teamId: 12, teamName: "Scramble Drill", managerName: "Megan", faabRemaining: 100, roster: [], record: { wins: 2, losses: 2, ties: 0 }, pointsScored: 420.1, pointsAllowed: 425.3 }
  ],
  schedule: [
    { week: 5, matchupId: 1, team1Id: 1, team1Proj: 114.2, team2Id: 2, team2Proj: 121.5 },
    { week: 5, matchupId: 2, team1Id: 3, team1Proj: 125.8, team2Id: 4, team2Proj: 109.1 },
    { week: 5, matchupId: 3, team1Id: 5, team1Proj: 102.5, team2Id: 6, team2Proj: 105.2 },
    { week: 5, matchupId: 4, team1Id: 7, team1Proj: 98.4,  team2Id: 8, team2Proj: 111.0 },
    { week: 5, matchupId: 5, team1Id: 9, team1Proj: 92.5,  team2Id: 10, team2Proj: 104.8 },
    { week: 5, matchupId: 6, team1Id: 11, team1Proj: 108.0, team2Id: 12, team2Proj: 106.5 }
  ],
  draftState: {
    draftType: "snake",
    draftOrder: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    currentPick: 1,
    selections: []
  },
  transactionHistory: []
};
