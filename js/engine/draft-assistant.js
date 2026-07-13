/**
 * Gridiron Edge Live Draft Recommendation Engine
 */

export function getDraftRecommendations(league) {
  const db = league.playerDatabase;
  const draftState = league.draftState;
  const selections = draftState.selections || [];
  
  // 1. Filter out already drafted players
  const draftedIds = new Set(selections.map(s => s.playerId));
  const availablePlayers = Object.values(db).filter(p => !draftedIds.has(p.id));
  
  if (availablePlayers.length === 0) {
    return null;
  }

  // Sort available players by ADP and projected points
  availablePlayers.sort((a, b) => {
    // Sort primarily by value index (weighted projections + ADP)
    const valA = (a.projectedPoints * 5) + (300 - a.adp);
    const valB = (b.projectedPoints * 5) + (300 - b.adp);
    return valB - valA;
  });

  // Calculate user's current draft roster layout
  const rounds = league.rosterSettings.startersCount + league.rosterSettings.benchCount;
  const currentPick = draftState.currentPick;
  
  // Find which slots have been filled by user (teamId: myTeamId)
  const myPicks = selections.filter(s => s.teamId === league.myTeamId);
  const myRosterPositions = myPicks.map(p => db[p.playerId]?.position).filter(Boolean);
  
  // Count counts of positions
  const posCounts = { QB: 0, RB: 0, WR: 0, TE: 0, 'D/ST': 0, K: 0 };
  myRosterPositions.forEach(pos => {
    if (posCounts[pos] !== undefined) posCounts[pos]++;
  });

  // Analyze roster needs compared to limits
  const limits = league.rosterSettings;
  const needs = {
    QB: posCounts.QB < limits.QB,
    RB: posCounts.RB < (limits.RB + 1), // assume flex
    WR: posCounts.WR < (limits.WR + 1), // assume flex
    TE: posCounts.TE < limits.TE,
    "D/ST": posCounts["D/ST"] < limits["D/ST"],
    K: posCounts.K < limits.K
  };

  // Identify next user pick overall index
  const draftOrder = draftState.draftOrder;
  const userOrderIdx = draftOrder.indexOf(league.myTeamId);
  const roundIdx = Math.floor((currentPick - 1) / league.leagueSize);
  const isEvenRound = (roundIdx + 1) % 2 === 0;
  
  // Snake calculation
  let nextUserPick = currentPick;
  if (draftState.draftType === 'snake') {
    // Find next picks for user
    const picks = [];
    for (let r = roundIdx; r < rounds; r++) {
      const isRRoundEven = (r + 1) % 2 === 0;
      let pickInRound = userOrderIdx;
      if (isRRoundEven) {
        pickInRound = league.leagueSize - 1 - userOrderIdx;
      }
      const absolutePick = (r * league.leagueSize) + pickInRound + 1;
      if (absolutePick >= currentPick) {
        picks.push(absolutePick);
      }
    }
    nextUserPick = picks[1] || (currentPick + league.leagueSize); // user's next pick
  } else {
    // Linear draft
    nextUserPick = currentPick + league.leagueSize;
  }

  const picksToNext = nextUserPick - currentPick;

  // Calculate estimated availability at user's next pick
  // Using ADP and a cumulative availability model
  const withAvailability = availablePlayers.map(p => {
    // standard deviation of ADP based on round rank
    const sd = Math.max(3, p.adp * 0.1); 
    const z = (nextUserPick - p.adp) / sd;
    
    // Simple CDF approximation
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    let prob = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    if (z < 0) prob = 1 - prob;
    
    // Invert probability: chance player IS available (not drafted)
    const availabilityProb = Math.min(100, Math.max(0, Math.round((1 - prob) * 100)));

    return {
      ...p,
      availabilityAtNext: availabilityProb
    };
  });

  // Sort shortlist candidate lists
  const wrCandidates = withAvailability.filter(p => p.position === 'WR');
  const rbCandidates = withAvailability.filter(p => p.position === 'RB');
  const qbCandidates = withAvailability.filter(p => p.position === 'QB');
  const teCandidates = withAvailability.filter(p => p.position === 'TE');

  // Compute replacements levels
  const getReplacementDiff = (player, list) => {
    // Difference between this player's projection and the baseline available player of the same position in 2 rounds
    const posList = list.filter(p => p.position === player.position);
    const baselineIdx = Math.min(posList.length - 1, Math.max(2, Math.floor(picksToNext / 3)));
    const baseline = posList[baselineIdx] || player;
    return player.projectedPoints - baseline.projectedPoints;
  };

  // Rank recommended list
  const ranked = [...withAvailability].map(p => {
    const needMultiplier = needs[p.position] ? 1.2 : 0.8;
    const replacementVal = getReplacementDiff(p, withAvailability);
    const score = (replacementVal * 1.5 + p.projectedPoints) * needMultiplier;
    return { player: p, score, replacementVal };
  }).sort((a, b) => b.score - a.score);

  const topPick = ranked[0].player;
  const bestAlternatives = ranked.slice(1, 6).map(r => r.player);

  // Position Scarcity Check
  let tierWarning = null;
  const topTEs = availablePlayers.filter(p => p.position === 'TE' && p.projectedPoints > 13);
  if (topTEs.length === 1 && topTEs[0].id === topPick.id) {
    tierWarning = "The highest-value tier of Tight Ends is about to disappear. Kelce and LaPorta represent significant positional advantage.";
  }
  const topRBs = availablePlayers.filter(p => p.position === 'RB' && p.projectedPoints > 16);
  if (topRBs.length <= 2 && topPick.position !== 'RB' && needs.RB) {
    tierWarning = "Running Back scarcity alert! Only a few high-volume backs remain. Reaching for other positions reduces long-term roster value.";
  }

  // Next available suggestions
  const nextPickAvailable = withAvailability.filter(p => p.availabilityAtNext > 50).slice(0, 3);

  // Create primary selection reasonings
  const whyBest = `Highest value over replacement remaining at ${topPick.position}. Projects for ${topPick.projectedPoints} points per game with stable snap shares (${Math.round((topPick.metrics?.snapShare || 0.8)*100)}%).`;
  const adv = `Provides +${Math.round(ranked[0].replacementVal * 10) / 10} points of advantage relative to next available baseline.`;
  const risk = topPick.injuryStatus !== 'Healthy' ? 'High due to injury concern' : (topPick.volatility > 4.5 ? 'Medium (high volatility player)' : 'Low');

  return {
    primaryPick: topPick,
    whyBest,
    advantage: adv,
    riskLevel: risk,
    alternatives: bestAlternatives,
    willBeAvailable: nextPickAvailable,
    planChange: `Secures anchoring ${topPick.position} slot. Plan to target ${topPick.position === 'WR' ? 'Running Backs' : 'Wide Receivers'} in rounds ${roundIdx + 2} and ${roundIdx + 3}.`,
    tierWarning
  };
}

/**
 * Recommends bids for auction drafts based on budgets.
 */
export function calculateAuctionBid(player, budget, remainingRosterSpots, maxOpponentBid) {
  // Base bid calculation: replacement points vs standard budget allocation
  const baseValue = (player.projectedPoints / 20) * (budget * 0.25);
  const recommendedBid = Math.min(budget - remainingRosterSpots + 1, Math.round(baseValue));
  const maxBid = Math.min(maxOpponentBid + 1, Math.round(baseValue * 1.2));
  
  return {
    recommendedBid,
    maxBid,
    reason: `Fair value is $${recommendedBid} based on a $${budget} remaining budget. Do not exceed $${maxBid} unless it secures your key championship anchor.`
  };
}
