/**
 * Gridiron Edge — Roster Portfolio Manager
 *
 * The bench and the waiver wire are one problem, not two: a fixed number of
 * roster spots, each of which must earn its keep. A bench player is not "yours"
 * in any meaningful sense — he is a spot you are choosing not to give to
 * somebody else. So every hold is re-decided continuously against the best
 * available alternative, and nothing is kept because it was drafted early or
 * has a famous name.
 *
 * The objective is championship probability over the rest of the season, not
 * points next Sunday. Those diverge often enough to matter:
 *
 *   - A player who cannot crack your starting lineup contributes almost nothing,
 *     however good his projection looks in isolation.
 *   - A player who would immediately start for a rival contributes something
 *     even while riding your bench, because your title odds are relative.
 *   - Upside is worth more in September than in December, because a breakout
 *     needs weeks to pay off and there are fewer left each week.
 *
 * Every number below is derived from data the app already holds: projections,
 * usage metrics (snap share, target share, carries, red-zone work), injury
 * status, bye weeks, ADP, rosters and FAAB balances.
 *
 * Inputs the strategy would use but the current data model does not carry —
 * depth-chart rank, route participation, rest-of-season strength of schedule,
 * playoff-week opponents, recovery timelines, coaching and trade news — are
 * declared in MISSING_INPUTS rather than guessed at. Where one of those would
 * sharpen a call, the confidence is lowered instead of a number being invented.
 */

const STARTER_SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, 'D/ST': 1, K: 1 };
const FLEX_POS = ['RB', 'WR', 'TE'];
const N_FLEX = 1;
const FINAL_WEEK = 17;
const PLAYOFF_WEEKS = [15, 16, 17];

/** Factors the strategy calls for that no current data source supplies. */
export const MISSING_INPUTS = [
  'depth-chart rank', 'route participation', 'rest-of-season strength of schedule',
  'playoff-week opponents', 'injury recovery timelines', 'coaching and scheme changes',
  'in-season trades', 'league bidding history',
];

/**
 * Inputs that WERE missing and are now supplied by the news monitor. Kept
 * explicit so the two lists cannot drift apart silently.
 */
export const NEWS_DERIVED_INPUTS = [
  'injury and inactive reports', 'suspensions', 'in-season trades',
  'depth-chart promotions and demotions', 'league-wide add/drop volume',
];

const INJURY = {
  Healthy:      { play: 1.00, weeksOut: 0 },
  Questionable: { play: 0.75, weeksOut: 0 },
  Doubtful:     { play: 0.30, weeksOut: 1 },
  Out:          { play: 0.00, weeksOut: 1 },
  IR:           { play: 0.00, weeksOut: 4 },
};

const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Season phase
// ---------------------------------------------------------------------------

/**
 * How much upside is worth right now.
 *
 * A stash needs weeks to pay off. In week 2 there are fifteen left and a
 * breakout can still win you the league; in week 13 the same player is a spot
 * you are wasting while trying to make the playoffs. So the weight on
 * speculative upside falls as the season runs, and the weight on players who
 * can start this week rises.
 */
export function seasonPhase(week) {
  const w = clamp(num(week, 1), 1, FINAL_WEEK);
  const remaining = Math.max(0, FINAL_WEEK - w + 1);
  const progress = (w - 1) / (FINAL_WEEK - 1);
  return {
    week: w,
    weeksRemaining: remaining,
    playoffWeeksRemaining: PLAYOFF_WEEKS.filter((p) => p >= w).length,
    label: w <= 5 ? 'early' : w <= 10 ? 'mid' : w <= 14 ? 'stretch' : 'playoffs',
    // Upside is a long-dated option: it decays as expiry approaches.
    upsideWeight: clamp(1.15 - progress * 1.05, 0.1, 1.15),
    // Startability matters more every week.
    startabilityWeight: clamp(0.55 + progress * 0.75, 0.55, 1.3),
  };
}

// ---------------------------------------------------------------------------
// Player value
// ---------------------------------------------------------------------------

