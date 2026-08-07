/**
 * Gridiron Edge — real player database.
 *
 * The app shipped with a couple of dozen mock players. Any real player nominated in a draft
 * was therefore invented on the spot with a made-up projection, which made
 * every bid ceiling, Must Buy flag and waiver score meaningless no matter how
 * cleanly the draft room was scraped. Fixing the scraper without fixing this
 * would have produced confident numbers built on nothing.
 *
 * data/projections-2026.json holds 523 players from the FantasyPros week-0
 * consensus of 88 analysts, with projections derived the way the backtest
 * validated: take a player's positional rank and read expected season points
 * off a curve fitted to what that rank actually returned in 2016-2025.
 *
 * That set covers all six roster positions. It originally held only the four
 * offensive skill positions, so a kicker or a team defense could not be drafted
 * at all -- and the auction engine, seeing two starting slots it could never
 * fill, kept its "steer toward the holes" rule switched on for the whole draft.
 * Kicker and D/ST scoring is not in the weekly stats as a fantasy total, so both
 * curves are rebuilt from the underlying counting stats under ESPN's default
 * scoring rather than assumed.
 * Converting rank to position-aware points was the single largest accuracy gain
 * measured (rank correlation 0.52 -> 0.62), because the receiver ranked 40th
 * overall and the quarterback ranked 40th are not the same asset.
 *
 * What this is NOT: a projection that beats the experts. Part 2 of BACKTEST.md
 * establishes that consensus cannot be beaten with public data. This is the
 * consensus, converted into the units the engines need.
 */

const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b/g;
// What a draft room appends to a team defense, in the shapes that survive
// playerKey(): "D/ST" becomes "d st", "DST" stays, and some feeds spell it out.
// Deliberately NOT global -- a /g regex carries lastIndex between .test() calls,
// so the same name would match on one lookup and miss on the next.
const DST_TAG = /\b(d st|dst|def|defense|special teams)\b/;
const DST_TAG_ALL = new RegExp(DST_TAG.source, 'g');

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

/**
 * The key to bar a drafted player under.
 *
 * A draft row often carries a status tag -- "Terry McLaurin Q", "Mike Evans O",
 * "... IR" -- and if that pick is stored under its own name, barring on the raw
 * key leaves the real player looking free. Strip the tag so both spellings land
 * on one key.
 */
const STATUS_TAG = /\s+(q|o|d|p|ir|out|sspd|susp|dtd|na)$/;
export function draftedNameKey(name) {
  let k = playerKey(name);
  let prev;
  do { prev = k; k = k.replace(STATUS_TAG, ''); } while (k !== prev);
  return k;
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
      // Re-derive the match key from the name with the SAME function that
      // normalises a scraped name. The generator and this file disagreed about
      // periods -- it wrote "a j brown", this produces "aj brown" -- so A.J.
      // Brown could never be found. Running both sides through one function
      // makes that class of mismatch impossible rather than fixed once. The id
      // still comes from the stored key, so existing rosters keep resolving.
      key: playerKey(p.name) || p.key,
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
  buildIndex(db);
  return db;
}

/**
 * Index the database once instead of re-deriving it on every lookup.
 *
 * findPlayer rebuilt `Object.values(db)` and filtered it before attempting any
 * match, then made up to five more full passes -- measured at 15ms for 200
 * lookups, and it is called once per pick on every three-second sync. The index
 * is non-enumerable so it never appears in Object.values(db) and cannot be
 * mistaken for a player by anything that iterates the database.
 */
export function buildIndex(db) {
  const all = Object.values(db);
  const players = all.filter((p) => p && typeof p.key === 'string');
  const byKey = new Map();
  const byPosition = new Map();
  const bySurname = new Map();
  players.forEach((p) => {
    if (!byKey.has(p.key)) byKey.set(p.key, p);
    if (!byPosition.has(p.position)) byPosition.set(p.position, []);
    byPosition.get(p.position).push(p);
    const parts = p.key.split(' ');
    if (parts.length >= 2) {
      const surname = parts.slice(1).join(' ');
      if (!bySurname.has(surname)) bySurname.set(surname, []);
      bySurname.get(surname).push(p);
    }
  });
  Object.defineProperty(db, INDEX, {
    // `size` is the count the index was built from, INCLUDING records with no
    // key. Comparing only the keyed count meant a single keyless record made the
    // two numbers disagree forever, so the index rebuilt on every single lookup
    // -- measured at 51ms per 190 lookups against 0.2ms indexed, and worse than
    // the full scan it replaced.
    value: { players, byKey, byPosition, bySurname, size: all.length },
    enumerable: false, configurable: true, writable: true,
  });
  return db;
}

const INDEX = Symbol.for('gridironEdge.index');

/** The index if one was built, otherwise derived on the spot. */
function indexOf(db) {
  const cached = db[INDEX];
  // A caller can spread the database ({ ...db, EXTRA }), which drops the
  // non-enumerable index, and a mapper can add a record after it was built.
  // Compare against the total size, not the keyed size.
  if (cached && cached.size === Object.keys(db).length) return cached;
  buildIndex(db);
  return db[INDEX];
}

