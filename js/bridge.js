/**
 * How draft data reaches the app.
 *
 * It used to arrive over HTTP: the extension POSTed the scraped draft to a local
 * Python server, which wrote imported_league.json, which the page re-fetched
 * every three seconds. That worked, but it asked every user to run a web server
 * on their own machine — and it put a listening socket, a CORS policy, a write
 * endpoint and a path allowlist between a Chrome extension and a page that ships
 * in the same package as that extension.
 *
 * The app is now an extension page, so the two halves can simply talk:
 *
 *     content script  ->  chrome.storage.local.set({ draft })
 *     app page        ->  chrome.storage.onChanged  ->  render
 *
 * That is a push, not a poll. Data appears within a millisecond or two of the
 * pick landing instead of up to three seconds later, and there is no server, no
 * port, no origin policy and nothing to install.
 *
 * The HTTP path is kept as a fallback for one real case: running the app from a
 * plain static server during development, where the extension APIs do not exist.
 * `describeSource()` says which one is live, so the interface can tell the truth
 * about where its data is coming from.
 */

export const STORAGE_KEY = 'gridironDraft';

/** Are we running as an extension page, with storage available? */
export function hasExtensionBridge() {
  return typeof chrome !== 'undefined'
    && Boolean(chrome.storage && chrome.storage.local)
    && Boolean(chrome.runtime && chrome.runtime.id);
}

/** Which transport is actually in use, for the interface to report honestly. */
export function describeSource() {
  if (hasExtensionBridge()) {
    return { kind: 'extension', label: 'Extension (live)', needsServer: false };
  }
  return { kind: 'http', label: 'Local file poll', needsServer: true };
}

/** The draft the extension last wrote, or null. */
export async function readLatest() {
  if (!hasExtensionBridge()) return null;
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(STORAGE_KEY, (all) => {
        // A read after the extension reloads can surface a lastError; treat it
        // as "nothing yet" rather than letting it reject the whole startup.
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve((all && all[STORAGE_KEY]) || null);
      });
    } catch (e) {
      console.warn('[Gridiron Edge] Could not read stored draft:', e.message);
      resolve(null);
    }
  });
}

/**
 * Call `onDraft` whenever the extension writes a new draft state, and once
 * immediately with whatever is already stored.
 *
 * Returns a function that stops listening.
 */
export function subscribe(onDraft) {
  if (!hasExtensionBridge()) return () => {};

  const listener = (changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue;
    if (next) onDraft(next);
  };
  chrome.storage.onChanged.addListener(listener);

  // Whatever was scraped before this page opened.
  readLatest().then((initial) => { if (initial) onDraft(initial); });

  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * The HTTP fallback, for development against a static server.
 *
 * Polls the file the old sync server wrote. Kept deliberately small: it exists
 * so `python3 -m http.server` still works for someone hacking on the UI, not as
 * a supported path for users.
 */
export function pollHttp(onDraft, intervalMs = 3000) {
  let lastKey = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const res = await fetch('imported_league.json?cb=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        // Same change key the extension uses, so a bid tick counts as a change.
        const key = JSON.stringify([
          data.draftDetail?.picks?.length || 0,
          data.currentNomination,
          (data.teams || []).map((t) => t.faabRemaining),
        ]);
        if (key !== lastKey) { lastKey = key; onDraft(data); }
      }
    } catch (e) {
      // A missing file is the normal state before the first sync. Anything else
      // is worth seeing -- swallowing every failure here once hid a render bug
      // that repeated silently every three seconds.
      if (!/Failed to fetch|NetworkError|404/.test(String(e && e.message))) {
        console.warn('[Gridiron Edge] Sync poll failed:', e.message);
      }
    }
  };

  tick();
  const id = setInterval(tick, intervalMs);
  return () => { stopped = true; clearInterval(id); };
}

/**
 * The fast path: a long-lived port to the service worker.
 *
 * A draft changes every second during bidding, and a storage round-trip on each
 * one is latency for nothing. The worker pushes down this port the moment the
 * scraper reports, so the page repaints essentially as the change is seen.
 * storage.onChanged stays subscribed underneath as a safety net: if the worker
 * has been suspended and the port is gone, the write still wakes us.
 */
export function connectPort(onDraft) {
  if (!hasExtensionBridge() || !chrome.runtime.connect) return () => {};
  let port = null;
  let closed = false;

  const open = () => {
    if (closed) return;
    try {
      port = chrome.runtime.connect({ name: 'gridiron-app' });
      port.onMessage.addListener((msg) => {
        if (msg && msg.type === 'draft' && msg.data) onDraft(msg.data);
      });
      // MV3 suspends idle service workers, which drops the port. Reconnect so
      // the fast path comes back rather than silently degrading to storage.
      port.onDisconnect.addListener(() => {
        port = null;
        if (!closed) setTimeout(open, 250);
      });
    } catch (e) {
      console.warn('[Gridiron Edge] Live port unavailable:', e.message);
    }
  };
  open();
  return () => { closed = true; if (port) { try { port.disconnect(); } catch (e) { /* already gone */ } } };
}

/**
 * Subscribe by whichever route is available.
 *
 * With the extension present this is both the port (fast) and storage (durable
 * and a fallback if the worker was asleep). The same draft arriving twice is
 * harmless — the import is keyed on content — and missing one is not.
 */
/**
 * Ask the draft room to read every team's roster.
 *
 * An auction renders one roster at a time, so the only way to see the whole
 * board is to step the room's own dropdown through the league. That writes to
 * the page the user is drafting in, so it never happens on a timer -- this is
 * the explicit request, and it is the user who makes it.
 *
 * Resolves to { ok, teams, players } or { ok: false, reason }.
 */
export function requestRosterSweep() {
  if (!hasExtensionBridge() || !chrome.runtime.sendMessage) {
    return Promise.resolve({ ok: false, reason: 'no-extension' });
  }
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'sweepRosters' }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, reason: chrome.runtime.lastError.message });
          return;
        }
        resolve(res || { ok: false, reason: 'no-response' });
      });
    } catch (e) {
      resolve({ ok: false, reason: e.message });
    }
  });
}

export function listenForDrafts(onDraft) {
  if (!hasExtensionBridge()) return pollHttp(onDraft);
  const stopPort = connectPort(onDraft);
  const stopStorage = subscribe(onDraft);
  return () => { stopPort(); stopStorage(); };
}