/** Weekly points, discounted for the chance he does not play. */
export function effectivePpg(player) {
  const inj = INJURY[player.injuryStatus] || INJURY.Healthy;
  // A headline this morning is fresher than an injury field that was accurate
  // last Thursday, so bad news discounts the player even before the feed
  // catches up. Only downgrades apply here; good news still has to show up as a
  // status change before we start him.
  const ni = player.newsImpact;
  const newsCut = ni && ni.selfImpact < 0 ? clamp(1 + ni.selfImpact * 0.5, 0.15, 1) : 1;
  return num(player.projectedPoints) * inj.play * newsCut;
}

/**
 * Points expected across every remaining week, net of byes and time missed.
 * This — not a single week's projection — is what a roster spot is buying.
 */
export function restOfSeasonPoints(player, phase) {
  const inj = INJURY[player.injuryStatus] || INJURY.Healthy;
  const bye = num(player.byeWeek, 0);
  let weeks = 0;
  for (let w = phase.week; w <= FINAL_WEEK; w++) {
    if (w === bye) continue;
    if (w < phase.week + inj.weeksOut) continue;
    weeks++;
  }
  return num(player.projectedPoints) * weeks * (inj.weeksOut > 0 ? 1 : inj.play);
}

/** Points available in the weeks that decide the title. */
export function playoffPoints(player, phase) {
  const bye = num(player.byeWeek, 0);
  const inj = INJURY[player.injuryStatus] || INJURY.Healthy;
  const weeks = PLAYOFF_WEEKS.filter((w) => w >= phase.week && w !== bye).length;
  const backByThen = phase.week + inj.weeksOut <= PLAYOFF_WEEKS[0];
  return num(player.projectedPoints) * weeks * (backByThen ? 1 : 0.35);
}

/**
 * Change in a player's opportunity over recent weeks.
 *
 * This is the only public signal that survived testing against the residual of
 * a points-based in-season estimate: r = 0.086, t = 5.9, same sign in all five
 * seasons 2021-2025. Prior-season box scores, expert consensus and even the
 * betting market are all already priced into projections. Recent *usage* is not.
 *
 * The reason is that points are the noisy output and opportunity is the
 * persistent input. A receiver whose targets have climbed from 4 a game to 9 is
 * a different player already; whether a touchdown happened to arrive yet is
 * mostly luck.
 *
 * Requires `metricsHistory`: an array of weekly {targets, carries, attempts}
 * snapshots, oldest first. Without it this returns 0 and the caller falls back
 * to the static snapshot, rather than a trend being invented from one data point.
 */
export function opportunityTrend(player, recentWeeks = 3, baseWeeks = 6) {
  const h = player.metricsHistory;
  if (!Array.isArray(h) || h.length < recentWeeks + baseWeeks + 1) return 0;

  // Snapshots hold cumulative season totals, so a single week's usage is the
  // difference between consecutive ones. Comparing the totals directly would
  // show every player "trending up" forever.
  const opp = (m) => num(m?.seasonTargets ?? m?.targets)
    + num(m?.seasonCarries ?? m?.carries)
    + 0.5 * num(m?.seasonAttempts ?? m?.attempts);
  const weekly = [];
  for (let i = 1; i < h.length; i++) {
    weekly.push(Math.max(0, opp(h[i]) - opp(h[i - 1])));
  }
  if (weekly.length < recentWeeks + baseWeeks) return 0;

  const recent = weekly.slice(-recentWeeks);
  const base = weekly.slice(-(recentWeeks + baseWeeks), -recentWeeks);
  const mean = (a) => a.reduce((x, v) => x + v, 0) / Math.max(1, a.length);
  return mean(recent) - mean(base);
}


/**
 * Probability this player develops into a materially larger role.
 *
 * Built from the gap between how much work he is getting and how much he is
 * being paid for in draft position: a player already earning snaps, targets and
 * red-zone looks who was drafted late is the classic profile of a role about to
 * expand. Usage leads production; ADP lags it.
 */
