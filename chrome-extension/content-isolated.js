/**
 * Isolated-world half of the sync bridge.
 *
 * The MAIN-world script scrapes the draft room and postMessages the result here;
 * this forwards it to the service worker, which stores it and pushes it to the
 * app page. (It used to POST to a local web server. There is no server now.)
 *
 * That makes this listener a trust boundary, and it was not treating itself as
 * one: the only check was `event.source !== window`, which any script running in
 * the same frame satisfies trivially. Combined with all_frames, any third-party
 * tag or ad on the page could post a GRIDIRON_EDGE_SYNC message and have the
 * extension write attacker-chosen JSON into the file the app renders.
 *
 * Now: the origin must be ESPN, the message must arrive from this exact window,
 * and the payload must look like a league before it goes anywhere.
 */

(function() {
  const TRUSTED_ORIGIN = 'https://fantasy.espn.com';

  /**
   * Enough shape to reject anything that is not a scrape result. This is not a
   * schema validator -- it is a gate that stops arbitrary objects reaching disk.
   */
  function looksLikeAScrape(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (typeof data.leagueId !== 'string' && typeof data.leagueId !== 'number') return false;
    if (!Array.isArray(data.teams) || data.teams.length === 0) return false;
    const picks = data.draftDetail && data.draftDetail.picks;
    if (picks !== undefined && !Array.isArray(picks)) return false;
    // A draft payload is tens of kilobytes; anything far past that is not ours.
    try {
      if (JSON.stringify(data).length > 5 * 1024 * 1024) return false;
    } catch (e) {
      return false;   // circular or otherwise unserialisable
    }
    return true;
  }

  console.log("[Gridiron Edge Sync] Isolated script initialized. Listening for messages from page context...");

  window.addEventListener('message', (event) => {
    // Same frame AND the right site. event.source alone proves almost nothing:
    // every script in this frame shares this window.
    if (event.source !== window) return;
    if (event.origin !== TRUSTED_ORIGIN) return;

    if (event.data && event.data.type === 'GRIDIRON_EDGE_SYNC') {
      if (!looksLikeAScrape(event.data.data)) {
        console.warn('[Gridiron Edge Sync] Ignored a sync message that is not a league payload.');
        return;
      }
      try {
        // Test if context is valid
        if (!chrome.runtime || !chrome.runtime.id) {
          showRefreshBanner();
          return;
        }
        // Forward securely to background.js using MV3 runtime APIs
        chrome.runtime.sendMessage({ action: 'sync', data: event.data.data });
      } catch (err) {
        console.warn("[Gridiron Edge Sync] Failed to forward sync message to background:", err.message);
        showRefreshBanner();
      }
    }
  });

  /**
   * Relay a "scan all rosters" request to the scraper, and its answer back.
   *
   * The scraper is declared world: "MAIN", where chrome.runtime does not
   * exist -- so a chrome.runtime.onMessage listener placed there never
   * registers, and the request reached the tab and was answered by nobody.
   * That surfaced as "the draft room did not respond".
   *
   * This half is the one with extension APIs, so the request lands here and
   * crosses to the scraper the same way results already cross back: a
   * postMessage on the shared window, origin-checked in both directions.
   */
  const SWEEP_TIMEOUT_MS = 45000;

  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.action !== 'sweepRosters') return false;

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onResult);
        sendResponse(result);
      };
      function onResult(event) {
        if (event.source !== window) return;
        if (event.origin !== TRUSTED_ORIGIN) return;
        if (!event.data || event.data.type !== 'GRIDIRON_EDGE_SWEEP_RESULT') return;
        finish(event.data.result);
      }
      window.addEventListener('message', onResult);
      window.postMessage({ type: 'GRIDIRON_EDGE_SWEEP_REQUEST' }, TRUSTED_ORIGIN);

      // A sweep waits on a re-render per team, so it needs real time -- but it
      // must not leave the button spinning forever if the scraper is not there.
      setTimeout(() => finish({ ok: false, reason: 'scraper-did-not-answer' }),
        SWEEP_TIMEOUT_MS);
      return true; // the response is asynchronous
    });
  }

  function showRefreshBanner() {
    if (document.getElementById('gridiron-refresh-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'gridiron-refresh-banner';
    banner.style.position = 'fixed';
    banner.style.top = '10px';
    banner.style.left = '50%';
    banner.style.transform = 'translateX(-50%)';
    banner.style.backgroundColor = '#d50000';
    banner.style.color = '#ffffff';
    banner.style.textAlign = 'center';
    banner.style.padding = '12px 24px';
    banner.style.fontSize = '14px';
    banner.style.fontFamily = 'Inter, system-ui, sans-serif';
    banner.style.fontWeight = '700';
    banner.style.borderRadius = '8px';
    banner.style.boxShadow = '0 4px 20px rgba(0,0,0,0.4)';
    banner.style.zIndex = '999999';
    banner.style.border = '2px solid rgba(255,255,255,0.2)';
    
    // Built rather than templated, and the handler is bound rather than inlined:
    // an inline onclick in an extension-injected banner is the same hazard the
    // app was just cleaned of.
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:12px;';
    const label = document.createElement('span');
    label.textContent = '🔄 Gridiron Edge Sync Extension reloaded.';
    const btn = document.createElement('button');
    btn.textContent = 'Refresh Page to Sync';
    btn.style.cssText = 'background:#ffffff; color:#d50000; border:none; padding:6px 12px;'
      + 'border-radius:4px; font-weight:700; cursor:pointer; font-size:12px;';
    btn.addEventListener('click', () => window.location.reload());
    row.appendChild(label);
    row.appendChild(btn);
    banner.appendChild(row);
    document.body.appendChild(banner);
  }
})();
