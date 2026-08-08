/**
 * Gridiron Edge — NFL News Monitor
 *
 * The waiver engine was reasoning from a static `injuryStatus` field and season
 * projections. That is the wrong information for a decision made on a Tuesday
 * morning, because the things that actually create waiver value happen between
 * Sunday night and Wednesday: a starter tears something, a back gets traded into
 * a bell-cow role, a suspension lands, a coach names a new starter.
 *
 * This module reads two live feeds and converts them into signals the roster
 * engine already knows how to use.
 *
 *   ESPN NEWS       headlines with player and team tags. Classified into the
 *                   event types that move fantasy value.
 *   SLEEPER TRENDING how many managers league-wide added or dropped each player
 *                    in the last 24 hours.
 *
 * Trending data deserves particular emphasis, because it fixes a real weakness.
 * The engine estimates how likely a rival is to claim a player from their roster
 * needs and budget — a decent guess. But if fifty thousand managers added
 * someone overnight, that is not a guess any more, it is a measurement. And the
 * backtest is clear that being late to the wire is what costs you: the first two
 * active rivals take 60% of the available edge.
 *
 * Everything degrades gracefully. If a feed is unreachable the engine falls back
 * to exactly what it did before, and `newsAvailable` reports false, rather than
 * decisions being made from stale or invented signals.
 */

// The default page size is 6, which in a quiet week yields nothing actionable
// at all. Asking for 50 is the difference between an empty panel and a usable
// one.
const ESPN_NEWS = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50';
const SLEEPER_TREND = 'https://api.sleeper.app/v1/players/nfl/trending';
const SLEEPER_PLAYERS = 'https://api.sleeper.app/v1/players/nfl';

/** How each event type moves a player's value. Tuned to be conservative. */
export const EVENT_IMPACT = {
  injury_out:    { self: -0.85, backup: +0.80, urgency: 'high',
                   label: 'ruled out' },
  injury_risk:   { self: -0.30, backup: +0.30, urgency: 'medium',
                   label: 'injury concern' },
  returning:     { self: +0.55, backup: -0.60, urgency: 'medium',
                   label: 'returning from injury' },
  suspension:    { self: -0.80, backup: +0.65, urgency: 'high',
                   label: 'suspended' },
  trade:         { self: +0.10, backup: -0.15, urgency: 'high',
                   label: 'traded' },
  promotion:     { self: +0.60, backup: -0.40, urgency: 'high',
                   label: 'named starter' },
  demotion:      { self: -0.55, backup: +0.45, urgency: 'medium',
                   label: 'lost the job' },
};

/**
 * Order matters. Losing a job and winning one share vocabulary -- "loses the
 * starting job" contains "starting job" -- so the negative readings are tested
 * first and the positive patterns are kept explicit about who is gaining. Get
 * this backwards and the engine recommends precisely the wrong player.
 */
const PATTERNS = [
  [/\b(out for the season|season-ending|torn (acl|achilles)|placed on ir|ruled out|will miss)\b/i, 'injury_out'],
  [/\b(suspended|suspension)\b/i, 'suspension'],
  [/\b(benched|demoted|split carries|committee)\b/i, 'demotion'],
  [/\b(loses|lost|out of|no longer)\b[^.]{0,24}\b(starting )?(job|role|gig)\b/i, 'demotion'],
  [/\b(traded|trade to|acquired by|dealt to)\b/i, 'trade'],
  [/\b(named (the )?starter|will start|takes over as|promoted to starter)\b/i, 'promotion'],
  [/\b(wins|won|earns|earned|claims|seizes)\b[^.]{0,24}\b(starting )?(job|role|gig)\b/i, 'promotion'],
  [/\b(returns|activated|cleared to play|back from injury|expected to play)\b/i, 'returning'],
  [/\b(questionable|doubtful|limited in practice|did not practice|dnp|injury|hurt|strain|sprain)\b/i, 'injury_risk'],
];

