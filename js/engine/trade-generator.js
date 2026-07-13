/**
 * Gridiron Edge Realistic Trade Recommendation Engine
 */

export function generateTradeProposals(league) {
  const db = league.playerDatabase;
  const myTeam = league.teams.find(t => t.teamId === league.myTeamId);
  if (!myTeam || !myTeam.roster) return [];

  const myRoster = myTeam.roster.map(pid => db[pid]).filter(Boolean);
  
  // Calculate our position counts and surpluses
  // A surplus means having more than starting limits of high-quality players
  const myPosCounts = { QB: [], RB: [], WR: [], TE: [] };
  myRoster.forEach(p => {
    if (myPosCounts[p.position]) myPosCounts[p.position].push(p);
  });

  // Simple surplus metric: count of players in position with projected points > 13
  const mySurplusPositions = [];
  const myWeakPositions = [];
  
  Object.keys(myPosCounts).forEach(pos => {
    const limit = league.rosterSettings[pos] || 2;
    const strongPlayers = myPosCounts[pos].filter(p => p.projectedPoints > 13);
    
    if (strongPlayers.length > limit) {
      mySurplusPositions.push(pos);
    } else if (strongPlayers.length < limit || myPosCounts[pos].length === 0) {
      myWeakPositions.push(pos);
    }
  });

  const proposals = [];

  // Iterate over opponents to find matching trade partners
  league.teams.forEach(opponent => {
    if (opponent.teamId === league.myTeamId) return;

    const oppRoster = opponent.roster.map(pid => db[pid]).filter(Boolean);
    const oppPosCounts = { QB: [], RB: [], WR: [], TE: [] };
    oppRoster.forEach(p => {
      if (oppPosCounts[p.position]) oppPosCounts[p.position].push(p);
    });

    // Check opponent gaps vs our surpluses, and opponent surpluses vs our gaps
    const oppSurplusPositions = [];
    const oppWeakPositions = [];
    
    Object.keys(oppPosCounts).forEach(pos => {
      const limit = league.rosterSettings[pos] || 2;
      const strongPlayers = oppPosCounts[pos].filter(p => p.projectedPoints > 13);
      
      if (strongPlayers.length > limit) {
        oppSurplusPositions.push(pos);
      } else if (strongPlayers.length < limit || oppPosCounts[pos].length === 0) {
        oppWeakPositions.push(pos);
      }
    });

    // Match trade pairings
    // Look for: We have surplus in X, opponent is weak in X. And opponent has surplus in Y, we are weak in Y.
    const weGivePos = mySurplusPositions.find(pos => oppWeakPositions.includes(pos));
    const weGetPos = oppSurplusPositions.find(pos => myWeakPositions.includes(pos));

    if (weGivePos && weGetPos) {
      // Find players to trade
      // We trade our lowest-ranked "strong" player in surplus position
      const myGivePlayers = myPosCounts[weGivePos]
        .filter(p => p.projectedPoints > 12)
        .sort((a, b) => a.projectedPoints - b.projectedPoints);
      
      // Opponent trades their lowest-ranked "strong" player in surplus position
      const oppGivePlayers = oppPosCounts[weGetPos]
        .filter(p => p.projectedPoints > 12)
        .sort((a, b) => a.projectedPoints - b.projectedPoints);

      const givePlayer = myGivePlayers[0];
      const getPlayer = oppGivePlayers[0];

      if (givePlayer && getPlayer) {
        // Calculate points difference
        const valDiff = getPlayer.projectedPoints - givePlayer.projectedPoints;
        
        // Calculate acceptance probability based on trade parity
        // Trade is realistic if valuations are close (within 3 points)
        const parity = Math.abs(valDiff);
        let acceptanceProb = 75 - Math.round(parity * 12);
        
        // Boost probability if it solves clear gaps for both teams
        acceptanceProb = Math.min(90, Math.max(25, acceptanceProb + 10));

        // Negotiation boundaries
        const openOffer = `Trade ${givePlayer.name} (WR-${givePlayer.team}) for ${getPlayer.name} (RB-${getPlayer.team})`;
        const counterLimit = `Include a late-round draft swap or $5 FAAB budget addition.`;
        const walkAway = `Do not accept if they demand an additional starting ${weGivePos}.`;

        // Direct message template
        const dmText = `Hey ${opponent.managerName}, I was looking at our rosters and noticed you could use a boost at ${weGivePos} while I'm looking to add some depth at ${weGetPos}. Would you be interested in a swap of ${givePlayer.name} for ${getPlayer.name}? It looks like a win-win for both of us.`;

        proposals.push({
          opponentId: opponent.teamId,
          opponentName: opponent.teamName,
          managerName: opponent.managerName,
          givePlayer,
          getPlayer,
          myImpact: `+${Math.round((getPlayer.projectedPoints - 10) * 10) / 10}% Championship Prob (addresses key RB starting weakness)`,
          oppImpact: `Patches starting WR gap with consistent ${givePlayer.projectedPoints} Proj points`,
          probability: acceptanceProb,
          risk: getPlayer.injuryStatus !== 'Healthy' ? 'High (injury concern)' : 'Low',
          negotiation: {
            open: openOffer,
            counter: counterLimit,
            walkAway: walkAway
          },
          dmText
        });
      }
    }
  });

  // Fallback: If no perfect surplus-weakness matches are found, suggest a standard value trade
  if (proposals.length === 0 && myRoster.length > 0) {
    league.teams.forEach(opponent => {
      if (opponent.teamId === league.myTeamId) return;
      const oppRoster = opponent.roster.map(pid => db[pid]).filter(Boolean);
      
      const give = myRoster.find(p => p.projectedPoints > 10 && p.projectedPoints < 16);
      const get = oppRoster.find(p => p.projectedPoints > 10 && p.projectedPoints < 16 && p.position !== give.position);
      
      if (give && get) {
        proposals.push({
          opponentId: opponent.teamId,
          opponentName: opponent.teamName,
          managerName: opponent.managerName,
          givePlayer: give,
          getPlayer: get,
          myImpact: `+2% Championship Prob`,
          oppImpact: `Balances scoring rotation`,
          probability: 55,
          risk: 'Low',
          negotiation: {
            open: `Trade ${give.name} for ${get.name}`,
            counter: `Swap bench players of similar position`,
            walkAway: `Do not add premium draft picks`
          },
          dmText: `Hey ${opponent.managerName}, interested in swapping ${give.name} for ${get.name}? Might help balance out both our rosters.`
        });
      }
    });
  }

  return proposals.slice(0, 3);
}
