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
        
        // There was an "acceptance probability" here -- 75 minus twelve times
        // the points gap, clamped to 25..90 -- rendered as "85% Acceptance
        // Probability" and colour-coded green above 70, red below 40. Nothing
        // measures it: BACKTEST.md has no entry for whether anyone accepts
        // anything, and it did not read the opponent's needs, his roster or a
        // single trade that has ever happened. A confidence colour on a number
        // that came from nowhere is the most convincing kind of invention.
        //
        // What IS computed is the points gap, so that is what is reported.

        // Negotiation boundaries
        // The positions were literally "WR" and "RB" here whatever the players
        // actually were, so a QB-for-TE offer described itself as WR-for-RB.
        const openOffer = `Trade ${givePlayer.name} (${givePlayer.position}-${givePlayer.team})`
          + ` for ${getPlayer.name} (${getPlayer.position}-${getPlayer.team})`;
        // Both of these were fixed sentences. "Include a late-round draft swap
        // or $5 FAAB budget addition" is also nonsense in an auction league,
        // which is the only kind this app scrapes.
        const counterLimit = `Even value here is ${getPlayer.name} for ${givePlayer.name}`
          + ` straight up: the gap is ${Math.abs(Math.round(valDiff * 10) / 10)}`
          + ` projected points a week.`;
        const walkAway = `Do not accept if they demand an additional starting ${weGivePos}.`;

        // Direct message template
        const dmText = `Hey ${opponent.managerName}, I was looking at our rosters and noticed you could use a boost at ${weGivePos} while I'm looking to add some depth at ${weGetPos}. Would you be interested in a swap of ${givePlayer.name} for ${getPlayer.name}? It looks like a win-win for both of us.`;

        proposals.push({
          opponentId: opponent.teamId,
          opponentName: opponent.teamName,
          managerName: opponent.managerName,
          givePlayer,
          getPlayer,
          // Both of these named a fixed position regardless of the trade, and
          // the "% Championship Prob" was a points figure with a percent sign
          // stuck on it. State the points, which is what was actually computed.
          myImpact: `+${Math.round((getPlayer.projectedPoints - givePlayer.projectedPoints) * 10) / 10}`
            + ` projected points a week at ${getPlayer.position}`,
          oppImpact: `They get ${givePlayer.projectedPoints} projected points a week`
            + ` at ${givePlayer.position}`,
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
      
      // `give` is checked BEFORE it is dereferenced. The guard below tested
      // both, but the line computing `get` already read give.position -- so
      // when no player on this roster sits in the 10-16 band, which is routine
      // early in an auction where unresolved picks are stubs at replacement
      // level, this threw a TypeError. It aborts the render mid-DOM on the
      // Home, Trades and Alerts pages, all three of which call this without a
      // guard, leaving a half-drawn page and no error state.
      const give = myRoster.find(p => p.projectedPoints > 10 && p.projectedPoints < 16);
      if (!give) return;
      const get = oppRoster.find(p => p.projectedPoints > 10 && p.projectedPoints < 16
        && p.position !== give.position);

      if (get) {
        proposals.push({
          opponentId: opponent.teamId,
          opponentName: opponent.teamName,
          managerName: opponent.managerName,
          givePlayer: give,
          getPlayer: get,
          // The points delta, not a percentage. This read "+2% Championship
          // Prob" for every fallback proposal ever generated, and no
          // championship probability is computed anywhere in this file. The
          // comment forty lines above records fixing exactly this on the
          // primary path -- "a points figure with a percent sign stuck on it"
          // -- while the fallback kept the invented number.
          myImpact: `+${Math.round((get.projectedPoints - give.projectedPoints) * 10) / 10} pts/wk`,
          // "Balances scoring rotation" was a fixed sentence, `probability: 55`
          // a fixed number rendered as "55% Acceptance Probability", and the
          // three negotiation lines were fixed strings that named no player.
          // Every one of them read as analysis of this specific trade.
          oppImpact: `They get ${give.projectedPoints} projected points a week`
            + ` at ${give.position}`,
          risk: get.injuryStatus && get.injuryStatus !== 'Healthy'
            ? `High (${get.name} is ${get.injuryStatus})` : 'Low',
          negotiation: {
            open: `Trade ${give.name} (${give.position}-${give.team})`
              + ` for ${get.name} (${get.position}-${get.team})`,
            counter: `The gap is `
              + `${Math.abs(Math.round((get.projectedPoints - give.projectedPoints) * 10) / 10)}`
              + ` projected points a week.`,
            walkAway: `Do not accept if they demand an additional starting ${give.position}.`
          },
          dmText: `Hey ${opponent.managerName}, interested in swapping ${give.name} for ${get.name}? Might help balance out both our rosters.`
        });
      }
    });
  }

  return proposals.slice(0, 3);
}
