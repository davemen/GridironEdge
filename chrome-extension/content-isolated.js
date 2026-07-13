// Isolated world content script for Gridiron Edge ESPN Sync extension
// Listens for postMessage events from the main-world script and forwards them to the service worker

(function() {
  console.log("[Gridiron Edge Sync] Isolated script initialized. Listening for messages from page context...");

  window.addEventListener('message', (event) => {
    // Only trust messages from the same window
    if (event.source !== window) return;

    if (event.data && event.data.type === 'GRIDIRON_EDGE_SYNC') {
      try {
        // Forward securely to background.js using MV3 runtime APIs
        chrome.runtime.sendMessage({ action: 'sync', data: event.data.data });
      } catch (err) {
        console.warn("[Gridiron Edge Sync] Failed to forward sync message to background:", err.message);
      }
    }
  });
})();