import { playerKey } from '../player-database.js';
import { NFL_NICKNAMES } from '../nfl-teams.js';
import { finite } from './numbers.js';


/**
 * Normalise a name for matching across feeds that punctuate differently.
 *
 * This was a third, independent normalizer that turned apostrophes into spaces
 * where playerKey removes them -- the exact difference whose own comment records
 * that it once valued the consensus number-one receiver at replacement level.
 * "Ja'Marr Chase" came out as "ja marr chase" here and "jamarr chase" there, so
 * any comparison across the two modules could not match an apostrophe name at
 * all. It is now the same function, re-exported under the name this module's
 * callers already use.
 */
export const normalizeName = playerKey;

/**
 * NFL team abbreviations, keyed by the club names ESPN writes in its tags.
 *
 * The nicknames come from js/nfl-teams.js rather than being written again here
 * -- this was one of five copies of the club list, and the only difference that
 * earns its own table is the city, which headlines use and the nickname map
 * does not carry.
 */
const CITIES = {
  ARI: 'arizona', ATL: 'atlanta', BAL: 'baltimore', BUF: 'buffalo',
  CAR: 'carolina', CHI: 'chicago', CIN: 'cincinnati', CLE: 'cleveland',
  DAL: 'dallas', DEN: 'denver', DET: 'detroit', GB: 'green bay',
  HOU: 'houston', IND: 'indianapolis', JAX: 'jacksonville', KC: 'kansas city',
  MIA: 'miami', MIN: 'minnesota', NE: 'new england', NO: 'new orleans',
  PHI: 'philadelphia', PIT: 'pittsburgh', SEA: 'seattle', SF: 'san francisco',
  TB: 'tampa bay', TEN: 'tennessee', WAS: 'washington', LV: 'las vegas',
  // Two clubs share Los Angeles and one shares New York, so the city alone
  // cannot pick between them: they match on nickname only.
  LAC: null, LAR: null, NYG: null, NYJ: null,
};

export const TEAM_ALIASES = Object.entries(NFL_NICKNAMES).reduce((out, [nickname, abbrev]) => {
  out[abbrev] = [nickname];
  if (CITIES[abbrev]) out[abbrev].push(CITIES[abbrev]);
  return out;
}, {});

/**
 * Why an article matters to a specific roster, or null if it does not.
 *
 * Matching only on athlete tags misses most of a preseason feed, which is
 * written about teams rather than individuals. So a player is considered hit if
 * he is tagged, if his name appears in the text, or -- more weakly -- if the
 * article is about his NFL club.
 */
export function relevanceTo(item, roster) {
  if (!roster || !roster.length) return null;
  const text = `${item.headline || ''} ${item.description || ''}`.toLowerCase();
  const tagged = (item.players || []).map((n) => normalizeName(n));
  const tags = [...(item.teams || []), item.team].filter(Boolean)
    .map((t) => String(t).toLowerCase());

  const named = [];
  const teammates = [];
  roster.forEach((p) => {
    const key = normalizeName(p.name);
    if (!key) return;
    if (tagged.includes(key) || text.includes(key)) {
      named.push(p.name);
      return;
    }
    const aliases = TEAM_ALIASES[p.team] || [];
    if (aliases.some((a) => tags.some((t) => t.includes(a)) || text.includes(a))) {
      teammates.push(p.name);
    }
  });

  if (named.length) return { strength: 'player', players: named,
                             why: named.slice(0, 2).join(', ') };
  if (teammates.length) return { strength: 'team', players: teammates,
                                 why: `${teammates[0]}'s team` };
  return null;
}

