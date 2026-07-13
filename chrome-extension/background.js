// Background service worker for Gridiron Edge ESPN Sync extension
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'sync') {
    fetch('http://localhost:8000/sync', {
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