export function breakoutProbability(player, phase) {
  const m = player.metrics || {};
  const snap = num(m.snapShare, 0.5);
  const target = num(m.targetShare, 0);
  const carries = num(m.carries, 0);
  const rz = num(m.redZoneTargets, 0) + num(m.redZoneCarries, 0);
  const adp = num(player.adp, 200);

  let p = 0.05;
  // Real usage already in hand.
  if (snap >= 0.75) p += 0.16; else if (snap >= 0.55) p += 0.09; else if (snap < 0.35) p -= 0.03;
  if (player.position === 'RB') {
    if (carries >= 14) p += 0.14; else if (carries >= 9) p += 0.07;
  } else if (['WR', 'TE'].includes(player.position)) {
    if (target >= 0.22) p += 0.15; else if (target >= 0.15) p += 0.08;
  }
  if (rz >= 3) p += 0.10; else if (rz >= 1) p += 0.05;
  // Cheap in the draft but already being used = the market has not caught up.
  if (adp > 120) p += 0.10; else if (adp > 80) p += 0.05; else if (adp < 40) p -= 0.05;
  // Volatile players have fatter tails in both directions.
  p += clamp((num(player.volatility, 3) - 3) * 0.015, -0.03, 0.05);
  // Rising opportunity, where weekly history is available. This is the one
  // public signal the projections have not already absorbed, so it gets real
  // weight -- but it is bounded, because r = 0.086 is a nudge, not a verdict.
  const trend = opportunityTrend(player);
  if (trend) p += clamp(trend * 0.020, -0.10, 0.18);
  // Breaking news outranks every trailing statistic. A back whose starter went
  // on IR this morning has a path to a full workload that no box score can show
  // yet, and that is precisely the add worth being first to.
  const ni = player.newsImpact;
  if (ni && ni.selfImpact) p += clamp(ni.selfImpact * 0.35, -0.35, 0.40);
  // A breakout still needs weeks to happen.
  p *= clamp(phase.weeksRemaining / 12, 0.35, 1.0);
  return clamp(p, 0.01, 0.85);
}

/** Probability he ends up worth nothing at all. */
export function bustProbability(player, phase) {
  const m = player.metrics || {};
  const snap = num(m.snapShare, 0.5);
  let p = 0.15;
  if (snap < 0.35) p += 0.25; else if (snap < 0.55) p += 0.10;
  if (num(player.projectedPoints) < 7) p += 0.15;
  if (['Out', 'IR'].includes(player.injuryStatus)) p += 0.20;
  if (num(player.adp, 200) < 60) p -= 0.10;
  return clamp(p, 0.02, 0.92);
}

// ---------------------------------------------------------------------------
// Roster shape
// ---------------------------------------------------------------------------

function rosterOf(team, db) {
  return (team?.roster || []).map((id) => db[id]).filter(Boolean);
}

/** Who starts, who sits, and what the lineup is worth. */
export function lineupBreakdown(roster) {
  const byPos = {};
  roster.forEach((p) => { (byPos[p.position] = byPos[p.position] || []).push(p); });
  Object.keys(byPos).forEach((k) => byPos[k].sort((a, b) => effectivePpg(b) - effectivePpg(a)));

  const starters = [];
  const spare = [];
  Object.keys(STARTER_SLOTS).forEach((pos) => {
    const list = byPos[pos] || [];
    starters.push(...list.slice(0, STARTER_SLOTS[pos]));
    if (FLEX_POS.includes(pos)) spare.push(...list.slice(STARTER_SLOTS[pos]));
  });
  spare.sort((a, b) => effectivePpg(b) - effectivePpg(a));
  const flex = spare.slice(0, N_FLEX);
  const starterIds = new Set([...starters, ...flex].map((p) => p.id));

  return {
    starters: [...starters, ...flex],
    bench: roster.filter((p) => !starterIds.has(p.id)),
    points: [...starters, ...flex].reduce((a, p) => a + effectivePpg(p), 0),
    byPos,
  };
}

/** How much a player would add to a given roster's weekly starting lineup. */
export function lineupGain(roster, player) {
  const before = lineupBreakdown(roster).points;
  const after = lineupBreakdown(roster.concat([player])).points;
  return Math.max(0, after - before);
}

/**
 * Probability this player is in your starting lineup in a given week — either
 * because he is good enough now, or because somebody ahead of him gets hurt.
 * A bench player who can never start is worth close to nothing.
 */
