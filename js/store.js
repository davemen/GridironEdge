/**
 * Gridiron Edge Central State Store
 * Handles localStorage persistence and provides reactive actions.
 */

const STORAGE_KEY = 'gridiron_edge_state';

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
      if (data) {
        this.state = JSON.parse(data);
      } else {
        this.state = { ...defaultState };
      }
    } catch (e) {
      console.error('Failed to load Gridiron Edge state from localStorage:', e);
      this.state = { ...defaultState };
    }
  }

  // Save state to localStorage
  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      this.notify();
    } catch (e) {
      console.error('Failed to save Gridiron Edge state to localStorage:', e);
    }
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
    this.state.leagues[leagueId] = {
      ...this.state.leagues[leagueId],
      ...leagueData,
      lastUpdated: new Date().toISOString()
    };
    this.state.currentLeagueId = leagueId;
    this.state.lastSyncTime = new Date().toISOString();
    this.save();
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
    this.state.playerDatabase = {
      ...this.state.playerDatabase,
      ...playersMap
    };
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