/**
 * Find a scraped player in the real database.
 *
 * Exact key first, then a contains-match, because ESPN and FantasyPros disagree
 * about suffixes and punctuation often enough to matter. Returns null when
 * genuinely unknown, so callers can say so instead of inventing a projection.
 */
export function findPlayer(db, name, position, team, bid) {
  if (!name) return null;
  const key = playerKey(name);
  // The mapper inserts placeholder records for players it could not resolve,
  // and those carry no match key. Reading one threw partway through the import,
  // which aborted the whole sync -- so a single unknown name emptied the entire
  // app rather than costing one roster slot. The index filters them out once.
  const idx = indexOf(db);
  const all = idx.players;

  const exact = idx.byKey.get(key);
  if (exact) return exact;

  // Team defenses are named by nickname in a draft room and by full team name
  // in the consensus -- "Texans D/ST" against "Houston Texans" -- so neither an
  // exact nor a contains match can join them. Compare on the nickname, which is
  // the last word of the full name and unique across the league.
  if (position === 'D/ST' || DST_TAG.test(key)) {
    const nick = key.replace(DST_TAG_ALL, ' ').replace(/\s+/g, ' ').trim();
    if (nick) {
      // "Houston Texans" can arrive as the nickname, the city, or both. Matching
      // on ANY shared word looks like it handles that but does not: "new
      // england" then collides with New Orleans and both New York clubs on the
      // word "new", and resolves to nothing. Every word has to be accounted for.
      const words = nick.split(' ').filter(Boolean);
      const covers = (a, b) => a.length && a.every((w) => b.includes(w));
      let hit = all.filter((p) => {
        if (p.position !== 'D/ST') return false;
        if (p.key === nick) return true;
        const pw = p.key.split(' ');
        return covers(words, pw) || covers(pw, words);
      });
      // "New York" and "Los Angeles" name two clubs each and are genuinely
      // ambiguous; the NFL abbreviation on the draft row settles them.
      if (hit.length > 1 && team) {
        const t = String(team).toUpperCase().trim();
        const byTeam = hit.filter((p) => String(p.team || '').toUpperCase() === t);
        if (byTeam.length === 1) return byTeam[0];
      }
      if (hit.length === 1) return hit[0];
    }
  }

  // A contains-match is loose enough to cross positions: the single hit for
  // "Washington" is the receiver Parker Washington, not a defense. Returning it
  // regardless of the position asked for is how a wideout ended up filling a
  // roster slot nobody drafted him into. When the caller knows the position,
  // honour it.
  let partial = all.filter(
    (p) => p.key.includes(key) || key.includes(p.key)
  );
  if (position) {
    const byPos = partial.filter((p) => p.position === position);
    // Only fall back to the unfiltered set if the position knocked everything
    // out -- that means the feeds disagree about position, not about identity.
    if (byPos.length) partial = byPos;
    else partial = [];
  }
  if (partial.length === 1) return partial[0];
  if (partial.length > 1 && team) {
    const t = String(team).toUpperCase().trim();
    const byTeam = partial.filter((p) => String(p.team || '').toUpperCase() === t);
    if (byTeam.length === 1) return byTeam[0];
  }

  // ESPN abbreviates the first name in a roster panel -- "B. Robinson",
  // "J. Allen", "P. Nacua". Neither an exact nor a substring match can reach
  // "Bijan Robinson" from "b robinson", so a whole roster resolved to nothing
  // and the page sat empty. Match the surname and the initial instead.
  const parts = key.split(' ');
  if (parts.length >= 2 && parts[0].length === 1) {
    const initial = parts[0];
    const surname = parts.slice(1).join(' ');
    let hits = (idx.bySurname.get(surname) || []).filter((p) => p.key[0] === initial);
    if (hits.length > 1 && position) hits = hits.filter((p) => p.position === position);
    // Two players can genuinely share an initial, a surname and a position --
    // Jonathan Taylor and J'Mari Taylor are both running backs. The NFL team
    // separates them, and a draft row carries it.
    if (hits.length > 1 && team) {
      const t = String(team).toUpperCase().trim();
      const byTeam = hits.filter((p) => String(p.team || '').toUpperCase() === t);
      if (byTeam.length === 1) return byTeam[0];
    }
    if (hits.length === 1) return hits[0];

    // Two Atlanta running backs are called B. Robinson: Bijan, ranked 3rd
    // overall, and Brian, ranked 160th. Name, position and team all fail to
    // separate them -- but the price does. Nobody pays $49 for the 160th player
    // and nobody pays $1 for the 3rd, so the money says which one this is. That
    // is market evidence, not a guess about which name is more famous.
    if (hits.length > 1 && typeof bid === 'number' && bid > 0) {
      const byProj = hits.slice().sort(
        (a, b) => (b.projectedPoints || 0) - (a.projectedPoints || 0));
      const spread = (byProj[0].projectedPoints || 0) - (byProj[byProj.length - 1].projectedPoints || 0);
      // Only decide this way when the candidates are far enough apart that the
      // price is genuinely informative.
      if (spread > 5) return bid >= 5 ? byProj[0] : byProj[byProj.length - 1];
    }
    // Still ambiguous: guessing would attach the wrong projection to a roster
    // slot, which is worse than reporting the player as unknown.
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
