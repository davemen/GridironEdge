/**
 * Gridiron Edge Central State Store
 * Handles localStorage persistence and provides reactive actions.
 */

import { rosterSize } from './engine/lineup-rules.js';

const STORAGE_KEY = 'gridiron_edge_state';

/**
 * How many leagues are kept. See pruneLeagues -- this is a quota ceiling, not
 * a limit on how many drafts you may follow at once.
 */
const MAX_LEAGUES = 8;

/**
 * A key an outsider chose, that is still just a key.
 *
 * League ids and player ids both arrive from a scrape and are both used as
 * object keys. "__proto__" as a player id made Object.getPrototypeOf(db)
 * return the injected record and String(db) throw a TypeError.
 */
export function isSafeKey(key) {
  const k = String(key);
  return k.length > 0 && k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
}


/**
 * Every league keeps its own copy of the player database, and every copy is
 * the same 523 records plus a handful of unresolved stubs.
 *
 * Measured at about 128KB per league serialised: twenty-one leagues came to
 * 2.7MB against a 5-10MB localStorage quota, and once save() starts failing
 * the app runs on state that is never persisted.
 *
 * This saved nothing at all until the projections were published as the shared
 * copy. `state.playerDatabase` was written only by loadMockLeague, so on a real
 * league `shared` was empty, `own` became the entire database, and each league
 * stored all 523 records inside an extra wrapper -- zero bytes saved for
 * +1.5ms of blocked main thread per sync tick. espn-client publishes them now,
 * which is what makes the paragraph above true rather than aspirational.
 *
 * The shared records are written once, at state.playerDatabase. A league
 * stores only what it holds that the shared copy does not -- the stubs the
 * mapper creates for names it could not resolve, which are genuinely
 * per-league and must survive a reload, because a pick stored under a stub id
 * is unreadable without it.
 */
const SHARED_DB = '__shared__';

function shareDatabase() {
  return function replacer(key, value) {
    if (key !== 'playerDatabase' || !value || typeof value !== 'object') return value;
    // `this` is the object being serialised: the state itself, or one league.
    if (this === undefined || !this.leagueId) return value;   // the shared copy
    const shared = store.state.playerDatabase || {};
    const own = {};
    // hasOwnProperty, not `!shared[id]`: a record keyed toString or constructor
    // resolves through the prototype, so it looked already-shared, was dropped,
    // and came back on restore as an inherited function -- which anything
    // reading .name then rendered as the player "Object".
    Object.keys(value).forEach((id) => {
      if (!Object.prototype.hasOwnProperty.call(shared, id)) own[id] = value[id];
    });
    return { [SHARED_DB]: true, own };
  };
}

function restoreSharedDatabase(state) {
  const shared = state.playerDatabase || {};
  Object.values(state.leagues || {}).forEach((league) => {
    const db = league && league.playerDatabase;
    if (!db || !db[SHARED_DB]) return;
    league.playerDatabase = { ...shared, ...(db.own || {}) };
  });
}

const defaultState = {
  currentLeagueId: null,
  leagues: {}, // Map of leagueId -> League data
  playerDatabase: {}, // PlayerID -> Player object
  activeTab: 'home',
  theme: 'dark',
  lastSyncTime: null
};

class Store {
  constructor() {
    this.state = { ...defaultState };
    this.listeners = [];
    this.load();
  }

