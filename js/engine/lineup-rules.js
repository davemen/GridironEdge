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
 * That header has twice claimed a consolidation that had not happened, so this
 * version says what is true and names what is not.
 *
 * TRUE: every function here takes the league's own `rosterSettings`, and the
 * engines pass it -- auction-advisor, team-strength, roster-manager,
 * lineup-optimizer, simulator, draft-assistant and app.js all derive their
 * slots from these functions. A 3-WR or 2-flex league is described once.
 *
 * The round before this one added those functions and left the frozen
 * constants exported beside them, and four engines went on importing the
 * constants -- so the module shipped two contradicting answers and the auction
 * engine priced every league as a 2-WR one-flex league. The constants are gone
 * rather than deprecated: the only way to ask about a lineup is now to say
 * which league you mean, which is what makes the next omission impossible
 * rather than merely discouraged.
 *
 * NOT consolidated, and deliberately: `app.js`'s roster-grid array, which is a
 * display concern with its own labels.
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

/**
 * Fixed starting positions, in the order a lineup grid shows them.
 *
 * Module-private, and that is the point. The slot COUNTS were exported here as
 * STARTER_SLOTS and N_FLEX, and four engines -- auction-advisor,
 * team-strength, roster-manager and app.js -- imported them INSTEAD of the
 * settings-aware functions below, while the header above claimed the
 * consolidation was finished. So the module shipped two contradicting
 * definitions of one thing: starterSlots({WR:3,FLEX:2}) answered WR 3 and flex
 * 2 while STARTER_SLOTS answered WR 2 and N_FLEX 1, and the auction engine --
 * the reason this project exists -- priced every league as a 2-WR one-flex
 * league. On a 2-QB superflex board the optimizer started two quarterbacks and
 * team-strength benched the second.
 *
 * Only the ORDER lives here now, because it is the same in every league. The
 * counts are unreachable without saying which league you mean.
 */
const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'D/ST', 'K'];

/**
 * Which positions may fill a flex slot. Exported because the roster grid, the
 * optimizer and `openStarterSlots` all need the same list -- and unlike the
 * counts, it does not vary with league settings, so there is nothing to say
 * "which league" about.
 */
export const FLEX_POS = ['RB', 'WR', 'TE'];

/** How many of a position a roster may hold. */
export const MAX_AT_POS = { QB: 3, RB: 7, WR: 7, TE: 3, 'D/ST': 2, K: 2 };

/** Season shape. Used by both the preseason model and the in-season simulator. */
export const REGULAR_WEEKS = 14;
export const PLAYOFF_TEAMS = 6;
// There is no BYE_TEAMS. A flat 2 was exported here and it is exactly the bug
// `byeCount` below exists to prevent, so leaving it available -- even unused --
// leaves the wrong answer one import away.

/**
 * How many teams make the playoffs in a league of this size.
 *
 * PLAYOFF_TEAMS is the standard six, but a six-team playoff in an eight-team
 * league is most of the league, and in a four-team league it is all of it.
 */
export function playoffFieldSize(leagueSize) {
  const n = Math.max(0, Math.floor(Number(leagueSize) || 0));
  if (n < 2) return 0;
  return Math.min(PLAYOFF_TEAMS, Math.max(2, n >= 8 ? PLAYOFF_TEAMS : Math.floor(n / 2)));
}

/**
 * How many top seeds sit out the first round.
 *
 * Derived from the field, not fixed at two. A bracket is even only when the
 * teams that DO play in the first round reduce to a power of two alongside the
 * byes -- so the byes are whatever it takes to reach the next power of two.
 *
 * A flat two was the bug: in a FOUR-team field, two byes left two teams to
 * play, their single winner joined the two byes, and the next round paired the
 * first and third seeds while the second walked into the final. Over 20,000
 * brackets of identical teams the second seed took 50.0% against the first
 * seed's 25.3%. That is not a seeding advantage, it is a structural one -- and
 * it survived the round-6 fix, which only balanced the six-team case.
 */
export function byeCount(fieldSize) {
  const n = Math.max(0, Math.floor(Number(fieldSize) || 0));
  if (n < 2) return 0;
  let pow = 1;
  while (pow < n) pow *= 2;
  return pow - n;
}

/** Where a position sits on the field, for grouping and display. */
export const OFFENSE = ['QB', 'RB', 'WR', 'TE'];

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
