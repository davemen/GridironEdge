/**
 * Gridiron Edge ESPN API Client & Data Mapper
 * Fetches public ESPN APIs and maps raw payloads into our normalized schema.
 */

import store from './store.js';
import { mockPlayers, mockLeague } from './mock-data.js';
import { loadProjections, toPlayerDatabase, findPlayer, playerKey } from './player-database.js';

// Real projections, loaded once at module init. Until this resolves the app
// falls back to mock data, which is why consumers check realDbReady rather than
// assuming the database is meaningful.
let realDb = null;
export const realDbReady = loadProjections().then((proj) => {
  realDb = toPlayerDatabase(proj);
  const n = Object.keys(realDb).length;
  console.log(n ? `[Gridiron Edge] Loaded ${n} real player projections.`
                : '[Gridiron Edge] No real projections - running on mock data.');
  return realDb;
});

/**
 * Resolve the player currently on the block.
 *
 * Both mappers need this and both had their own copy. The copy in mapESPNLeague
 * read `playerDatabase` seventy-seven lines before its own `const` declaration --
 * a TDZ ReferenceError that only fired on a non-scraped payload with a live
 * nomination, which is why it survived — and it compared raw lowercased names
 * where the working copy correctly used findPlayer. One function, called twice.
 */
/**
 * Replacement level for a position. The only acceptable answer when the feed
 * gives us nothing: a mid-range guess flows straight into a bid ceiling.
 */
function replacementPoints(position) {
  if (position === 'QB') return 9.0;
  if (position === 'RB' || position === 'WR') return 4.5;
  return 3.0;
}

function unresolvedPlayer(name, position, team) {
  const pos = position || 'RB';
  console.warn('[Gridiron Edge] "' + name + '" is not in the projection set; '
    + 'valuing him at replacement level rather than guessing.');
  return {
    id: `MOCK_${playerKey(name).replace(/\s+/g, '_') || 'unknown'}`,
    // A record without a match key breaks every later lookup.
    key: playerKey(name),
    name,
    position: pos,
    team: team || 'FA',
    // Replacement level, not a mid-range guess -- an invented projection flows
    // straight into a bid ceiling.
    projectedPoints: replacementPoints(pos),
    isUnknownPlayer: true,
    volatility: 4.0,
    injuryStatus: 'Healthy',
    byeWeek: 6,
    adp: 150.0,
  };
}

function resolveNomination(db, nomination) {
  const name = typeof nomination === 'object' ? nomination.name : nomination;
  if (!name) return null;
  const team = typeof nomination === 'object' ? nomination.team : 'FA';
  const position = typeof nomination === 'object' ? nomination.position : 'RB';

  const found = findPlayer(db, name, position, team);
  if (found) return found;

  return unresolvedPlayer(name, position, team);
}

class ESPNClient {
  constructor() {
    // Current year of NFL season
    this.season = new Date().getFullYear();
  }

