/**
 * Gridiron Edge ESPN API Client & Data Mapper
 * Fetches public ESPN APIs and maps raw payloads into our normalized schema.
 */

import store from './store.js';
import { mockPlayers, mockLeague } from './mock-data.js';

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
  importScrapedPayload(jsonPayload) {
    try {
      const parsed = typeof jsonPayload === 'string' ? JSON.parse(jsonPayload) : jsonPayload;
      if (!parsed.isDOMScraped && (!parsed.teams || !parsed.settings)) {
        throw new Error('Invalid scraped payload. Missing core structures.');
      }
      
      const mapped = this.mapESPNLeague(parsed);
      store.saveLeague(mapped.leagueId, mapped);
      return mapped;
    } catch (e) {
      console.error('Failed to import scraped payload:', e);
      throw new Error(`Import error: ${e.message}`);
    }
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

    const db = Object.assign({}, mockPlayers);

    // Match draft picks to players in mockPlayers database
    const selections = [];
    
    if (espnData.draftDetail && espnData.draftDetail.picks) {
      espnData.draftDetail.picks.forEach(p => {
        // Try finding a matching player by name in mockPlayers
        let match = Object.values(db).find(pl => pl.name.toLowerCase() === p.playerName.toLowerCase());
        
        if (!match) {
          // Substring match
          match = Object.values(db).find(pl => {
            const pName = p.playerName.toLowerCase();
            const plName = pl.name.toLowerCase();
            return pName.includes(plName) || plName.includes(pName);
          });
        }

        if (!match) {
          // Dynamic mock player
          const mockId = `MOCK_${p.playerName.replace(/\s+/g, '_')}`;
          match = {
            id: mockId,
            name: p.playerName,
            position: p.playerPosition || 'RB',
            team: p.playerTeam || 'FA',
            projectedPoints: 10.0,
            volatility: 4.0,
            injuryStatus: 'Healthy',
            byeWeek: 6,
            adp: 150.0
          };
          db[mockId] = match;
        }

        if (match) {
          selections.push({
            pick: p.overallPickNumber,
            playerId: String(match.id),
            teamId: p.drafterTeamId
          });
          
          // Dynamically populate roster for the team
          const team = teams.find(t => t.teamId === p.drafterTeamId);
          if (team) {
            team.roster.push(String(match.id));
          }
        }
      });
    }

    let currentNomination = null;
    if (espnData.currentNomination) {
      const nomName = typeof espnData.currentNomination === 'object' ? espnData.currentNomination.name : espnData.currentNomination;
      const nomTeam = typeof espnData.currentNomination === 'object' ? espnData.currentNomination.team : 'FA';
      const nomPos = typeof espnData.currentNomination === 'object' ? espnData.currentNomination.position : 'RB';
      
      let match = Object.values(db).find(pl => pl.name.toLowerCase() === nomName.toLowerCase());
      if (!match) {
        // Substring match
        match = Object.values(db).find(pl => {
          const pName = nomName.toLowerCase();
          const plName = pl.name.toLowerCase();
          return pName.includes(plName) || plName.includes(pName);
        });
      }
      
      if (!match) {
        const mockId = `MOCK_${nomName.replace(/\s+/g, '_')}`;
        match = {
          id: mockId,
          name: nomName,
          position: nomPos,
          team: nomTeam,
          projectedPoints: nomPos === 'QB' ? 17.5 : (nomPos === 'RB' ? 12.5 : (nomPos === 'WR' ? 11.8 : 9.5)),
          volatility: 4.0,
          injuryStatus: 'Healthy',
          byeWeek: 6,
          adp: 120.0
        };
        db[mockId] = match;
      }
      currentNomination = match.name;
    }

    const draftState = {
      draftType: 'auction', // For mock Salary Cap drafts, force Auction mode
      draftOrder: teams.map(t => t.teamId),
      currentPick: selections.length + 1,
      selections: selections,
      currentNomination: currentNomination
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
      leagueSize: teams.length || 8,
      myTeamId: typeof espnData.myTeamId === 'number' ? espnData.myTeamId : 1,
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
    if (espnData.currentNomination) {
      const nomName = typeof espnData.currentNomination === 'object' ? espnData.currentNomination.name : espnData.currentNomination;
      const nomTeam = typeof espnData.currentNomination === 'object' ? espnData.currentNomination.team : 'FA';
      const nomPos = typeof espnData.currentNomination === 'object' ? espnData.currentNomination.position : 'RB';
      
      let match = Object.values(playerDatabase).find(pl => pl.name.toLowerCase() === nomName.toLowerCase());
      if (!match) {
        const mockId = `MOCK_${nomName.replace(/\s+/g, '_')}`;
        match = {
          id: mockId,
          name: nomName,
          position: nomPos,
          team: nomTeam,
          projectedPoints: nomPos === 'QB' ? 17.5 : (nomPos === 'RB' ? 12.5 : (nomPos === 'WR' ? 11.8 : 9.5)),
          volatility: 4.0,
          injuryStatus: 'Healthy',
          byeWeek: 6,
          adp: 120.0
        };
        playerDatabase[mockId] = match;
      }
      currentNomination = match.name;
    }

    const draftState = {
      draftType: settings.draftSettings?.type?.toLowerCase() || 'snake',
      draftOrder: settings.draftSettings?.pickOrder || teams.map(t => t.teamId),
      currentPick: selections.length + 1,
      selections: selections,
      currentNomination: currentNomination
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
          projectedPoints: p.ratings?.overall?.projectedPoints || 10,
          volatility: this.getVolatilityByPos(player.defaultPositionId),
          injuryStatus: this.mapESPNInjury(player.injuryStatus),
          byeWeek: player.byeWeek || 6,
          adp: player.averageDraftPosition || 150.0,
          matchProjs: { w1: 10, w2: 10, w3: 10 },
          opponent: 'OPP',
          metrics: {
            snapShare: 0.60,
            targetShare: 0.15,
            redZoneTargets: 1,
            carries: 5,
            redZoneCarries: 1
          }
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
    store.saveLeague(mockLeague.leagueId, mockLeague);
    store.setActiveLeagueId(mockLeague.leagueId);
  }
}

const espnClient = new ESPNClient();
window.espnClient = espnClient;
export default espnClient;
