/**
 * Service worker: the only thing that talks to the local server.
 *
 * It used to forward whatever arrived, from wherever it arrived, straight to
 * disk -- `sender` was never inspected, so any extension page or injected script
 * could drive it. A message now has to come from a tab on the ESPN draft site.
 */
const TRUSTED_SENDER_PREFIX = 'https://fantasy.espn.com/';
const SYNC_URL = 'http://localhost:8000/sync';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === 'sync') {
    const from = (sender && sender.url) || '';
    if (!from.startsWith(TRUSTED_SENDER_PREFIX)) {
      console.warn('[Gridiron Sync Service Worker] Refused a sync from', from || 'an unknown sender');
      return true;
    }
    fetch(SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.data)
    })
    .then(res => {
      if (res.ok) {
        console.log("[Gridiron Sync Service Worker] Sync successful");
      } else {
        console.error("[Gridiron Sync Service Worker] Sync server returned status:", res.status);
      }
    })
    .catch(err => {
      console.warn("[Gridiron Sync Service Worker] Sync server offline:", err.message);
    });
  }
  return true;
});