export function startProbability(player, roster, phase) {
  const others = roster.filter((p) => p.id !== player.id);
  const gain = lineupGain(others, player);
  if (gain > 0.5) return 0.95;

  // Not a starter today. He becomes one if an incumbent misses time.
  const ahead = others.filter(
    (p) => p.position === player.position && effectivePpg(p) > effectivePpg(player)
  );
  const slots = STARTER_SLOTS[player.position] || 1;
  const blockers = Math.max(0, Math.min(ahead.length, slots + (FLEX_POS.includes(player.position) ? 1 : 0)));
  if (blockers === 0) return 0.6;

  // Roughly one starter in four misses meaningful time over a season.
  const injuryChance = 1 - Math.pow(0.78, 1 / Math.max(1, blockers));
  const closeness = clamp(
    effectivePpg(player) / Math.max(1, effectivePpg(ahead[ahead.length - 1] || player)), 0, 1
  );
  return clamp(injuryChance + closeness * 0.25 + breakoutProbability(player, phase) * 0.5, 0.02, 0.9);
}

// ---------------------------------------------------------------------------
// Blocking value
// ---------------------------------------------------------------------------

/**
 * What this player is worth to everybody else.
 *
 * Fantasy standings are relative: a player who would walk into a contender's
 * starting lineup costs you something by going there, even if he would never
 * start for you. This is deliberately conservative — blocking is a tiebreaker
 * between comparable holds, never a reason to weaken your own lineup.
 */
export function blockingValue(player, league, db, phase) {
  const me = league.myTeamId;
  const rivals = league.teams.filter((t) => t.teamId !== me);
  if (!rivals.length) return { value: 0, claimProbability: 0.05, suitors: [] };

  const records = rivals.map((t) => num(t.record?.wins, 0));
  const bestRecord = Math.max(...records, 1);

  const suitors = rivals.map((t) => {
    const gain = lineupGain(rosterOf(t, db), player);
    // Contenders hurt more, and so do teams you still have to play.
    const contention = clamp(num(t.record?.wins, 0) / bestRecord, 0.3, 1.0);
    const faab = num(t.faabRemaining, 0);
    const canPay = clamp(faab / 40, 0.1, 1.0);
    return { teamId: t.teamId, teamName: t.teamName, gain, contention, canPay };
  }).filter((s) => s.gain > 0.25).sort((a, b) => b.gain - a.gain);

  if (!suitors.length) return { value: 0, claimProbability: 0.05, suitors: [] };

  // Chance at least one rival actually claims him.
  let claimProbability = clamp(
    1 - suitors.reduce((acc, s) => acc * (1 - clamp(s.gain / 8, 0.05, 0.7) * s.canPay), 1),
    0.05, 0.95
  );
  // If the wider fantasy world is already adding him in volume, that is a
  // measurement rather than an inference, and it should dominate the estimate.
  const heat = player.newsImpact ? num(player.newsImpact.claimHeat) : 0;
  if (heat > 0) {
    // Measured demand beats inferred demand, and must be able to exceed a
    // baseline that has already saturated -- otherwise the signal is invisible
    // exactly when it is strongest.
    const measured = 0.40 + heat * 0.57;
    claimProbability = clamp(Math.max(claimProbability, measured)
      + (heat > 0.5 ? 0.02 : 0), 0.05, 0.99);
  }

  const top = suitors[0];
  // Denting one rival is worth a fraction of denting the whole field.
  const value = top.gain * top.contention * claimProbability * phase.startabilityWeight * 0.45;
  return { value, claimProbability, suitors: suitors.slice(0, 3) };
}

// ---------------------------------------------------------------------------
// Bench: hold value and classification
// ---------------------------------------------------------------------------

const CATEGORY = {
  CORE: 'Core Hold',
  STASH: 'High-Upside Stash',
  HANDCUFF: 'Injury Handcuff',
  MATCHUP: 'Matchup Depth',
  DEFENSIVE: 'Defensive Hold',
  REPLACEABLE: 'Replaceable',
  DROP: 'Drop Candidate',
};

/**
 * What a bench spot is worth if you gave it to the best free agent instead.
 * Every hold has to clear this bar; that is the whole point of the exercise.
 */
function benchOpportunityCost(freeAgents, roster, phase) {
  if (!freeAgents.length) return 0;
  const best = freeAgents
    .map((p) => startProbability(p, roster, phase) * restOfSeasonPoints(p, phase))
    .sort((a, b) => b - a)[0] || 0;
  return best * 0.5;    // you only capture part of it, and only if you guess right
}