  // Load state from localStorage
  load() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      // Merge over the defaults rather than replacing them. A stored state from
      // an older schema is valid JSON, so the catch below never fires -- but it
      // may have no `leagues` key at all, and getActiveLeague() then threw
      // reading a property of undefined. Every collection gets a floor.
      const parsed = data ? JSON.parse(data) : {};
      this.state = { ...defaultState, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
      restoreSharedDatabase(this.state);
      if (!this.state.leagues || typeof this.state.leagues !== 'object') this.state.leagues = {};
      // A stored league that is not an object is not a league. Keeping one made
      // pruneLeagues throw on its lastUpdated, and every subsequent saveLeague
      // threw with it, so persistence stopped without saying anything.
      Object.keys(this.state.leagues).forEach((id) => {
        const l = this.state.leagues[id];
        if (!l || typeof l !== 'object' || Array.isArray(l)) {
          console.warn('[Gridiron Edge] Dropped a stored entry that is not a league:', id);
          delete this.state.leagues[id];
        }
      });
      if (!this.state.playerDatabase || typeof this.state.playerDatabase !== 'object') {
        this.state.playerDatabase = {};
      }
      if (this.state.currentLeagueId && !this.state.leagues[this.state.currentLeagueId]) {
        this.state.currentLeagueId = null;
      }
    } catch (e) {
      console.error('Failed to load Gridiron Edge state from localStorage:', e);
      this.state = { ...defaultState };
    }
  }

  /**
   * Persist, then tell the app once.
   *
   * Two things were wrong here. `notify()` sat inside the `try`, so a failed
   * write -- the quota is reachable, since every league keeps its own copy of a
   * 523-player database -- silently skipped every listener and the app carried
   * on rendering state that was never saved. And one sync calls this twice
   * while the caller renders a third time, so a single scrape repainted the
   * draft page three times: measured at 628ms of blocked main thread per
   * three-second tick, two thirds of it duplication.
   *
   * Notifications now coalesce onto a microtask, so any number of saves in one
   * turn produce exactly one render, and a write failure is surfaced rather
   * than swallowed.
   */
  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state, shareDatabase()));
      this.persistFailed = false;
    } catch (e) {
      // Quota is the realistic cause. Keep going and tell the interface, rather
      // than pretending the write happened.
      this.persistFailed = true;
      this.persistError = e && e.name ? e.name : 'StorageError';
      console.error('Failed to save Gridiron Edge state to localStorage:', e);
    }
    this.scheduleNotify();
  }

  /** Collapse a burst of saves into a single notification. */
  scheduleNotify() {
    if (this._notifyQueued) return;
    this._notifyQueued = true;
    Promise.resolve().then(() => {
      this._notifyQueued = false;
      this.notify();
    });
  }

  // Register state change listener
  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  // Notify all state change listeners
  notify() {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  // Get current active league
  getActiveLeague() {
    if (!this.state.currentLeagueId) return null;
    return this.state.leagues[this.state.currentLeagueId] || null;
  }

  // Set the current active league ID
  setActiveLeagueId(leagueId) {
    this.state.currentLeagueId = leagueId;
    this.save();
  }

  // Save or update a league's details
  saveLeague(leagueId, leagueData) {
    // A key that came off the wire must not be able to reach the prototype.
    // playerDatabase[player.id] and leagues[leagueId] are both attacker-keyed:
    // an id of "__proto__" made Object.getPrototypeOf() return the injected
    // record and String(db) throw. No Object.prototype pollution followed --
    // that was checked -- but a map whose shape an outsider chooses is one
    // change away from it.
    if (!isSafeKey(leagueId)) {
      console.warn('[Gridiron Edge] Refused a league id that is not a plain key:', leagueId);
      return;
    }
    this.state.leagues[leagueId] = {
      ...this.state.leagues[leagueId],
      ...leagueData,
      lastUpdated: new Date().toISOString()
    };
    this.state.currentLeagueId = leagueId;
    this.state.lastSyncTime = new Date().toISOString();
    this.pruneLeagues(leagueId);
    this.save();
  }

  /**
   * Keep the most recently seen leagues and drop the rest.
   *
   * Nothing bounded this. Each league carries its own copy of the 523-player
   * database -- about 128KB serialised -- so twenty-one leagues measured 2.7MB
   * against a 5-10MB localStorage quota. A sync loop with rotating league ids
   * fills it, and once save() starts failing the app runs on state that is
   * never persisted. Ordinary use never reaches this: it is the ceiling, not a
   * policy about how many drafts you may follow.
   */
  pruneLeagues(keepId) {
    const ids = Object.keys(this.state.leagues);
    if (ids.length <= MAX_LEAGUES) return;
    // Insertion order breaks ties, because lastUpdated ties are ordinary: two
    // leagues synced in the same millisecond have no older one, and sorting on
    // the timestamp alone left which of them survived up to the sort's own
    // stability. That is a coin flip deciding whose draft is dropped.
    const seenAt = (id) => Date.parse(this.state.leagues[id].lastUpdated || 0) || 0;
    const order = new Map(ids.map((id, i) => [id, i]));
    const bySeen = ids
      .filter((id) => id !== keepId)
      .sort((a, b) => (seenAt(b) - seenAt(a)) || (order.get(b) - order.get(a)));
    bySeen.slice(MAX_LEAGUES - 1).forEach((id) => {
      delete this.state.leagues[id];
      if (this.state.currentLeagueId === id) this.state.currentLeagueId = keepId;
    });
  }

  // Delete a league from local storage
  deleteLeague(leagueId) {
    if (this.state.leagues[leagueId]) {
      delete this.state.leagues[leagueId];
      if (this.state.currentLeagueId === leagueId) {
        const remainingKeys = Object.keys(this.state.leagues);
        this.state.currentLeagueId = remainingKeys.length > 0 ? remainingKeys[0] : null;
      }
      this.save();
    }
  }

  // Set standard list of players in the player database
  updatePlayerDatabase(playersMap) {
    // Same key gate as saveLeague. These are PLAYER ids, which is the vector
    // the comment on isSafeKey names -- and this was the one attacker-keyed
    // write with no gate at all.
    const existing = this.state.playerDatabase;
    const merged = {};
    Object.keys(playersMap).forEach((id) => {
      if (!isSafeKey(id)) {
        console.warn('[Gridiron Edge] Refused a player id that is not a plain key:', id);
        return;
      }
      const incoming = playersMap[id];
      const prior = existing[id];
      merged[id] = prior
        ? { ...prior, ...incoming, metricsHistory: prior.metricsHistory }
        : incoming;
    });
    this.state.playerDatabase = { ...existing, ...merged };
    this.recordWeeklyMetrics();
    this.save();
  }

  /**
   * Keep a weekly snapshot of every player's usage.
   *
   * Recent opportunity -- targets, carries, attempts -- is the only public
   * signal found that projections have not already absorbed (r = 0.086 against
   * the residual, same sign in all five seasons 2021-2025). But a trend needs
   * history, and an import only ever shows the present. So each refresh appends
   * one snapshot per player, and from roughly week 10 the engines could see
   * which roles are growing rather than only which players scored.
   *
   * COULD, not can. Two things stop this working on a real league, and both are
   * recorded here rather than left for the next reader to rediscover:
   *
   *   - it runs, but over records that have no `.metrics`. The only caller is
   *     `updatePlayerDatabase`, reached twice: from `realDbReady` at module
   *     init with the 523-player projections database, and from
   *     `loadMockLeague` with the 31 mock players. `toPlayerDatabase` builds
   *     fourteen fields and `metrics` is not one of them, so every one of the
   *     523 hits the `!p.metrics` guard below and is skipped. All 31 mock
   *     players carry metrics, which is why this looks wired in the sandbox.
   *     (An earlier version of this comment said the only caller repo-wide was
   *     loadMockLeague. It was not; the live path does reach here, it just has
   *     nothing to record. The conclusion held for the wrong reason, which is
   *     the kind of comment that survives a reading and fails a grep.)
   *   - and a live SYNC still never comes through here at all:
   *     importScrapedPayload -> saveLeague is its own path, so no history
   *     accumulates between refreshes and opportunityTrend's `h.length >= 10`
   *     cannot fire outside the sandbox.
   *   - the deduplication below is inert. `week` falls back to
   *     `this.state.currentScoringPeriod`, which is not in defaultState (see
   *     line 79) and is not written anywhere in the repo, so `week` is always
   *     null and the guard that needs `week !== null` never runs.
   *
   * BACKTEST.md Part 9 identifies this as the one unpriced signal it found, so
   * wiring it up is worth doing -- but saying it works when it does not is how
   * a measured result turns into a claim nobody checks.
   */
  recordWeeklyMetrics(period = null) {
    const week = period ?? this.state.currentScoringPeriod ?? null;
    const db = this.state.playerDatabase;
    Object.keys(db).forEach((id) => {
      const p = db[id];
      if (!p || !p.metrics) return;
      const hist = Array.isArray(p.metricsHistory) ? p.metricsHistory : [];
      const last = hist[hist.length - 1];
      if (last && week !== null && last.week === week) return;   // already logged
      // Cumulative season totals are recorded, not per-game rates, because
      // differencing consecutive snapshots is what recovers a single week's
      // usage. Averaging rates would smear a role change across the season.
      hist.push({
        week,
        seasonTargets: p.metrics.seasonTargets ?? 0,
        seasonCarries: p.metrics.seasonCarries ?? 0,
        seasonAttempts: p.metrics.seasonAttempts ?? 0,
      });
      // Two full seasons is far more than any trend window needs.
      p.metricsHistory = hist.slice(-40);
    });
  }

  /**
   * Share of a player's fantasy points that came from touchdowns last season.
   *
   * Feeds the median-ranking adjustment in the draft engine, which is worth
   * +2 to +6 points of championship probability but is a no-op without this
   * number. Accepts whatever a stats feed can supply -- either the share
   * directly, or last season's touchdown counts and total points to derive it.
   *
 * DEFINED AND NOT CALLED. grep across js/, test/ and index.html returns this
 * definition and one paragraph in BACKTEST.md. That paragraph used to cite
 * this method as evidence the adjustment was live; it now says the opposite,
 * and gives the two further reasons the field never arrives: `extractTdShare`
 * is called only from mapESPNLeague's public-API branch, which
 * mapDOMScrapedLeague bypasses on every scraped import, and 0 of 523 players
 * in data/projections-2026.json carry the field. Wiring it is worth doing;
 * claiming it is wired was the failure, and for a while the repo held two
 * documents contradicting each other about one method.
 */
  setPriorSeasonScoring(statsById) {
    const db = this.state.playerDatabase;
    Object.keys(statsById || {}).forEach((id) => {
      const p = db[id];
      const st = statsById[id];
      if (!p || !st) return;
      if (typeof st.tdShare === 'number') {
        p.tdShare = st.tdShare;
        return;
      }
      const total = Number(st.fantasyPoints);
      if (!total || total <= 0) return;
      const tdPoints = 6 * (Number(st.rushingTds) || 0)
        + 6 * (Number(st.receivingTds) || 0)
        + 4 * (Number(st.passingTds) || 0);
      p.tdShare = Math.max(0, Math.min(1, tdPoints / total));
    });
    this.save();
  }

  // Set active page tab
  setActiveTab(tabName) {
    this.state.activeTab = tabName;
    this.save();
  }

  // Toggle UI theme between dark and light
  toggleTheme() {
    const nextTheme = this.state.theme === 'light' ? 'dark' : 'light';
    this.state.theme = nextTheme;
    document.documentElement.setAttribute('data-theme', nextTheme);
    this.save();
  }

  // Get user details
  getMyTeam() {
    const league = this.getActiveLeague();
    if (!league) return null;
    return league.teams.find(t => t.teamId === league.myTeamId) || null;
  }

  // Records a drafted pick in draftState
  recordDraftPick(pickNumber, playerId, bidAmount = 1) {
    const league = this.getActiveLeague();
    if (!league || !league.draftState) return;

    // Check if player is already drafted
    const existingPick = league.draftState.selections.find(s => s.pick === pickNumber);
    if (existingPick) {
      existingPick.playerId = playerId;
      existingPick.bidAmount = bidAmount;
    } else {
      const draftOrder = league.draftState.draftOrder;
      const totalPicks = league.leagueSize * rosterSize(league);
      if (pickNumber > totalPicks) return;

      // Determine team that owns the pick
      // For snake drafts:
      const round = Math.floor((pickNumber - 1) / league.leagueSize) + 1;
      const relativePick = (pickNumber - 1) % league.leagueSize;
      let teamIndex = relativePick;
      if (league.draftState.draftType === 'snake' && round % 2 === 0) {
        teamIndex = league.leagueSize - 1 - relativePick;
      }
      const teamId = draftOrder[teamIndex];

      league.draftState.selections.push({
        pick: pickNumber,
        playerId: playerId,
        teamId: teamId,
        bidAmount: bidAmount
      });
    }

    // Set current pick counter
    league.draftState.currentPick = pickNumber + 1;

    // Update player availability
    // Draft state does NOT live on the player record.
    //
    // These wrote `drafted`, `draftedAtPick`, `draftedCost` and `ownerId` onto
    // the SHARED player database -- and since that database went live on the
    // real path, every league holds the same record objects. So drafting a
    // player in one league marked him drafted in all of them, and it persisted:
    // a false availability reading is indistinguishable on screen from a true
    // one, which is the failure mode this repo exists to avoid.
    //
    // Nothing read any of the four -- a repo-wide grep outside this file
    // returns zero -- so they were pure cost. Who owns whom is answered by
    // draftState.selections and the rosters rebuilt from it, which is one
    // definition rather than two that can disagree.

    // Reflect draft changes in roster
    this.rebuildRostersFromDraft(league);
    this.save();
  }

  // Records a drafted pick in auction format (by winning team & bid amount)
  recordDraftPickAuction(playerId, teamId, bidAmount) {
    const league = this.getActiveLeague();
    if (!league || !league.draftState) return;

    const selections = league.draftState.selections || [];
    const pickNumber = selections.length + 1;

    selections.push({
      pick: pickNumber,
      playerId: playerId,
      teamId: teamId,
      bidAmount: bidAmount
    });

    league.draftState.currentPick = pickNumber + 1;

    // Deduct budget
    const team = league.teams.find(t => t.teamId === teamId);
    if (team) {
      team.faabRemaining = Math.max(0, team.faabRemaining - bidAmount);
    }

    // Draft state does not live on the player record -- see recordDraftPick.

    this.rebuildRostersFromDraft(league);
    this.save();
  }

  // Undo the last draft selection
  undoLastDraftPick() {
    const league = this.getActiveLeague();
    if (!league || !league.draftState || league.draftState.selections.length === 0) return;

    const lastPick = league.draftState.selections.pop();
    league.draftState.currentPick = lastPick.pick;

    // Mark player as available again
    const playerId = lastPick.playerId;
    if (playerId && this.state.playerDatabase[playerId]) {
    }

    this.rebuildRostersFromDraft(league);
    this.save();
  }

  // Clear all selections and reset current draft pick count to 1
  resetDraft() {
    const league = this.getActiveLeague();
    if (!league || !league.draftState) return;

    // Free all drafted players
    for (const selection of league.draftState.selections) {
      const pid = selection.playerId;
      if (pid && this.state.playerDatabase[pid]) {
      }
    }

    league.draftState.selections = [];
    league.draftState.currentPick = 1;
    this.rebuildRostersFromDraft(league);
    this.save();
  }

  // Re-distributes player ownership rosters based on draft state picks
  rebuildRostersFromDraft(league) {
    if (!league.draftState) return;
    
    // Clear draft-based ownership for all teams first
    for (const team of league.teams) {
      team.roster = [];
    }

    // Assign drafted players to teams
    for (const selection of league.draftState.selections) {
      if (!selection.playerId) continue;
      const team = league.teams.find(t => t.teamId === selection.teamId);
      if (team) {
        team.roster.push(selection.playerId);
      }
    }
  }

  // Perform a waiver transaction (Add-Drop)
  processTransaction(addPlayerId, dropPlayerId, teamId) {
    const league = this.getActiveLeague();
    if (!league) return;

    const team = league.teams.find(t => t.teamId === teamId);
    if (!team) return;

    // Drop first
    if (dropPlayerId) {
      team.roster = team.roster.filter(pid => pid !== dropPlayerId);
      if (this.state.playerDatabase[dropPlayerId]) {
      }
    }

    // Add second
    if (addPlayerId) {
      if (!team.roster.includes(addPlayerId)) {
        team.roster.push(addPlayerId);
      }
      if (this.state.playerDatabase[addPlayerId]) {
      }
    }

    // Record in history
    if (!league.transactionHistory) league.transactionHistory = [];
    league.transactionHistory.push({
      timestamp: new Date().toISOString(),
      teamId: teamId,
      type: 'waiver',
      add: addPlayerId,
      drop: dropPlayerId
    });

    this.save();
  }
}

// Global store instance
const store = new Store();
window.store = store; // Make it accessible globally
export default store;
