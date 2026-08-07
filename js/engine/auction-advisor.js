/**
 * Gridiron Edge — Market-Adaptive Auction Advisor
 *
 * An auction is a live market, not a price list. What a player is worth to you
 * depends on how much money is still in the room, who else still needs his
 * position, what you have already bought, and what you would have to give up
 * later to afford him now. This module tracks all of that and answers one
 * question:
 *
 *     What is the most I can pay for this player and still end up with a better
 *     roster than if I let him go?
 *
 * That price is the bid ceiling. It is derived, not assigned:
 *
 *     planWithout   = best roster I can still build with my current budget
 *     planWith(x)   = best roster I can build if I pay $x for him
 *     ceiling       = largest x where planWith(x) >= planWithout
 *
 * "Best roster I can still build" is a greedy fill at FORECAST prices — what
 * players will actually cost in this room given current budgets and needs — so
 * the ceiling moves as the market moves. When three rivals go broke, prices fall
 * and the ceiling rises automatically; nobody has to tune a scarcity constant.
 *
 * Must Buy is the same calculation read backwards: if losing this player would
 * drop the best roster still available to me by a large margin, he is a Must Buy
 * and the ceiling is allowed to stretch past his market price.
 *
 * Positions are never weighted by hand. A second quarterback adds almost nothing
 * to a starting lineup, so the planner refuses to pay for one on its own. An
 * elite running back is scarce at the top of the board, so it will.
 *
 * Backtested over 2021-2025 against real NFL results, real preseason ADP and
 * FantasyPros expert consensus. The previous `calculateAuctionBid()` priced
 * quarterbacks at roughly five times market and deployed only a quarter of the
 * league's money; replacing it is worth +306 points a season. Against a well-built static value chart the
 * result depends on the room: in an efficient one they tie (+16, t = 0.9), but
 * in a realistically front-loaded room -- where the first two dozen names go
 * for far more than par and half the league is then broke -- this wins by +125
 * points a season (t = 5.8). Seeing that four rivals just spent themselves out
 * is the whole point, and a static chart cannot. See BACKTEST.md.
 */

import { STARTER_SLOTS, FLEX_POS, N_FLEX, MAX_AT_POS, openStarterSlots }
  from './lineup-rules.js';

const BENCH_WEIGHT = 0.12;       // depth is worth something, but far less than a starter
const MUST_BUY_POINTS = 10.0;    // lineup points lost by missing him
const PLAN_CANDIDATES = 110;    // the priced part of the board
const STARTER_MARGIN = 1.25;     // hold 25% over forecast for slots you must fill
const GAMES = 17;

const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const seasonPoints = (p) => num(p.projectedPoints) * GAMES;

// ---------------------------------------------------------------------------
// League state
// ---------------------------------------------------------------------------

/**
 * Snapshot every team's budget, roster, open slots, positional needs and
 * observed bidding behaviour. Rebuilt from the live draft state on every render,
 * so it is always current.
 */
export function buildLeagueState(league, parById = null) {
  const db = league.playerDatabase || {};
  const rosterSize = (league.rosterSettings?.startersCount || 9)
    + (league.rosterSettings?.benchCount || 7);
  const selections = league.draftState?.selections || [];

  const teams = league.teams.map((t) => ({
    teamId: t.teamId,
    teamName: t.teamName,
    budget: num(t.faabRemaining, 200),
    roster: [],
    counts: {},
    paidVsPar: [],
  }));
  const byId = new Map(teams.map((t) => [t.teamId, t]));

  selections.forEach((s) => {
    const team = byId.get(s.teamId);
    const player = db[s.playerId];
    if (!team || !player) return;
    team.roster.push(player);
    team.counts[player.position] = (team.counts[player.position] || 0) + 1;
    // Observed bidding behaviour: what this manager actually paid against what
    // the player was worth. Needs a par lookup, which only exists once values
    // have been computed -- hence the optional argument rather than a field on
    // the selection, which would go stale the moment the board moved.
    const par = parById ? parById.get(s.playerId) : null;
    if (typeof s.bidAmount === 'number' && par && par > 2) {
      team.paidVsPar.push(s.bidAmount / par);
    }
  });

  teams.forEach((t) => {
    t.spotsLeft = Math.max(0, rosterSize - t.roster.length);
    // Every open slot needs at least $1 held back, so this is the true ceiling.
    t.maxBid = t.spotsLeft > 0 ? Math.max(0, t.budget - (t.spotsLeft - 1)) : 0;
    t.needs = openStarterSlots(t.counts);
    // Managers who have been overpaying will keep overpaying.
    t.aggression = t.paidVsPar.length
      ? Math.max(0.5, Math.min(2.0, t.paidVsPar.reduce((a, b) => a + b, 0) / t.paidVsPar.length))
      : 1.0;
  });

  return {
    teams,
    byId,
    rosterSize,
    myTeamId: league.myTeamId,
    me: byId.get(league.myTeamId) || teams[0],
    leagueSize: league.leagueSize || teams.length,
    moneyLeft: teams.reduce((a, t) => a + t.budget, 0),
    slotsLeft: teams.reduce((a, t) => a + t.spotsLeft, 0),
  };
}


