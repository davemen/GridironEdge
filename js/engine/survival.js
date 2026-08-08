/**
 * Will he still be there at my next pick?
 *
 * One definition, because there were three, and they disagreed on the board.
 * Two of them lived 110 lines apart in draft-assistant.js and the third in
 * app.js; on a 10-team snake on the clock at pick 25 with the next at 36 they
 * answered, for the same player:
 *
 *     ADP 30  ->   2%  /   5%  /   9%
 *     ADP 40  ->  84%  /  89%  /  75%
 *     ADP 45  ->  98%  /  99%  /  91%
 *
 * They differed in the spread assumed around ADP (0.10 against 0.15 of it) and
 * in the normal approximation used. The app.js copy also took `currentPick +
 * leagueSize` as the next pick, a linear-draft assumption on a board that
 * renders for snake drafts, so it was wrong about *which pick* as well.
 *
 * This is the form that drove which player was recommended, kept because it is
 * the one the engine's advice was already built on -- not because it was
 * measured against the other. Neither was; BACKTEST.md has no entry for this
 * curve, and putting one number on screen where three used to fight is the
 * point of the change, not an accuracy claim.
 */

/** Spread of real draft position around ADP, as a fraction of ADP. */
const ADP_SPREAD = 0.15;
const MIN_SD = 3;

/**
 * Probability, 0..1, that a player with this ADP is still available at
 * `pickNumber`. Null when his ADP is unknown -- a survival curve fitted to a
 * missing draft position is a percentage about nothing.
 */
export function survivalProbability(player, pickNumber) {
  const adp = player && typeof player.adp === 'number' ? player.adp : null;
  if (adp === null || !Number.isFinite(pickNumber)) return null;

  const sd = Math.max(MIN_SD, adp * ADP_SPREAD);
  const z = (pickNumber - adp) / (sd * Math.SQRT2);
  // erf approximation (Abramowitz & Stegun 7.1.26)
  const s = z < 0 ? -1 : 1;
  const a = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * a);
  const erf = s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
  return 1 - 0.5 * (1 + erf);
}

/**
 * The pick this manager is next on the clock for.
 *
 * Consolidating the CURVE was not enough: app.js went on computing
 * `currentPick + leagueSize`, a linear-draft assumption on a board that renders
 * for snake drafts, which is the very thing this module's header names as the
 * reason the app.js copy was wrong. Measured on a 10-team snake from slot 1 on
 * pick 25, the two answers were 41 and 35 -- and so 43% and 80% for the same
 * player. One question, one answer, derived in one place.
 */
export function nextPickFor(league, currentPick) {
  const size = Number(league && league.leagueSize) || 0;
  const draft = (league && league.draftState) || {};
  if (!size || !Number.isFinite(currentPick)) return null;

  const order = draft.draftOrder || (league.teams || []).map((t) => t.teamId);
  const seat = order.indexOf(league.myTeamId);
  // No seat, no snake: a scraped auction room carries no draft order, and the
  // honest fallback is one full turn of the wheel.
  if (seat < 0 || draft.draftType !== 'snake') return currentPick + size;

  const round = Math.floor((currentPick - 1) / size);
  for (let r = round; r < round + 3; r++) {
    const inRound = (r % 2 === 1) ? (size - 1 - seat) : seat;
    const absolute = r * size + inRound + 1;
    // picks[0], not picks[1]. Taking the second upcoming pick answered for the
    // pick AFTER next whenever the board was not on your clock.
    if (absolute > currentPick) return absolute;
  }
  return currentPick + size;
}

/** The same answer as a whole percentage for display, or null if unknown. */
export function survivalPct(player, pickNumber) {
  const p = survivalProbability(player, pickNumber);
  return p === null ? null : Math.min(100, Math.max(0, Math.round(p * 100)));
}
