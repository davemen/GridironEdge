# The draft-room scraper

Reads your live ESPN draft room and hands it to the app. Four files:

| File | Runs in | Does |
|---|---|---|
| `content-main.js` | the page's own world | reads the draft room and posts what it finds |
| `content-isolated.js` | the extension's world | forwards that to the service worker |
| `background.js` | the service worker | stores it and pushes it to the app page |

## Installing

The extension is the **repo root**, not this directory — `manifest.json` lives
one level up and references `index.html`, `js/` and `icons/` alongside these
scripts. Loading this folder fails for lack of a manifest.

1. `chrome://extensions` → **Developer mode**
2. **Load unpacked** → select the repo root
3. Click the toolbar icon; the app opens in a tab
4. Open your ESPN draft room in another tab

There is no server. Earlier versions POSTed each scrape to a local Python
process which wrote a file the page re-fetched every three seconds; that is
gone, along with the file and the launcher script. Data now travels
`content script → service worker → app page` over a long-lived port, with
`chrome.storage.local` as the durable snapshot behind it.

For Safari, see [SAFARI.md](../SAFARI.md) — it needs a signed native app, and
`tools/install-safari.sh` builds and installs one.

## When it stops working

**Check which build the page is running first.** Content scripts are injected
at page load, so a draft room opened before an extension update keeps the old
ones — and keeps scraping perfectly well, so nothing looks broken while a newly
added path is simply absent. In the ESPN tab's console:

```
[Gridiron Edge Sync] Isolated script initialized (2026.08.07-sweep).
[Gridiron Edge Sync] Main world script initialized (2026.08.07-sweep).
```

Two lines, matching builds. Either missing or older means **reload that tab**.

Then, in the same console:

```js
__GRIDIRON_EDGE_DEBUG__()      // what the scraper last parsed
```

This is set on the page's own `window`, so it is reachable in Chrome. **In
Safari it is not** — there the scraper runs in the isolated world and the page
console cannot see it; use **Develop → Web Extension Background Content** to
read the service worker's log instead.

The app's own banner is usually more direct: it reports how many picks ESPN
says have been made against how many were read.

### An auction room reads differently

ESPN usually renders no draft board in an auction — one live room, checked
directly, contained exactly two tables: your queue and one team's roster. The
scraper still accepts an auction results table where one exists, because
"there is never one" was concluded twice from partial DOM dumps and was wrong
both times. So a scrape often sees only the team whose panel is open, and the app steps the room's own dropdown through the league to
read the rest. That is automatic, throttled to once a minute, and it gives up
after two passes that add nothing.

You will see the roster panel cycle through the teams while it runs. If picks
never appear, the dropdown is not being found; if the panel does not move, it
refused the change event.
