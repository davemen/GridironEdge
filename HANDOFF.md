# Handoff — 2026-08-08 (after round 7's fixes, before round 8)

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

| | R1 | R2 | R3 | R4 | R5 | R6 | R7 |
|---|---|---|---|---|---|---|---|
| security | 31 | 62 | 52 | 58 | 64 | 78 | 74 |
| tests | 54 | 61 | 38 | 47 | 52 | 60 | 62 |
| perf | 42 | 55 | 52 | 62 | 71 | 78 | 84 |
| docs | 58 | 66 | 44 | 61 | 58 | 67 | 70 |
| readability | 58 | 61 | 62 | 58 | 63 | 64 | 68 |

Round 7 raised **64 findings; 38 are fixed**, in the fourteen commits from
`4075b40` to HEAD. Nothing is at 90. Round 8 has not been run, so those are
round 7's numbers and nothing here claims the fixes moved them.

## Trust the ledger, but know what it is

`audit/history.json`'s `fixed` flags are no longer written by hand. Run:

```bash
python3 audit/verify-fixes.py && node audit/build-report.mjs
```

Each flag is a check against the current tree; a check that fails **removes**
the flag, so a regression un-marks itself. This exists because round 6 was
recorded as 55 of 71 fixed by the session that wrote the fixes, and round 7
found six of those marked against a file that was never edited.

When you fix something, add its check. A finding with no check stays open —
which is the correct default, and the reason 26 are open below.

## The lesson round 7 taught

**The fix ledger is a fork too.** Round 6's lesson was that fixes get applied to
one branch of a fork; round 7's is that the *record* of the fix is another
branch, and it drifts the same way. Every claim about work done is a claim that
needs a check.

The corollary bit twice while fixing round 7:

- `js/store.js` said `recordWeeklyMetrics`'s "only caller repo-wide is
  loadMockLeague". False — `updatePlayerDatabase` reaches it at module init with
  all 523 real players. The *conclusion* held (no history accumulates) but for a
  different reason: `toPlayerDatabase` builds fourteen fields and `metrics` is
  not one. **A comment that survives a reading and fails a grep.**
- `survival.js` gave a worked example — "41 and 35, so 43% and 80%" — where 41
  is not a pick slot 1 ever holds and no ADP gives 43% at pick 40. Correct: 40
  and 35, 50% and 80%. Both are asserted now.

## Still open (26)

**Needs you, not an agent**

1. `../GridironEdge-pre-purge.bundle` still holds everything the history purge
   removed — three real league ids and the owner's team name. Delete it when
   satisfied. The purge is verified: 1,093 objects, 493 blobs, zero orphans, and
   all 28 data blobs 404 from GitHub.
2. **Verify against a live draft room.** Several changes have never met ESPN:
   the sweep's four truncation exits, the install sentinel back on `window`, and
   the draft-search debounce. All are covered by tests that drive the real code
   against a fake room; none has run against a real one. After any install,
   **reload the ESPN draft-room tab** — content scripts are injected at page
   load, so an open tab keeps the old ones and keeps scraping.

**Structural, and worth a round of their own**

3. **2,103 lines of the extension are invisible to coverage.**
   `content-main.js`, `content-isolated.js` and `background.js` are loaded via
   `new Function` over hand-sliced source, so V8 attributes none of it to a
   file. Any coverage figure is over `js/` only, and a coverage-driven audit
   structurally cannot find gaps there.
4. **The XSS suite reaches a fraction of the escape sites it defends** — the
   round-7 count was 79 undefended. It needs a fixture with a bench, a
   resolvable trade partner and an injured player. (`test/dom-stub.mjs` is now
   shared with `render.test.mjs`, so the security suite has the stronger DOM;
   the reach problem is the fixture, not the stub.)
5. **61 of 122 exports in `js/` have no production importer.** Eleven have a
   dead `export` keyword, six exist only for a test, and `describe` — thirteen
   lines producing a label displayed nowhere — is dead outright.