// ---------------------------------------------------------------------------
// Par values and inflation
// ---------------------------------------------------------------------------

/**
 * Par value: what each player would cost in a perfectly efficient room. The
 * league's spendable money (every roster spot costs $1 minimum) split in
 * proportion to value over replacement.
 */
export function parValues(available, state, budget = 200) {
  const replacementRank = { QB: 14, RB: 34, WR: 40, TE: 14, 'D/ST': 13, K: 13 };
  const byPos = {};
  available.forEach((p) => {
    (byPos[p.position] = byPos[p.position] || []).push(seasonPoints(p));
  });
  Object.keys(byPos).forEach((k) => byPos[k].sort((a, b) => b - a));

  const replacement = {};
  Object.keys(byPos).forEach((pos) => {
    const list = byPos[pos];
    const idx = Math.min(list.length - 1, (replacementRank[pos] || 20) - 1);
    replacement[pos] = list[Math.max(0, idx)] || 0;
  });

  const vor = available.map((p) => Math.max(0, seasonPoints(p) - (replacement[p.position] || 0)));
  // A league cannot roster more players than exist. Without this floor, a thin
  // player database (a partial ESPN import, say) spreads the league's whole
  // budget across a handful of names and every one of them looks priceless.
  const nRostered = Math.min(state.leagueSize * state.rosterSize, available.length);
  const surplus = state.leagueSize * (budget - state.rosterSize);
  // No player can ever be worth more than one team could physically pay.
  const maxSingleBid = Math.max(1, budget - state.rosterSize + 1);

  const order = vor.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, nRostered);
  const total = order.reduce((a, [v]) => a + v, 0);

  // Only players who will actually be rostered get the $1 minimum. Giving it to
  // all 459 in the pool when a league rosters 128 inflated the board's total
  // value well past the money that exists in it -- $1931 against $1600 -- which
  // pushed every forecast price up.
  const par = new Array(available.length).fill(0);
  if (total > 0) {
    order.forEach(([v, i]) => {
      par[i] = Math.min(maxSingleBid, 1 + (surplus * v) / total);
    });
  }
  return par;
}

/**
 * How many points a dollar buys at the board's own prices.
 *
 * Par splits the league's spendable money in proportion to value over
 * replacement, so the ratio between them IS the going exchange rate. It is what
 * makes "this player is replaceable" a statement about money rather than taste:
 * paying $x more than a substitute costs is worth it only if the upgrade beats
 * what $x would buy anywhere else.
 */
export function pointsPerDollar(available, state, budget = 200) {
  const replacementRank = { QB: 14, RB: 34, WR: 40, TE: 14, 'D/ST': 13, K: 13 };
  const byPos = {};
  available.forEach((p) => {
    (byPos[p.position] = byPos[p.position] || []).push(seasonPoints(p));
  });
  Object.keys(byPos).forEach((k) => byPos[k].sort((a, b) => b - a));
  const replacement = {};
  Object.keys(byPos).forEach((pos) => {
    const list = byPos[pos];
    const idx = Math.min(list.length - 1, (replacementRank[pos] || 20) - 1);
    replacement[pos] = list[Math.max(0, idx)] || 0;
  });
  const nRostered = Math.min(state.leagueSize * state.rosterSize, available.length);
  const surplus = Math.max(1, state.leagueSize * (budget - state.rosterSize));
  const total = available
    .map((p) => Math.max(0, seasonPoints(p) - (replacement[p.position] || 0)))
    .sort((a, b) => b - a)
    .slice(0, nRostered)
    .reduce((a, b) => a + b, 0);
  return total / surplus;
}

