const statusEl = document.getElementById('status');
const syncBtn = document.getElementById('sync-btn');

// Scraper function that runs in the context of the active ESPN tab
async function scrapeEspnData() {
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

  const url = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=${views.join('&view=')}`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP Status: ${response.status}`);
  }
  return await response.json();
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
          throw new Error('Failed to retrieve league data from tab.');
        }

        const payload = results[0].result;
        statusEl.innerHTML = 'Sending to local server...';

        try {
          // Attempt local server POST sync
          const response = await fetch('http://localhost:8000/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          if (response.ok) {
            statusEl.innerHTML = '<span style="color:#00e676;">Success! Synced with Gridiron Edge.</span>';
          } else {
            throw new Error(`Server returned status: ${response.status}`);
          }
        } catch (serverErr) {
          // Fallback: Copy to clipboard
          await navigator.clipboard.writeText(JSON.stringify(payload));
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
