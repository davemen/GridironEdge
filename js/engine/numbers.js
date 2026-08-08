/**
 * One coercion from "whatever the payload held" to a number you can do
 * arithmetic with.
 *
 * This was declared five times -- auction-advisor, bracket-strategy,
 * team-strength, news-monitor and roster-manager each carried
 * `const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d)`
 * -- and a sixth `num()` with the same name and a different job lives in
 * `js/escape.js`, where it FORMATS a figure for markup and returns a string.
 * Two contracts sharing one name in one codebase is how the wrong one gets
 * imported.
 *
 * So the arithmetic one is called `finite` here and the display one keeps
 * `num` in escape.js. The names now say which job is being asked for.
 *
 * `typeof v === 'number'` was the substantive bug in the five copies, not just
 * the duplication. Everything the app reads arrives as JSON: an ESPN payload,
 * a news API, a scraped roster panel. A projection that came back as the string
 * "12.4" -- which any of those can produce -- failed the typeof test and became
 * the fallback, which is 0 at every call site. Zero is not "unknown": it is a
 * measurement saying this player is worth nothing, and it flowed into
 * `seasonPoints`, into par values, and out as a bid ceiling. The rule this repo
 * is built on is that an unknown value must never be given an invented one, and
 * a numeric string is not unknown.
 *
 * Booleans and '' still take the fallback. `Number(true)` is 1 and `Number('')`
 * is 0, both finite, and neither is a projection anyone wrote down.
 */
export function finite(value, fallback = 0) {
  if (value === null || value === undefined || value === ''
    || typeof value === 'boolean') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Clamp into a range. Declared beside `finite` because they travel together. */
export function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}