/**
 * Dollars still in the room divided by the value still on the board. Above 1.0
 * means teams are hoarding cash and everything left is about to cost more than
 * the chart says; below 1.0 means the room overspent early and bargains are
 * coming. This is the single number that makes a static value chart wrong.
 */
export function marketInflation(state, remainingPar) {
  if (state.slotsLeft <= 0) return 1.0;
  const spendable = state.moneyLeft - state.slotsLeft;
  const par = Math.max(1, remainingPar - state.slotsLeft);
  return Math.max(0.4, Math.min(2.5, spendable / par));
}

// ---------------------------------------------------------------------------
// Forecast price
// ---------------------------------------------------------------------------

/**
 * What this player will actually sell for.
 *
 * An auction is second-price in effect: you pay one dollar more than the
 * runner-up is willing to go. So the price is set by the SECOND-best bidder,
 * not the best. A star nominated while three rivals are broke goes cheap no
 * matter how good he is — and that is precisely the moment a static value chart
 * cannot see, and this engine can.
 */
export function forecastPrice(player, par, state, infl) {
  const base = par * infl;
  const rivals = [];
  state.teams.forEach((t) => {
    if (t.teamId === state.myTeamId || t.spotsLeft <= 0) return;
    if ((t.counts[player.position] || 0) >= (MAX_AT_POS[player.position] || 4)) return;
    if (t.maxBid < 2) return;
    const wants = t.needs[player.position] ? 1.0 : 0.5;
    rivals.push(Math.min(t.maxBid, base * wants * t.aggression));
  });
  if (!rivals.length) return 1.0;
  rivals.sort((a, b) => b - a);
  const runnerUp = rivals.length === 1 ? rivals[0] : rivals[1];
  return Math.max(1, Math.min(base * 1.6, runnerUp + 1));
}

// ---------------------------------------------------------------------------
// Lineup value and the roster planner
// ---------------------------------------------------------------------------

/**
 * Lineup value from an already-grouped roster.
 *
 * lineupPoints() re-groups and re-sorts the whole roster on every call, and the
 * planner calls it once per board candidate per greedy iteration -- measured at
 * 269,479 calls and 318,498 board-scan iterations for a single targetBoard(),
 * which cost 270-320ms on every render of the Live Draft page.
 *
 * This takes the grouping as given, so the planner can keep one set of sorted
 * per-position arrays and splice a trial player in and out. Same arithmetic,
 * same result to the last decimal -- there is a test pinning that.
 */
function lineupPointsFromGroups(byPos) {
  let total = 0;
  const leftovers = [];
  for (const pos of STARTER_POSITIONS) {
    const list = byPos[pos];
    if (!list || !list.length) continue;
    const n = STARTER_SLOTS[pos];
    const take = n < list.length ? n : list.length;
    for (let i = 0; i < take; i++) total += list[i];
    if (FLEX_SET.has(pos) && list.length > n) {
      for (let i = n; i < list.length; i++) leftovers.push(list[i]);
    }
  }
  leftovers.sort((a, b) => b - a);
  const flex = N_FLEX < leftovers.length ? N_FLEX : leftovers.length;
  for (let i = 0; i < flex; i++) total += leftovers[i];
  for (let i = N_FLEX; i < leftovers.length; i++) {
    total += leftovers[i] * BENCH_WEIGHT * Math.pow(0.75, i - N_FLEX);
  }
  return total;
}

/** Insert into a descending array, keeping it sorted. Returns the index used. */
function insertDesc(list, value) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] > value) lo = mid + 1; else hi = mid;
  }
  list.splice(lo, 0, value);
  return lo;
}

const STARTER_POSITIONS = Object.keys(STARTER_SLOTS);
const FLEX_SET = new Set(FLEX_POS);

