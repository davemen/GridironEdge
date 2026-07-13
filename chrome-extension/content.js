// Content script for Gridiron Edge ESPN Sync extension
// Periodically scrapes the draft page and sends updates to the background service worker

(function() {
  console.log("[Gridiron Edge Sync] Content script initialized.");

  let lastSyncKey = null;

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

  function checkAndSync() {
    try {
      const selections = scrapeDraftDOM() || [];
      const currentNom = findCurrentNomination();

      const isDraftPage = window.location.pathname.includes('/draft');
      if (selections.length === 0 && !(isDraftPage && currentNom)) return;

      const picksCount = selections.length;
      const nomName = currentNom ? currentNom.name : '';
      const syncKey = `${picksCount}_${nomName}`;

      if (lastSyncKey === syncKey) {
        return; // State unchanged
      }

      lastSyncKey = syncKey;
      console.log("[Gridiron Edge Sync] Auto-sync detected change. Sending update...", syncKey);

      // Extract query parameters for ID context
      const urlParams = new URLSearchParams(window.location.search);
      let leagueId = urlParams.get('leagueId') || urlParams.get('leagueid') || 'scraped-draft';
      let season = urlParams.get('seasonId') || urlParams.get('seasonid') || new Date().getFullYear();

      // Group unique drafter teams
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

      const data = {
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

      // Direct IPC dispatch to MV3 background service worker
      chrome.runtime.sendMessage({ action: 'sync', data });
    } catch (err) {
      console.warn("[Gridiron Edge Sync] Check error:", err.message);
    }
  }

  // Poll the page DOM for live changes every 2 seconds
  setInterval(checkAndSync, 2000);
})();