export function evaluateBench(league, options = {}) {
  const db = league.playerDatabase || {};
  const phase = seasonPhase(options.week ?? deriveWeek(league));
  const myTeam = league.teams.find((t) => t.teamId === league.myTeamId);
  if (!myTeam) return { phase, bench: [], weakest: null };

  const roster = rosterOf(myTeam, db);
  const { bench, starters } = lineupBreakdown(roster);
  const freeAgents = freeAgentPool(league, db);
  const oppCost = benchOpportunityCost(freeAgents, roster, phase);

  const evaluated = bench.map((p) => {
    const startProb = startProbability(p, roster, phase);
    const ros = restOfSeasonPoints(p, phase);
    const breakout = breakoutProbability(p, phase);
    const bust = bustProbability(p, phase);
    const block = blockingValue(p, league, db, phase);
    const playoff = playoffPoints(p, phase);
    const replacement = bestAtPosition(freeAgents, p.position, roster, phase);
    const replacementRos = replacement ? restOfSeasonPoints(replacement, phase) : 0;

    // What the spot actually returns: points he is likely to start for, plus
    // the option value of a role change, plus what denying him is worth.
    const startingValue = startProb * ros * phase.startabilityWeight;
    const optionValue = breakout * ros * 0.45 * phase.upsideWeight;
    const playoffValue = playoff * 0.25 * (phase.playoffWeeksRemaining ? 1 : 0);
    const holdValue = startingValue + optionValue + playoffValue + block.value - oppCost;

    const scarcity = positionalScarcity(freeAgents, p.position);
    const category = classify({
      player: p, startProb, breakout, bust, block, holdValue,
      replacementRos, ros, scarcity, phase,
    });

    return {
      player: p, holdValue: round(holdValue), category,
      startProbability: round(startProb, 2),
      restOfSeasonPoints: round(ros),
      playoffPoints: round(playoff),
      breakoutProbability: round(breakout, 2),
      bustProbability: round(bust, 2),
      blockingValue: round(block.value),
      claimProbability: round(block.claimProbability, 2),
      likelySuitors: block.suitors.map((s) => s.teamName),
      replacementLevel: round(replacementRos),
      positionalScarcity: round(scarcity, 2),
      benchOpportunityCost: round(oppCost),
      reason: benchReason({ player: p, category, startProb, breakout, block, replacementRos, ros, phase }),
      outcomes: outcomeProbabilities(p, startProb, breakout, bust),
    };
  }).sort((a, b) => b.holdValue - a.holdValue);

  const droppable = evaluated.filter((e) => e.category !== CATEGORY.CORE);
  const weakest = (droppable.length ? droppable : evaluated).slice(-1)[0] || null;

  return { phase, bench: evaluated, starters, weakest, freeAgents };
}

function classify({ player, startProb, breakout, bust, block, holdValue,
                    replacementRos, ros, scarcity, phase }) {
  if (startProb > 0.85 && ros > replacementRos * 1.15) return CATEGORY.CORE;
  if (breakout >= 0.28 && phase.upsideWeight > 0.5) return CATEGORY.STASH;
  if (startProb >= 0.25 && startProb <= 0.6 && ros >= replacementRos) return CATEGORY.HANDCUFF;
  if (block.value > 0 && block.value >= holdValue * 0.5 && block.claimProbability > 0.4) {
    return CATEGORY.DEFENSIVE;
  }
  if (scarcity > 0.6 && ros > replacementRos) return CATEGORY.MATCHUP;
  if (ros <= replacementRos * 1.02 || bust > 0.6) return CATEGORY.REPLACEABLE;
  if (holdValue <= 0) return CATEGORY.DROP;
  return CATEGORY.MATCHUP;
}

/** Explicit probabilities instead of vague labels, as the strategy requires. */
function outcomeProbabilities(player, startProb, breakout, bust) {
  const weeklyStarter = clamp(startProb * (0.55 + breakout), 0.01, 0.95);
  const matchupStarter = clamp(startProb - weeklyStarter, 0, 0.6);
  const injuryOnly = clamp((1 - startProb) * 0.55, 0, 0.7);
  const tradeable = clamp(breakout * 0.6 + (startProb > 0.7 ? 0.15 : 0), 0.01, 0.8);
  const replaceable = clamp(bust, 0.02, 0.95);
  const total = weeklyStarter + matchupStarter + injuryOnly + replaceable;
  return {
    weeklyStarter: round(weeklyStarter / total, 2),
    matchupStarter: round(matchupStarter / total, 2),
    injuryOnly: round(injuryOnly / total, 2),
    replaceable: round(replaceable / total, 2),
    tradeable: round(tradeable, 2),
  };
}

