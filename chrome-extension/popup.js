const statusEl = document.getElementById('status');
const syncBtn = document.getElementById('sync-btn');

/**
 * Write a status line as text, never as markup.
 *
 * These strings carry error text that originates in the MAIN world of the ESPN
 * page, where a page script can shape an Error message. MV3's CSP stops that
 * becoming script execution, but building markup out of page-controlled text is
 * one relaxation away from worse, and textContent costs nothing.
 */
function setStatus(text, color) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = '';
  const span = document.createElement('span');
  if (color) span.style.color = color;
  span.textContent = text;
  el.appendChild(span);
}

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
      const uiBlacklist = new Set(['SHOW', 'DRAFTED', 'QUEUE', 'AUTO', 'FILTER', 'SEARCH', 'ALL', 'PAGE', 'RANK', 'PICK', 'WINNER', 'BUDGET', 'BID', 'RESET', 'UNDO', 'CLOSE', 'OPEN', 'STATS', 'PROJECTED', 'PRE-DRAFT', 'VAL', 'MANUAL', 'CURRENT', 'NOMINATION', 'ACTIVE', 'SELECT', 'WINNING', 'RECORD', 'ALTERNATIVES', 'SHORTLIST', 'LIVE', 'DRAFT', 'MY', 'TEAM', 'MATCHUP', 'WAIVERS', 'TRADES', 'LEAGUE', 'SETTINGS', 'STANDINGS', 'PLAYERS', 'ROSTER', 'SUMMARY', 'BOARD', 'RULES', 'BUGGETS', 'SELECTIONS', 'EMPTY', 'SOUND', 'ON', 'OFF', 'MUTE', 'VOLUME', 'AUDIO', 'SPEAKERS', 'MUSIC', 'CLICK', 'BUTTON', 'ICON', 'HELP', 'SETTINGS', 'PLAYER', 'PLAYERS', 'TEAM', 'TEAMS', 'MANAGER', 'MANAGERS', 'ROUND', 'ROUNDS', 'OVERALL', 'STATUS']);

      // 1. Locate the active nomination container
      const card = document.querySelector('.pickArea [data-testid="player-selected"], .pickArea .player-selected, .pickArea');
      if (card) {
        // 2. Locate player details inside the card
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
            data.currentNomination = { name, team, position };
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
    let myTeamId = parseInt(urlParams.get('teamId') || urlParams.get('teamid') || '1', 10);

    function findActiveRosterTeam() {
      try {
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
          if (!sel || !sel.options || sel.options.length < 4) continue;
          const text = sel.innerText || '';
          if (text.includes('Team 1') || text.includes('Team 2') || text.includes('Team 8')) {
            const activeOption = sel.options[sel.selectedIndex];
            if (activeOption) {
              return activeOption.innerText.trim();
            }
          }
        }
      } catch (e) {}
      return null;
    }

    function findMyTeamNameFromDOM() {
      try {
        const elements = document.querySelectorAll('div');
        for (const el of elements) {
          if (!el || el.children.length > 5) continue;
          const text = el.innerText ? el.innerText.trim() : '';
          if (!text || text.length > 100 || text.length < 5) continue;
          
          const lines = text.split('\n');
          if (lines.length >= 2) {
            const nameLineRaw = lines[0].trim();
            if (/^\d+\.\s+/.test(nameLineRaw)) {
              const nameLine = nameLineRaw.replace(/^\d+\.\s*/, '');
              const budgetLine = lines[1].trim();
              if (budgetLine.startsWith('$')) {
                if (!text.toUpperCase().includes('AUTO')) {
                  return nameLine;
                }
              }
            }
          }
        }
      } catch (e) {}
      return null;
    }

    const myTeamName = findActiveRosterTeam() || findMyTeamNameFromDOM();


    function findCurrentNomination() {
      try {
        const card = document.querySelector('.pickArea [data-testid="player-selected"], .pickArea .player-selected, .pickArea');
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
    
    /**
     * Locate the results table, in either draft format.
     *
     * This used to require the literal string "Round 1", which is a snake-draft
     * artefact. An auction has no rounds -- players are nominated and bid on --
     * so the check could never pass in an auction room, and the extension was
     * unusable for exactly the format the auction engine exists to serve.
     *
     * Now it accepts either signature: round labelling for a snake, or a column
     * of dollar amounts for an auction.
     */

    // Fallback: If no React/Redux store state is found, scrape the HTML DOM for draft summary
    // The DOM fallback used to be a second, independent copy of the draft-room
    // scraper that lives in content-main.js. The two drifted: the auction fix
    // landed only here, the duplicate-row fix only there, so each carried the
    // bug the other had already fixed. content-main.js runs in this same MAIN
    // world on every draft page and caches its last payload, so read that rather
    // than scraping the page a second time with a different parser.
    if (!rawState) {
      const fromContentScript = window.__GRIDIRON_EDGE_LAST__;
      if (fromContentScript && Array.isArray(fromContentScript.teams)
          && fromContentScript.teams.length) {
        return { success: true, data: fromContentScript, source: 'content-script' };
      }
      return {
        success: false,
        error: 'No draft state yet. The page scraper runs every two seconds on a '
             + 'draft page - open the draft room, wait a moment, then try again. '
             + 'If it persists, check window.__GRIDIRON_EDGE_VERSION__ in the page '
             + 'console to confirm the extension actually reloaded.',
      };
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
      setStatus('No active tab detected.');
      return;
    }

    const isEspn = tab.url.includes('fantasy.espn.com');
    if (!isEspn) {
      setStatus('Navigate to fantasy.espn.com first.');
      syncBtn.disabled = true;
      return;
    }

    setStatus('ESPN tab detected. Ready to sync.');
    syncBtn.disabled = false;

    syncBtn.onclick = async () => {
      setStatus('Scraping ESPN session...');
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
          setStatus('API redirected. Scanning page state...');
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
            setStatus('Error: ' + errorText, '#ff1744');
            return;
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

        setStatus('Sending to local server...');

        try {
          // Attempt local server POST sync
          const response = await fetch('http://localhost:8000/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });

          if (response.ok) {
            setStatus('Success! Synced with Gridiron Edge.', '#00e676');
          } else {
            throw new Error(`Server returned status: ${response.status}`);
          }
        } catch (serverErr) {
          // Fallback: Copy to clipboard
          await navigator.clipboard.writeText(JSON.stringify(data));
          setStatus('Copied to clipboard! (Local server offline)', '#00e5ff');
        }
      } catch (err) {
        setStatus('Error: ' + err.message, '#ff1744');
      } finally {
        syncBtn.disabled = false;
      }
    };
  } catch (e) {
    setStatus('Failed: ' + e.message, '#ff1744');
  }
});
