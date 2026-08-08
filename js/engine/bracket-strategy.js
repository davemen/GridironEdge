/**
 * Gridiron Edge — Bracket Strategy
 *
 * The single most valuable in-season decision this project measured, and it
 * costs nothing to make.
 *
 * Every lineup tool, including this app's, maximises expected points. That is
 * correct for 14 weeks and wrong for the three that decide the title. In a
 * single elimination game you are not trying to score a lot — you are trying to
 * beat one specific opponent once. Those are different objectives:
 *
 *   FAVOURED   you win by not blowing up. Play the floor: the steady
 *              high-snap-share players, not the boom/bust ones. Variance can
 *              only cost you a game you were expected to win.
 *   UNDERDOG   your median outcome loses. You need a tail. Play the ceiling and
 *              accept the extra downside, because the downside was a loss
 *              anyway.
 *
 * Same roster, opposite advice, decided entirely by who you are playing.
 *
 * Measured over 2021-2025 with real results and real lineup decisions: worth
 * +4.0 points of championship probability, the largest single effect of the
 * five levers tested, and it moves season points by zero because it only
 * changes three lineups. See BACKTEST.md.
 */

import { finite } from './numbers.js';

const PLAYOFF_WEEKS = [15, 16, 17];
const FINAL_WEEK = 17;


/**
 * Estimate whether this team beats that one, from season scoring to date.
 * Deliberately crude: the decision only needs the sign, and a more elaborate
 * model of a 12-team league's scoring would be false precision.
 */
export function winProbability(myTeam, opponentTeam) {
  const mine = finite(myTeam?.pointsScored);
  const theirs = finite(opponentTeam?.pointsScored);
  // Null, not 0.5. "No games have been played" is not "a coin flip": rendered
  // as a percentage it reads "you are the favourite (50%)", which is a claim
  // about two teams the function has no scoring for at all.
  if (!mine || !theirs) return null;
  const games = Math.max(1, finite(myTeam?.record?.wins) + finite(myTeam?.record?.losses)
    + finite(myTeam?.record?.ties));
  const perWeek = (mine - theirs) / games;
  // Weekly scores in a PPR league scatter with a standard deviation near 25,
  // so a margin of one weekly standard deviation is an 84% favourite.
  const z = perWeek / (25 * Math.SQRT2);
  return Math.max(0.05, Math.min(0.95, 0.5 * (1 + erf(z))));
}

function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const s = x < 0 ? -1 : 1, a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}

/**
 * Which lineup strategy to play this week, and why.
 *
 * Returns a `strategy` that plugs straight into optimizeLineup(): 'floor' when
 * protecting a lead, 'ceiling' when chasing one.
 */
export function recommendLineupStrategy(league, options = {}) {
  const week = finite(options.week, currentWeek(league));
  const isPlayoffs = PLAYOFF_WEEKS.includes(week);
  const myTeam = league.teams?.find((t) => t.teamId === league.myTeamId);
  const opponent = options.opponentTeamId
    ? league.teams?.find((t) => t.teamId === options.opponentTeamId)
    : findOpponent(league, week);

  const base = { week, isPlayoffs, opponent: opponent || null };

  if (!myTeam) {
    return { ...base, strategy: 'floor', favoured: null, winProbability: null,
      confidence: 'low', reason: 'No team loaded.' };
  }

  if (!opponent) {
    return { ...base, strategy: 'floor', favoured: null, winProbability: null,
      confidence: 'low',
      reason: 'No opponent identified this week, so the lineup defaults to the '
        + 'steadier option.' };
  }

  const wp = winProbability(myTeam, opponent);

  // No scoring, no verdict. winProbability correctly returns null when neither
  // team has played -- under a comment insisting on it -- and then everything
  // below treated it as a number: `null >= 0.5` is false so you were the
  // UNDERDOG, Math.abs(null - 0.5) is 0.5 so the confidence was HIGH, and
  // Math.round(null * 100) is 0. On a league imported before a game has been
  // played, which is this app's normal state, the card read "You are the
  // underdog (0%). Play the ceiling" at high confidence -- next to a number the
  // page had correctly rendered as "not yet".
  if (wp === null) {
    return { ...base, strategy: 'floor', favoured: null, winProbability: null,
      confidence: 'low',
      reason: 'No games have been scored yet, so there is no favourite to play '
        + 'for or against. The lineup defaults to the steadier option.' };
  }

  const favoured = wp >= 0.5;

  if (!isPlayoffs) {
    // Fourteen weeks of accumulating wins: just maximise expected points. The
    // floor/ceiling trade only pays when a single game ends your season.
    return { ...base, strategy: 'floor', favoured, winProbability: wp,
      confidence: 'medium',
      reason: `Regular season — play your best expected lineup. The floor/ceiling `
        + `trade-off only pays once a single loss ends your season.` };
  }

  const strategy = favoured ? 'floor' : 'ceiling';
  const margin = Math.abs(wp - 0.5);
  const confidence = margin > 0.15 ? 'high' : margin > 0.06 ? 'medium' : 'low';

  const reason = favoured
    ? `You are the favourite (${Math.round(wp * 100)}%). Play the floor — start the `
      + `steady producers and bench the boom/bust ones. Variance can only cost you a `
      + `game you are expected to win.`
    : `You are the underdog (${Math.round(wp * 100)}%). Play the ceiling — your median `
      + `outcome loses this game, so start the volatile players and accept the extra `
      + `downside. The downside was a loss anyway.`;

  return { ...base, strategy, favoured, winProbability: wp, confidence, reason };
}

function currentWeek(league) {
  const weeks = (league?.schedule || []).map((m) => finite(m.week));
  return weeks.length ? Math.min(FINAL_WEEK, Math.max(...weeks)) : 1;
}

function findOpponent(league, week) {
  const me = league?.myTeamId;
  const m = (league?.schedule || []).find(
    (x) => finite(x.week) === week && (x.team1Id === me || x.team2Id === me));
  if (!m) return null;
  const oppId = m.team1Id === me ? m.team2Id : m.team1Id;
  return league.teams?.find((t) => t.teamId === oppId) || null;
}

/**
 * Value of a player for the three weeks that decide the title.
 *
 * `playoffMatchup` is a multiplier for how favourable his weeks 15-17 schedule
 * is, above 1.0 meaning easy. It has to come from an NFL schedule feed, which
 * this app does not yet carry — so it defaults to neutral and the function
 * degrades to plain projection rather than inventing a number.
 *
 * Backtested at +1.1 points of championship probability when the schedule data
 * is present. It deliberately costs season points: it is buying strength in the
 * only three weeks that award a trophy.
 */
export function playoffValue(player, options = {}) {
  const weight = finite(options.weight, 3.0);
  const mult = finite(player.playoffMatchup, 1.0);
  const season = finite(player.projectedPoints) * 17;
  const playoffPts = finite(player.projectedPoints) * 3 * mult;
  return {
    seasonPoints: season,
    playoffPoints: playoffPts,
    matchupMultiplier: mult,
    hasScheduleData: typeof player.playoffMatchup === 'number',
    // What the draft board should sort on if you are drafting for a title
    // rather than for a points crown.
    titleWeightedValue: season + weight * (playoffPts - finite(player.projectedPoints) * 3),
  };
}