6. **One nomination costs about 1.1s of blocked main thread.** The largest
   single performance finding still open.

**Known and bounded**

7. `store.js`'s state API is 38% killed by mutation, and `processTransaction` is
   named as covered when it is not.
8. `js/bridge.js` is 3 of 8 killed.
9. `preseasonOutlook`'s partial-board decline is untested — the fixture changes
   two things at once, so it cannot attribute the result.
10. The inbound trust boundary has no behavioural coverage.
11. `pruneLeagues`'s tie-break is untested and the cap has slack.
12. `parValues` and `pointsPerDollar` share 20 duplicated lines that have
    already drifted.
13. "Is the draft finished?" has five derivations, two of which produce NaN.
14. Four different models of what an injury costs.
15. `projectionsMissing` renders a 10.9% title chance; a null win probability
    prints as a measured 0% at HIGH confidence.
16. `starterReserve` still allocates a slot table per bought player.
17. The cold-board budget is set above the regression it names.
18–26. `chrome-extension/README`'s manifest claim; the version string that
    cannot detect the staleness it exists to detect; the 523/88 doc guard that
    matches zero claims; vacuous bounds, ordering assertions over one-element
    arrays, and three lists of smaller residue — each enumerated in
    `audit/history.json`.

**Deliberately not fixed, argued in the code**: both shape gates stringify the
payload to measure it, because trusting a size from the sender is worse and
textual identity is what stops the two gates drifting again; a cold
`targetBoard` blocks 20–205ms in the task carrying a sale, because an idle
callback would paint a board still listing the player who just sold; and the
10% weather roll in `simulator.js` is retained with its own measurement
attached — forced to never and to always it moves the bye figure 91.4% → 91.0%,
inside run-to-run noise, so it carries no claim and deleting it would change
output on no better evidence than adding it did.

**Declined by the owner**: rewriting the `readText` header in
`chrome-extension/content-main.js`. It still claims 205ms → 93ms (55%) where a
later measurement gave 28%, and this harness has no browser to settle it. The
*read count* is now asserted by `test/scraper.test.mjs` regardless.

## Do these next

- **Run round 8.** 38 findings were closed by the session that read them, which
  is the arrangement rounds 4, 6 and 7 all proved worth distrusting — even with
  the checker, because the checker was written by the same session.
- Point round 8's tests agent at items 3 and 4: the extension's invisibility to
  coverage is the largest structural blind spot left, and it has survived three
  rounds because no agent can see into it.

## Orientation

`js/app.js` is 3,357 lines with all 10 page renderers in it, and round 6 judged
the decision not to split it defensible: the routing order matches the
definition order, so it reads top to bottom. Both counts are asserted by
`test/render.test.mjs` against the file itself, because a previous handoff
claimed 3,117 and eleven and both were false when written.

Modules added while fixing round 7, each because something was defined twice:

- `js/engine/numbers.js` — `finite()`, the one coercion to a number you can do
  arithmetic with. Five engines had their own, all rejecting numeric strings, so
  a projection that arrived as `"12.4"` became **0**.
- `js/engine/scoring-model.js` — `WEEKLY_SD` and `WEATHER_RATE`. The simulator
  modelled weekly noise at 12 and team-strength at 22, and both write the same
  three spans. Worth 20 points of first-round-bye probability.
- `test/dom-stub.mjs` — one DOM stub. The security suite had been running
  against the weaker of two forks.

## Ground rules that bit repeatedly

- `npm test` is the gate. 15 suites, ~900 assertions.
- Never write to `imported_league.json` or `data/*.json` while testing.
- Never invent a number, and never let "nothing to report" share a message with
  "could not reach the feed".
- Prove a fix by reverting it in a scratch copy and watching a test fail. Every
  round-7 commit did this; it caught three tests of mine that passed whether or
  not the code worked.

## The extension itself

Installed at `/Applications/GridironEdge.app`, build `2026.08.07-sweep`.
Rebuild with `./tools/install-safari.sh <TEAM_ID>`, or set `$GRIDIRON_TEAM_ID`.
