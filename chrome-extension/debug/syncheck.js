/**
 * Paste into the ESPN draft-room console. Reports which hop of the sync chain
 * is broken, rather than leaving "sync is not working" to be guessed at.
 *
 *   page scraper  ->  isolated script  ->  service worker  ->  chrome.storage
 *
 * WHICH CONSOLE. Hops 1, 2, 5 and 6 read the page, so run this in the ESPN
 * tab's own console. Hops 3 and 4 read chrome.storage, which the page cannot
 * see -- in that console they report "not visible from here", which is the
 * honest answer rather than a failure. To answer those, run it from the
 * extension's inspector instead. The header used to say "every hop below is
 * really checked", which its own body contradicts thirty lines down.
 *
 * An earlier version reported "server reachable: YES" from a hardcoded string,
 * and when that was removed the fetch went with it while the code reading its
 * response stayed -- `res.json()` on a `res` that was never declared, inside an
 * empty catch. It threw on every run and said nothing, which is the same
 * failure in a quieter form: a diagnostic that cannot fail tells you nothing
 * when it passes.
 */
(async () => {
  const r = {};

  // Hop 1: is the current content script running in this tab? Content scripts
  // are injected at page load, so a tab opened before an update keeps the old
  // ones -- and keeps scraping, so nothing looks wrong.
  // The MAIN-world script sets the version; the isolated one sets only its own
  // install flag. In the isolated console the version is legitimately absent,
  // so report which world answered rather than calling a current build "NOT
  // LOADED".
  r['1_page_scraper'] = window.__GRIDIRON_EDGE_VERSION__
    || (window.__GRIDIRON_EDGE_ISOLATED_INSTALLED__
      ? 'isolated half is installed (run this in the page console for the build string)'
      : 'NOT LOADED (old or absent)');

  // Hop 2: did the scraper actually parse anything this tab?
  const last = window.__GRIDIRON_EDGE_LAST__;
  if (!last) {
    r['2_last_payload'] = 'none captured yet';
  } else {
    const picks = (last.draftDetail && last.draftDetail.picks) || [];
    r['2_last_payload'] = `${(last.teams || []).length} teams, ${picks.length} picks`
      + `, coverage ${(last.coverage && last.coverage.kind) || 'unknown'}`;
  }

  // Hops 3 and 4: did the isolated script forward it, and did the worker store
  // it? Both are answered by the same question -- is there a payload in
  // chrome.storage -- because the worker is the only thing that writes there.
  //
  // This is the isolated world's API. Pasting into the page console leaves it
  // undefined, which is itself the answer to "am I looking at the right
  // console", so it is reported rather than skipped.
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    r['3_worker_storage'] = 'chrome.storage not visible from this console '
      + '(run it from the extension\'s own console, not the page\'s)';
  } else {
    try {
      const stored = await chrome.storage.local.get('gridironDraft');
      const d = stored && stored.gridironDraft;
      if (!d) {
        r['3_worker_storage'] = 'EMPTY — the worker has stored nothing';
      } else {
        const at = d.scrapedAt ? Date.parse(d.scrapedAt) : null;
        r['3_worker_storage'] = `league ${d.leagueId}, `
          + `${((d.draftDetail && d.draftDetail.picks) || []).length} picks`;
        r['4_storage_age_seconds'] = at ? Math.round((Date.now() - at) / 1000) : 'no timestamp';
      }
    } catch (e) {
      // Named, not swallowed: "could not read storage" and "storage is empty"
      // are different answers and this panel exists to tell them apart.
      r['3_worker_storage'] = `READ FAILED: ${(e && e.message) || e}`;
    }
  }

  // Hop 5: does the room currently show anything worth scraping?
  const card = document.querySelector('.pickArea [data-testid="player-selected"], .pickArea');
  r['5_nomination_visible'] = !!card;
  const amt = document.querySelector('.current-amount');
  r['6_live_bid'] = amt ? amt.innerText.trim() : 'none';

  console.table(r);
  console.log('%c If 1 says NOT LOADED, reload the extension AND fully reopen this tab. ',
    'background:#ffb020;color:#000');
  console.log('%c If 2 has picks but 3 is EMPTY, the break is between the page and the '
    + 'worker: open chrome://extensions -> Gridiron Edge -> "service worker" and watch '
    + 'its console while a pick happens. ', 'background:#00e5ff;color:#000');
  return r;
})();