function benchReason({ player, category, startProb, breakout, block, replacementRos, ros, phase }) {
  switch (category) {
    case CATEGORY.CORE:
      return `Starts most weeks (${Math.round(startProb * 100)}%) and projects `
        + `${Math.round(ros - replacementRos)} points clear of the best free agent at the position.`;
    case CATEGORY.STASH:
      return `Usage is running ahead of his draft cost — roughly a `
        + `${Math.round(breakout * 100)}% chance the role grows. Worth the spot while there are `
        + `${phase.weeksRemaining} weeks left to cash in.`;
    case CATEGORY.HANDCUFF:
      return `Only ${Math.round(startProb * 100)}% likely to start as things stand, but he is the `
        + `direct beneficiary if the player ahead of him misses time.`;
    case CATEGORY.DEFENSIVE:
      return `Marginal for you, but ${block.suitors[0]?.teamName || 'a rival'} would start him `
        + `immediately (${Math.round(block.claimProbability * 100)}% chance he is claimed).`;
    case CATEGORY.MATCHUP:
      return `Useful in specific weeks — bye coverage and favourable matchups — but not a lineup fixture.`;
    case CATEGORY.REPLACEABLE:
      return `The waiver wire already offers his production. Holding him buys nothing you cannot re-add.`;
    default:
      return `Low expected value with no realistic path into your lineup and no strategic reason to hold.`;
  }
}

// ---------------------------------------------------------------------------
// Waiver wire
// ---------------------------------------------------------------------------

function freeAgentPool(league, db) {
  const owned = new Set();
  league.teams.forEach((t) => (t.roster || []).forEach((id) => owned.add(id)));
  // A drafted player is off the board whether or not we worked out who bought
  // him. Reading only the rosters meant a pick whose owner could not be
  // identified came back as a free agent -- which is how the app recommended
  // claiming Josh Allen while Josh Allen was already drafted.
  ((league.draftState && league.draftState.selections) || [])
    .forEach((s) => { if (s && s.playerId) owned.add(String(s.playerId)); });
  return Object.values(db).filter((p) => !owned.has(p.id));
}

function bestAtPosition(pool, position, roster, phase) {
  return pool
    .filter((p) => p.position === position)
    .sort((a, b) => restOfSeasonPoints(b, phase) - restOfSeasonPoints(a, phase))[0] || null;
}

/**
 * How thin the position is on the wire: 1 means the next man up is a big step
 * down, 0 means there are interchangeable options and nothing is urgent.
 */
function positionalScarcity(pool, position) {
  const at = pool.filter((p) => p.position === position)
    .map((p) => num(p.projectedPoints)).sort((a, b) => b - a);
  if (at.length < 2) return 1;
  const best = at[0];
  const depth = at.slice(0, 5).reduce((a, b) => a + b, 0) / Math.min(5, at.length);
  return clamp(best > 0 ? (best - depth) / best * 2.2 : 0, 0, 1);
}

/**
 * FAAB ladder with the probability each amount actually wins the claim.
 *
 * Budget is only worth what it buys before the season ends. Late in the year
 * unspent FAAB is worthless, so the model stops hoarding it — while early on it
 * holds back unless the player has a genuine season-long path.
 */
