/**
 * Gridiron Edge ESPN Scraper Bookmarklet
 * 
 * Instructions:
 * 1. Create a bookmark in your web browser.
 * 2. Edit the URL/Location of the bookmark and paste the raw Javascript code block below.
 * 3. Log in to https://fantasy.espn.com and click your league.
 * 4. Tap the bookmark. It will automatically fetch ESPN's authenticated APIs for your
 *    settings, rosters, drafts, standings, and schedules and copy them to your clipboard.
 * 5. Return to Gridiron Edge, click "Paste JSON Payload" and paste the clipboard data.
 */

// Raw Bookmarklet Code:
/*
javascript:(async function(){
  const views = ['mSettings', 'mRoster', 'mTeam', 'mMatchup', 'mMatchupScore', 'mStandings', 'mTransactionHistory'];
  const urlParams = new URLSearchParams(window.location.search);
  let leagueId = urlParams.get('leagueId') || urlParams.get('leagueid');
  let season = urlParams.get('seasonId') || urlParams.get('seasonid') || new Date().getFullYear();

  if (!leagueId) {
    const parts = window.location.pathname.split('/');
    const leagueIdIdx = parts.indexOf('leagues');
    if (leagueIdIdx !== -1 && parts[leagueIdIdx + 1]) {
      leagueId = parts[leagueIdIdx + 1];
    }
  }

  if (!urlParams.get('seasonId') && !urlParams.get('seasonid')) {
    const parts = window.location.pathname.split('/');
    const fflIdx = parts.indexOf('ffl');
    if (fflIdx !== -1 && parts[fflIdx + 1]) {
      season = parts[fflIdx + 1];
    }
  }

  if(!leagueId){
    alert('Error: Gridiron Edge could not find your League ID. Make sure you are on fantasy.espn.com league page or draft page!');
    return;
  }

  const url = 'https://fantasy.espn.com/apis/v3/games/ffl/seasons/' + season + '/segments/0/leagues/' + leagueId + '?view=' + views.join('&view=');
  
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Status: ' + response.status);
    const data = await response.json();
    
    const textarea = document.createElement('textarea');
    textarea.value = JSON.stringify(data);
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    alert('League payload successfully copied to clipboard! Return to Gridiron Edge and paste it in.');
  } catch (err) {
    alert('Error extracting ESPN league data: ' + err.message + '. Make sure you are signed in and viewing your league.');
  }
})();
*/
