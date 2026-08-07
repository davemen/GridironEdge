/**
 * The 32 clubs, once.
 *
 * There were five live copies of this table -- an if-chain and a nickname map
 * in content-main.js that were verbatim duplicates of each other, an
 * abbreviation Set, a proTeamId map, and news-monitor.js's TEAM_ALIASES --
 * plus three more inside popup.js. No two had drifted yet, but adding a
 * franchise was a five-file edit, and the one consumer that needed the id map
 * most was using none of them: the ESPN API mapper stored `String(proTeamId)`,
 * so a player on Kansas City had the club "12" six lines below a table saying
 * 12 is KC. A wrong club is not cosmetic -- it is what separates two defenses
 * and two running backs who share a surname.
 *
 * Two of the five are still separate and deliberately so. The extension's
 * content scripts are classic scripts with no module loader, so they cannot
 * import this; their two copies are merged into one within their own file.
 * news-monitor's TEAM_ALIASES maps a club to the city AND nickname a headline
 * might use, which is a different table, not another copy of this one -- it
 * takes its nicknames from here so the two cannot drift.
 */

/** ESPN's proTeamId space, as ESPN publishes it. */
export const PRO_TEAM_BY_ID = Object.freeze({
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
  9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA',
  16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI',
  23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR',
  30: 'JAX', 33: 'BAL', 34: 'HOU',
});

/** Nickname to abbreviation, for feeds and scraped rows that name the club. */
export const NFL_NICKNAMES = Object.freeze({
  patriots: 'NE', ravens: 'BAL', '49ers': 'SF', bills: 'BUF', cowboys: 'DAL',
  dolphins: 'MIA', jets: 'NYJ', eagles: 'PHI', chiefs: 'KC', raiders: 'LV',
  broncos: 'DEN', chargers: 'LAC', vikings: 'MIN', bears: 'CHI', packers: 'GB',
  lions: 'DET', buccaneers: 'TB', saints: 'NO', falcons: 'ATL', panthers: 'CAR',
  commanders: 'WAS', giants: 'NYG', cardinals: 'ARI', seahawks: 'SEA', rams: 'LAR',
  jaguars: 'JAX', colts: 'IND', titans: 'TEN', texans: 'HOU', steelers: 'PIT',
  browns: 'CLE', bengals: 'CIN',
});

/** Every club abbreviation. 'FA' is not a club and is deliberately absent. */
export const NFL_ABBREVS = Object.freeze(Object.values(PRO_TEAM_BY_ID));

/**
 * A club abbreviation from an ESPN proTeamId.
 *
 * Null rather than the id as a string: "12" is not a club, and a caller that
 * renders it produces something that looks like data.
 */
export function proTeamAbbrev(proTeamId) {
  const n = Number(proTeamId);
  return Number.isFinite(n) && PRO_TEAM_BY_ID[n] ? PRO_TEAM_BY_ID[n] : null;
}