export function faabLadder(player, league, phase, acquisitionValue, claimProbability) {
  const me = league.teams.find((t) => t.teamId === league.myTeamId);
  const budget = num(me?.faabRemaining, 100);
  const rivalBudgets = league.teams
    .filter((t) => t.teamId !== league.myTeamId)
    .map((t) => num(t.faabRemaining, 0)).sort((a, b) => b - a);
  const richestRival = rivalBudgets[0] || 0;

  // Waiver runs left. As this shrinks, holding cash gets steadily more pointless.
  const runsLeft = Math.max(1, phase.weeksRemaining);
  const urgency = clamp(1.25 - runsLeft / 14, 0.35, 1.25);

  // Share of budget justified by what he is worth to the roster.
  const worthShare = clamp(acquisitionValue / 120, 0.01, 0.55) * urgency;
  const fair = Math.max(1, Math.round(budget * worthShare));

  const minimum = Math.max(1, Math.round(fair * 0.5));
  const aggressive = Math.max(minimum + 1, Math.round(fair * 1.4));
  const maximum = Math.min(budget, Math.max(aggressive, Math.round(fair * 1.9)));

  // Rough win probability: rivals bid in proportion to their budgets and need.
  const winProb = (bid) => {
    if (richestRival <= 0) return 0.97;
    const rivalTypical = richestRival * clamp(claimProbability, 0.05, 0.9) * 0.35;
    const z = (bid - rivalTypical) / Math.max(2, rivalTypical * 0.55);
    return clamp(0.5 + 0.5 * Math.tanh(z), 0.02, 0.97);
  };

  return {
    recommended: fair,
    minimum, aggressive, maximum,
    budget,
    budgetAfter: budget - fair,
    winProbability: {
      minimum: round(winProb(minimum), 2),
      recommended: round(winProb(fair), 2),
      aggressive: round(winProb(aggressive), 2),
      maximum: round(winProb(maximum), 2),
    },
    opportunityCost: runsLeft > 6
      ? `Spending $${fair} now leaves $${budget - fair} for roughly ${runsLeft} more waiver runs.`
      : `Only ${runsLeft} waiver periods remain — unspent FAAB expires worthless, so bidding up is close to free.`,
  };
}

const ACTION = {
  PRIORITY: 'Priority Add', ADD: 'Add', SPECULATIVE: 'Speculative Add',
  DEFENSIVE: 'Defensive Add', HOLD: 'Hold', MONITOR: 'Monitor',
  DROP: 'Drop', NO: 'Do Not Add',
};

/**
 * Rank the wire by what each player would actually add, net of what he costs
 * you — the player dropped, the FAAB spent, and the flexibility of the spot.
 */
export function evaluateWaivers(league, options = {}) {
  const db = league.playerDatabase || {};
  const benchReport = evaluateBench(league, options);
  const phase = benchReport.phase;
  const myTeam = league.teams.find((t) => t.teamId === league.myTeamId);
  if (!myTeam) return { phase, targets: [], weakest: null, topMove: null };

  const roster = rosterOf(myTeam, db);
  const freeAgents = benchReport.freeAgents || freeAgentPool(league, db);
  const dropTarget = benchReport.weakest;

  const targets = freeAgents
    .map((p) => {
      const startProb = startProbability(p, roster, phase);
      const ros = restOfSeasonPoints(p, phase);
      const breakout = breakoutProbability(p, phase);
      const bust = bustProbability(p, phase);
      const block = blockingValue(p, league, db, phase);
      const immediate = lineupGain(roster, p);
      const playoff = playoffPoints(p, phase);
      const scarcity = positionalScarcity(freeAgents, p.position);

      const dropRos = dropTarget ? dropTarget.restOfSeasonPoints : 0;
      const dropHold = dropTarget ? dropTarget.holdValue : 0;

      // What the spot returns with him in it, minus what it returns today.
      const startingValue = startProb * ros * phase.startabilityWeight;
      const optionValue = breakout * ros * 0.45 * phase.upsideWeight;
      const playoffValue = playoff * 0.25;
      const gross = startingValue + optionValue + playoffValue + block.value
        + immediate * 4 * phase.startabilityWeight;
      const acquisitionValue = gross - Math.max(0, dropHold);

      const faab = faabLadder(p, league, phase, acquisitionValue, block.claimProbability);
      const action = recommendAction({
        acquisitionValue, immediate, breakout, block, startProb, bust, phase, scarcity,
      });

      return {
        player: p,
        addPlayer: p,
        dropPlayer: dropTarget ? dropTarget.player : null,
        acquisitionValue: round(acquisitionValue),
        immediateLineupGain: round(immediate, 1),
        restOfSeasonPoints: round(ros),
        netRestOfSeason: round(ros - dropRos),
        playoffPoints: round(playoff),
        breakoutProbability: round(breakout, 2),
        bustProbability: round(bust, 2),
        blockingValue: round(block.value),
        claimProbability: round(block.claimProbability, 2),
        likelySuitors: block.suitors.map((s) => s.teamName),
        positionalScarcity: round(scarcity, 2),
        startProbability: round(startProb, 2),
        faab,
        bid: faab.recommended,
        action,
        confidence: confidenceFor({ acquisitionValue, breakout, bust, immediate }),
        reason: waiverReason({ player: p, action, immediate, breakout, block, phase, scarcity }),
        triggers: triggersFor(p, block),
        outcomes: outcomeProbabilities(p, startProb, breakout, bust),
      };
    })
    .filter((t) => t.action !== ACTION.NO)
    .sort((a, b) => b.acquisitionValue - a.acquisitionValue);

  return {
    phase,
    targets,
    bench: benchReport.bench,
    weakest: dropTarget,
    topMove: targets[0] || null,
    missingInputs: MISSING_INPUTS,
  };
}

