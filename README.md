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

Prerequisites: **Python 3** (for the local server), **Node 18+** (only to run the
tests), and **Chrome** (for the extension).

```bash
./Start\ Gridiron\ Edge.command      # double-clickable on macOS
# or
python3 server.py                    # then open http://localhost:8000
```

The server is not optional. The app fetches `data/projections-2026.json` and
`/imported_league.json` over HTTP, so opening `index.html` from `file://` gives
you a blank page.

The server binds `127.0.0.1` only and serves an explicit allowlist — `index.html`,
`css/`, `js/`, `data/`, and the sync file. It is not reachable from your network.

## Getting your league in

**During a live draft — the Chrome extension.** See
[`chrome-extension/README.md`](chrome-extension/README.md) for loading and
troubleshooting. It scrapes the draft room every two seconds and POSTs to
`http://localhost:8000/sync`, which writes `imported_league.json`; the app polls
that file every three seconds. Reload the extension from `chrome://extensions`
after any edit — Chrome caches content scripts, and a stale one is the first
thing to rule out when a fix appears to have done nothing.

**Outside a draft — the bookmarklet or a paste.** The Setup screen offers
"Setup Bookmarklet" (works on private leagues, since it runs in your session) and
"Paste JSON Payload". A public league can be fetched by ID.

No API keys, no accounts, no data leaves your machine.

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

Eleven suites. Each file's header explains the specific failure it guards
against — most of them shipped at some point. A few worth knowing about:

| Suite | Guards |
|---|---|
| `syntax.test.mjs` | that every module parses **as an ES module** and the app boots. `node --check` silently exits 0 on a broken file here — see the header. |
| `render.test.mjs` | that every page actually renders against a realistic league. A deleted variable declaration is invisible to a syntax check. |
| `xss.test.mjs` | that a hostile draft payload cannot become markup. |
| `perf.test.mjs` | that the live-draft hot path stays inside its budget, and that optimising it did not change any answer. |
| `scraper.test.mjs` | the real content script against rows copied from a live draft room. |

## Layout

```
index.html            the whole UI
server.py             local server + the /sync endpoint
js/app.js             routing, rendering, page logic
js/store.js           state and localStorage persistence
js/espn-client.js     ESPN payload -> the app's schema
js/player-database.js name resolution (the hard part)
js/escape.js          HTML escaping for anything scraped or fetched
js/engine/            the models — see lineup-rules.js for the shared rules
chrome-extension/     the draft-room scraper
test/                 eleven suites
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
