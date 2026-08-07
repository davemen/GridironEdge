/**
 * Gridiron Edge — real player database.
 *
 * The app shipped with 22 mock players. Any real player nominated in a draft
 * was therefore invented on the spot with a made-up projection, which made
 * every bid ceiling, Must Buy flag and waiver score meaningless no matter how
 * cleanly the draft room was scraped. Fixing the scraper without fixing this
 * would have produced confident numbers built on nothing.
 *
 * data/projections-2026.json holds 459 players from the FantasyPros week-0
 * consensus of 88 analysts, with projections derived the way the backtest
 * validated: take a player's positional rank and read expected season points
 * off a curve fitted to what that rank actually returned in 2016-2025.
 * Converting rank to position-aware points was the single largest accuracy gain
 * measured (rank correlation 0.52 -> 0.62), because the receiver ranked 40th
 * overall and the quarterback ranked 40th are not the same asset.
 *
 * What this is NOT: a projection that beats the experts. Part 2 of BACKTEST.md
 * establishes that consensus cannot be beaten with public data. This is the
 * consensus, converted into the units the engines need.
 */

const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b/g;

/** Match names across feeds that punctuate differently. */
export function playerKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    // Apostrophes and periods are REMOVED, hyphens become spaces. This has to
    // match the keys in the projection file exactly: turning the apostrophe
    // into a space instead produced "ja marr chase" against a stored
    // "jamarr chase", so the consensus number one player failed to resolve and
    // was valued at replacement level.
    .replace(/['’`.]/g, '')
    .replace(/-/g, ' ')
    .replace(SUFFIX, ' ')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let cache = null;

/**
 * Load the projection set. Returns null rather than throwing if the file is
 * missing, so the app degrades to mock data with a visible warning instead of
 * failing to start.
 */
export async function loadProjections(url = 'data/projections-2026.json') {
  if (cache) return cache;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.players) || !data.players.length) {
      throw new Error('empty');
    }
    cache = data;
    return cache;
  } catch (e) {
    console.warn('[Gridiron Edge] Real projections unavailable:', e.message);
    return null;
  }
}

/**
 * Build the app's player database from the projection set.
 * Keys are stable ids derived from the name, so a scraped player resolves to
 * the same record every sync.
 */
export function toPlayerDatabase(projections) {
  const db = {};
  if (!projections) return db;
  projections.players.forEach((p) => {
    const id = `FP_${p.key.replace(/\s+/g, '_')}`;
    db[id] = {
      id,
      key: p.key,
      name: p.name,
      position: p.position,
      team: p.team || 'FA',
      projectedPoints: p.projectedPoints,
      projectedSeason: p.projectedSeason,
      adp: p.adp,
      ecr: p.ecr,
      ecrStd: p.ecrStd,
      tier: p.tier,
      byeWeek: p.byeWeek || undefined,
      injuryStatus: 'Healthy',
      // Volatility drives the floor/ceiling lineup decision. Expert
      // disagreement is the only ex-ante uncertainty signal available, so it
      // stands in for it rather than a constant being invented per position.
      volatility: typeof p.ecrStd === 'number'
        ? Math.max(1.5, Math.min(8, p.ecrStd)) : 3.5,
    };
  });
  return db;
}

/**
 * Find a scraped player in the real database.
 *
 * Exact key first, then a contains-match, because ESPN and FantasyPros disagree
 * about suffixes and punctuation often enough to matter. Returns null when
 * genuinely unknown, so callers can say so instead of inventing a projection.
 */
export function findPlayer(db, name, position) {
  if (!name) return null;
  const key = playerKey(name);
  const all = Object.values(db);

  const exact = all.find((p) => p.key === key);
  if (exact) return exact;

  const partial = all.filter(
    (p) => p.key.includes(key) || key.includes(p.key)
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1 && position) {
    const byPos = partial.filter((p) => p.position === position);
    if (byPos.length === 1) return byPos[0];
  }
  return null;
}

/** How complete the loaded database is, for the interface to report honestly. */
export function describe(projections) {
  if (!projections) {
    return { loaded: false, count: 0,
             label: 'Mock data — projections unavailable, advice is not meaningful' };
  }
  return {
    loaded: true,
    count: projections.players.length,
    season: projections.season,
    experts: projections.experts,
    label: `${projections.players.length} players · ${projections.season} consensus of `
      + `${projections.experts} analysts`,
  };
}
