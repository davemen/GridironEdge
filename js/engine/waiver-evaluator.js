/**
 * Gridiron Edge Waiver Wire Advisor Engine
 */

export function getWaiverRecommendations(league) {
  const db = league.playerDatabase;
  const myTeam = league.teams.find(t => t.teamId === league.myTeamId);
  if (!myTeam) return [];

  // Group current roster and count slots
  const myRoster = myTeam.roster.map(pid => db[pid]).filter(Boolean);
  
  // Find all players owned by other teams
  const ownedPlayerIds = new Set();
  league.teams.forEach(t => {
    t.roster.forEach(pid => ownedPlayerIds.add(pid));
  });

  // Available free agents
  const freeAgents = Object.values(db).filter(p => !ownedPlayerIds.has(p.id) && !p.drafted);
  if (freeAgents.length === 0) return [];

  // Sort available free agents by projected points
  freeAgents.sort((a, b) => b.projectedPoints - a.projectedPoints);

  // Identify lowest value player on my bench to drop
  const benchPlayers = myRoster.filter(p => {
    // Basic heuristics: don't recommend dropping top starters
    return p.projectedPoints < 12 || p.position === 'K' || p.position === 'D/ST';
  });
  benchPlayers.sort((a, b) => a.projectedPoints - b.projectedPoints);
  const primaryDrop = benchPlayers[0] || myRoster.sort((a,b)=>a.projectedPoints - b.projectedPoints)[0];

  // Analyze position strengths to find gaps
  const posAverages = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const posCounts = { QB: 0, RB: 0, WR: 0, TE: 0 };

  myRoster.forEach(p => {
    if (posAverages[p.position] !== undefined) {
      posAverages[p.position] += p.projectedPoints;
      posCounts[p.position]++;
    }
  });

  const rosterWeaknesses = [];
  Object.keys(posAverages).forEach(pos => {
    const avg = posCounts[pos] > 0 ? posAverages[pos] / posCounts[pos] : 0;
    if (avg < 11.5 || posCounts[pos] === 0) {
      rosterWeaknesses.push(pos);
    }
  });

  // Opponents FAAB profiles
  const opponentsFaab = league.teams.filter(t => t.teamId !== league.myTeamId).map(t => t.faabRemaining);
  const maxOpponentBudget = Math.max(...opponentsFaab, 0);

  // Generate waiver items
  const recommendations = [];

  // Take top available free agents
  const topTargets = freeAgents.slice(0, 4);

  topTargets.forEach((target, index) => {
    // Bid multiplier based on roster weakness
    const isWeakness = rosterWeaknesses.includes(target.position);
    const multiplier = isWeakness ? 1.5 : 1.0;
    
    // Bid percentage calculations
    let pctOfBudget = 0.05; // default 5%
    if (target.projectedPoints > 15) pctOfBudget = 0.25; // high breakout
    else if (target.projectedPoints > 12) pctOfBudget = 0.12; // solid replacement
    else if (target.position === 'D/ST' || target.position === 'K') pctOfBudget = 0.02; // streamers

    pctOfBudget = pctOfBudget * multiplier;
    
    // Suggest FAAB bid value
    let faabBid = Math.max(1, Math.round(myTeam.faabRemaining * pctOfBudget));
    
    // Competitor check blocking: if bid is close to max competitor, recommend bidding +1 over their max
    if (faabBid > maxOpponentBudget && maxOpponentBudget > 0 && faabBid < myTeam.faabRemaining) {
      faabBid = Math.min(myTeam.faabRemaining, maxOpponentBudget + 1);
    }

    // Determine confidence
    let confidence = 'Medium';
    if (isWeakness && target.projectedPoints > 13) confidence = 'High';
    if (target.projectedPoints < 9) confidence = 'Low';

    // Drop selection
    let dropCandidate = primaryDrop;
    if (primaryDrop && primaryDrop.id === target.id) {
      dropCandidate = benchPlayers[1] || null;
    }

    // Secondary backup
    const backupTarget = freeAgents[index + 1] || null;

    // Reasonings
    let reason = `Solid waiver pick to patch our starting roster.`;
    if (isWeakness) {
      reason = `Our roster is vulnerable at ${target.position}. Acquiring ${target.name} patches a major starting lineup gap.`;
    } else if (target.projectedPoints > 14) {
      reason = `Breakout opportunity: ${target.name} has experienced target increases and holds massive rest-of-season upside.`;
    }

    recommendations.push({
      addPlayer: target,
      dropPlayer: dropCandidate,
      bid: faabBid,
      pct: Math.round(pctOfBudget * 100),
      confidence,
      reason,
      urgency: `Waiver deadline is approaching. Acting now prevents opponents from acquiring a high-value starting ${target.position}.`,
      backup: backupTarget
    });
  });

  return recommendations;
}
