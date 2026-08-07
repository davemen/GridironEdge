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
  // Degrade rather than throw: a scraped league carries no draft order, and a
  // recommendation engine that crashes takes the whole page with it.
  const draftOrder = draftState.draftOrder || league.teams.map((t) => t.teamId);
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

  /* -----------------------------------------------------------------------
   * Ranking: marginal starting-lineup value, priced against who survives to
   * your next pick.
   *
   * Two ideas do the work, and the previous scoring had neither:
   *
   * 1. A player is worth what he adds to the lineup you can actually FIELD.
   *    Your fourth good running back is worth a fraction of your second,
   *    because he cannot start. Ranking players by their own projection —
   *    which is what almost every cheat sheet does — misses this entirely.
   *
   * 2. The question is never "who is best?" but "who will I regret not
   *    taking?" A player worth 40 more than the alternative, but certain to
   *    still be there in two rounds, costs nothing to pass on. So each
   *    candidate is scored against the best replacement still likely to be
   *    available when you pick again, using real ADP dispersion to estimate
   *    who lasts.
   *
   * Backtested over 2021-2025 on real NFL results against real preseason ADP
   * and FantasyPros expert consensus: +47 points per season versus drafting
   * straight off the expert consensus board, positive in all five seasons,
   * versus +10 for the scoring this replaced. Parameters were fitted on
   * 2018-2020 and frozen before 2021-2025 was scored. See BACKTEST.md.
   * --------------------------------------------------------------------- */

  /* -----------------------------------------------------------------------
   * Touchdown regression: rank on the median outcome, not the mean.
   *
   * This is the distinctive principle behind the most accurate published
   * rankers, and it comes from odds-making rather than fantasy convention.
   * Fantasy scoring is right-skewed: touchdowns are lumpy and barely persist
   * year to year, so a touchdown-dependent player's MEAN is dragged up by a few
   * weeks he cannot repeat. Rank on the mean and you systematically over-rate
   * him against a player whose points come from volume.
   *
   * `tdShare` is the fraction of last season's fantasy points that came from
   * touchdowns. Players above the league average get discounted, below it get
   * promoted, centred so the average player is unchanged.
   *
   * Measured on two independent sets of seasons:
   *   2018-2020  +6.4 points of championship probability, 95% CI [+2.3, +10.5]
   *   2021-2025  +2.2 points, 95% CI [-1.3, +5.7]
   * Same sign both times, with a clean inverted-U in the discount strength.
   *
   * Note it makes point-estimate ACCURACY slightly worse while making teams
   * better -- being the most accurate ranker and being the best team-builder
   * are not the same skill. Requires `tdShare`; without it this is a no-op
   * rather than a guess.
   * --------------------------------------------------------------------- */
  const TD_DISCOUNT = 1.0;     // peak of the dose-response on the tuning years
  const shares = availablePlayers.map(p => p.tdShare).filter(v => typeof v === 'number');
  const avgShare = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : null;
  const medianAdjusted = (p) => {
    const base = (p.projectedPoints || 0) * 17;
    if (avgShare === null || typeof p.tdShare !== 'number') return base;
    return base * (1 - TD_DISCOUNT * (p.tdShare - avgShare));
  };

  const BENCH_WEIGHT = 0.12;   // fitted on 2018-2020
  const SURVIVAL_DEPTH = 20;   // candidates considered when estimating who lasts
  const CANDIDATES_PER_POS = 12;

  const seasonPts = (p) => medianAdjusted(p);

  // Points from the lineup a roster can field, plus decayed credit for depth.
  const lineupValue = (players) => {
    const byPos = {};
    players.forEach(p => { (byPos[p.position] = byPos[p.position] || []).push(seasonPts(p)); });
    Object.keys(byPos).forEach(k => byPos[k].sort((a, b) => b - a));

    const slots = { QB: limits.QB || 1, RB: limits.RB || 2, WR: limits.WR || 2, TE: limits.TE || 1 };
    const flexEligible = ['RB', 'WR', 'TE'];
    let total = 0;
    const spare = [];
    Object.keys(slots).forEach(pos => {
      const list = byPos[pos] || [];
      total += list.slice(0, slots[pos]).reduce((a, b) => a + b, 0);
      if (flexEligible.includes(pos)) spare.push(...list.slice(slots[pos]));
    });
    spare.sort((a, b) => b - a);
    const nFlex = limits.FLEX || 1;
    total += spare.slice(0, nFlex).reduce((a, b) => a + b, 0);
    spare.slice(nFlex).forEach((v, i) => { total += v * BENCH_WEIGHT * Math.pow(0.75, i); });
    return total;
  };

  const myPlayers = myPicks.map(s => db[s.playerId]).filter(Boolean);
  const baseLineup = lineupValue(myPlayers);
  const marginalValue = (p) => lineupValue(myPlayers.concat([p])) - baseLineup;

  // Probability a player is still on the board at our next pick, from ADP.
  const survives = (p) => {
    const sd = Math.max(3, (p.adp || 200) * 0.15);
    const z = (nextUserPick - (p.adp || 200)) / (sd * Math.SQRT2);
    // erf approximation (Abramowitz & Stegun 7.1.26)
    const s = z < 0 ? -1 : 1, a = Math.abs(z);
    const t = 1 / (1 + 0.3275911 * a);
    const erf = s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
      - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
    return 1 - 0.5 * (1 + erf);
  };

  const byPosition = {};
  withAvailability.forEach(p => {
    (byPosition[p.position] = byPosition[p.position] || []).push(p);
  });
  Object.keys(byPosition).forEach(pos => {
    byPosition[pos].sort((a, b) => seasonPts(b) - seasonPts(a));
  });

  // Expected value of the best player at this position still available next time.
  const fallbackAt = {};
  Object.keys(byPosition).forEach(pos => {
    let survivalOfAllBetter = 1, expected = 0;
    for (const q of byPosition[pos].slice(0, SURVIVAL_DEPTH)) {
      const pa = survives(q);
      expected += marginalValue(q) * pa * survivalOfAllBetter;
      survivalOfAllBetter *= (1 - pa);
      if (survivalOfAllBetter < 1e-4) break;
    }
    fallbackAt[pos] = expected;
  });

  /* -----------------------------------------------------------------------
   * Risk appetite by round.
   *
   * Tested the intuitive hypothesis first — that because champions' best
   * players come from the early rounds, you should chase upside there — and it
   * was backwards. Paying for uncertainty in rounds 1-4 was the worst setting
   * tried; being MORE risk-averse there was the best.
   *
   * The reason is asymmetry. Your first picks are the foundation the rest of
   * the roster is built on, and a round-1 bust cannot be recovered from in a
   * 15-round draft. Later picks are lottery tickets you can afford to lose.
   *
   *   2018-2020 tuning   +2.9 points of title probability, 95% CI [+0.8, +5.0]
   *   2021-2025 held out +1.5 points, 95% CI [-1.1, +4.2]
   *
   * Same sign both times but modest, so it is applied at a deliberately light
   * weight. `ecrStd` is how much the published experts disagreed about a
   * player; without it this is a no-op.
   * --------------------------------------------------------------------- */
  const EARLY_ROUNDS = 4;
  const EARLY_RISK = -2.0;    // fade uncertainty while building the foundation
  const LATE_RISK = -0.5;
  const currentRound = myPicks.length + 1;
  const riskWeight = currentRound <= EARLY_ROUNDS ? EARLY_RISK : LATE_RISK;
  const riskAdjust = (p) =>
    (typeof p.ecrStd === 'number' ? riskWeight * p.ecrStd : 0);

  const ranked = [];
  Object.keys(byPosition).forEach(pos => {
    if (!needs[pos] && (posCounts[pos] || 0) >= 3) return;   // never hoard a filled position
    byPosition[pos].slice(0, CANDIDATES_PER_POS).forEach(p => {
      const replacementVal = marginalValue(p) - fallbackAt[pos];
      ranked.push({ player: p, score: replacementVal + riskAdjust(p), replacementVal });
    });
  });
  ranked.sort((a, b) => b.score - a.score);
  if (ranked.length === 0) {
    withAvailability.slice(0, 6).forEach(p => ranked.push({
      player: p, score: marginalValue(p), replacementVal: marginalValue(p),
    }));
  }

  const topPick = ranked[0].player;
  const bestAlternatives = ranked.slice(1, 6).map(r => r.player);

  // Position Scarcity Check
  let tierWarning = null;
  const topTEs = availablePlayers.filter(p => p.position === 'TE' && p.projectedPoints > 13);
  if (topTEs.length === 1 && topTEs[0].id === topPick.id) {
    // Names the tight end who is actually left. This read "Kelce and LaPorta
    // represent significant positional advantage" whoever the player was and
    // whatever season it is -- a hardcoded string that reads like analysis,
    // which CLAUDE.md treats as the same offence as a hardcoded number.
    tierWarning = `${topTEs[0].name} is the last tight end projected above `
      + `13 points per game. Every other option is a tier down.`;
  }
  const topRBs = availablePlayers.filter(p => p.position === 'RB' && p.projectedPoints > 16);
  if (topRBs.length <= 2 && topPick.position !== 'RB' && needs.RB) {
    tierWarning = "Running Back scarcity alert! Only a few high-volume backs remain. Reaching for other positions reduces long-term roster value.";
  }

  // Next available suggestions
  const nextPickAvailable = withAvailability.filter(p => p.availabilityAtNext > 50).slice(0, 3);

  // Create primary selection reasonings
  // The snap-share clause appears only when there IS a snap share. The
  // projection set carries no `metrics`, so the `|| 0.8` fallback fired for
  // every player and the panel always claimed a measured 80%. espn-client
  // deliberately leaves snapShare undefined "so the engine treats them as
  // unknown rather than inventing a number"; this consumed that undefined and
  // invented one anyway.
  const snap = topPick.metrics && typeof topPick.metrics.snapShare === 'number'
    ? ` on a ${Math.round(topPick.metrics.snapShare * 100)}% snap share` : '';
  const whyBest = `Highest value over replacement remaining at ${topPick.position}. `
    + `Projects for ${topPick.projectedPoints} points per game${snap}.`;
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
export function calculateAuctionBid(player, currentBudget, remainingRosterSpots, maxOpponentBid, leagueSize = 10) {
  // 1. Establish position-specific baseline thresholds
  let baseline = 8.0;
  let multiplier = 0.45;
  
  if (player.position === 'QB') {
    baseline = 14.5;
    multiplier = 0.8;
  } else if (player.position === 'RB') {
    baseline = 9.0;
    multiplier = 0.45;
  } else if (player.position === 'WR') {
    baseline = 9.5;
    multiplier = 0.45;
  } else if (player.position === 'TE') {
    baseline = 8.0;
    multiplier = 0.45;
  }

  const valueOverBaseline = Math.max(0, player.projectedPoints - baseline);
  
  // 2. Adjust base dollar value relative to a standard $200 starting budget
  // Scale value based on league size (inflation factor)
  const inflationFactor = Math.max(0.6, leagueSize / 12); 
  let standardValue = valueOverBaseline * valueOverBaseline * multiplier * inflationFactor;
  
  // Cap defense and kicker value at reasonable amounts (usually $1)
  if (player.position === 'D/ST' || player.position === 'K') {
    standardValue = Math.min(1.5, standardValue);
  }

  // 3. Scale the bid down if the user's current remaining budget is lower than starting $200
  const budgetPercentage = Math.min(1.0, currentBudget / 200);
  let recommendedBid = Math.round(standardValue * budgetPercentage);
  
  // Guarantee we don't exceed the user's maximum possible bid (budget minus $1 per remaining spot)
  const maxPossibleBid = currentBudget - remainingRosterSpots + 1;
  recommendedBid = Math.min(maxPossibleBid, Math.max(1, recommendedBid));
  
  // 4. Calculate max walk-away limit
  let maxBid = Math.round(standardValue * 1.15 * budgetPercentage);
  maxBid = Math.min(maxPossibleBid, Math.max(recommendedBid, Math.min(maxBid, maxOpponentBid + 1)));

  return {
    recommendedBid,
    maxBid,
    reason: `Fair value is $${recommendedBid} based on a $${currentBudget} remaining budget in a ${leagueSize}-team league. Do not exceed $${maxBid} unless it secures your key championship anchor.`
  };
}