/** Which fantasy event, if any, a headline describes. */
export function classifyHeadline(text) {
  const s = String(text || '');
  for (const [re, type] of PATTERNS) {
    if (re.test(s)) return type;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

async function getJSON(url, timeoutMs = 8000) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Headlines from ESPN, reduced to {players, team, type, headline, published}.
 * ESPN tags each article with categories that name the players involved, which
 * is what makes the mapping reliable rather than a fuzzy text search.
 */
export async function fetchLeagueNews({ classifiedOnly = true } = {}) {
  const data = await getJSON(ESPN_NEWS);
  const items = [];
  (data.articles || []).forEach((a) => {
    const text = `${a.headline || ''}. ${a.description || ''}`;
    const type = classifyHeadline(text);
    // The engine only acts on classified events, but the reading panel wants
    // everything -- most of the feed in a quiet week is camp reports and
    // analysis, which is worth seeing even though it moves no valuation.
    if (classifiedOnly && !type) return;
    const players = [];
    let team = null;
    (a.categories || []).forEach((c) => {
      if (c.type === 'athlete' && c.description) players.push(c.description);
      else if (c.type === 'team' && c.description) team = c.description;
      else if (c.description && /^[A-Z][a-z]+ [A-Z]/.test(c.description)) {
        players.push(c.description);
      }
    });
    // Keep every team tag, not just the last one. An article about a trade
    // names two, and a roster is far likelier to intersect a team than a
    // specific athlete -- ESPN tags athletes sparsely in the preseason, when
    // most of the feed is camp coverage.
    const teams = [];
    (a.categories || []).forEach((c) => {
      if (c.type === 'team' && c.description) teams.push(c.description);
    });
    items.push({
      type, team, teams, players,
      headline: a.headline || '',
      description: a.description || '',
      published: a.published || a.lastModified || null,
      source: 'ESPN',
    });
  });
  return items;
}

/**
 * How many managers league-wide added or dropped each player in the last day.
 *
 * This is the sharpest available estimate of "will somebody else take him
 * before I do", and it replaces a guess built from opponents' roster needs.
 */
export async function fetchTrending(lookbackHours = 24, limit = 50) {
  const [adds, drops, players] = await Promise.all([
    getJSON(`${SLEEPER_TREND}/add?lookback_hours=${lookbackHours}&limit=${limit}`),
    getJSON(`${SLEEPER_TREND}/drop?lookback_hours=${lookbackHours}&limit=${limit}`),
    getJSON(SLEEPER_PLAYERS),
  ]);
  const nameOf = (id) => {
    const p = players[id];
    if (!p) return null;
    return p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
  };
  const map = (rows, key) => (rows || []).map((r) => ({
    name: nameOf(r.player_id), [key]: finite(r.count),
  })).filter((r) => r.name);
  return { adds: map(adds, 'adds'), drops: map(drops, 'drops') };
}

// ---------------------------------------------------------------------------
// Applying news to a league
// ---------------------------------------------------------------------------

/**
 * Attach `newsImpact` to every player the feeds mention.
 *
 * Two distinct effects, and keeping them separate matters:
 *   `selfImpact`  what the news does to that player's own outlook
 *   `claimHeat`   how hard the rest of the world is chasing him right now
 *
 * A backup whose starter just went on IR gets a large positive selfImpact even
 * though no article mentions him by name — which is exactly the add the engine
 * previously could not see.
 */
export function applyNews(league, news, trending, options = {}) {
  const db = league.playerDatabase || {};
  const players = Object.values(db);
  const byName = new Map(players.map((p) => [normalizeName(p.name), p]));

  players.forEach((p) => { delete p.newsImpact; });

  const applied = [];
  const bump = (player, delta, type, headline, urgency) => {
    if (!player) return;
    const cur = player.newsImpact || { selfImpact: 0, claimHeat: 0, events: [] };
    cur.selfImpact += delta;
    if (urgency) cur.urgency = urgency;
    cur.events.push({ type, headline, delta: Number(delta.toFixed(2)) });
    player.newsImpact = cur;
    applied.push({ player: player.name, type, delta });
  };

  (news || []).forEach((item) => {
    const impact = EVENT_IMPACT[item.type];
    if (!impact) return;
    const hits = (item.players || [])
      .map((n) => byName.get(normalizeName(n)))
      .filter(Boolean);
    hits.forEach((p) => bump(p, impact.self, item.type, item.headline, impact.urgency));

    // The player nobody wrote about: whoever inherits the touches.
    hits.forEach((p) => {
      if (!impact.backup) return;
      const heirs = players.filter(
        (q) => q.id !== p.id && q.position === p.position && q.team === p.team
      ).sort((a, b) => finite(b.projectedPoints) - finite(a.projectedPoints));
      if (heirs[0]) {
        bump(heirs[0], impact.backup, `${item.type}_beneficiary`,
             `Inherits work with ${p.name} ${impact.label}`, impact.urgency);
      }
    });
  });

  // Market heat, normalised so the busiest add of the day is 1.0.
  const adds = (trending && trending.adds) || [];
  const peak = adds.reduce((m, r) => Math.max(m, finite(r.adds)), 0) || 1;
  adds.forEach((r) => {
    const p = byName.get(normalizeName(r.name));
    if (!p) return;
    const cur = p.newsImpact || { selfImpact: 0, claimHeat: 0, events: [] };
    cur.claimHeat = Math.max(cur.claimHeat, finite(r.adds) / peak);
    cur.addsLast24h = finite(r.adds);
    p.newsImpact = cur;
  });

  return {
    newsAvailable: true,
    itemsClassified: (news || []).length,
    playersAffected: new Set(applied.map((a) => a.player)).size,
    trendingTracked: adds.length,
    applied,
    // Split by what it means for THIS team, because a generic feed is reading
    // material and these are decisions. Everything else on the wire is noise
    // for someone who has to choose a lineup in an hour.
    ...triage(league, players),
  };
}

/**
 * Sort the affected players into the only two groups that require action:
 * bad news about someone you own, and opportunity among players you do not.
 */
export function triage(league, players) {
  const me = league.teams?.find((t) => t.teamId === league.myTeamId);
  const mine = new Set((me?.roster || []).map(String));
  const owned = new Set();
  (league.teams || []).forEach((t) => (t.roster || []).forEach((id) => owned.add(String(id))));

  const affects = [], opportunities = [];
  players.forEach((p) => {
    const ni = p.newsImpact;
    if (!ni) return;
    const headline = ni.events?.[0]?.headline || null;
    const row = {
      player: p.name, position: p.position, team: p.team,
      impact: Number(ni.selfImpact.toFixed(2)),
      claimHeat: Number((ni.claimHeat || 0).toFixed(2)),
      addsLast24h: ni.addsLast24h || 0,
      urgency: ni.urgency || 'low',
      headline,
    };
    if (mine.has(String(p.id))) {
      // Only bad news about your own players is actionable; good news about a
      // player already in your lineup changes nothing you do today.
      if (ni.selfImpact < 0) affects.push(row);
    } else if (!owned.has(String(p.id))) {
      if (ni.selfImpact > 0 || (ni.claimHeat || 0) > 0.25) opportunities.push(row);
    }
  });

  affects.sort((a, b) => a.impact - b.impact);
  opportunities.sort(
    (a, b) => (b.impact + b.claimHeat) - (a.impact + a.claimHeat));
  return { affectsMyTeam: affects, opportunities };
}

/**
 * One call for the UI: pull both feeds, apply them, never throw.
 *
 * A failed feed must not take the waiver page down, and it must not silently
 * look like "no news" either — `newsAvailable: false` says the difference.
 */
export async function refreshNews(league, options = {}) {
  let news = [], trending = { adds: [], drops: [] };
  const errors = [];
  try {
    news = await fetchLeagueNews();
  } catch (e) {
    errors.push(`news: ${e.message}`);
  }
  try {
    trending = await fetchTrending(options.lookbackHours || 24, options.limit || 50);
  } catch (e) {
    errors.push(`trending: ${e.message}`);
  }
  if (errors.length === 2) {
    return { newsAvailable: false, errors, itemsClassified: 0,
             playersAffected: 0, trendingTracked: 0, applied: [] };
  }
  const res = applyNews(league, news, trending, options);
  return { ...res, errors, news, trending };
}
