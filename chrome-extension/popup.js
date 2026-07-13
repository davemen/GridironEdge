const statusEl = document.getElementById('status');
const syncBtn = document.getElementById('sync-btn');

// Scraper function that runs in the context of the active ESPN tab
async function scrapeEspnData() {
  try {
    const views = ['mSettings', 'mRoster', 'mTeam', 'mMatchup', 'mMatchupScore', 'mStandings', 'mTransactionHistory'];
    
    // Try parsing query params first (robust for both league home and draft pages)
    const urlParams = new URLSearchParams(window.location.search);
    let leagueId = urlParams.get('leagueId') || urlParams.get('leagueid');
    let season = urlParams.get('seasonId') || urlParams.get('seasonid') || new Date().getFullYear();

    // Fallback: Try parsing from path if query parameters are missing
    const pathParts = window.location.pathname.split('/');
    if (!leagueId) {
      const leaguesIdx = pathParts.indexOf('leagues');
      if (leaguesIdx !== -1 && pathParts[leaguesIdx + 1]) {
        leagueId = pathParts[leaguesIdx + 1];
      }
    }
    if (!urlParams.get('seasonId') && !urlParams.get('seasonid')) {
      const fflIdx = pathParts.indexOf('ffl');
      if (fflIdx !== -1 && pathParts[fflIdx + 1]) {
        season = pathParts[fflIdx + 1];
      }
    }

    if (!leagueId) {
      throw new Error('League ID not found in URL. Make sure you are on fantasy.espn.com league home page.');
    }

    let url = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=${views.join('&view=')}`;
    
    let response = await fetch(url);
    
    // Check for redirects to landing page (indicating unauthorized/invalid league)
    if (response.redirected && response.url.includes('/fantasy/')) {
      throw new Error('ESPN redirected the request. This league ID may not exist or require session authorization.');
    }

    if (!response.ok) {
      // Fallback: Try minimal views in case matchup/standings are not yet generated
      const fallbackViews = ['mSettings', 'mRoster', 'mTeam', 'mDraftDetail'];
      const fallbackUrl = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=${fallbackViews.join('&view=')}`;
      const fallbackResponse = await fetch(fallbackUrl);
      
      if (!fallbackResponse.ok) {
        throw new Error(`ESPN API returned status: ${response.status} (Fallback: ${fallbackResponse.status})`);
      }
      response = fallbackResponse;
    }

    const data = await response.json();
    
    // Find current nomination details inside the page context
    try {
      const nflTeams = new Set(['DET', 'LAR', 'ATL', 'CIN', 'SEA', 'SF', 'GB', 'KC', 'BUF', 'DAL', 'PHI', 'MIA', 'NYJ', 'NE', 'LV', 'DEN', 'LAC', 'MIN', 'CHI', 'TB', 'NO', 'CAR', 'WAS', 'NYG', 'ARI', 'JAX', 'IND', 'TEN', 'HOU', 'BAL', 'PIT', 'CLE', 'FA']);
      const positions = new Set(['QB', 'RB', 'WR', 'TE', 'D/ST', 'K', 'FLEX']);
      const all = document.querySelectorAll('div, span, h1, h2, h3, h4, p');
      for (const el of all) {
        if (el.children.length > 2) continue;
        const text = el.innerText ? el.innerText.trim() : '';
        if (text.length > 3 && text.length < 35 && !text.includes('\n')) {
          let parentText = el.parentElement ? el.parentElement.innerText : '';
          const parentParts = parentText.split(/[\s\n]+/);
          let team = '';
          let position = '';
          let hasTeam = false;
          let hasPos = false;
          for (const p of parentParts) {
            const pUpper = p.toUpperCase();
            if (nflTeams.has(pUpper)) { team = pUpper; hasTeam = true; }
            if (positions.has(pUpper)) { position = pUpper; hasPos = true; }
          }
          if (hasTeam && hasPos) {
            const parts = text.split(/\s+/);
            if (parts.length >= 2 && parts.length <= 4) {
              const isCapitalized = parts.every(p => p[0] === p[0].toUpperCase());
              if (isCapitalized && !text.toUpperCase().includes('STATS') && !text.toUpperCase().includes('PROJECTED') && !text.toUpperCase().includes('BID') && !text.toUpperCase().includes('TEAM')) {
                data.currentNomination = { name: text, team, position };
                break;
              }
            }
          }
        }
      }
    } catch (e) {}

    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Scraper function that runs in the MAIN world to search for Redux state in the page JS
function scanForEspnState() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    let leagueId = urlParams.get('leagueId') || urlParams.get('leagueid') || 'scraped-draft';
    let season = urlParams.get('seasonId') || urlParams.get('seasonid') || new Date().getFullYear();

    function findCurrentNomination() {
      try {
        const nflTeams = new Set(['DET', 'LAR', 'ATL', 'CIN', 'SEA', 'SF', 'GB', 'KC', 'BUF', 'DAL', 'PHI', 'MIA', 'NYJ', 'NE', 'LV', 'DEN', 'LAC', 'MIN', 'CHI', 'TB', 'NO', 'CAR', 'WAS', 'NYG', 'ARI', 'JAX', 'IND', 'TEN', 'HOU', 'BAL', 'PIT', 'CLE', 'FA']);
        const positions = new Set(['QB', 'RB', 'WR', 'TE', 'D/ST', 'K', 'FLEX']);
        const all = document.querySelectorAll('div, span, h1, h2, h3, h4, p');
        for (const el of all) {
          if (el.children.length > 2) continue;
          const text = el.innerText ? el.innerText.trim() : '';
          if (text.length > 3 && text.length < 35 && !text.includes('\n')) {
            let parentText = el.parentElement ? el.parentElement.innerText : '';
            const parentParts = parentText.split(/[\s\n]+/);
            let team = '';
            let position = '';
            let hasTeam = false;
            let hasPos = false;
            for (const p of parentParts) {
              const pUpper = p.toUpperCase();
              if (nflTeams.has(pUpper)) { team = pUpper; hasTeam = true; }
              if (positions.has(pUpper)) { position = pUpper; hasPos = true; }
            }
            if (hasTeam && hasPos) {
              const parts = text.split(/\s+/);
              if (parts.length >= 2 && parts.length <= 4) {
                const isCapitalized = parts.every(p => p[0] === p[0].toUpperCase());
                if (isCapitalized && !text.toUpperCase().includes('STATS') && !text.toUpperCase().includes('PROJECTED') && !text.toUpperCase().includes('BID') && !text.toUpperCase().includes('TEAM')) {
                  return { name: text, team, position };
                }
              }
            }
          }
        }
      } catch (e) {}
      return null;
    }

    function findStoreState() {
      // 1. Direct window objects
      if (window.__PRELOADED_STATE__) return window.__PRELOADED_STATE__;
      if (window.espn?.draft) return window.espn.draft;

      // 2. Scan window keys for objects that look like state/store
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

      // Check if any object has Redux store shape
      function isReduxStore(obj) {
        return obj && typeof obj.getState === 'function' && typeof obj.dispatch === 'function' && typeof obj.subscribe === 'function';
      }

      // Helper to search properties of an object for a Redux store
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

      // 3. React Fiber tree search for Redux store
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
                        searchObjForStore(node.memoizedState);
            
            if (store) return store.getState();

            try {
              let dep = node.dependencies;
              while (dep) {
                const s = searchObjForStore(dep.firstContext?.memoizedValue) || 
                          searchObjForStore(dep.firstContext);
                if (s) return s.getState();
                dep = dep.next;
              }
            } catch (e) {}

            node = node.return;
          }
        }
      }
      return null;
    }

    const rawState = findStoreState();
    
    // Fallback: If no React/Redux store state is found, scrape the HTML DOM for draft summary
    if (!rawState) {
      const nflTeams = new Set(['DET', 'LAR', 'ATL', 'CIN', 'SEA', 'SF', 'GB', 'KC', 'BUF', 'DAL', 'PHI', 'MIA', 'NYJ', 'NE', 'LV', 'DEN', 'LAC', 'MIN', 'CHI', 'TB', 'NO', 'CAR', 'WAS', 'NYG', 'ARI', 'JAX', 'IND', 'TEN', 'HOU', 'BAL', 'PIT', 'CLE', 'FA']);
      const positions = new Set(['QB', 'RB', 'WR', 'TE', 'D/ST', 'K', 'FLEX']);
      
      const elements = document.querySelectorAll('tr, [role="row"], [class*="row" i], [class*="item" i], div');
      const selections = [];
      const seenPicks = new Set();

      elements.forEach(el => {
        if (!el || typeof el.innerText !== 'string') return;
        const text = el.innerText.trim();
        if (el.children.length > 8 || text.length > 150 || text.length < 10) return;
        const parts = text.split(/[\s\n]+/).map(p => p.trim()).filter(Boolean);
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

      const currentNom = findCurrentNomination();
      const isDraftPage = window.location.pathname.includes('/draft');

      if (selections.length > 0 || (isDraftPage && currentNom)) {
        if (selections.length > 0) {
          selections.sort((a, b) => a.overallPickNumber - b.overallPickNumber);
        }
        
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

        return {
          success: true,
          isDOMScraped: true,
          data: {
            isDOMScraped: true,
            leagueId,
            season,
            leagueName: document.title || 'ESPN Mock Draft Room',
            teams,
            draftDetail: {
              picks: finalPicks
            },
            currentNomination: currentNom
          }
        };
      }

      return { success: false, error: 'Could not find ESPN draft state in window, React store, or page DOM.' };
    }

    // Extract only necessary parts of the state to avoid serialization errors or excessive payload size
    const data = {};
    
    // Find settings
    data.settings = rawState.settings || rawState.leagueSettings || rawState.draftSettings || 
                    rawState.league?.settings || rawState.draft?.settings;
    
    // Find teams
    data.teams = rawState.teams || rawState.league?.teams || rawState.draft?.teams;

    // Find draftDetail / picks
    data.draftDetail = rawState.draftDetail || rawState.draft?.draftDetail || 
                       (rawState.draft?.picks ? { picks: rawState.draft.picks } : null) ||
                       (rawState.picks ? { picks: rawState.picks } : null);

    // Find schedule
    data.schedule = rawState.schedule || rawState.league?.schedule;

    // Find players
    data.players = rawState.players || rawState.draft?.players || rawState.playerPool?.players;

    // ID / name details
    data.id = rawState.leagueId || rawState.league?.id || rawState.id;
    data.name = rawState.leagueName || rawState.league?.name || rawState.name;

    // Active nomination
    data.currentNomination = findCurrentNomination();

    if (!data.settings && !data.teams && !data.draftDetail) {
      // If we couldn't find subkeys, return a trimmed version of the rawState itself
      const trimmed = {};
      for (const k of Object.keys(rawState)) {
        if (!['router', 'ui', 'view', 'modal', 'theme', 'config'].includes(k.toLowerCase())) {
          trimmed[k] = rawState[k];
        }
      }
      trimmed.currentNomination = data.currentNomination;
      return { success: true, isScrapedFromStore: true, data: trimmed };
    }

    return { success: true, isScrapedFromStore: true, data };
  } catch (err) {
    return { success: false, error: 'Scanner error: ' + err.message };
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      statusEl.innerHTML = 'No active tab detected.';
      return;
    }

    const isEspn = tab.url.includes('fantasy.espn.com');
    if (!isEspn) {
      statusEl.innerHTML = 'Navigate to fantasy.espn.com first.';
      syncBtn.disabled = true;
      return;
    }

    statusEl.innerHTML = 'ESPN tab detected. Ready to sync.';
    syncBtn.disabled = false;

    syncBtn.onclick = async () => {
      statusEl.innerHTML = 'Scraping ESPN session...';
      syncBtn.disabled = true;

      try {
        // Step 1: Try scraping via standard page context APIs in all frames
        let results = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: scrapeEspnData
        });

        let payload = null;
        if (results && results.length > 0) {
          for (const res of results) {
            if (res.result && res.result.success) {
              payload = res.result;
              break;
            }
          }
        }

        // Step 2: Fallback to scanning React Redux store in all frames inside the MAIN world
        if (!payload) {
          statusEl.innerHTML = 'API redirected. Scanning page state...';
          const scanResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: scanForEspnState,
            world: 'MAIN'
          });

          if (scanResults && scanResults.length > 0) {
            for (const res of scanResults) {
              if (res.result && res.result.success) {
                payload = res.result;
                break;
              }
            }
          }

          if (!payload) {
            // Find specific errors from the frames to display a helpful message
            let errors = [];
            if (results) {
              results.forEach(r => { if (r.result && r.result.error) errors.push(r.result.error); });
            }
            if (scanResults) {
              scanResults.forEach(r => { if (r.result && r.result.error) errors.push(r.result.error); });
            }
            const errorText = errors.length > 0 ? errors.join(' | ') : 'Could not find ESPN draft state in window or React store.';
            throw new Error(errorText);
          }
        }

        const data = payload.data;
        
        // Safely extract leagueId and season from tab URL to enrich fallback scraped data
        const urlParams = new URLSearchParams(tab.url.split('?')[1] || '');
        const queryLeagueId = urlParams.get('leagueId') || urlParams.get('leagueid');
        if (queryLeagueId) {
          if (!data.id) data.id = queryLeagueId;
          if (!data.settings) data.settings = {};
          if (!data.settings.leagueId) data.settings.leagueId = queryLeagueId;
        }

        statusEl.innerHTML = 'Sending to local server...';

        try {
          // Attempt local server POST sync
          const response = await fetch('http://localhost:8000/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });

          if (response.ok) {
            statusEl.innerHTML = '<span style="color:#00e676;">Success! Synced with Gridiron Edge.</span>';
          } else {
            throw new Error(`Server returned status: ${response.status}`);
          }
        } catch (serverErr) {
          // Fallback: Copy to clipboard
          await navigator.clipboard.writeText(JSON.stringify(data));
          statusEl.innerHTML = '<span style="color:#00e5ff;">Copied to clipboard! (Local server offline)</span>';
        }
      } catch (err) {
        statusEl.innerHTML = `<span style="color:#ff1744;">Error: ${err.message}</span>`;
      } finally {
        syncBtn.disabled = false;
      }
    };
  } catch (e) {
    statusEl.innerHTML = `<span style="color:#ff1744;">Failed: ${e.message}</span>`;
  }
});
