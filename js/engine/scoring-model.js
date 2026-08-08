/**
 * The two constants that turn a projection into a distribution.
 *
 * Both engines that produce the playoff, championship and first-round-bye
 * figures -- `simulator.js` and `team-strength.js` -- draw a team's weekly
 * score as `projection + normal(0, WEEKLY_SD)`. Identical model, and they
 * carried different numbers: the simulator 12, team-strength 22. Those two
 * write to the same three spans on the Championship page, and 12 against 22
 * is worth 20 points of first-round-bye probability (91.5% against 71.0%,
 * 20,000 simulated seasons of a balanced twelve-team league). A reader
 * comparing the two figures was comparing two different leagues.
 *
 * NOT MEASURED, and this is where that is admitted rather than in a comment
 * beside a number. BACKTEST.md has no entry for weekly team variance; its
 * data section carries nflverse weekly scoring, but the harness that reads it
 * lives outside this repo and the only per-player spread shipped here --
 * `volatility` -- is derived from expert RANK disagreement, which is not a
 * scoring variance and cannot stand in for one.
 *
 * So 22 was chosen, and the reasoning is worth stating because it is reasoning
 * and not evidence:
 *
 *   - 12 is the one with no comment anywhere; 22 is the one whose author wrote
 *     down what it was for.
 *   - a 12-point SD on a ~115-point team score puts 95% of weeks inside a
 *     48-point band. Fantasy teams swing further than that most Sundays. 22 is
 *     still probably low, but it is inside the plausible range and 12 is not.
 *
 * If this is ever measured, the sensitivity above is the thing to re-run: the
 * bye percentage is where it shows, not the championship percentage, which
 * moved 1.3 points across the same comparison.
 */

/** Week-to-week scoring noise for a whole starting lineup, in points. */
export const WEEKLY_SD = 22;

/**
 * Chance that a given matchup is played in adverse weather.
 *
 * Retained rather than tuned. Forced to 0 and to 1 over 20,000 seasons of a
 * balanced twelve-team league the entire switch moved the bye figure from
 * 91.4% to 91.0% and the championship figure from 25.4% to 26.1%, both inside
 * run-to-run noise at that sample size. It is not carrying a claim, and
 * deleting it would change shipped output on no better evidence than adding it
 * did. The per-position effects it applies live in simulator.js beside the
 * lineup they adjust.
 */
export const WEATHER_RATE = 0.10;