/** Projected points from the lineup a roster can actually field. */
export function lineupPoints(roster) {
  const byPos = {};
  roster.forEach((p) => {
    (byPos[p.position] = byPos[p.position] || []).push(seasonPoints(p));
  });
  Object.keys(byPos).forEach((k) => byPos[k].sort((a, b) => b - a));

  let total = 0;
  const leftovers = [];
  Object.keys(STARTER_SLOTS).forEach((pos) => {
    const list = byPos[pos] || [];
    const n = STARTER_SLOTS[pos];
    for (let i = 0; i < n && i < list.length; i++) total += list[i];
    if (FLEX_POS.includes(pos)) leftovers.push(...list.slice(n));
  });
  leftovers.sort((a, b) => b - a);
  for (let i = 0; i < N_FLEX && i < leftovers.length; i++) total += leftovers[i];
  // Bench depth pays off through byes and injuries, but with sharply
  // diminishing returns — it must never outbid a starting slot.
  leftovers.slice(N_FLEX).forEach((v, i) => { total += v * BENCH_WEIGHT * Math.pow(0.75, i); });
  return total;
}

/**
 * The best roster still realistically attainable: greedily buy whichever player
 * adds the most starting-lineup value per dollar at his forecast price, until
 * the roster is full.
 *
 * This is the quantity every recommendation is derived from. Because it prices
 * future players at what they will really cost in THIS room, the resulting bid
 * ceiling tightens when money is tight and loosens when it is not.
 */
export function planValue(roster, budget, spots, board, extra, detail) {
  const have = extra ? roster.concat([extra]) : roster.slice();
  const counts = {};
  have.forEach((p) => { counts[p.position] = (counts[p.position] || 0) + 1; });
  const used = new Set(have.map((p) => p.id));
  const bought = [];
  let spend = 0;

  // One set of sorted per-position arrays, carried across the whole greedy
  // loop. Trying a candidate is a splice in and a splice out rather than a
  // rebuild of the entire roster.
  const byPos = {};
  have.forEach((p) => {
    (byPos[p.position] = byPos[p.position] || []).push(seasonPoints(p));
  });
  Object.keys(byPos).forEach((k) => byPos[k].sort((a, b) => b - a));

  let cash = budget;
  let slots = spots;
  let current = lineupPointsFromGroups(byPos);

  while (slots > 0) {
    const afford = cash - (slots - 1);
    if (afford < 1) break;

    let best = null, bestRatio = 0, bestPrice = 1, bestGain = 0;
    for (let i = 0; i < board.length; i++) {
      const { player, price } = board[i];
      if (used.has(player.id)) continue;
      if ((counts[player.position] || 0) >= (MAX_AT_POS[player.position] || 4)) continue;
      const px = Math.max(1, price);
      // A player you cannot afford is not an option. Clamping his price down to
      // whatever cash is left would let the plan "buy" a $50 stud for $1, which
      // makes the budget irrelevant and drives every bid ceiling to the maximum.
      if (px > afford) continue;

      const list = byPos[player.position] || (byPos[player.position] = []);
      const at = insertDesc(list, seasonPoints(player));
      const gain = lineupPointsFromGroups(byPos) - current;
      list.splice(at, 1);

      if (gain <= 0) continue;
      const ratio = gain / px;
      if (ratio > bestRatio) {
        best = player; bestRatio = ratio; bestPrice = px; bestGain = gain;
      }
    }
    if (!best) break;
    have.push(best);
    insertDesc(byPos[best.position] || (byPos[best.position] = []), seasonPoints(best));
    used.add(best.id);
    counts[best.position] = (counts[best.position] || 0) + 1;
    cash -= bestPrice;
    spend += bestPrice;
    slots -= 1;
    current += bestGain;
    bought.push({ player: best, price: Math.round(bestPrice) });
  }
  // Any slots the plan could not afford still cost $1 each to fill.
  spend += Math.max(0, slots);
  return detail ? { value: current, spend: Math.round(spend), bought } : current;
}

