// Main world content script for Gridiron Edge ESPN Sync extension
// Accesses the page's React/Redux store directly and posts updates to the isolated content script

(function() {
  console.log("[Gridiron Edge Sync] Main world script initialized.");

  let lastSyncKey = null;

  function findCurrentNomination() {
    try {
      const card = document.querySelector('[data-testid="player-selected"], .player-selected, .pickArea');
      if (!card) return null;

      const nameEl = card.querySelector('.playerinfo__playername');
      const teamEl = card.querySelector('.playerinfo__playerteam');
      const posEl = card.querySelector('.playerinfo__playerpos');

      if (nameEl) {
        const name = nameEl.innerText ? nameEl.innerText.trim() : '';
        let team = teamEl && teamEl.innerText ? teamEl.innerText.trim().toUpperCase() : 'FA';
        let position = posEl && posEl.innerText ? posEl.innerText.trim().toUpperCase() : 'RB';

        if (name && name.length >= 2 && name.length <= 40) {
          if (position === 'D/ST') {
            const lowerName = name.toLowerCase();
            if (lowerName.includes('patriots')) team = 'NE';
            else if (lowerName.includes('ravens')) team = 'BAL';
            else if (lowerName.includes('49ers')) team = 'SF';
            else if (lowerName.includes('bills')) team = 'BUF';
            else if (lowerName.includes('cowboys')) team = 'DAL';
            else if (lowerName.includes('dolphins')) team = 'MIA';
            else if (lowerName.includes('jets')) team = 'NYJ';
            else if (lowerName.includes('eagles')) team = 'PHI';
            else if (lowerName.includes('chiefs')) team = 'KC';
            else if (lowerName.includes('raiders')) team = 'LV';
            else if (lowerName.includes('broncos')) team = 'DEN';
            else if (lowerName.includes('chargers')) team = 'LAC';
            else if (lowerName.includes('vikings')) team = 'MIN';
            else if (lowerName.includes('bears')) team = 'CHI';
            else if (lowerName.includes('packers')) team = 'GB';
            else if (lowerName.includes('lions')) team = 'DET';
            else if (lowerName.includes('buccaneers')) team = 'TB';
            else if (lowerName.includes('saints')) team = 'NO';
            else if (lowerName.includes('falcons')) team = 'ATL';
            else if (lowerName.includes('panthers')) team = 'CAR';
            else if (lowerName.includes('commanders')) team = 'WAS';
            else if (lowerName.includes('giants')) team = 'NYG';
            else if (lowerName.includes('cardinals')) team = 'ARI';
            else if (lowerName.includes('seahawks')) team = 'SEA';
            else if (lowerName.includes('rams')) team = 'LAR';
            else if (lowerName.includes('jaguars')) team = 'JAX';
            else if (lowerName.includes('colts')) team = 'IND';
            else if (lowerName.includes('titans')) team = 'TEN';
            else if (lowerName.includes('texans')) team = 'HOU';
            else if (lowerName.includes('steelers')) team = 'PIT';
            else if (lowerName.includes('browns')) team = 'CLE';
            else if (lowerName.includes('bengals')) team = 'CIN';
          }
          return { name, team, position };
        }
      }
    } catch (e) {}
    return null;
  }

  function scrapeDraftDOM() {
    try {
      const nflTeams = new Set(['DET', 'LAR', 'ATL', 'CIN', 'SEA', 'SF', 'GB', 'KC', 'BUF', 'DAL', 'PHI', 'MIA', 'NYJ', 'NE', 'LV', 'DEN', 'LAC', 'MIN', 'CHI', 'TB', 'NO', 'CAR', 'WAS', 'NYG', 'ARI', 'JAX', 'IND', 'TEN', 'HOU', 'BAL', 'PIT', 'CLE', 'FA']);
      const positions = new Set(['QB', 'RB', 'WR', 'TE', 'D/ST', 'K', 'FLEX']);
      
      const elements = document.querySelectorAll('tr, [role="row"], [class*="row" i], [class*="item" i], div');
      const selections = [];
      const seenPicks = new Set();

      elements.forEach(el => {
        if (!el || typeof el.innerText !== 'string') return;
        const text = el.innerText.trim();
        if (el.children.length > 8 || text.length > 150 || text.length < 10) return;
        const parts = text.split(/[\s\n]+/);
        if (parts.length < 3) return;
        
        let pick = -1;
        let nameStartIdx = 1;
        
        const firstPartNum = parseInt(parts[0], 10);
        if (!isNaN(firstPartNum) && firstPartNum > 0 && firstPartNum <= 300) {
          pick = firstPartNum;
          nameStartIdx = 1;
        } else if (parts[0].toLowerCase() === 'pick' || parts[0].toLowerCase() === 'pk') {
          const secondPartNum = parseInt(parts[1], 10);
          if (!isNaN(secondPartNum) && secondPartNum > 0 && secondPartNum <= 300) {
            pick = secondPartNum;
            nameStartIdx = 2;
          }
        }

        if (pick === -1 || seenPicks.has(pick)) return;

        let teamIdx = -1;
        let posIdx = -1;
        for (let i = nameStartIdx; i < parts.length; i++) {
          const pUpper = parts[i].toUpperCase();
          if (nflTeams.has(pUpper)) teamIdx = i;
          if (positions.has(pUpper)) posIdx = i;
        }

        if (teamIdx !== -1 && posIdx !== -1) {
          seenPicks.add(pick);
          
          const endIdx = Math.min(teamIdx, posIdx);
          const nameParts = parts.slice(nameStartIdx, endIdx);
          const playerName = nameParts.join(' ');

          const maxIdx = Math.max(teamIdx, posIdx);
          const remaining = parts.slice(maxIdx + 1);
          const drafterParts = remaining.filter(p => !p.startsWith('$') && !p.startsWith('-$') && isNaN(parseFloat(p)));
          const drafterTeamName = drafterParts.join(' ') || `Team ${pick}`;

          selections.push({
            overallPickNumber: pick,
            playerName,
            playerTeam: parts[teamIdx],
            playerPosition: parts[posIdx],
            drafterTeamName
          });
        }
      });

      if (selections.length > 0) {
        selections.sort((a, b) => a.overallPickNumber - b.overallPickNumber);
        return selections;
      }
    } catch (e) {}
    return null;
  }

  function isReduxStore(obj) {
    return obj && typeof obj.getState === 'function' && typeof obj.dispatch === 'function' && typeof obj.subscribe === 'function';
  }

  function searchObjForStore(obj, visited = new Set()) {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return null;
    visited.add(obj);

    if (isReduxStore(obj)) return obj;
    if (isReduxStore(obj.store)) return obj.store;

    try {
      for (const k of Object.keys(obj)) {
        try {
          const val = obj[k];
          if (isReduxStore(val)) return val;
        } catch (e) {}
      }
    } catch (e) {}
    return null;
  }

  function findStoreState() {
    if (window.__PRELOADED_STATE__) return window.__PRELOADED_STATE__;
    if (window.espn?.draft) return window.espn.draft;

    for (const key of Object.keys(window)) {
      if (key.toLowerCase().includes('draft') || key.toLowerCase().includes('espn') || key.toLowerCase().includes('redux') || key.toLowerCase().includes('state')) {
        try {
          const val = window[key];
          if (val && typeof val === 'object') {
            if (val.picks || val.selections || val.teams || val.draftDetail || val.settings) {
              return val;
            }
          }
        } catch (e) {}
      }
    }

    const allElements = document.querySelectorAll('*');
    const visitedFibers = new Set();
    for (const el of allElements) {
      const keys = Object.keys(el);
      const reactKey = keys.find(key => key.startsWith('__reactContainer$') || key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
      if (reactKey) {
        let node = el[reactKey];
        while (node) {
          if (visitedFibers.has(node)) break;
          visitedFibers.add(node);

          let store = searchObjForStore(node.memoizedProps) || 
                      searchObjForStore(node.stateNode) || 
                      searchObjForStore(node.updateQueue) || 
                      searchObjForStore(node.memoizedState);
          if (store) {
            const state = store.getState();
            if (state) return state;
          }
          node = node.return;
        }
      }
    }
    return null;
  }

  function extractDataFromStore(state) {
    if (!state) return null;
    
    let dState = state;
    if (state.draft && typeof state.draft === 'object') dState = state.draft;
    else if (state.draftroom && typeof state.draftroom === 'object') dState = state.draftroom;

    let picksList = dState.picks || dState.selections || dState.draftDetail?.picks || [];
    let teamsList = dState.teams || dState.draftDetail?.teams || dState.settings?.teams || [];

    if (!picksList.length && !teamsList.length) {
      return null;
    }

    const teams = teamsList.map(t => ({
      teamId: t.teamId || t.id,
      teamName: t.teamName || t.name || `Team ${t.teamId || t.id}`,
      managerName: t.managerName || `Manager ${t.teamId || t.id}`
    }));

    const picks = picksList.map(p => ({
      overallPickNumber: p.overallPickNumber || p.pickNumber || p.pick,
      playerName: p.playerName || p.player?.fullName || p.name,
      drafterTeamId: p.drafterTeamId || p.teamId || 1
    }));

    return { teams, picks };
  }

  function checkAndSync() {
    try {
      let data = null;
      const urlParams = new URLSearchParams(window.location.search);
      let leagueId = urlParams.get('leagueId') || urlParams.get('leagueid') || 'scraped-draft';
      let season = urlParams.get('seasonId') || urlParams.get('seasonid') || new Date().getFullYear();
      const currentNom = findCurrentNomination();

      // 1. Try React store extraction
      try {
        const storeState = findStoreState();
        const extracted = extractDataFromStore(storeState);
        if (extracted) {
          data = {
            isDOMScraped: false,
            leagueId,
            season,
            leagueName: document.title || 'ESPN Mock Draft Room',
            teams: extracted.teams,
            draftDetail: {
              picks: extracted.picks
            },
            currentNomination: currentNom
          };
        }
      } catch (e) {
        console.warn("[Gridiron Edge Sync] Store extraction failed:", e.message);
      }

      // 2. Fallback to DOM Scraper
      if (!data) {
        const selections = scrapeDraftDOM() || [];
        const isDraftPage = window.location.pathname.includes('/draft');
        if (selections.length === 0 && !(isDraftPage && currentNom)) return;

        let uniqueTeams = Array.from(new Set(selections.map(p => p.drafterTeamName)));
        if (uniqueTeams.length === 0) {
          uniqueTeams = ["Team 1", "Team 2", "Team 3", "Team 4", "Team 5", "Team 6", "Team 7", "Team 8"];
        }

        const teams = uniqueTeams.map((tName, index) => ({
          teamId: index + 1,
          teamName: tName,
          managerName: `Manager ${index + 1}`
        }));

        const finalPicks = selections.map(p => {
          const team = teams.find(t => t.teamName === p.drafterTeamName);
          return {
            overallPickNumber: p.overallPickNumber,
            playerName: p.playerName,
            drafterTeamId: team ? team.teamId : 1
          };
        });

        data = {
          isDOMScraped: true,
          leagueId,
          season,
          leagueName: document.title || 'ESPN Mock Draft Room',
          teams,
          draftDetail: {
            picks: finalPicks
          },
          currentNomination: currentNom
        };
      }

      const picksCount = data.draftDetail.picks.length;
      const nomName = currentNom ? currentNom.name : '';
      const syncKey = `${picksCount}_${nomName}`;

      if (lastSyncKey === syncKey) {
        return;
      }

      lastSyncKey = syncKey;
      console.log("[Gridiron Edge Sync] Auto-sync detected change. Dispatching postMessage...", syncKey, "isDOMScraped:", data.isDOMScraped);

      // Dispatch to the window for content-isolated.js to pick up
      window.postMessage({ type: 'GRIDIRON_EDGE_SYNC', data }, '*');
    } catch (err) {
      console.warn("[Gridiron Edge Sync] Sync loop error:", err.message);
    }
  }

  // Poll the page DOM for live changes every 2 seconds
  setInterval(checkAndSync, 2000);
})();
