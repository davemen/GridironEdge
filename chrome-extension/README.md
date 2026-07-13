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
