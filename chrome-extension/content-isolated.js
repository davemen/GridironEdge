// Isolated world content script for Gridiron Edge ESPN Sync extension
// Listens for postMessage events from the main-world script and forwards them to the service worker

(function() {
  console.log("[Gridiron Edge Sync] Isolated script initialized. Listening for messages from page context...");

  window.addEventListener('message', (event) => {
    // Only trust messages from the same window
    if (event.source !== window) return;

    if (event.data && event.data.type === 'GRIDIRON_EDGE_SYNC') {
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
    
    banner.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px;">
        <span>🔄 Gridiron Edge Sync Extension reloaded.</span>
        <button onclick="window.location.reload();" style="background:#ffffff; color:#d50000; border:none; padding:6px 12px; border-radius:4px; font-weight:700; cursor:pointer; font-size:12px; transition:opacity 0.2s;">
          Refresh Page to Sync
        </button>
      </div>
    `;
    document.body.appendChild(banner);
  }
})();