  /**
   * Fetches public league details directly from ESPN V3 API.
   * Note: Private leagues will fail this fetch due to cookie/cors restrictions.
   */
  async fetchPublicLeague(leagueId) {
    // ESPN API endpoints require query param views to include all parameters
    const views = [
      'mSettings', 'mRoster', 'mTeam', 'mMatchup', 
      'mMatchupScore', 'mStandings', 'mTransactionHistory'
    ];
    const url = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${this.season}/segments/0/leagues/${leagueId}?view=${views.join('&view=')}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('ESPN Private League: Authentication required. Use the Companion Bookmarklet or Browser Extension connection method.');
        }
        throw new Error(`ESPN API returned status ${response.status}`);
      }
      const rawData = await response.json();
      return this.mapESPNLeague(rawData);
    } catch (e) {
      console.error('ESPN fetch failed:', e);
      throw e;
    }
  }

  /**
   * Import data scraped from the active browser session via bookmarklet.
   */
  async importScrapedPayload(jsonPayload) {
    // Projections load asynchronously while syncs arrive every two seconds, so
    // the first import can otherwise land on mock data and persist made-up
    // valuations into the store.
    await realDbReady;
    try {
      const parsed = typeof jsonPayload === 'string' ? JSON.parse(jsonPayload) : jsonPayload;
      if (!parsed.isDOMScraped && (!parsed.teams || !parsed.settings)) {
        throw new Error('Invalid scraped payload. Missing core structures.');
      }
      
      const mapped = this.mapESPNLeague(parsed);

      // Which team is yours survives the update.
      //
      // saveLeague replaces the whole league object, so a myTeamId chosen in
      // Settings was overwritten by whatever the next scrape guessed -- once
      // per pick, in a room that changes every second. Picking your team
      // appeared to work and then silently undid itself, which is the failure
      // that reads as "my team is not showing up".
      //
      // A choice you made outranks anything read off the page. The scrape only
      // fills it in when nobody has said otherwise.
      const stored = store.state.leagues[mapped.leagueId];
      if (stored && stored.myTeamIdSource === 'user' && typeof stored.myTeamId === 'number') {
        mapped.myTeamId = stored.myTeamId;
        mapped.myTeamIdSource = 'user';
      } else {
        mapped.myTeamIdSource = typeof mapped.myTeamId === 'number' ? 'scrape' : 'unknown';
      }
      // Read this BEFORE saving: saveLeague sets the active league itself, so
      // afterwards it always equals whatever just arrived and any comparison
      // against it is vacuously true.
      const previous = store.state.currentLeagueId;
      store.saveLeague(mapped.leagueId, mapped);
      // Saving it was not enough: the app renders whichever league is ACTIVE,
      // and this never made the imported one active. So once the sandbox had
      // been loaded even briefly, the mock league stayed on screen forever --
      // "Championship Bound", mock standings, an assessment computed on invented
      // rosters -- while every live sync landed in the store unseen. A draft you
      // are syncing is the league you are looking at.
      const SANDBOX = '48317-espn-mock';
      const prevLeague = previous ? store.state.leagues[previous] : null;
      const prevWasSandbox = !prevLeague || prevLeague.isSandbox || previous === SANDBOX;

      // Is the league on screen still being fed? Two rooms open at once means
      // both are syncing seconds apart. A room you have since left goes quiet.
      // Refusing every other league outright -- which the first version did --
      // meant that moving to a new draft left the app stuck on the old one for
      // good, showing rosters from a draft that had finished.
      const STALE_MS = 45 * 1000;
      const prevSeen = prevLeague && prevLeague.lastUpdated
        ? Date.parse(prevLeague.lastUpdated) : 0;
      const prevIsLive = prevSeen > 0 && (Date.now() - prevSeen) < STALE_MS;

      if (previous === mapped.leagueId || !previous || prevWasSandbox || !prevIsLive) {
        if (previous !== mapped.leagueId) {
          console.log('[Gridiron Edge] Now showing league ' + mapped.leagueId
            + (mapped.leagueName ? ' (' + mapped.leagueName + ')' : ''));
        }
        store.state.competingLeagueId = null;
      } else {
        // Both are live: two draft rooms open at once. Taking whichever posted
        // last made the app flip between drafts every few seconds and show a
        // roster belonging to neither. Keep the one on screen and say the other
        // exists rather than swapping under you.
        store.state.currentLeagueId = previous;
        store.state.competingLeagueId = mapped.leagueId;
      }
      // saveLeague already persisted and queued a notification; a second save()
      // here bought nothing but another full render of the draft page.
      store.scheduleNotify();
      return mapped;
    } catch (e) {
      console.error('Failed to import scraped payload:', e);
      throw new Error(`Import error: ${e.message}`);
    }
  }


  /**
   * ESPN fantasy stat identifiers, for the counting stats the roster engine
   * reasons about. Only the ones needed are listed; anything absent is treated
   * as unknown rather than zero.
   */
  static get STAT_IDS() {
    return {
      passAttempts: 0, passYards: 3, passTds: 4,
      rushAttempts: 23, rushYards: 24, rushTds: 25,
      receptions: 41, recYards: 42, recTds: 43, targets: 58,
    };
  }

  /**
   * Real per-game usage from ESPN's stat splits.
   *
   * This previously returned the same hardcoded numbers for every player --
   * 0.60 snap share, 5 carries, 0.15 target share, for a quarterback and a
   * third receiver alike. That silently disabled every usage-based judgement in
   * the roster engine while still looking like it worked, which is worse than
   * having no data at all. So when ESPN gives us nothing, this now returns
   * undefined and the engine falls back to explicitly not knowing.
   */
  extractUsage(player) {
    const ids = ESPNClient.STAT_IDS;
    const splits = (player && player.stats) || [];
    // Prefer season totals for the current season; fall back to any total.
    const season = splits.find(s => s.statSourceId === 0 && s.statSplitTypeId === 0)
      || splits.find(s => s.statSourceId === 0)
      || null;
    const raw = season && season.stats;
    if (!raw) return undefined;

    const g = Math.max(1, Number(season.appliedTotal ? season.games : 0) || this.gamesPlayed(raw));
    const val = (id) => {
      const v = raw[String(id)] ?? raw[id];
      return typeof v === 'number' && isFinite(v) ? v : 0;
    };

    const targets = val(ids.targets);
    const carries = val(ids.rushAttempts);
    const attempts = val(ids.passAttempts);
    if (targets + carries + attempts === 0) return undefined;

    return {
      // The engine's thresholds are PER GAME ("14 carries" means a workhorse),
      // so that is what these must be. Season totals are kept separately under
      // `season*` because the weekly trend is computed by differencing them.
      carries: carries / g,
      targets: targets / g,
      attempts: attempts / g,
      seasonTargets: targets,
      seasonCarries: carries,
      seasonAttempts: attempts,
      // Not exposed by this feed. Left undefined so the engine treats them as
      // unknown rather than inventing a number.
      snapShare: undefined,
      targetShare: undefined,
      redZoneTargets: undefined,
      redZoneCarries: undefined,
    };
  }

  gamesPlayed(raw) {
    // ESPN does not always send a games field; approximate from a volume stat.
    const ids = ESPNClient.STAT_IDS;
    const yards = (raw[String(ids.recYards)] || 0) + (raw[String(ids.rushYards)] || 0)
      + (raw[String(ids.passYards)] || 0);
    return yards > 0 ? Math.max(1, Math.round(yards / 60)) : 1;
  }

  /**
   * Share of a player's fantasy points that came from touchdowns.
   *
   * Feeds the median-ranking adjustment in the draft engine, which is worth
   * +2 to +6 points of championship probability and is a no-op without it.
   */
  extractTdShare(player) {
    const ids = ESPNClient.STAT_IDS;
    const splits = (player && player.stats) || [];
    const season = splits.find(s => s.statSourceId === 0 && s.statSplitTypeId === 0)
      || splits.find(s => s.statSourceId === 0);
    const raw = season && season.stats;
    const total = season && Number(season.appliedTotal);
    if (!raw || !total || total <= 0) return undefined;
    const val = (id) => Number(raw[String(id)] ?? raw[id]) || 0;
    const tdPoints = 6 * val(ids.rushTds) + 6 * val(ids.recTds) + 4 * val(ids.passTds);
    return Math.max(0, Math.min(1, tdPoints / total));
  }

  mapDOMScrapedLeague(espnData) {
    const leagueId = String(espnData.leagueId);
    
    // Map teams
    const teams = (espnData.teams || []).map(t => {
      return {
        teamId: t.teamId,
        teamName: t.teamName,
        managerName: t.managerName,
        faabRemaining: typeof t.faabRemaining === 'number' ? t.faabRemaining : 200,
        roster: [],
        record: { wins: 0, losses: 0, ties: 0 },
        pointsScored: 0,
        pointsAllowed: 0
      };
    });

    // Real projections when available; mock data only as a visible fallback.
    const db = (realDb && Object.keys(realDb).length)
      ? Object.assign({}, realDb)
      : Object.assign({}, mockPlayers);

    // Match draft picks to players in mockPlayers database
    const selections = [];
    
    if (espnData.draftDetail && espnData.draftDetail.picks) {
      espnData.draftDetail.picks.forEach(p => {
        try {
        // Resolve the same way a nomination does. This used to be raw name
        // comparison while only the nomination path used findPlayer, so the
        // punctuation and naming differences that resolver exists to absorb --
        // "Texans D/ST" against "Houston Texans" among them -- were left to a
        // substring test that cannot bridge them.
        let match = findPlayer(db, p.playerName, p.playerPosition, p.playerTeam,
                                 typeof p.bidAmount === 'number' ? p.bidAmount : undefined);

        if (!match) {
          // Same construction as a nomination we cannot place. This used to
          // invent projectedPoints: 10.0 -- a mid-range guess for a player we
          // know nothing about, which then flowed into every ceiling and every
          // roster ranking as though it were measured.
          match = unresolvedPlayer(p.playerName, p.playerPosition, p.playerTeam);
          db[match.id] = match;
        }

        if (match) {
          // A pick whose owner could not be identified still belongs in the
          // selection list -- the player is off the board either way -- but it
          // must not be handed to a team. Attributing it to a guess corrupts
          // that roster and the budget model the bid ceilings read from.
          const ownerId = typeof p.drafterTeamId === 'number' ? p.drafterTeamId : null;
          selections.push({
            pick: p.overallPickNumber,
            playerId: String(match.id),
            teamId: ownerId,
            // Price paid, when the draft room shows it. Drives the auction
            // engine's read on which managers overpay.
            bidAmount: typeof p.bidAmount === 'number' ? p.bidAmount : undefined
          });
          
          // Dynamically populate roster for the team
          const team = ownerId === null ? null : teams.find(t => t.teamId === ownerId);
          if (team) {
            team.roster.push(String(match.id));
          }
        }
        } catch (err) {
          // One unresolvable pick must cost one roster slot, not the sync. This
          // threw partway through the loop and aborted the entire import, so a
          // single odd name emptied the whole app.
          console.warn('[Gridiron Edge] Skipped pick "'
            + (p && p.playerName) + '": ' + err.message);
        }
      });
    }

    let currentNomination = null;
    let currentNominationBid = null;
    let currentNominationMax = null;
    if (espnData.currentNomination) {
      // One resolver for both mappers -- see resolveNomination above.
      const match = resolveNomination(db, espnData.currentNomination);
      if (match && match.isUnknownPlayer) db[match.id] = match;
      currentNomination = match ? match.name : null;
      // Carry the live bid alongside the name so the advisor can price against
      // what the player is actually going for right now.
      currentNominationBid = typeof espnData.currentNomination === 'object'
        && typeof espnData.currentNomination.bid === 'number'
        ? espnData.currentNomination.bid : null;
      // ESPN publishes the most this manager can still bid. Preferring it over
      // our own arithmetic means the ceiling can never exceed what the draft
      // room will actually accept.
      currentNominationMax = typeof espnData.currentNomination === 'object'
        && typeof espnData.currentNomination.maxAffordable === 'number'
        ? espnData.currentNomination.maxAffordable : null;
    }

    const draftState = {
      draftType: 'auction', // For mock Salary Cap drafts, force Auction mode
      draftOrder: teams.map(t => t.teamId),
      currentPick: selections.length + 1,
      selections: selections,
      currentNomination: currentNomination,
      currentNominationBid: currentNominationBid,
      currentNominationMax: currentNominationMax
    };

    const positionLimits = {
      QB: 1,
      RB: 2,
      WR: 2,
      TE: 1,
      FLEX: 1,
      "D/ST": 1,
      K: 1,
      BE: 7,
      IR: 1,
      startersCount: 9,
      benchCount: 7
    };

    return {
      leagueId,
      leagueName: espnData.leagueName || 'Scraped ESPN Draft',
      // What ESPN says has been drafted, so the app can tell when it has parsed
      // fewer picks than the room has made rather than quietly recommending
      // players somebody already owns.
      picksMadeOnEspn: typeof espnData.picksMadeOnEspn === 'number'
        ? espnData.picksMadeOnEspn : undefined,
      leagueSize: teams.length || 8,
      // Null, not 1. Defaulting to the first team is a guess wearing the
      // clothes of a fact: it silently shows you somebody else's roster, and
      // every bid ceiling is computed against the roster it thinks is yours.
      // An unknown owner is a question the interface can ask; a wrong one is
      // not something it can detect.
      myTeamId: typeof espnData.myTeamId === 'number' ? espnData.myTeamId : null,
      scoringFormat: 'PPR',
      rosterSettings: positionLimits,
      waiverSettings: {
        faabBudget: 100,
        processingDays: ['Wednesday', 'Thursday'],
        waiverType: 'FAAB'
      },
      teams,
      schedule: [],
      draftState,
      transactionHistory: [],
      playerDatabase: db
    };
  }

  /**
   * Maps ESPN's complex JSON into Gridiron Edge normalized schema.
   */
  mapESPNLeague(espnData) {
    if (espnData.isDOMScraped) {
      return this.mapDOMScrapedLeague(espnData);
    }
    const settings = espnData.settings || {};
    const rosterSettings = settings.rosterSettings || {};
    const scheduleSettings = settings.scheduleSettings || {};
    const scoringSettings = settings.scoringSettings || {};

    // 1. Map scoring format (PPR, half-PPR, standard)
    let scoringFormat = 'Standard';
    if (scoringSettings.scoringItems) {
      // Find receptions weight (15 is usually the ID for receptions in ESPN)
      const receptionsScoring = scoringSettings.scoringItems.find(item => item.statId === 53);
      if (receptionsScoring) {
        const pprValue = receptionsScoring.points || 0;
        if (pprValue >= 1) scoringFormat = 'PPR';
        else if (pprValue >= 0.5) scoringFormat = 'Half-PPR';
      }
    }

    // 2. Map position configuration limits
    const rawSlots = rosterSettings.lineupSlotCounts || {};
    const positionLimits = {
      QB: rawSlots["0"] || 1,      // ESPN ID 0 = QB
      RB: rawSlots["2"] || 2,      // ESPN ID 2 = RB
      WR: rawSlots["4"] || 2,      // ESPN ID 4 = WR
      TE: rawSlots["6"] || 1,      // ESPN ID 6 = TE
      FLEX: rawSlots["23"] || 1,   // ESPN ID 23 = FLEX (RB/WR/TE)
      "D/ST": rawSlots["16"] || 1, // ESPN ID 16 = D/ST
      K: rawSlots["17"] || 1,      // ESPN ID 17 = Kicker
      BE: rawSlots["20"] || 7,     // ESPN ID 20 = Bench
      IR: rawSlots["21"] || 1,     // ESPN ID 21 = IR
      startersCount: 9,
      benchCount: 7
    };
    
    // Compute total roster slot counts
    let startersCount = 0;
    for (const key of ['QB', 'RB', 'WR', 'TE', 'FLEX', 'D/ST', 'K']) {
      startersCount += positionLimits[key] || 0;
    }
    positionLimits.startersCount = startersCount;
    positionLimits.benchCount = positionLimits.BE;

    // 3. Map teams list
    const teams = (espnData.teams || []).map(t => {
      const wins = t.record?.overall?.wins || 0;
      const losses = t.record?.overall?.losses || 0;
      const ties = t.record?.overall?.ties || 0;

      // Extract rosters
      const rosterList = [];
      if (t.roster && t.roster.entries) {
        t.roster.entries.forEach(entry => {
          if (entry.playerPoolEntry && entry.playerPoolEntry.player) {
            rosterList.push(String(entry.playerPoolEntry.player.id));
          }
        });
      }

      return {
        teamId: t.id,
        teamName: `${t.location} ${t.nickname}`,
        managerName: t.owners && t.owners.length > 0 ? `Manager ${t.owners[0].substring(0, 5)}` : 'Opponent Manager',
        faabRemaining: t.transactionCounter?.remainingBudget ?? 100,
        roster: rosterList,
        record: { wins, losses, ties },
        pointsScored: t.record?.overall?.pointsFor || 0,
        pointsAllowed: t.record?.overall?.pointsAgainst || 0
      };
    });

    // 4. Map draft sequence details
    const draftDetail = espnData.draftDetail || {};
    const selections = [];
    if (draftDetail.picks) {
      draftDetail.picks.forEach(p => {
        selections.push({
          pick: p.overallPickNumber,
          playerId: String(p.playerId),
          teamId: p.teamId
        });
      });
    }

    let currentNomination = null;
    let currentNominationBid = null;
    let currentNominationMax = null;
    if (espnData.currentNomination) {
      
      // Resolved against the real database, which is built further down this
      // function -- so the resolution happens after it exists, not before.
      const match = resolveNomination(realDb || {}, espnData.currentNomination);
      currentNomination = match ? match.name : null;
      // Carry the live bid alongside the name so the advisor can price against
      // what the player is actually going for right now.
      currentNominationBid = typeof espnData.currentNomination === 'object'
        && typeof espnData.currentNomination.bid === 'number'
        ? espnData.currentNomination.bid : null;
      // ESPN publishes the most this manager can still bid. Preferring it over
      // our own arithmetic means the ceiling can never exceed what the draft
      // room will actually accept.
      currentNominationMax = typeof espnData.currentNomination === 'object'
        && typeof espnData.currentNomination.maxAffordable === 'number'
        ? espnData.currentNomination.maxAffordable : null;
    }

    const draftState = {
      draftType: settings.draftSettings?.type?.toLowerCase() || 'snake',
      draftOrder: settings.draftSettings?.pickOrder || teams.map(t => t.teamId),
      currentPick: selections.length + 1,
      selections: selections,
      currentNomination: currentNomination,
      currentNominationBid: currentNominationBid,
      currentNominationMax: currentNominationMax
    };

    // 5. Map Schedule Matchups
    const schedule = [];
    if (espnData.schedule) {
      espnData.schedule.forEach((match, idx) => {
        if (match.matchupPeriodId) {
          schedule.push({
            week: match.matchupPeriodId,
            matchupId: idx + 1,
            team1Id: match.away?.teamId || 0,
            team1Proj: match.away?.totalPointsLive || match.away?.totalPoints || 100,
            team2Id: match.home?.teamId || 0,
            team2Proj: match.home?.totalPointsLive || match.home?.totalPoints || 100
          });
        }
      });
    }

    // 6. Map transaction logs
    const transactionHistory = [];
    if (espnData.transactions) {
      espnData.transactions.forEach(tx => {
        transactionHistory.push({
          timestamp: new Date(tx.proposedDate).toISOString(),
          teamId: tx.teamId,
          type: tx.type.toLowerCase(),
          add: tx.items?.find(i => i.type === 'ADD')?.playerId,
          drop: tx.items?.find(i => i.type === 'DROP')?.playerId
        });
      });
    }

    // 7. Inject player catalog mapping
    // Note: In production, we parse espnData.players to construct our player database.
    // For MVP, if ESPN doesn't supply a full catalog, we supplement it with our high-fidelity mock list.
    const playerDatabase = {};
    if (espnData.players) {
      espnData.players.forEach(p => {
        const player = p.player || {};
        playerDatabase[player.id] = {
          id: String(player.id),
          name: player.fullName,
          position: this.mapESPNPosition(player.defaultPositionId),
          team: player.proTeamId ? String(player.proTeamId) : 'FA',
          // Keyed like every other record: without a key it is invisible to
          // findPlayer AND it defeats the database index for everyone else.
          key: playerKey(player.fullName || ''),
          // No invented mid-range guess: unknown means replacement level.
          projectedPoints: typeof p.ratings?.overall?.projectedPoints === 'number'
            ? p.ratings.overall.projectedPoints : replacementPoints(mapESPNPosition(player.defaultPositionId)),
          volatility: this.getVolatilityByPos(player.defaultPositionId),
          injuryStatus: this.mapESPNInjury(player.injuryStatus),
          byeWeek: player.byeWeek || 6,
          adp: player.averageDraftPosition || 150.0,
          matchProjs: { w1: 10, w2: 10, w3: 10 },
          opponent: 'OPP',
          metrics: this.extractUsage(player),
          tdShare: this.extractTdShare(player)
        };
      });
    } else {
      // Re-populate store player pool from default
      Object.assign(playerDatabase, mockPlayers);
    }

    return {
      leagueId: String(espnData.id || settings.leagueId),
      leagueName: settings.name || 'Imported ESPN League',
      leagueSize: settings.size || teams.length || 12,
      myTeamId: 1, // Default user's team is first (reconciled later by UI)
      scoringFormat,
      rosterSettings: positionLimits,
      waiverSettings: {
        faabBudget: settings.restrictionSettings?.waiverBudget || 100,
        processingDays: ['Wednesday', 'Thursday'],
        waiverType: settings.restrictionSettings?.waiverLimitType || 'FAAB'
      },
      teams,
      schedule,
      draftState,
      transactionHistory,
      playerDatabase
    };
  }

  mapESPNPosition(positionId) {
    switch (positionId) {
      case 1: return 'QB';
      case 2: return 'RB';
      case 3: return 'WR';
      case 4: return 'TE';
      case 5: return 'K';
      case 16: return 'D/ST';
      default: return 'FLEX';
    }
  }

  mapESPNInjury(status) {
    if (!status) return 'Healthy';
    switch (status.toUpperCase()) {
      case 'QUESTIONABLE': return 'Questionable';
      case 'DOUBTFUL': return 'Doubtful';
      case 'OUT': return 'Out';
      case 'IR': return 'IR';
      case 'SUSPENDED': return 'Suspended';
      default: return 'Healthy';
    }
  }

  getVolatilityByPos(posId) {
    // QB (lower), RB (mid-high), WR (high), TE (mid), K (low), DST (high)
    switch (posId) {
      case 1: return 3.5;
      case 2: return 4.5;
      case 3: return 5.0;
      case 4: return 3.8;
      case 5: return 2.0;
      case 16: return 4.2;
      default: return 4.0;
    }
  }

  /**
   * Loads high-fidelity mock data as a default league sandbox.
   */
  loadMockLeague() {
    store.updatePlayerDatabase(mockPlayers);
    // Flagged so the interface can say out loud that nothing on screen is real.
    store.saveLeague(mockLeague.leagueId, { ...mockLeague, isSandbox: true });
    store.setActiveLeagueId(mockLeague.leagueId);
  }
}

const espnClient = new ESPNClient();
window.espnClient = espnClient;
export default espnClient;
