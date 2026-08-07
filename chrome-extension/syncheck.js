/**
 * Paste into the ESPN draft-room console. Reports which hop of the sync chain
 * is broken, rather than leaving "sync is not working" to be guessed at.
 *
 *   page scraper  ->  isolated script  ->  service worker  ->  localhost:8000
 */
(async () => {
  const r = {};

  // Hop 1: is the current content script running in this tab?
  r['1_content_script'] = window.__GRIDIRON_EDGE_VERSION__ || 'NOT LOADED (old or absent)';

  // Hop 2: can this page reach the local server at all? If this fails but the
  // server answers in a normal tab, the block is CORS or mixed content.
  try {
    const res = await fetch('http://localhost:8000/health', { cache: 'no-store' });
    const j = await res.json();
    r['2_server_reachable'] = 'YES';
    r['3_sync_file_age_mins'] = Math.round((j.syncFileAgeSeconds || 0) / 60);
  } catch (e) {
    r['2_server_reachable'] = 'NO — ' + e.message;
  }

  // Hop 3: does a scrape actually produce anything to send?
  const card = document.querySelector('.pickArea [data-testid="player-selected"], .pickArea');
  r['4_nomination_visible'] = !!card;
  const amt = document.querySelector('.current-amount');
  r['5_live_bid'] = amt ? amt.innerText.trim() : 'none';

  console.table(r);
  console.log('%c If 1 says NOT LOADED, reload the extension AND fully reopen this tab. ',
    'background:#ffb020;color:#000');
  console.log('%c Then open chrome://extensions -> Gridiron Edge -> "service worker" ' +
    'and watch its console while a pick happens. ', 'background:#00e5ff;color:#000');
  return r;
})();
