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
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
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
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: scrapeEspnData
        });

        if (!results || results.length === 0 || !results[0].result) {
          throw new Error('Failed to retrieve league data from tab (empty result).');
        }

        const payload = results[0].result;
        if (!payload.success) {
          throw new Error(payload.error);
        }

        const data = payload.data;
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