/**
 * Money that must be held back to fill the starting slots still open.
 *
 * The planner maximises points, and once your starters and flex are set, every
 * further dollar can only buy bench -- worth a fraction of a starter. That makes
 * leftover cash look almost worthless, so the planner would cheerfully pay $28
 * for a fourth receiver worth 26 bench points while a starting quarterback slot
 * sat empty. It is not wrong about the points; it is blind to the risk that
 * prices move before you get back to that hole.
 *
 * So: read the plan's own shopping list, and ring-fence whatever it earmarked
 * for slots you still have to start someone in. A player who fills none of those
 * slots may only bid what is left over.
 */
export function starterReserve(me, board) {
  const plan = planValue(me.roster, me.budget, me.spotsLeft, board, null, true);
  const counts = { ...me.counts };
  let reserve = 0;
  let n = 0;
  plan.bought.forEach(({ player, price }) => {
    const pos = player.position;
    const cap = STARTER_SLOTS[pos] || 0;
    const flexCap = FLEX_POS.includes(pos) ? N_FLEX : 0;
    // Counts a flex-eligible buy as filling a starting slot only while the
    // combined starter+flex allowance is unfilled.
    if ((counts[pos] || 0) < cap + flexCap) {
      reserve += price;
      n += 1;
    }
    counts[pos] = (counts[pos] || 0) + 1;
  });
  return { reserve, slots: n };
}

/** Does this player fill a starting slot I have not filled yet? */
function fillsStarterSlot(me, player) {
  return Boolean(me.needs[player.position]);
}

// ---------------------------------------------------------------------------
// The recommendation
// ---------------------------------------------------------------------------

/**
 * Full live recommendation for a nominated player at the current bid.
 *
 * Returns everything the interface needs: ceiling, action, Must Buy flag,
 * confidence, reasoning, budget after winning, budget still required to fill the
 * roster, and the tradeoff winning would create.
 *
 * Safe to call on every keystroke — it recomputes from scratch, and the cheap
 * end of the board short-circuits before the planner runs.
 */
