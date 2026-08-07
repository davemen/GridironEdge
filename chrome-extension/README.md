# Gridiron Edge ESPN Sync Chrome Extension

This Chrome Extension automates the process of scraping your private/public ESPN Fantasy Football leagues and synchronizing them directly with your local Gridiron Edge server, bypassing the need to copy-paste JSON files manually.

---

## Installation Instructions

1. **Open Chrome Extensions Page:**
   Open Google Chrome and navigate to `chrome://extensions/` in your address bar.

2. **Enable Developer Mode:**
   Toggle the **Developer mode** switch in the top right corner of the page to **ON**.

3. **Load the Extension:**
   * Click the **Load unpacked** button in the top-left corner.
   * In the file selector, navigate to your `GridironEdge` project folder.
   * Select and load the `chrome-extension` directory.

4. **Pin the Extension (Optional but recommended):**
   Click the puzzle piece icon in Chrome's top right toolbar, locate **Gridiron Edge ESPN Sync**, and click the pin icon.

---

## How to Use

1. **Start Your Local Server:**
   Ensure the Gridiron Edge server is running:
   ```bash
   python3 server.py
   ```
2. **Go to ESPN Fantasy Football:**
   Open your browser and navigate to your league home page (e.g., `https://fantasy.espn.com/football/league?leagueId=XXXXXX`).
3. **Open the Extension & Sync:**
   * Click the extension icon.
   * Click **Sync Active League**.
   * If the local development server is running, the extension will instantly sync the data.
   * If the server is offline, it will automatically fallback to copying the JSON payload to your clipboard so you can paste it manually.

## Troubleshooting

**Reload the extension after any edit.** Chrome caches content scripts, so an
edit you just made may not be running. Go to `chrome://extensions`, hit reload on
Gridiron Edge, then refresh the ESPN tab. This is the first thing to rule out
when a fix appears to have done nothing.

**Confirm which version is actually loaded.** In the ESPN tab's console:

```js
window.__GRIDIRON_EDGE_VERSION__     // e.g. '2026.08.07-rejects'
```

If that is not the version you expect, the reload did not take and nothing else
you observe is meaningful. (`manifest.json` carries a separate, coarser version
for Chrome's own use; the marker above is the one that tracks code changes.)

**See what the scraper actually parsed.** In the ESPN tab's console:

```js
__GRIDIRON_EDGE_DEBUG__()
```

It prints the teams and budgets it found, how many picks it parsed, how many it
attributed to you, how many it could not attribute at all, the last dozen picks
with their owners — and a second table of every row it *dropped*, with the
reason. That last table is usually the answer. `window.__GRIDIRON_EDGE_LAST__`
holds the raw payload if you want to inspect it directly.

**Banners in the app tell you when something is wrong.** An amber banner means
the app read fewer picks than ESPN reports; a red one means picks arrived that
could not be matched to a manager. Neither is silent.

**Deeper diagnostics** live in [`debug/`](debug/) as console-paste scripts.
