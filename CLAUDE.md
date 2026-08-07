# Working in this repo

Conventions that are consistently applied here but are not obvious from any one
file. Read this before changing anything.

## No build step

Plain ES modules, loaded directly by the browser. There is a `package.json`, but
only for test scripts — there are **no dependencies**, no bundler, no transpiler.
Do not add one without a reason that survives being said out loud.

## `npm test` is the gate, not `node --check`

`node --check` used to be actively dangerous here: with no `package.json` it
treated modules as CommonJS, stopped at the first `import`, and **exited 0** on a
file containing `const a = ;`. A broken build shipped exactly that way. The
`package.json` added later declares `"type": "module"`, so on `js/` it is now
correct — but it still resolves no imports, boots nothing, and says nothing about
the extension's classic scripts.

```bash
npm test                     # the real gate
node test/syntax.test.mjs    # parses every module AS a module, then boots the app
```

`test/syntax.test.mjs` also asserts that its own checker still rejects
deliberately broken source, so it cannot go quiet the way the old one did.

## Never invent a number

The single most important rule. If a value is unknown, say so:

- an unresolvable player gets **replacement level**, never a mid-range guess —
  an invented projection flows straight into a bid ceiling
- a panel with no data gets an **empty state that explains itself**, never a
  plausible-looking placeholder
- "nothing to report" and "could not reach the feed" are different facts and must
  never share a message

This has been violated repeatedly and each time it took a while to notice,
because invented output looks exactly like real output. Hardcoded strings that
*read* like analysis ("Wide Receiver room is deep and healthy") are the same
offence as a hardcoded number.

## Escape anything from outside

Player names, team names, the league name and news headlines are all attacker-
controllable in the sense that matters: they come from a scraped page or a
third-party API. Use `esc()` from `js/escape.js` for anything interpolated into
markup, or `textContent` where the value is plain text. Never build an inline
`onclick` — bind a listener. `test/xss.test.mjs` enforces this.

## Comments carry the *why*

Engine modules are heavily commented and that is deliberate. `simulator.js`,
`lineup-optimizer.js` and `trade-generator.js` are the outstanding exceptions. Explain the
decision and the failure it prevents, not the mechanics:

```js
// Losing him means he is off the board entirely -- so both sides of the
// comparison must shop from a board without him. Leaving him in the baseline
// would quietly assume we can still buy him later, which collapses every
// ceiling to zero: passing would cost nothing.
```

**A stale comment is worse than none.** If you change behaviour, change the
comment above it. Do not assert a count in a comment unless a test checks it —
several have drifted (`22 mock players` when there were 31; `459 players` when
there were 523).

## One definition of anything

Duplication that drifts is the most expensive failure mode here, and it has
happened repeatedly: three name normalizers that disagreed on apostrophes, two
scrapers where each had the bug the other had fixed, six shapes of the lineup
rules. Before copying a block, put it in a module:

- `js/engine/lineup-rules.js` — starting slots, flex, playoff shape
- `js/player-database.js` — `playerKey` is the **only** name normalizer
- `js/engine/roster-manager.js` — `freeAgentPool` is the only free-agent pool
- `js/bridge.js` — the only way draft data enters the app

## No server, ever

The app is an extension page. Data arrives by port and `chrome.storage`, never
over HTTP from something the user has to run. If you find yourself adding a
`fetch('http://localhost...')`, that is the wrong shape.

## Don't swallow errors

A bare `catch (e) {}` is how "102 picks made, 0 were read" became a mystery. Give
it a body, or state why silence is correct:

```js
} catch (e) { /* the counter is a nicety, not a requirement */ }
```

## Measure, don't assert

`BACKTEST.md` is the record and it includes the negative results. A parameter
change is not an improvement until it survives a paired comparison, and several
that looked like wins vanished on validation. If you optimise something, prove
the output did not change (`test/perf.test.mjs` does this by comparison, not by
hope).

## Commits

Subject is a behavioural sentence, not a conventional-commit prefix. Body
explains what was wrong and how it was verified. Look at `git log` for the shape.
