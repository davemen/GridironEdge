// Main world content script for Gridiron Edge ESPN Sync extension
// Accesses the page's React/Redux store directly and posts updates to the isolated content script

(function() {
  // Version marker: lets a console check confirm whether Chrome is running the
  // current content script or a cached older one, which is the first thing to
  // rule out when a fix appears to have had no effect.
  try { window.__GRIDIRON_EDGE_VERSION__ = '2026.08.07-dst3'; } catch (e) {}
  console.log("[Gridiron Edge Sync] Main world script initialized (2026.08.05-bidfix).");

  let lastSyncKey = null;

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
          // The live bid, read from ESPN's actual markup rather than inferred.
          // The draft room renders:
          //   <div data-testid="bidding-form" class="bidding-form__container">
          //     <div class="current-amount">Current offer: $35</div>
          //     <div class="manual-bid">Manual offer (max $99)</div>
          //
          // ".current-amount" is the number that ticks up as people bid, and
          // ".manual-bid" carries the most this manager can still afford, which
          // is worth having because it is ESPN's own answer to the budget
          // question the advisor otherwise computes itself.
          let bid = null;
          let maxAffordable = null;
          try {
            // There can be more than one ".current-amount" on the page -- bid
            // history rows carry the same class -- and taking the first found a
            // stale or opening value like $1 while the live offer was far
            // higher. Collect every candidate and take the largest, preferring
            // the one inside the bidding form when it exists.
            const amountEls = [
              ...document.querySelectorAll('[data-testid="bidding-form"] .current-amount'),
              ...(card ? card.querySelectorAll('.current-amount') : []),
              ...document.querySelectorAll('.current-amount'),
            ];
            const seenAmounts = [];
            amountEls.forEach(el => {
              const t = el && el.innerText ? el.innerText : '';
              const m = t.match(/\$\s?([\d,]+)/);
              if (m) seenAmounts.push(parseInt(m[1].replace(/,/g, ''), 10));
            });
            if (seenAmounts.length) bid = Math.max(...seenAmounts);

            const maxEl = card.querySelector('.manual-bid')
              || document.querySelector('[data-testid="bidding-form"] .manual-bid')
              || document.querySelector('.manual-bid');
            if (maxEl && maxEl.innerText) {
              const m = maxEl.innerText.match(/max\s*\$\s?([\d,]+)/i);
              if (m) maxAffordable = parseInt(m[1].replace(/,/g, ''), 10);
            }

            // Only if the labelled elements are missing does it fall back to
            // scanning the card for a dollar figure.
            if (bid === null) {
              const all = (card.innerText || '').match(/\$\s?\d+/g) || [];
              if (all.length) {
                bid = Math.max(...all.map(t => parseInt(t.replace(/[^0-9]/g, ''), 10)));
              }
            }
            if (bid !== null && (isNaN(bid) || bid < 0 || bid > 400)) bid = null;
            if (maxAffordable !== null && (isNaN(maxAffordable) || maxAffordable < 0)) {
              maxAffordable = null;
            }
          } catch (e) { bid = null; maxAffordable = null; }

          return { name, team, position, bid, maxAffordable };
        }
      }
    } catch (e) {}
    return null;
  }

  function findDraftSummaryContainer() {
    const containers = document.querySelectorAll('div, table, tbody');
    for (const el of containers) {
      if (!el || el.children.length === 0) continue;
      const text = el.innerText ? el.innerText.trim() : '';
      if (text.includes('Round 1') && text.includes('PLAYER') && text.includes('TEAM') && (text.includes('PROJ PTS') || text.includes('PTS'))) {
        if (text.length < 15000 && !text.includes('No players in queue')) {
          return el;
        }
      }
    }
    return null;
  }

  function scrapeDraftDOM() {
    try {
      const container = findDraftSummaryContainer();
      if (!container) return null;

  // Every club by nickname. A defense is the one "player" whose name IS a team,
  // so a results row can put the nickname before the position token, after it,
  // or on its own -- and a parser that assumes one order loses the pick. With
  // this, the nickname can be found anywhere in the row.
  const NFL_NICKNAMES = {
    patriots: 'NE', ravens: 'BAL', '49ers': 'SF', bills: 'BUF', cowboys: 'DAL',
    dolphins: 'MIA', jets: 'NYJ', eagles: 'PHI', chiefs: 'KC', raiders: 'LV',
    broncos: 'DEN', chargers: 'LAC', vikings: 'MIN', bears: 'CHI', packers: 'GB',
    lions: 'DET', buccaneers: 'TB', saints: 'NO', falcons: 'ATL', panthers: 'CAR',
    commanders: 'WAS', giants: 'NYG', cardinals: 'ARI', seahawks: 'SEA', rams: 'LAR',
    jaguars: 'JAX', colts: 'IND', titans: 'TEN', texans: 'HOU', steelers: 'PIT',
    browns: 'CLE', bengals: 'CIN',
  };

      const nflTeams = new Set(['DET', 'LAR', 'ATL', 'CIN', 'SEA', 'SF', 'GB', 'KC', 'BUF', 'DAL', 'PHI', 'MIA', 'NYJ', 'NE', 'LV', 'DEN', 'LAC', 'MIN', 'CHI', 'TB', 'NO', 'CAR', 'WAS', 'NYG', 'ARI', 'JAX', 'IND', 'TEN', 'HOU', 'BAL', 'PIT', 'CLE', 'FA']);
      // Feeds spell a team defense several ways, and the row is thrown away
      // entirely if the position token is not recognised.
      const DST_ALIASES = new Set(['D/ST', 'DST', 'DEF', 'D-ST']);
      const positions = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'FLEX', ...DST_ALIASES]);
      
      const elements = container.querySelectorAll('tr, [role="row"], [class*="row" i], [class*="item" i], div');
      const selections = [];
      const seenPicks = new Set();
      // Why each row was thrown away. Rows are dropped silently by design --
      // most of what this selector returns is not a pick -- but that also hides
      // the real picks being lost, which is how two defenses went missing for
      // three attempts running. Keep the ones that looked like a pick.
      const rejected = [];
      const note = (why, text) => {
        if (rejected.length < 40 && /d\/?st|dst/i.test(text)) rejected.push({ why, text: text.slice(0, 120) });
      };

      elements.forEach(el => {
        if (!el || typeof el.innerText !== 'string') return;
        const text = el.innerText.trim();
        if (el.children.length > 8 || text.length > 150 || text.length < 10) return;
        const parts = text.split(/[\s\n]+/);
        // "Broncos D/ST" is a complete row and only two tokens long. Requiring
        // three discarded it, and with it the pick.
        const looksDst = parts.some((x) => DST_ALIASES.has(x.toUpperCase()))
          || parts.some((x) => NFL_NICKNAMES[x.toLowerCase()]);
        if (parts.length < (looksDst ? 2 : 3)) { note('too few tokens', text); return; }
        
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

        // A row that does not lead with a pick number used to be thrown away
        // outright. Auction results rows frequently do not have one -- they lead
        // with the player -- so those picks never reached the app at all, which
        // is how an already-drafted player came back as a recommendation. Parse
        // it anyway and number it by arrival.
        if (pick === -1) nameStartIdx = 0;

        // Reject rows that actually contain several players. The selector
        // includes plain divs, so a wrapper's innerText can concatenate the
        // whole table -- which produced player names like
        // "Bijan Robinson ATL RB Team 3 370.8 353 $47 2 Christian McCaffrey".
        let teamTokenCount = 0;
        for (let i = nameStartIdx; i < parts.length; i++) {
          if (nflTeams.has(parts[i].toUpperCase())) teamTokenCount++;
        }
        if (teamTokenCount > 1) { note('names more than one NFL team', text); return; }

        // Take the FIRST team and position token, not the last. Scanning the
        // whole row and overwriting on every match meant a merged row pointed
        // at a later player's team while the name swallowed everything before
        // it.
        let teamIdx = -1;
        let posIdx = -1;
        for (let i = nameStartIdx; i < parts.length; i++) {
          const pUpper = parts[i].toUpperCase();
          if (teamIdx === -1 && nflTeams.has(pUpper)) teamIdx = i;
          if (posIdx === -1 && positions.has(pUpper)) posIdx = i;
          if (teamIdx !== -1 && posIdx !== -1) break;
        }

        // A defense carries no separate NFL team abbreviation -- its name IS the
        // team -- so requiring one threw every D/ST pick away before it reached
        // the app, and the D/ST slot stayed empty however the draft went. The
        // team requirement is relaxed for defenses only; for everyone else it
        // still guards against a wrapper div swallowing the whole table.
        // A row naming a club and no position is still a defense -- that is the
        // one position whose name identifies it. Requiring a position token
        // dropped the pick outright.
        const nickIdx = parts.findIndex((x, i) => i >= nameStartIdx && NFL_NICKNAMES[x.toLowerCase()]);
        const isDst = (posIdx !== -1 && DST_ALIASES.has(parts[posIdx].toUpperCase()))
          || (posIdx === -1 && nickIdx !== -1);

        if (posIdx === -1 && !isDst) { note('no position token', text); return; }
        if (posIdx !== -1 && teamIdx === -1 && !isDst) { note('no NFL team token', text); return; }

        if (isDst || (posIdx !== -1 && teamIdx !== -1)) {

          const endIdx = teamIdx === -1 ? posIdx : Math.min(teamIdx, posIdx);
          const nameParts = parts.slice(nameStartIdx, endIdx);
          let playerName = nameParts.join(' ');
          let teamAbbr = teamIdx === -1 ? 'FA' : parts[teamIdx];

          const maxIdx = Math.max(teamIdx, posIdx);
          const remaining = parts.slice(maxIdx + 1);

          // The winning bid sits in this row as a "$45" token. It used to be
          // discarded along with the other noise while isolating the team name,
          // which left the auction engine unable to tell an aggressive manager
          // from a disciplined one -- it had to assume every rival paid exactly
          // par. Capture it before filtering.
          let bidAmount = null;
          remaining.forEach(tok => {
            if (bidAmount === null && /^\$\d+$/.test(tok)) {
              const v = parseInt(tok.slice(1), 10);
              if (!isNaN(v) && v >= 0 && v <= 400) bidAmount = v;
            }
          });

          const drafterParts = remaining.filter(p => {
            if (p === '-' || p.startsWith('$') || p.startsWith('-$')) return false;
            const num = parseFloat(p);
            if (!isNaN(num)) {
              if (p.includes('.') || num > 32) return false;
            }
            return true;
          });
          const drafterTeamName = drafterParts.join(' ') || `Team ${pick}`;

          // Dedupe by who was bought, not by the leading number. That number is
          // not always a pick number, and two rows sharing one silently dropped
          // the second -- losing a real pick with no error anywhere.
          // For a defense, take the nickname from anywhere in the row rather
          // than only from the tokens before the position. Slicing by position
          // yields an empty name whenever the row reads "D/ST Broncos", and an
          // empty name meant the pick was dropped without a trace.
          if (isDst) {
            const nickTok = parts.find((x) => NFL_NICKNAMES[x.toLowerCase()]);
            if (nickTok) {
              playerName = nickTok;
              if (teamIdx === -1) teamAbbr = NFL_NICKNAMES[nickTok.toLowerCase()];
            }
          }

          const ident = (playerName + '|' + (isDst ? 'D/ST' : parts[posIdx])).toLowerCase();
          if (!playerName) { note('no player name found', text); return; }
          if (seenPicks.has(ident)) { note('duplicate of ' + playerName, text); return; }
          seenPicks.add(ident);

          selections.push({
            overallPickNumber: pick === -1 ? selections.length + 1 : pick,
            playerName,
            playerTeam: teamAbbr,
            // Normalise so the app sees one spelling.
            playerPosition: isDst ? 'D/ST' : parts[posIdx],
            drafterTeamName,
            bidAmount
          });
        }
      });

      // Reachable from the console whether or not anything parsed, so a pick
      // that was dropped can be seen rather than deduced.
      try { window.__GRIDIRON_EDGE_REJECTED__ = rejected; } catch (e) { /* best effort */ }

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

  let lastSeenPicks = [];

  function findDataInState(obj, depth = 0, visited = new Set()) {
    if (depth > 6 || !obj || typeof obj !== 'object' || visited.has(obj)) return null;
    visited.add(obj);

    let picks = obj.picks || obj.selections || (obj.draftDetail && obj.draftDetail.picks);
    let teams = obj.teams || (obj.draftDetail && obj.draftDetail.teams) || (obj.settings && obj.settings.teams);

    if (Array.isArray(picks) && Array.isArray(teams) && (picks.length > 0 || teams.length > 0)) {
      return { teams, picks };
    }

    for (const key of Object.keys(obj)) {
      try {
        const val = obj[key];
        if (val && typeof val === 'object') {
          const result = findDataInState(val, depth + 1, visited);
          if (result) return result;
        }
      } catch (e) {}
    }
    return null;
  }

  function scrapeTeamsAndBudgets() {
    const teams = [];
    try {
      const elements = document.querySelectorAll('div');
      const seenTeams = new Set();
      
      elements.forEach(el => {
        if (!el || el.children.length > 5) return;
        const text = el.innerText ? el.innerText.trim() : '';
        if (!text || text.length > 100 || text.length < 5) return;
        
        const lines = text.split('\n');
        if (lines.length >= 2) {
          const nameLineRaw = lines[0].trim();
          if (/^\d+\.\s+/.test(nameLineRaw)) {
            const nameLine = nameLineRaw.replace(/^\d+\.\s*/, '');

            // The pick train renders three lines, not two:
            //   "1. Team 7" / "AUTO" / "$103"
            // Reading lines[1] therefore found "AUTO", never a dollar amount,
            // so every budget silently fell back to $200 and the whole market
            // model -- who is broke, who can still outbid you -- ran blind.
            // Take the first dollar figure anywhere below the name instead.
            let budgetLine = '';
            for (let i = 1; i < lines.length; i++) {
              const candidate = lines[i].trim();
              if (/^\$\s?[\d,]+$/.test(candidate)) { budgetLine = candidate; break; }
            }

            if (budgetLine.startsWith('$')) {
              const budgetVal = parseInt(budgetLine.replace(/[^0-9]/g, ''), 10);
              if (!isNaN(budgetVal) && budgetVal >= 0 && budgetVal <= 400) {
                if (nameLine.length > 2 && nameLine.length < 30 && !seenTeams.has(nameLine)) {
                  seenTeams.add(nameLine);
                  teams.push({
                    teamName: nameLine,
                    budget: budgetVal
                  });
                }
              }
            }
          }
        }
      });
    } catch (e) {}
    return teams;
  }

  function extractDataFromStore(state) {
    if (!state) return null;
    
    const extracted = findDataInState(state);
    if (!extracted) return null;

    const teams = extracted.teams.map(t => ({
      teamId: t.teamId || t.id,
      teamName: t.teamName || t.name || `Team ${t.teamId || t.id}`,
      managerName: t.managerName || `Manager ${t.teamId || t.id}`,
      faabRemaining: typeof t.faabRemaining === 'number' ? t.faabRemaining : (typeof t.draftBudget === 'number' ? t.draftBudget : (typeof t.budget === 'number' ? t.budget : 200))
    }));

    const picks = extracted.picks.map(p => {
      const posMap = { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'D/ST', 17: 'K' };
      const posId = p.player?.defaultPositionId;
      const position = posMap[posId] || p.playerPosition || p.player?.position || 'RB';
      
      const teamMap = { 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'HOU', 11: 'IND', 12: 'JAX', 13: 'KC', 14: 'LV', 15: 'LAR', 16: 'MIA', 17: 'MIN', 18: 'NE', 19: 'NO', 20: 'NYG', 21: 'NYJ', 22: 'PHI', 23: 'PIT', 24: 'SF', 25: 'SEA', 26: 'TB', 27: 'TEN', 28: 'WAS', 29: 'CAR', 30: 'ARI', 33: 'BAL', 34: 'HOU' };
      const nflTeamId = p.player?.proTeamId;
      const team = teamMap[nflTeamId] || p.playerTeam || p.player?.proTeam || 'FA';

      return {
        overallPickNumber: p.overallPickNumber || p.pickNumber || p.pick,
        playerName: p.playerName || p.player?.fullName || p.name,
        playerPosition: position,
        playerTeam: team,
        drafterTeamId: p.drafterTeamId || p.teamId || 1
      };
    });

    return { teams, picks };
  }

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

  function checkAndSync() {
    try {
      let data = null;
      const urlParams = new URLSearchParams(window.location.search);
      let leagueId = urlParams.get('leagueId') || urlParams.get('leagueid') || 'scraped-draft';
      let season = urlParams.get('seasonId') || urlParams.get('seasonid') || new Date().getFullYear();
      let myTeamId = parseInt(urlParams.get('teamId') || urlParams.get('teamid') || '1', 10);
      const currentNom = findCurrentNomination();
      
      const myTeamName = findActiveRosterTeam() || findMyTeamNameFromDOM();

      // 1. Try React store extraction
      try {
        const storeState = findStoreState();
        const extracted = extractDataFromStore(storeState);
        if (extracted) {
          let resolvedTeamId = myTeamId;
          if (myTeamName) {
            const matchedTeam = extracted.teams.find(t => t.teamName.toLowerCase() === myTeamName.toLowerCase() || myTeamName.toLowerCase().includes(t.teamName.toLowerCase()) || t.teamName.toLowerCase().includes(myTeamName.toLowerCase()));
            if (matchedTeam) {
              resolvedTeamId = matchedTeam.teamId;
            }
          }

          data = {
            isDOMScraped: false,
            leagueId,
            season,
            leagueName: document.title || 'ESPN Mock Draft Room',
            myTeamId: resolvedTeamId,
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
        if (selections.length > 0) {
          lastSeenPicks = selections;
        }

        const isDraftPage = window.location.pathname.includes('/draft');
        if (lastSeenPicks.length === 0 && !(isDraftPage && currentNom)) return;

        const scrapedForNames = scrapeTeamsAndBudgets();
        let uniqueTeams = Array.from(new Set([
          // The pick train lists every team whether or not they have drafted,
          // so it is a better roster of the league than names recovered from
          // pick rows, which only cover teams that already own somebody.
          ...scrapedForNames.map(b => b.teamName),
          ...lastSeenPicks.map(p => p.drafterTeamName),
        ].filter(Boolean)));
        if (uniqueTeams.length === 0) {
          uniqueTeams = ["Team 1", "Team 2", "Team 3", "Team 4", "Team 5", "Team 6", "Team 7", "Team 8"];
        }

        const scrapedBudgets = scrapeTeamsAndBudgets();

        const teams = uniqueTeams.map((tName, index) => {
          const budgetMatch = scrapedBudgets.find(b => b.teamName.toLowerCase() === tName.toLowerCase() || tName.toLowerCase().includes(b.teamName.toLowerCase()) || b.teamName.toLowerCase().includes(tName.toLowerCase()));
          const budget = budgetMatch ? budgetMatch.budget : 200;
          return {
            teamId: index + 1,
            teamName: tName,
            managerName: `Manager ${index + 1}`,
            faabRemaining: budget
          };
        });

        // Who bought the player. The drafter's name is rebuilt from whatever
        // tokens were left over in the pick row, so it rarely matches the pick
        // train's version character for character -- and this used to demand
        // exact equality, then blame team 1 for every miss. That silently piled
        // the whole draft onto one roster: if you were team 1 you owned
        // everybody, and if you were not, your roster never filled at all.
        // Punctuation has to go. "Mac's Marauders" against "Macs Marauders
        // Team", or a curly apostrophe against a straight one, is not a match by
        // any string comparison -- and this is the third time in this codebase
        // that an apostrophe has silently broken a lookup.
        const norm = (x) => String(x || '')
          .toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          // Apostrophes are REMOVED, not spaced -- "Mac's" and "Daves" have to
          // land on the same string. Turning them into spaces produces
          // "mac s marauders", which matches neither spelling. This is the
          // identical mistake that once priced Ja'Marr Chase at replacement.
          .replace(/['\u2019\u2018\u0060]/g, '')
          .replace(/[^a-z0-9 ]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        const findDrafter = (name) => {
          const n = norm(name);
          if (!n) return null;
          const exact = teams.filter(t => norm(t.teamName) === n);
          if (exact.length === 1) return exact[0];

          // Token containment rather than substring. A substring test matches
          // "Team 8" inside "Team 87" and hands a pick to the wrong manager;
          // comparing whole words cannot do that. Require exactly one team to
          // match, so an ambiguous name stays unattributed instead of guessing.
          const nt = n.split(' ').filter(Boolean);
          const covers = (a, b) => a.length && a.every(w => b.includes(w));
          const hits = teams.filter(t => {
            const tt = norm(t.teamName).split(' ').filter(Boolean);
            return covers(nt, tt) || covers(tt, nt);
          });
          return hits.length === 1 ? hits[0] : null;
        };

        let unattributed = 0;
        const finalPicks = lastSeenPicks.map(p => {
          const team = findDrafter(p.drafterTeamName);
          if (!team) unattributed++;
          return {
            overallPickNumber: p.overallPickNumber,
            playerName: p.playerName,
            playerPosition: p.playerPosition || p.position,
            playerTeam: p.playerTeam || p.team,
            // Null, not 1. An unattributed pick still takes the player off the
            // board, but guessing an owner corrupts that team's roster AND the
            // budget model every bid ceiling is derived from.
            drafterTeamId: team ? team.teamId : null,
            bidAmount: typeof p.bidAmount === 'number' ? p.bidAmount : null
          };
        });
        if (unattributed) {
          console.warn('[Gridiron Edge] ' + unattributed + ' of ' + finalPicks.length
            + ' picks could not be matched to a team.');
        }

        let resolvedTeamId = 1;
        if (myTeamName) {
          const matchedTeam = teams.find(t => t.teamName.toLowerCase() === myTeamName.toLowerCase() || myTeamName.toLowerCase().includes(t.teamName.toLowerCase()) || t.teamName.toLowerCase().includes(myTeamName.toLowerCase()));
          if (matchedTeam) {
            resolvedTeamId = matchedTeam.teamId;
          }
        } else {
          const matchedUrlTeam = teams.find(t => t.teamId === myTeamId);
          if (matchedUrlTeam) resolvedTeamId = myTeamId;
        }

        data = {
          isDOMScraped: true,
          leagueId,
          season,
          leagueName: document.title || 'ESPN Mock Draft Room',
          myTeamId: resolvedTeamId,
          teams,
          draftDetail: {
            picks: finalPicks
          },
          currentNomination: currentNom
        };
      }

      // Keep the last payload reachable from the console. Every scraper bug so
      // far has been diagnosed by guessing at ESPN's markup and shipping a fix
      // blind; this makes what was actually parsed inspectable in one command.
      try {
        window.__GRIDIRON_EDGE_LAST__ = data;
        window.__GRIDIRON_EDGE_DEBUG__ = function () {
          const d = window.__GRIDIRON_EDGE_LAST__;
          if (!d) { console.log('No payload captured yet.'); return; }
          const picks = (d.draftDetail && d.draftDetail.picks) || [];
          const mine = picks.filter(function (p) { return p.drafterTeamId === d.myTeamId; });
          const orphan = picks.filter(function (p) { return p.drafterTeamId == null; });
          console.log('%c GRIDIRON EDGE — what the scraper sees ',
            'background:#00e5ff;color:#000;font-weight:bold');
          console.log('source           :', d.isDOMScraped ? 'DOM scrape' : 'ESPN store');
          console.log('league / my team :', d.leagueId, '/ id', d.myTeamId);
          console.log('teams found      :', (d.teams || []).map(function (t) {
            return t.teamId + ':' + t.teamName + ' ($' + t.faabRemaining + ')'; }).join('  '));
          console.log('picks parsed     :', picks.length,
                      '| mine:', mine.length, '| unattributed:', orphan.length);
          console.table(picks.slice(-12).map(function (p) {
            return { pick: p.overallPickNumber, player: p.playerName, pos: p.playerPosition,
                     nfl: p.playerTeam, ownerId: p.drafterTeamId, bid: p.bidAmount };
          }));
          console.log('MY PICKS:', mine.map(function (p) { return p.playerName; }).join(', ') || '(none)');
          var rej = window.__GRIDIRON_EDGE_REJECTED__ || [];
          if (rej.length) {
            console.log('%c ROWS DROPPED THAT MENTIONED A DEFENSE ',
              'background:#f59e0b;color:#000;font-weight:bold');
            console.table(rej);
          } else {
            console.log('No defense-looking rows were dropped.');
          }
          return d;
        };
      } catch (e) { /* console access is best effort */ }

      // ESPN prints its own progress ("PK 87 OF 128"). Carrying it lets the app
      // notice when it has parsed fewer picks than the room has actually made --
      // which is what a drafted player reappearing as a recommendation looks
      // like from the inside.
      try {
        const m = (document.body.innerText || '').match(/PK\s*(\d+)\s*OF\s*(\d+)/i);
        if (m) {
          data.picksMadeOnEspn = parseInt(m[1], 10) - 1;   // the printed one is on the clock
          data.rosterSpotsTotal = parseInt(m[2], 10);
        }
      } catch (e) { /* the counter is a nicety, not a requirement */ }

      const picksCount = data.draftDetail.picks.length;
      const nomName = currentNom ? currentNom.name : '';
      // The bid belongs in the key. Without it the loop treats "same player,
      // higher bid" as no change and stops syncing mid-auction -- which is
      // exactly when the advice needs to move.
      const nomBid = currentNom && currentNom.bid != null ? currentNom.bid : '';
      const budgets = (data.teams || []).map(t => t.faabRemaining).join(',');
      const syncKey = `${picksCount}_${nomName}_${nomBid}_${budgets}`;

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
