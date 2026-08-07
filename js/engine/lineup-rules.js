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
 * That header used to claim the consolidation had happened. It had not: an
 * audit found the pair of walks and the if-chain still there, plus a fourth
 * shape in draft-assistant.js which had reintroduced the exact flex bug
 * described below. They agreed only because every league was handed a
 * fabricated 1/2/2/1/1 shape, so nothing ever exercised the disagreement.
 *
 * Everything here now takes the league's own `rosterSettings` and falls back to
 * DEFAULT_ROSTER_SETTINGS, so a 3-WR or 2-flex league is described by one set
 * of functions rather than by five guesses.
 *
 * The flex is a slot shared between running backs, receivers and tight ends.
 * Granting each of them its own flex allowance claimed eight flex-eligible
 * starters where the lineup has six, so a complete roster still reported an
 * open slot; `openStarterSlots` below is the corrected form, kept here so there
 * is only one of it.
 */

/**
 * The standard ESPN shape, used when the league has not told us its own.
 *
 * This is a default, not a measurement, and the mappers that apply it say so on
 * the league they build (`rosterSettingsSource`), because a scraped auction
 * room does not publish its slot counts and a wrong denominator on screen
 * ("WRs: 2 / 2") is indistinguishable from a right one.
 */
export const DEFAULT_ROSTER_SETTINGS = Object.freeze({
  QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, 'D/ST': 1, K: 1, BE: 7, IR: 1,
  startersCount: 9, benchCount: 7,
});

/** Fixed starting positions, in the order a lineup grid shows them. */
const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'D/ST', 'K'];

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

/** Total starting slots, flex included, for the default shape. */
export const STARTERS_COUNT =
  Object.values(STARTER_SLOTS).reduce((a, b) => a + b, 0) + N_FLEX;

/** A non-negative slot count, or the default when the league did not say. */
function slotCount(settings, key) {
  const n = Number(settings ? settings[key] : undefined);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_ROSTER_SETTINGS[key];
}

/**
 * How many of each fixed starting position this league starts.
 * Pass a league's `rosterSettings`; omit it for the standard shape.
 */
export function starterSlots(settings) {
  const out = {};
  SLOT_ORDER.forEach((pos) => { out[pos] = slotCount(settings, pos); });
  return out;
}

/** How many flex slots this league starts. */
export function flexCount(settings) {
  return slotCount(settings, 'FLEX');
}

/** Total starting slots for this league, flex included. */
export function startersCount(settings) {
  const slots = starterSlots(settings);
  return SLOT_ORDER.reduce((a, pos) => a + slots[pos], 0) + flexCount(settings);
}

/** How many bench slots this league carries. */
export function benchCount(settings) {
  const n = Number(settings ? (settings.benchCount ?? settings.BE) : undefined);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_ROSTER_SETTINGS.benchCount;
}

/**
 * The lineup as an ordered list of labelled slots — the form a roster grid
 * wants. Derived from the league's slot counts so it cannot disagree with them.
 */
export function slotList(settings) {
  const slots = starterSlots(settings);
  const out = [];
  SLOT_ORDER.forEach((pos) => {
    const n = slots[pos];
    for (let i = 0; i < n; i++) {
      out.push({ label: n > 1 ? `${pos}${i + 1}` : pos, pos, isFlex: false });
    }
  });
  const nFlex = flexCount(settings);
  for (let i = 0; i < nFlex; i++) {
    out.push({ label: nFlex > 1 ? `FLEX${i + 1}` : 'FLEX', pos: FLEX_POS, isFlex: true });
  }
  return out;
}

/**
 * Starting slots still to fill, with the flex counted once across all of
 * RB/WR/TE rather than once per position.
 */
export function openStarterSlots(counts, settings) {
  const slots = starterSlots(settings);
  const out = {};
  let flexOpen = flexCount(settings);
  SLOT_ORDER.forEach((pos) => {
    const have = counts[pos] || 0;
    const need = slots[pos] - have;
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
  const s = (league && league.rosterSettings) || null;
  const starters = s && Number.isFinite(Number(s.startersCount))
    ? Math.floor(Number(s.startersCount))
    : startersCount(s);
  return starters + benchCount(s);
}
