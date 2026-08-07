/**
 * One definition of what a starting lineup is.
 *
 * These three constants were declared verbatim in auction-advisor.js,
 * team-strength.js and roster-manager.js, with three further shapes of the same
 * rules elsewhere: an array of slot objects in app.js, a pair of literal walks
 * inside simulator.js, and a straight-line if-chain in lineup-optimizer.js. Six
 * representations of one league's rules, free to drift apart — and two of them
 * already had, giving the playoff field six teams in one engine and four in
 * another while both wrote to the same three spans on screen.
 *
 * The flex is ONE slot shared between running backs, receivers and tight ends.
 * Granting each of them its own flex allowance claimed eight flex-eligible
 * starters where the lineup has six, so a complete roster still reported an open
 * slot; `openStarterSlots` below is the corrected form, kept here so there is
 * only one of it.
 */

export const STARTER_SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, 'D/ST': 1, K: 1 };
export const FLEX_POS = ['RB', 'WR', 'TE'];
export const N_FLEX = 1;

/** How many of a position a roster may hold. */
export const MAX_AT_POS = { QB: 3, RB: 7, WR: 7, TE: 3, 'D/ST': 2, K: 2 };

/** Season shape. Used by both the preseason model and the in-season simulator. */
export const REGULAR_WEEKS = 14;
export const PLAYOFF_TEAMS = 6;
export const BYE_TEAMS = 2;

/** Where a position sits on the field, for grouping and display. */
export const OFFENSE = ['QB', 'RB', 'WR', 'TE'];

/** Total starting slots, flex included. */
export const STARTERS_COUNT =
  Object.values(STARTER_SLOTS).reduce((a, b) => a + b, 0) + N_FLEX;

/**
 * The lineup as an ordered list of labelled slots — the form a roster grid
 * wants. Derived from STARTER_SLOTS so it cannot disagree with it.
 */
export function slotList() {
  const out = [];
  Object.keys(STARTER_SLOTS).forEach((pos) => {
    const n = STARTER_SLOTS[pos];
    for (let i = 0; i < n; i++) {
      out.push({ label: n > 1 ? `${pos}${i + 1}` : pos, pos, isFlex: false });
    }
  });
  for (let i = 0; i < N_FLEX; i++) {
    out.push({ label: 'FLEX', pos: FLEX_POS, isFlex: true });
  }
  return out;
}

/**
 * Starting slots still to fill, with the flex counted once across all of
 * RB/WR/TE rather than once per position.
 */
export function openStarterSlots(counts) {
  const out = {};
  let flexOpen = N_FLEX;
  Object.keys(STARTER_SLOTS).forEach((pos) => {
    const have = counts[pos] || 0;
    const need = STARTER_SLOTS[pos] - have;
    if (need > 0) out[pos] = need;
    else if (FLEX_POS.includes(pos)) flexOpen -= Math.min(flexOpen, -need);
  });
  if (flexOpen > 0) {
    FLEX_POS.forEach((pos) => { out[pos] = (out[pos] || 0) + flexOpen; });
  }
  return out;
}

/** Roster size from league settings, falling back to the standard 9 + 7. */
export function rosterSize(league) {
  const s = (league && league.rosterSettings) || {};
  return (s.startersCount || STARTERS_COUNT) + (s.benchCount || 7);
}
