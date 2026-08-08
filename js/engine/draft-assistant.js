/**
 * Gridiron Edge Live Draft Recommendation Engine
 */
import { survivalProbability, survivalPct, nextPickFor } from './survival.js';
import { openStarterSlots, starterSlots, flexCount, FLEX_POS, rosterSize }
  from './lineup-rules.js';

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
  const rounds = rosterSize(league);
  const currentPick = draftState.currentPick;
  
  // Find which slots have been filled by user (teamId: myTeamId)
  const myPicks = selections.filter(s => s.teamId === league.myTeamId);
  const myRosterPositions = myPicks.map(p => db[p.playerId]?.position).filter(Boolean);
  
  // Count counts of positions
  const posCounts = { QB: 0, RB: 0, WR: 0, TE: 0, 'D/ST': 0, K: 0 };
  myRosterPositions.forEach(pos => {
    if (posCounts[pos] !== undefined) posCounts[pos]++;
  });

  // Analyze roster needs compared to limits.
  //
  // This gave RB and WR a flex allowance EACH -- `limits.RB + 1` and
  // `limits.WR + 1` -- which is the precise bug lineup-rules.js exists to hold
  // one corrected copy of: the flex is one slot shared between RB, WR and TE,
  // so granting it twice claims eight flex-eligible starters where the lineup
  // has six, and a complete roster still reports an open slot.
  const limits = league.rosterSettings;
  const open = openStarterSlots(posCounts, limits);
  const needs = {};
  Object.keys(starterSlots(limits)).forEach((pos) => { needs[pos] = (open[pos] || 0) > 0; });

  // Identify next user pick overall index
  // Degrade rather than throw: a scraped league carries no draft order, and a
  // recommendation engine that crashes takes the whole page with it.
  const draftOrder = draftState.draftOrder || league.teams.map((t) => t.teamId);
  const userOrderIdx = draftOrder.indexOf(league.myTeamId);
  const roundIdx = Math.floor((currentPick - 1) / league.leagueSize);
  
  // One derivation, in survival.js, which also owns the curve it feeds. This
  // copy took picks[1] -- the pick AFTER next -- whenever the board was not on
  // your clock, so a manager in seat 4 on pick 25 was told what would survive
  // to pick 44 rather than 37.
  const nextUserPick = nextPickFor(league, currentPick) ?? (currentPick + league.leagueSize);

  const picksToNext = nextUserPick - currentPick;

  // Estimated availability at the user's next pick. One shared curve -- this
  // file used to carry two of them, 110 lines apart, answering the same
  // question differently, with the display reading one and the recommendation
  // reading the other.
  const withAvailability = availablePlayers.map(p => ({
    ...p,
    availabilityAtNext: survivalPct(p, nextUserPick),
  }));



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

    // Fourth private copy of the lineup shape. The counts come from
    // lineup-rules now, so a 3-WR league is described here the same way it is
    // everywhere else -- but deliberately only for the offensive slots.
    //
    // This compares candidates for the pick in front of you, and every roster
    // fills kicker and defence last for near-nothing. Counting them as open
    // starting slots makes the first kicker on the board outrank a starting
    // receiver: it put one into the shortlist at pick 97 when tried. That is a
    // strategy change, and BACKTEST.md has no measurement for it, so the scope
    // stays where it was.
    const allSlots = starterSlots(limits);
    const slots = { QB: allSlots.QB, RB: allSlots.RB, WR: allSlots.WR, TE: allSlots.TE };
    let total = 0;
    const spare = [];
    Object.keys(slots).forEach(pos => {
      const list = byPos[pos] || [];
      total += list.slice(0, slots[pos]).reduce((a, b) => a + b, 0);
      if (FLEX_POS.includes(pos)) spare.push(...list.slice(slots[pos]));
    });
    spare.sort((a, b) => b - a);
    const nFlex = flexCount(limits);
    total += spare.slice(0, nFlex).reduce((a, b) => a + b, 0);
    spare.slice(nFlex).forEach((v, i) => { total += v * BENCH_WEIGHT * Math.pow(0.75, i); });
    return total;
  };

  const myPlayers = myPicks.map(s => db[s.playerId]).filter(Boolean);
  const baseLineup = lineupValue(myPlayers);
  const marginalValue = (p) => lineupValue(myPlayers.concat([p])) - baseLineup;

  // Probability a player is still on the board at our next pick, from ADP.
  // An unknown ADP used to be silently read as 200 -- late enough that the
  // player was treated as certain to last, which is a claim, not an absence.
  // A player we cannot place is assumed gone, so he is never recommended on
  // the strength of a wait that was never measured.
  const survives = (p) => survivalProbability(p, nextUserPick) ?? 0;

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
   * NOT MEASURED. These two lines used to carry effect sizes and confidence
   * intervals -- +2.9 [+0.8, +5.0] tuned, +1.5 [-1.1, +4.2] held out -- and not
   * one of those four figures appears anywhere in BACKTEST.md. Its only risk
   * sweep tests a CONSTANT tilt with no intervals, and the round-dependent pair
   * shipped here was never measured. Every other backtest citation in this file
   * reproduces exactly, which is what makes an invented one worth deleting
   * rather than softening.
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
    // Names them, and says how many. This was a fixed sentence -- "Only a few
    // high-volume backs remain. Reaching for other positions reduces long-term
    // roster value." -- printed whoever was on the board, five lines below the
    // tight-end warning that had already been corrected for exactly this and
    // carries a comment citing CLAUDE.md by name.
    tierWarning = topRBs.length === 0
      ? 'No running back left is projected above 16 points per game, and your '
        + 'backfield is not full.'
      : `${topRBs.length === 1 ? 'Only ' : ''}${topRBs.map(p => p.name).join(' and ')} `
        + `${topRBs.length === 1 ? 'is' : 'are'} still projected above 16 points per `
        + `game, and your backfield is not full.`;
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

  /* -----------------------------------------------------------------------
   * What is still open after taking him.
   *
   * This read: "Secures anchoring <POS> slot. Plan to target <Running Backs if
   * he is a WR, else Wide Receivers> in rounds N+2 and N+3." Every clause was
   * invented. It named RB or WR by flipping on the recommended player's
   * position, whether or not either slot was open -- so a manager with a full
   * backfield taking a receiver was told to draft running backs, and the two
   * round numbers were arithmetic on the current round with nothing behind
   * them. It is a hardcoded string that reads like analysis, which CLAUDE.md
   * treats as the same offence as a hardcoded number, and it went on screen
   * under the heading "Future Roster Plan".
   *
   * `open` is already computed above, from this league's own slot counts, and
   * `fallbackAt` already holds what the best survivor at each position is worth
   * at the next pick. That is enough to say something true: which starting
   * slots remain after this pick, ordered by how much value is still on the
   * board there. When nothing remains open it says so, and when the board is
   * too thin to rank anything it returns null rather than a sentence -- app.js
   * omits the line entirely in that case.
   * --------------------------------------------------------------------- */
  const afterPick = { ...posCounts };
  afterPick[topPick.position] = (afterPick[topPick.position] || 0) + 1;
  const slots = starterSlots(limits);
  // The FIXED openings, counted per position. `openStarterSlots` folds the
  // shared flex into every flex-eligible position, which is right for asking
  // "may I still start one of these" and wrong for a list a reader will add
  // up: it reported 2x TE and 3x WR on a lineup with one flex between them.
  // The flex is named once, separately, which is what it is.
  const fixedOpen = Object.keys(slots)
    .map((pos) => ({ pos, n: slots[pos] - (afterPick[pos] || 0), worth: fallbackAt[pos] ?? null }))
    .filter((o) => o.n > 0)
    .sort((a, b) => (b.worth ?? -Infinity) - (a.worth ?? -Infinity));
  const flexStillOpen = flexCount(limits)
    - FLEX_POS.reduce((a, pos) => a + Math.max(0, (afterPick[pos] || 0) - slots[pos]), 0);

  let planChange = null;
  if (fixedOpen.length === 0 && flexStillOpen <= 0) {
    planChange = 'Every starting slot is filled after this pick. What is left is bench.';
  } else if (fixedOpen.some((o) => o.worth !== null) || flexStillOpen > 0) {
    // `fallbackAt` is expected value ADDED TO THE STARTING LINEUP over the
    // season by the best player at that position likely to survive to the next
    // pick -- so the label says that rather than printing a bare figure.
    const named = fixedOpen.slice(0, 3).map((o) => {
      const label = o.n > 1 ? `${o.n}\u00d7 ${o.pos}` : o.pos;
      return o.worth === null ? label : `${label} (+${o.worth.toFixed(0)} pts)`;
    });
    if (flexStillOpen > 0) {
      named.push(flexStillOpen > 1 ? `${flexStillOpen} flex slots` : 'the flex');
    }
    planChange = `Still open after this pick: ${named.join(', ')}`
      + `. Figures are the season lineup points the best likely survivor at `
      + `pick ${nextUserPick} would add.`;
  }

  return {
    primaryPick: topPick,
    whyBest,
    advantage: adv,
    riskLevel: risk,
    alternatives: bestAlternatives,
    willBeAvailable: nextPickAvailable,
    planChange,
    tierWarning
  };
}


