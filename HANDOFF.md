# Handoff — 2026-08-07 (after round 6)

Read `CLAUDE.md` first; it is the rules. This is the state and the queue.

## The standing instruction

Run the **5-point audit** — five independent parallel agents (security, tests,
performance, documentation, readability), each proving findings by execution
rather than by reading. After each round: record it in `audit/history.json`,
regenerate `audit-report.html` (`node audit/build-report.mjs`), fix the
findings, and repeat **until every category is ≥ 90**. Do not stop before that.

Prompts that work are in the memory file `repo-audit-prompt.md`. Two structural
choices matter: run all five in parallel, and use **fresh** agents each round so
"I fixed it" is verified by someone who did not write the fix.

## Where the scores are

| | R1 | R2 | R3 | R4 | R5 | R6 |
|---|---|---|---|---|---|---|
| security | 31 | 62 | 52 | 58 | 64 | 78 |
| tests | 54 | 61 | 38 | 47 | 52 | 60 |
| perf | 42 | 55 | 52 | 62 | 71 | 78 |
| docs | 58 | 66 | 44 | 61 | 58 | 67 |
| readability | 58 | 61 | 62 | 58 | 63 | 64 |

Mutation score 27% → 39% → 36% → **49.6%**. Line coverage **67.2%**.
Every category rose in round 6. Nothing is at 90.

**Round 6 raised 71 findings. 55 are fixed; 16 remain, listed below.**
Round 7 has not been run: the scores above are round 6's, and nothing here
claims the fixes moved them.

## The one lesson round 6 taught

**Fixes get applied to one branch of a fork.** Every category found an instance:

- `runSeasonSimulation` learned to decline when it cannot read a roster;
  `preseasonOutlook`, which the app routes to for *every draft-room import*,
  did not — and scored unread teams at 102.8, which is the old 105.0 constant
  renamed.
- `lineup-rules.js` gained settings-aware functions and kept the frozen
  constants exported beside them; four engines went on importing the constants,
  so the module whose whole purpose is one definition shipped two.
- `survival.js` consolidated the curve and left two different next-pick numbers
  feeding it — 43% and 80% for the same player.
- The shared player database was keyed off a field only `loadMockLeague` writes,
  so it saved zero bytes on the live path and cost +1.5ms a tick.
- The install sentinel went on `window`, which the two content-script worlds do
  not share, so both copies installed and the scrape ran twice.

When you fix something, grep for the *other* caller before believing it.

## Still open (16)

**Needs you, not an agent**

1. `../GridironEdge-pre-purge.bundle` still holds everything the history purge
   removed — three real league ids and the owner's team name. Delete it when
   satisfied. The purge itself is verified: 1,093 objects, 493 blobs, zero
   orphans, and all 28 data blobs now 404 from GitHub.

**Structural, and worth a round of their own**

2. **1,962 lines of the extension are invisible to coverage.** `content-main.js`,
   `content-isolated.js` and `background.js` are loaded via `new Function` over
   hand-sliced source, so V8 attributes none of it to a file. The 67.2% figure
   is over `js/` only, and a coverage-driven audit structurally cannot find gaps
   there.
3. **The XSS suite reaches 17.5% of the escape sites it defends** — 29 of 166
   have hostile data proven to arrive; 73 never execute at all. It needs a
   fixture with a bench, a resolvable trade partner and an injured player.
4. **`num()` is defined six times** — the exported one plus five private copies
   in the engines with *different* semantics (`typeof v === 'number' ? v : 0`
   rejects numeric strings). The "one definition of anything" rule, verbatim.
5. **The ~500-row draft table is rebuilt on every keystroke**, with no debounce
   and no cache key: 15.1ms warm, 96.5ms on a render carrying a sale.

**Known and bounded**

6. `lineup-optimizer`'s thirteen scoring constants and its whole
   `replacementPlans` output are executed by no test.
7. `survival.js` has 100% coverage and 4 of 8 mutants survive — `ADP_SPREAD`,
   `MIN_SD` and both clamps are unpinned.
8. `readText` was not applied at four sites its own comment claims; the measured
   win is 28%, not the 55% that comment states.
9. `recommendBid`'s 25ms budget flakes at 3.3% (max 69.8ms over 120 runs).
10. `store.test.mjs` uses an undeclared `store` that resolves to a global.
11. Cross-league record aliasing: after `restoreSharedDatabase`, leagues share
    record objects. Harmless only because nothing reads `.drafted`,
    `.draftedCost`, `.draftedAtPick` or `.ownerId` — which also makes those five
    write sites pure waste.
12. `package-extension.sh`'s blocklist is string-literal, so `$HOME/x/..`
    bypasses it. The marker guard still refuses.
13–16. Assertions that cannot fail, ceilings where equalities are meant, and two
    lists of smaller residue — each enumerated in `audit/history.json`.

**Deliberately not fixed, argued in the code**: both shape gates stringify the
payload to measure it, because trusting a size from the sender is worse and
textual identity is what stops the two gates drifting again; and a cold
`targetBoard` blocks 20–205ms in the task carrying a sale, because an idle
callback would paint a board still listing the player who just sold.

## Do these next

- **Run round 7.** 55 findings were closed by the session that read them, which
  is the arrangement rounds 4 and 6 both proved worth distrusting.
- **Verify against a live draft room.** Two changes here have never met ESPN:
  the sweep moved worlds and now bails differently, and the install sentinel
  moved to `document.documentElement.dataset`. Both are covered by tests that
  drive the real code against a fake room; neither has run against a real one.
  After any install, **reload the ESPN draft-room tab** — content scripts are
  injected at page load, so an open tab keeps the old ones and keeps scraping.

## The extension itself

Installed at `/Applications/GridironEdge.app`, build `2026.08.07-sweep`.
Rebuild with `./tools/install-safari.sh <TEAM_ID>`, or set `$GRIDIRON_TEAM_ID`.

## Things I got wrong this round, so you do not repeat them

- **I wrote a commit message claiming a test I had not added**, because the
  script that was meant to add it failed its assertion while the commit went
  ahead anyway. And I wrote "~29%" for a bracket distribution I had just
  measured at 25.0%. Both were caught by re-reading the message against the run
  that produced it, and amended. Check your own numbers the same way.
- **My first fixture for the odds decline was wrong twice**: guarding on
  "mid-draft" skipped every real import, and a by-team bracket test could not
  see a by-seed bug. When a test passes, ask what it would take to make it fail.
- **Two existing fixtures encoded the bug being fixed** — `render.test.mjs` gave
  picks to one team of eight, which is exactly the board the odds engines now
  decline on. A test that breaks when you fix something is worth reading before
  it is worth changing.

## Orientation

`js/app.js` is 3,327 lines with all 10 page renderers in it, and
round 6 judged the decision not to split it defensible: the routing order
matches the definition order, so it reads top to bottom. Those two counts are
asserted by `test/render.test.mjs` against the file itself, because the previous
handoff claimed 3,117 and eleven and both were already false when written.

## Ground rules that bit repeatedly

- `npm test` is the gate. 15 suites, ~750 assertions.
- Never write to `imported_league.json` or `data/*.json` while testing.
- Never invent a number, and never let "nothing to report" share a message with
  "could not reach the feed".