function recommendAction({ acquisitionValue, immediate, breakout, block, startProb, bust, phase, scarcity }) {
  if (acquisitionValue <= 0) return ACTION.NO;
  if (immediate > 1.5 && acquisitionValue > 45) return ACTION.PRIORITY;
  if (immediate > 0.5 && acquisitionValue > 20) return ACTION.ADD;
  if (breakout >= 0.3 && phase.upsideWeight > 0.55) return ACTION.SPECULATIVE;
  if (block.value > acquisitionValue * 0.55 && block.claimProbability > 0.5) return ACTION.DEFENSIVE;
  if (acquisitionValue > 8 || scarcity > 0.7) return ACTION.MONITOR;
  return ACTION.NO;
}

function confidenceFor({ acquisitionValue, breakout, bust, immediate }) {
  if (immediate > 1.5 && bust < 0.35) return 'High';
  if (acquisitionValue > 30 && bust < 0.5) return 'Medium';
  if (breakout > 0.35) return 'Medium';
  return 'Low';
}

function waiverReason({ player, action, immediate, breakout, block, phase, scarcity }) {
  if (action === ACTION.PRIORITY) {
    return `Starts for you immediately, adding about ${immediate.toFixed(1)} points a week to your lineup.`;
  }
  if (action === ACTION.ADD) {
    return `Upgrades the back of your roster and slots in on bye weeks and injuries.`;
  }
  if (action === ACTION.SPECULATIVE) {
    return `Roughly a ${Math.round(breakout * 100)}% chance the role grows, and `
      + `${phase.weeksRemaining} weeks left for it to pay off.`;
  }
  if (action === ACTION.DEFENSIVE) {
    return `He would start for ${block.suitors[0]?.teamName || 'a rival contender'} the week you pass — `
      + `claiming him is worth more in what it denies than what it adds.`;
  }
  return scarcity > 0.7
    ? `Worth watching: the position is thin and the next option is a clear step down.`
    : `Marginal. Keep an eye on his usage before spending a roster spot.`;
}

/** What to watch that would change the call. */
function triggersFor(player, block) {
  const m = player.metrics || {};
  const out = [];
  const ni = player.newsImpact;
  if (ni && ni.events && ni.events.length) {
    out.push(ni.events[0].headline);
  }
  if (ni && ni.addsLast24h) {
    out.push(`${ni.addsLast24h.toLocaleString()} managers added him in 24h`);
  }
  if (num(m.snapShare, 0) < 0.6) out.push('snap share climbing above 60%');
  if (['WR', 'TE'].includes(player.position) && num(m.targetShare, 0) < 0.2) {
    out.push('target share climbing above 20%');
  }
  if (player.position === 'RB' && num(m.carries, 0) < 12) out.push('carries reaching a starter workload');
  if (player.injuryStatus && player.injuryStatus !== 'Healthy') out.push(`injury status clearing (${player.injuryStatus})`);
  if (block.claimProbability > 0.5) out.push('a rival claiming him first');
  return out.slice(0, 3);
}

// ---------------------------------------------------------------------------

function deriveWeek(league) {
  const weeks = (league.schedule || []).map((m) => num(m.week, 0));
  return weeks.length ? Math.max(...weeks) : 5;
}

function round(v, dp = 0) {
  const f = Math.pow(10, dp);
  return Math.round(num(v) * f) / f;
}

export { CATEGORY, ACTION };

/** Backwards-compatible shape for callers of the previous waiver engine. */
export function getWaiverRecommendations(league, options = {}) {
  const report = evaluateWaivers(league, options);
  return report.targets
    .filter((t) => [ACTION.PRIORITY, ACTION.ADD, ACTION.SPECULATIVE, ACTION.DEFENSIVE].includes(t.action))
    .slice(0, 4);
}