export function recommendBid(league, player, currentBid = 0, options = {}) {
  const db = league.playerDatabase || {};
  const startBudget = options.startingBudget || 200;

  const draftedIds = new Set((league.draftState?.selections || []).map((s) => s.playerId));
  const available = Object.values(db).filter((p) => !draftedIds.has(p.id));

  // Values first, then state: the state needs par to score how aggressively
  // each manager has been bidding, and par needs the league size and roster
  // size that a bare state carries. Build a cheap state to price with, then a
  // full one that knows what everyone paid.
  const shell = buildLeagueState(league);
  const par = parValues(available, shell, startBudget);
  const parById = new Map(available.map((p, i) => [p.id, par[i]]));
  // Sold players still need a price for the aggression read.
  const soldPar = parValues(Object.values(db), shell, startBudget);
  Object.values(db).forEach((p, i) => {
    if (!parById.has(p.id)) parById.set(p.id, soldPar[i]);
  });

  const state = buildLeagueState(league, parById);
  const me = state.me;
  // If the draft room told us the most we may bid, trust it over our own
  // budget arithmetic -- it accounts for league rules we cannot see.
  const roomMax = league.draftState?.currentNominationMax;
  if (typeof roomMax === 'number' && roomMax >= 0 && roomMax < me.maxBid) {
    me.maxBid = roomMax;
  }

  const remainingPar = par.reduce((a, b) => a + b, 0);
  const infl = marketInflation(state, remainingPar);
  const myPar = parById.get(player.id) || 1;
  const price = forecastPrice(player, myPar, state, infl);

  const base = {
    player,
    currentBid,
    expectedPrice: Math.round(price),
    inflation: Number(infl.toFixed(2)),
    budgetRemaining: me.budget,
    spotsLeft: me.spotsLeft,
  };

  if (me.spotsLeft <= 0 || me.maxBid < 1) {
    return { ...base, action: 'EXIT', maxBid: 0, recommendedBid: 0, mustBuy: false, confidence: 'high',
      reason: 'Your roster is full.', lossIfMissed: 0, budgetAfterWin: me.budget,
      budgetToCompleteRoster: 0, tradeoff: '' };
  }
  if ((me.counts[player.position] || 0) >= (MAX_AT_POS[player.position] || 4)) {
    return { ...base, action: 'EXIT', maxBid: 0, recommendedBid: 0, mustBuy: false, confidence: 'high',
      reason: `You already roster the maximum at ${player.position}.`, lossIfMissed: 0,
      budgetAfterWin: me.budget, budgetToCompleteRoster: me.spotsLeft, tradeoff: '' };
  }

  // Cheap end of the board: many interchangeable players, no planning required.
  if (myPar * infl < 4 && !me.needs[player.position]) {
    const ceiling = Math.max(1, Math.round(myPar * infl));
    return { ...base, action: currentBid >= ceiling ? 'EXIT' : 'BID', maxBid: ceiling,
      recommendedBid: ceiling, mustBuy: false, confidence: 'high',
      reason: 'Replacement-level filler — there are many like him left.',
      lossIfMissed: 0, budgetAfterWin: me.budget - Math.max(1, currentBid + 1),
      budgetToCompleteRoster: Math.max(0, me.spotsLeft - 1), tradeoff: '' };
  }

  // Board the planner will shop from, priced at what it will really cost.
  // It needs the cheap tail as well as the stars: real rosters are finished off
  // with $1-3 players, and a board of nothing but studs leaves the planner
  // unable to fill a roster at all.
  const ranked = available
    .map((p, i) => ({ player: p, par: par[i] }))
    .sort((a, b) => b.par - a.par);
  const picked = ranked.slice(0, PLAN_CANDIDATES);
  // Taking the top N by par alone leaves the planner unable to fill a slot whose
  // whole position is cheap. Every kicker and defense prices near the $1 floor,
  // so none of them made the cut -- and a planner that cannot see a SECOND
  // defense concludes the nominated one is irreplaceable and will pay anything
  // for him. Guarantee a few bodies at every position the lineup requires.
  const seen = new Set(picked.map((b) => b.player.id));
  const onBoard = {};
  picked.forEach((b) => { onBoard[b.player.position] = (onBoard[b.player.position] || 0) + 1; });
  Object.keys(STARTER_SLOTS).forEach((pos) => {
    // Only backfill a position the board cannot already staff. Topping up
    // positions that are well represented would change what the planner buys
    // everywhere, which is not the problem being solved here.
    const want = (STARTER_SLOTS[pos] || 1) + 2;
    const short = want - (onBoard[pos] || 0);
    if (short <= 0) return;
    ranked.filter((b) => b.player.position === pos && !seen.has(b.player.id))
      .slice(0, short)
      .forEach((b) => { picked.push(b); seen.add(b.player.id); });
  });
  const board = picked
    .map(({ player: p, par: v }) => ({ player: p, price: forecastPrice(p, v, state, infl) }));

  // Losing him means he is off the board entirely -- so both sides of the
  // comparison must shop from a board without him. Leaving him in the baseline
  // would quietly assume we can still buy him later, which collapses every
  // ceiling to zero: passing would cost nothing.
  const boardMinus = board.filter((b) => b.player.id !== player.id);

  const planMissing = planValue(me.roster, me.budget, me.spotsLeft, boardMinus);
  const planIfWon = (x) => (x > me.maxBid
    ? -Infinity
    : planValue(me.roster, me.budget - x, me.spotsLeft - 1, boardMinus, player));

  // Walk-away price: the most I can pay and still be better off than passing.
  let maxBid = 0;
  if (planIfWon(1) >= planMissing) {
    let lo = 1, hi = Math.floor(me.maxBid);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (planIfWon(mid) >= planMissing) lo = mid; else hi = mid - 1;
    }
    maxBid = lo;
  }

  // What he is actually worth to this roster: the gain from landing him at the
  // forecast price rather than losing him.
  const atMarket = Math.max(1, Math.min(Math.round(price), Math.floor(me.maxBid)));
  const lossIfMissed = Math.max(0, planIfWon(atMarket) - planMissing);

  // Steer toward the holes. If he starts for me, nothing is held back. If he
  // would ride the bench while a starting slot is still open, he may only have
  // the money that slot does not need.
  const fillsSlot = fillsStarterSlot(me, player);
  // Only steer while there is somewhere to steer TO. Once every starting slot
  // is filled, leftover money SHOULD go to the best bench available, and
  // clamping it to market would leave you tying every auction and finishing
  // with a row of $1 players.
  // A hole only counts if the board can actually fill it. When the projection
  // set held no kickers or defenses, those two slots were permanently open, so
  // this stayed true for the entire draft and the cap never lifted. Guarding on
  // what is actually available means an incomplete import cannot silently
  // re-arm it.
  const fillable = new Set(available.map((p) => p.position));
  const hasHoles = Object.keys(me.needs).some((pos) => fillable.has(pos));
  let luxuryCap = null;
  if (!fillsSlot && hasHoles) {
    const { reserve, slots } = starterReserve(me, boardMinus);
    // $1 apiece for the bench slots that remain after this buy and the reserved
    // ones. The reserve carries a margin because a forecast price is not a
    // guaranteed price -- if the room bids the last starting tight end past the
    // forecast and the money is already spent on a fourth receiver, the slot
    // stays empty all season.
    const otherSpots = Math.max(0, me.spotsLeft - 1 - slots);
    const affordCap = Math.max(0, me.budget - reserve * STARTER_MARGIN - otherSpots);
    // And never outbid the room for bench depth while a starting slot is open.
    // Depth is worth having at a discount and worth nothing at a premium.
    luxuryCap = Math.min(affordCap, Math.round(price));
    maxBid = Math.min(maxBid, luxuryCap);
  }

  // Price him against his substitute. The planner values a roster, not a player,
  // and once your starters are set it sees leftover money as nearly worthless --
  // so it would hand a whole budget to whoever filled the last slot, even a
  // defense with an all-but-identical one behind him. The market disagrees: a
  // dollar buys points at a known rate, so paying over the substitute's price is
  // only worth the upgrade it actually buys.
  const rate = pointsPerDollar(available, shell, startBudget);
  const alt = boardMinus
    .filter((b) => b.player.position === player.position)
    .sort((a, b) => seasonPoints(b.player) - seasonPoints(a.player))[0];
  if (alt && rate > 0) {
    const upgrade = Math.max(0, seasonPoints(player) - seasonPoints(alt.player));
    const subCap = Math.ceil(alt.price + upgrade / rate);
    maxBid = Math.min(maxBid, Math.max(1, subCap));
  }

  const mustBuyThreshold = options.mustBuyPoints || MUST_BUY_POINTS;
  const mustBuy = lossIfMissed >= mustBuyThreshold && maxBid >= Math.max(2, price * 0.8);
  if (mustBuy) {
    // A Must Buy earns a premium over par — but never past the point where the
    // rest of the roster collapses, which me.maxBid already guards.
    maxBid = Math.min(Math.floor(me.maxBid), Math.floor(maxBid * 1.15) + 1);
    if (luxuryCap !== null) maxBid = Math.min(maxBid, luxuryCap);
  }

  // If the walk-away price is already below what the player will sell for, you
  // are not going to win him at a price worth paying. Saying BID there -- which
  // it did whenever the current bid was zero -- invites you into an auction you
  // should be sitting out.
  const willBeOutbid = maxBid > 0 && price > maxBid;

  let action;
  if (maxBid <= 0 || currentBid >= maxBid) action = 'EXIT';
  else if (willBeOutbid) action = 'PASS';
  else if (mustBuy || currentBid < price * 0.85) action = 'BID';
  else action = 'HOLD';

  const winPrice = Math.max(1, currentBid + 1);
  const budgetAfterWin = me.budget - winPrice;
  const spotsAfter = Math.max(0, me.spotsLeft - 1);
  const perSlot = spotsAfter > 0 ? (budgetAfterWin - spotsAfter) / spotsAfter : 0;

  // What the rest of the roster is forecast to cost if we win at this price.
  const after = planValue(me.roster.concat([player]), budgetAfterWin, spotsAfter,
                          boardMinus, null, true);
  const costToFinish = after.spend;

  let reason;
  if (mustBuy) {
    reason = `Losing ${player.name} costs about ${Math.round(lossIfMissed)} lineup points and `
      + `nothing comparable is left at ${player.position}.`;
  } else if (luxuryCap !== null) {
    const open = Object.keys(me.needs).join(', ');
    reason = `Your ${player.position} starters and flex are set — he is bench depth, `
      + `and you still have to start ${open}. Take him at $${luxuryCap} or below, not above.`;
  } else if (willBeOutbid) {
    reason = `He is worth $${maxBid} to you and the room will pay about $${Math.round(price)}. `
      + `Let him go — the difference buys more elsewhere.`;
  } else if (maxBid <= 1) {
    reason = `Replacement level at ${player.position} is close behind — your money does more elsewhere.`;
  } else {
    reason = `Worth up to $${maxBid}. Market forecast is $${Math.round(price)} `
      + `with inflation running ${infl.toFixed(2)}x.`;
  }

  const spread = Math.abs(maxBid - price) / Math.max(1, price);
  const confidence = spread > 0.35 ? 'high' : spread > 0.15 ? 'medium' : 'low';

  let tradeoff = '';
  if (spotsAfter > 0 && perSlot < 3 && maxBid > 10) {
    tradeoff = `Winning at $${winPrice} leaves about $${Math.max(0, Math.round(perSlot))} per `
      + `remaining slot — you would fill ${spotsAfter} spots at replacement level.`;
  } else if (mustBuy && maxBid > price * 1.2) {
    tradeoff = `Paying above market here is justified, but it removes your flexibility to chase `
      + `another premium starter later.`;
  }

  // The ceiling is a walk-away price: pay exactly that and you have gained
  // nothing. What you should actually put in right now is the least that still
  // wins — the market forecast plus a nudge. The ceiling stays in reserve for
  // Must Buys, where losing the player is the expensive outcome.
  // Opening at your walk-away price is never right: it captures no surplus and
  // it is the number you should be prepared to stop at, not start at. Bid the
  // least that still wins -- and bid nothing at all when the market is already
  // past your ceiling, which is why these two used to collapse onto the same
  // figure and look like a bug.
  // What to put in RIGHT NOW is always the least that still wins. Must Buy
  // raises the ceiling -- the point at which you stop -- it does not mean you
  // should open at your maximum. Setting the two equal made them read as one
  // number and told you to bid your walk-away price on the first shout, which
  // hands the entire surplus to the seller.
  let recommendedBid;
  if (maxBid <= 0 || willBeOutbid) {
    recommendedBid = 0;
  } else if (luxuryCap !== null) {
    // Depth you want only if it falls to you. Jumping the bid to just above
    // market is how you win a player -- exactly what you should not do while a
    // starting slot is still open. Stay in a dollar at a time instead.
    recommendedBid = Math.max(1, Math.min(Math.floor(maxBid), currentBid + 1));
  } else {
    const nextUp = Math.max(currentBid + 1, Math.round(price * 1.05) + 1);
    recommendedBid = Math.max(1, Math.min(Math.floor(maxBid), nextUp));
  }

  return {
    ...base,
    action,
    maxBid: Math.floor(maxBid),
    recommendedBid: maxBid > 0 ? recommendedBid : 0,
    mustBuy,
    confidence,
    reason,
    lossIfMissed: Math.round(lossIfMissed),
    budgetAfterWin,
    spotsAfterWin: spotsAfter,
    budgetToCompleteRoster: costToFinish,
    affordable: costToFinish <= budgetAfterWin,
    tradeoff,
  };
}

/**
 * Rank every available player by how badly this roster needs him right now.
 * Drives the Must Buy watchlist so the user can see what is coming before it is
 * nominated.
 */
export function targetBoard(league, limit = 8, options = {}) {
  const db = league.playerDatabase || {};
  const draftedIds = new Set((league.draftState?.selections || []).map((s) => s.playerId));
  const available = Object.values(db).filter((p) => !draftedIds.has(p.id));
  const state = buildLeagueState(league);
  if (state.me.spotsLeft <= 0) return [];

  const par = parValues(available, state, options.startingBudget || 200);
  const shortlist = available
    .map((p, i) => ({ p, v: par[i] }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 20)
    .map(({ p }) => p);

  return shortlist
    .map((p) => {
      const rec = recommendBid(league, p, 0, options);
      return { player: p, maxBid: rec.maxBid, mustBuy: rec.mustBuy,
               expectedPrice: rec.expectedPrice, lossIfMissed: rec.lossIfMissed };
    })
    .filter((r) => r.maxBid > 1)
    .sort((a, b) => (b.mustBuy - a.mustBuy) || (b.lossIfMissed - a.lossIfMissed))
    .slice(0, limit);
}
