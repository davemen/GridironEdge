/**
 * Gridiron Edge Central State Store
 * Handles localStorage persistence and provides reactive actions.
 */

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
      if (!this.state.leagues || typeof this.state.leagues !== 'object') this.state.leagues = {};
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
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
    const bySeen = ids
      .filter((id) => id !== keepId)
      .sort((a, b) => Date.parse(this.state.leagues[b].lastUpdated || 0)
        - Date.parse(this.state.leagues[a].lastUpdated || 0));
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
    const existing = this.state.playerDatabase;
    const merged = {};
    Object.keys(playersMap).forEach((id) => {
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
   *   - the only caller repo-wide is loadMockLeague. A live sync goes
   *     importScrapedPayload -> saveLeague and never comes through here, so no
   *     history accumulates and opportunityTrend's `h.length >= 10` can never
   *     fire outside the sandbox.
   *   - the deduplication below is inert. `week` falls back to
   *     `this.state.currentScoringPeriod`, which is not in defaultState and is
   *     not written anywhere in the repo, so `week` is always null and the
   *     guard that needs `week !== null` never runs.
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
      const totalRounds = league.rosterSettings.startersCount + league.rosterSettings.benchCount;
      const totalPicks = league.leagueSize * totalRounds;
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
    if (this.state.playerDatabase[playerId]) {
      this.state.playerDatabase[playerId].drafted = true;
      this.state.playerDatabase[playerId].draftedAtPick = pickNumber;
      this.state.playerDatabase[playerId].draftedCost = bidAmount;
    }

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

    if (this.state.playerDatabase[playerId]) {
      this.state.playerDatabase[playerId].drafted = true;
      this.state.playerDatabase[playerId].draftedAtPick = pickNumber;
      this.state.playerDatabase[playerId].draftedCost = bidAmount;
    }

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
      this.state.playerDatabase[playerId].drafted = false;
      delete this.state.playerDatabase[playerId].draftedAtPick;
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
        this.state.playerDatabase[pid].drafted = false;
        delete this.state.playerDatabase[pid].draftedAtPick;
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
        this.state.playerDatabase[dropPlayerId].ownerId = null;
      }
    }

    // Add second
    if (addPlayerId) {
      if (!team.roster.includes(addPlayerId)) {
        team.roster.push(addPlayerId);
      }
      if (this.state.playerDatabase[addPlayerId]) {
        this.state.playerDatabase[addPlayerId].ownerId = teamId;
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
