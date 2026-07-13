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
javascript:(function(){
  const views = ['mSettings', 'mRoster', 'mTeam', 'mMatchup', 'mMatchupScore', 'mStandings', 'mTransactionHistory'];
  const parts = window.location.pathname.split('/');
  const leagueIdIdx = parts.indexOf('leagues');
  if(leagueIdIdx === -1){
    alert('Error: Gridiron Edge could not find your League ID. Make sure you are on fantasy.espn.com league homepage!');
    return;
  }
  const leagueId = parts[leagueIdIdx + 1];
  const season = parts[parts.indexOf('ffl') + 1] || new Date().getFullYear();
  const url = 'https://fantasy.espn.com/apis/v3/games/ffl/seasons/' + season + '/segments/0/leagues/' + leagueId + '?view=' + views.join('&view=');
  
  fetch(url)
    .then(response => {
      if (!response.ok) throw new Error('Status: ' + response.status);
      return response.json();
    })
    .then(data => {
      const textarea = document.createElement('textarea');
      textarea.value = JSON.stringify(data);
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      alert('League payload successfully copied to clipboard! Return to Gridiron Edge and paste it in.');
    })
    .catch(err => {
      alert('Error extracting ESPN league data: ' + err.message + '. Make sure you are signed in and viewing your league.');
    });
})();
*/
