/**
 * Service worker: the only thing that stores what the draft-room scraper finds.
 *
 * It used to POST every scrape to a local Python server, which wrote a file the
 * app re-fetched every three seconds. That put a listening socket, a CORS
 * policy and a write endpoint between two halves of the same extension. Now it
 * writes to chrome.storage.local, and the app page — which ships in this same
 * package — is woken by chrome.storage.onChanged within a millisecond or two.
 *
 * No server, no port, nothing for a user to install or run.
 */
const TRUSTED_ORIGIN = 'https://fantasy.espn.com';
const STORAGE_KEY = 'gridironDraft';

/**
 * Open app pages, kept as live ports.
 *
 * A draft moves every second — a bid ticks, someone nominates — and waiting for
 * a storage round-trip on every one of those is latency nobody needs to pay.
 * Ports deliver in well under a millisecond, so the page repaints essentially as
 * the scraper sees the change. chrome.storage is still written, but as the
 * durable snapshot a newly-opened page reads, not as the delivery mechanism.
 */
const appPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'gridiron-app') return;
  appPorts.add(port);
  port.onDisconnect.addListener(() => appPorts.delete(port));
});

function broadcast(message) {
  for (const port of appPorts) {
    try {
      port.postMessage(message);
    } catch (e) {
      // The page went away between the check and the send.
      appPorts.delete(port);
    }
  }
}

/**
 * Enough shape to reject anything that is not a scrape result. The content
 * script checks this too; a service worker that trusts its callers is one
 * bypass away from writing whatever it is handed.
 */
function looksLikeAScrape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (typeof data.leagueId !== 'string' && typeof data.leagueId !== 'number') return false;
  if (!Array.isArray(data.teams) || data.teams.length === 0) return false;
  const picks = data.draftDetail && data.draftDetail.picks;
  return picks === undefined || Array.isArray(picks);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.action !== 'sync') return false;

  // sender.origin is the field Chrome guarantees for this; sender.url can be
  // absent for some contexts and was the weaker check this used before.
  const origin = (sender && sender.origin)
    || (sender && sender.url ? new URL(sender.url).origin : '');
  // ESPN's draft room, or our own popup. Anything else is refused: this worker
  // used to forward whatever it was handed, from wherever.
  // Ask the runtime for our own origin rather than building it from a literal
  // scheme. Safari serves extension pages from safari-web-extension://, so
  // "chrome-extension://" + runtime.id matched nothing there and the popup's
  // own syncs were refused by the worker that ships alongside it.
  //
  // Trimmed by hand rather than with `new URL(...).origin`: neither
  // chrome-extension: nor safari-web-extension: is a "special" scheme, so the
  // URL parser reports their origin as the string "null" -- which compares
  // equal to itself and would have let any extension through.
  const ownOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
  if (origin !== TRUSTED_ORIGIN && origin !== ownOrigin) {
    console.warn('[Gridiron Edge] Refused a sync from', origin || 'an unknown sender');
    return false;
  }
  if (!looksLikeAScrape(message.data)) {
    console.warn('[Gridiron Edge] Refused a payload that is not a league.');
    return false;
  }

  // Deliver first, persist second. The open page should not wait on a disk
  // write to show a bid that just changed.
  broadcast({ type: 'draft', data: message.data });

  chrome.storage.local.set({ [STORAGE_KEY]: message.data }, () => {
    if (chrome.runtime.lastError) {
      console.error('[Gridiron Edge] Could not store the draft:',
        chrome.runtime.lastError.message);
      sendResponse({ ok: false });
      return;
    }
    sendResponse({ ok: true });
  });
  return true;    // keep the channel open for the async sendResponse
});

/**
 * MAIN-world injection is not guaranteed everywhere.
 *
 * The scraper is declared with `world: "MAIN"` because reading ESPN's own React
 * store is the fastest route to draft state. Chromium honours that; other
 * engines — Safari in particular — have supported it for less long and it cannot
 * be assumed. If a draft tab has been open for a few seconds and has never
 * reported, inject the same script into the isolated world instead. It loses the
 * store shortcut and falls back to reading the rendered DOM, which is a path it
 * already has and already tests.
 */
const FALLBACK_AFTER_MS = 6000;
const reported = new Set();

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message && message.action === 'sync' && sender && sender.tab) {
    reported.add(sender.tab.id);
  }
  return false;
});


chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!tab.url || !tab.url.startsWith('https://fantasy.espn.com/')) return;
  if (!/\/draft/.test(tab.url)) return;

  reported.delete(tabId);
  setTimeout(async () => {
    if (reported.has(tabId)) return;   // MAIN world is working; nothing to do
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['chrome-extension/content-main.js'],
        // No `world` -- the isolated world, which every engine supports.
      });
      console.warn('[Gridiron Edge] MAIN-world injection did not report; '
        + 'running the scraper in the isolated world instead (DOM only).');
    } catch (e) {
      console.warn('[Gridiron Edge] Fallback injection failed:', e.message);
    }
  }, FALLBACK_AFTER_MS);
});

// Clicking the toolbar icon opens the app itself, reusing the tab if it is
// already open so a live draft does not end up with six copies of the page.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('index.html');
  const open = await chrome.tabs.query({ url });
  if (open.length) {
    await chrome.tabs.update(open[0].id, { active: true });
    return;
  }
  await chrome.tabs.create({ url });
});
