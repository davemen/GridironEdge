# Gridiron Edge

A fantasy football draft and in-season assistant that runs entirely on your own
machine. It reads your live ESPN draft room through a Chrome extension and tells
you what to bid, what it is worth to *your* roster, and where to stop.

The auction engine is the reason this exists. It answers one question:

> What is the most I can pay for this player and still end up with a better
> roster than if I let him go?

That number moves with the room — when three rivals go broke, prices fall and
your ceiling rises, and nobody has to tune a constant for it. Everything else
(waivers, lineups, trades, championship odds) is built on the same idea.

## Running it

There is no server, no build step and nothing to install beyond the extension.

1. Open `chrome://extensions` and turn on **Developer mode**
2. **Load unpacked** → select this folder
3. Click the Gridiron Edge icon in the toolbar

That opens the app. Open your ESPN draft room in another tab and picks appear
within a second — the extension pushes them straight to the page.

Works on **Chrome, Edge, Brave and any other Chromium browser, on macOS, Windows
and Linux.** Earlier versions needed a local Python web server and a macOS-only
launcher script; both are gone.

**Safari** needs one build step and an Apple Developer account — see
[SAFARI.md](SAFARI.md).

### How data gets in

**During a draft.** The content script reads the draft room as it changes — a
MutationObserver, not a timer — and hands each update to the service worker,
which pushes it down a live port to the app page. Measured median delivery
latency is **under a millisecond**; the previous poll could take up to three
seconds.

**In an auction room.** ESPN renders no draft board in an auction — the room
contains your queue and one team's roster, and nothing else. So a scrape sees
only the team whose panel is open, and the app steps the room's own dropdown
through the league to read the rest. That happens by itself, throttled to once
a minute, and stops after two passes that add nothing. You will see the roster
panel cycle while it runs. It is a snapshot, not a feed.

**Outside a draft.** The Setup screen connects a public league by ID, or
accepts a JSON payload pasted from the Setup Bookmarklet for private ones.

No accounts, no API keys, and no service to run. The app reads three public
endpoints — ESPN's league and news APIs and Sleeper's trending feed — and
uploads nothing anywhere.

## Where the numbers come from

`data/projections-2026.json` ships in the repo: 523 players across all six roster
positions, from the FantasyPros week-0 consensus of 88 analysts. Projections are
not a forecast of our own — [BACKTEST.md](BACKTEST.md) Part 2 establishes that
the consensus cannot be beaten with public data. A player's positional rank is
read off a curve fitted to what that rank actually returned in 2016–2025, which
converts the consensus into the units the engines need.

Kickers and team defenses are not fantasy rows in the source data, so both are
rebuilt from their counting stats under ESPN's default scoring by
[`tools/kickers_defense.py`](tools/kickers_defense.py).

**When something is unknown, it says so.** An unresolvable player gets
replacement level rather than a mid-range guess, because an invented projection
flows straight into a bid ceiling. Panels with no data show an empty state rather
than a plausible-looking number.

## Tests

```bash
npm test                    # or: node --test test/*.test.mjs
npm run coverage
```

Fifteen suites, one command. Each file's header explains the specific failure it guards
against — most of them shipped at some point. A few worth knowing about:

| Suite | Guards |
|---|---|
| `syntax.test.mjs` | that every module parses **as an ES module** and the app boots. `node --check` silently exits 0 on a broken file here — see the header. |
| `render.test.mjs` | that every page actually renders against a realistic league. A deleted variable declaration is invisible to a syntax check. |
| `xss.test.mjs` | that a hostile draft payload cannot become markup. |
| `perf.test.mjs` | that the hot path stays inside budget, and that 360 pinned auction answers are unchanged. |
| `transport.test.mjs` | that draft data reaches the page in under a millisecond, and only from ESPN. |
| `scraper.test.mjs` | the real content script against rows copied from a live draft room. |

## Layout

```
manifest.json         the extension; the repo root IS the package
index.html            the whole UI, served from the extension origin
js/app.js             routing, rendering, page logic
js/bridge.js          how draft data arrives (port + storage, no server)
js/store.js           state and localStorage persistence
js/espn-client.js     ESPN payload -> the app's schema
js/player-database.js name resolution (the hard part)
js/escape.js          HTML escaping for anything scraped or fetched
js/engine/            the models — see lineup-rules.js for the shared rules
chrome-extension/     the draft-room scraper
test/                 fifteen suites
tools/                data preparation
BACKTEST.md           what was measured, and what turned out to be noise
audit-report.html     rolling five-dimension audit (audit/build-report.mjs)
```

## What is actually validated

[BACKTEST.md](BACKTEST.md) is the record, including the negative results — the
tuning sweeps that vanished on validation and the levers that measured a clean
null are in there alongside the wins. Read the Honest Summary first.

The short version: the auction engine is worth roughly +306 points a season
against the formula it replaced, and +125 against a static value chart in a
realistically front-loaded room. The championship-odds model on the home page is
*not* covered by that document — it is a preseason model, and the page says so.
