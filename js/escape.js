/**
 * HTML escaping for everything that came from outside this codebase.
 *
 * The app builds its markup from template literals and assigns them with
 * innerHTML. Most of what it interpolates is scraped out of the live ESPN draft
 * room -- player names, manager-chosen team names, the league name lifted from
 * document.title -- or pulled from third-party news APIs. None of it was escaped,
 * and a security audit demonstrated the whole chain end to end: a POST to the
 * local sync endpoint, through the real importScrapedPayload, into nine
 * confirmed injection points across five panels.
 *
 * Two helpers, because the two jobs are genuinely different:
 *
 *   esc(v)     for text that lands between tags or inside a quoted attribute
 *   attr(v)    same thing, named so an attribute site reads as deliberate
 *
 * The single-quote and backtick escapes matter as much as the angle brackets:
 * several sinks interpolate into attributes, and a lone quote there ends the
 * attribute and starts a new one.
 *
 * A number is not safe just because it is meant to be a number -- `projectedPoints`
 * arrives from JSON we did not write -- so numeric formatting still goes through
 * `num()` rather than being trusted.
 */

const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escape a value for interpolation into HTML text or a quoted attribute. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (c) => HTML_ENTITIES[c]);
}

/**
 * Escape for an attribute. Identical to esc() -- named separately so that a
 * reader can see at the call site that the author knew it was an attribute.
 */
export const attr = esc;

/**
 * A number, or a fallback. Use where markup expects a figure: it guarantees the
 * output contains no markup at all, whatever the JSON held.
 */
export function num(value, digits = 1, fallback = '—') {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return digits === 0 ? String(Math.round(n)) : n.toFixed(digits);
}

/** An integer, or a fallback. */
export function int(value, fallback = '—') {
  return num(value, 0, fallback);
}
