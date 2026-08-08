# Handoff — 2026-08-07 (after round 5)

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

| | R1 | R2 | R3 | R4 | R5 |
|---|---|---|---|---|---|
| security | 31 | 62 | 52 | 58 | 64 |
| tests | 54 | 61 | 38 | 47 | 52 |
| perf | 42 | 55 | 52 | 62 | 71 |
| docs | 58 | 66 | 44 | 61 | 58 |
| readability | 58 | 61 | 62 | 58 | 63 |

Scores drop when a round reaches ground the last one did not. That is the
system working, not a regression.

**Round 5 raised 85 findings. 80 are fixed; 5 are open and listed below.**
A round 6 has not been run — every score above is round 5's, and nothing in
this file claims the fixes moved them. That is what round 6 is for.

## What round 5 taught, beyond the individual findings

**Three agents found one defect from three directions.** The `targetBoard`
cache — round 4's critical *fix* — shipped a key missing five inputs that
change the answer. Performance proved it by priming and mutating, documentation
proved two leagues returned the same board object, and the test agent's
surviving mutants dropped `faabRemaining` and `myTeamId` from the key. When
independent lenses converge, that is the finding to act on first.

**A test that reaches a sink is worth more than a test that asserts about it.**
`test/xss.test.mjs` was green through eight raw injection sinks because it
stubbed `fetch` to throw for every non-projections URL, only ever drove the
DOM-scrape mapper, and keyed its recorder by element id — so every table row
overwrote the last and only the final one was ever scanned. Fixing the *gate*
found more than fixing the sinks.

**Writing the fixture is most of the work.** Several fixes needed two or three
attempts at a fixture before the mutation actually died: the free-agent name
bar and id bar cover for each other unless the case distinguishes them, and
team-strength's FLEX slot has its own fallback that masks every fixed slot's.
If a mutation survives, the fixture is wrong, not the finding.

## Still open

Numbered as they were when round 5 closed; item 1 has since been done.

1. ~~The repo's history held real league data.~~ **Done 2026-08-07.**
   `git filter-repo` stripped `imported_league.json`, `sleeper_*.json` and
   `espn_news.json` from all 154 commits, plus three league ids and the owner's
   real team name from blobs *and* commit messages. Two things worth knowing
   next time: `--replace-text` does not touch commit messages (that is
   `--replace-message`), and neither catches a string wrapped across two lines
   of a comment. And **force-pushing was not enough** -- GitHub went on serving
   the old blobs by SHA, proven by fetching one back after the push -- so the
   repo was deleted and recreated. All 28 data blobs and the old tip now
   404/422, verified from a fresh clone. The pre-purge bundle is at
   `../GridironEdge-pre-purge.bundle`; **it contains everything that was
   removed**, so delete it once you are satisfied.

2. **`GRIDIRON_EDGE_SYNC` is still forgeable, and a nonce cannot fix it.**
   `content-main.js` runs in world MAIN, so `event.source === window` and the
   origin check are satisfied by construction for any script on ESPN's page.
   Every script in a frame sees every `postMessage`, so a token sent that way is
   not a secret. The only real fix is to stop carrying data through the page's
   world — which means moving or dropping the React/Redux read that is the only
   reason `content-main.js` is in MAIN at all. That is a design change, not a
   patch. The header in `content-isolated.js` now states this plainly instead of
   reading as though the boundary were closed.
   **The sweep half IS closed**: it moved to the isolated world, so a forged
   message can no longer drive the draft room's dropdown.

3. **`js/app.js` is 3,327 lines** with all 10 page renderers in it. The dead
   assignments and orphaned docblocks are gone; the file is not split.

4. **Two performance costs are deliberate, and say so in the code**: both shape
   gates stringify the payload to measure it (trusting a size from the sender is
   worse than paying twice, and textual identity is what stops the two gates
   drifting apart *again*), and a cold `targetBoard` blocks 20–205ms in the task
   that carries a sale (an idle callback would paint a board still listing the
   player who just sold).

5. **33 of 55 container ids take a page down if `index.html` stops carrying
   them.** Measured by `test/render.test.mjs`, which pins the number so it
   cannot grow. The app ships all of them and does not claim they are optional.

## Do these next

- **Run round 5's fixes past fresh agents.** 79 findings were closed by the
  same session that read them, which is exactly the arrangement round 4 showed
  is worth distrusting: three of its four claimed fixes held, one did not.
- **Verify the extension against a live draft room.** The sweep moved from the
  page's world to the isolated world. It is covered by a test that drives it
  against a fake React-controlled `<select>` and asserts it visits every team,
  reads a *different* roster for each, and restores the selection — but it has
  not run against ESPN. After any install, **reload the ESPN draft room tab**:
  content scripts are injected at page load, so an open tab keeps the old ones
  and keeps scraping, which is why a missing new route looks like a bug in the
  new code. Both halves print their build to that tab's console.
- **Raise the mutation score.** It was 36% at round 5 and the campaign predates
  this session's work; the survivors it named are killed, but the number itself
  needs re-measuring.

## The extension itself

Installed at `/Applications/GridironEdge.app`, build `2026.08.07-sweep`.
Rebuild and install with `./tools/install-safari.sh <TEAM_ID>` — the Apple Team
ID is now an argument or `$GRIDIRON_TEAM_ID`, not a literal in a public repo.

`chrome-extension/popup.js` and `popup.html` are **gone**: the manifest
registers no `default_popup`, so 676 lines shipped in every build and none of
it was ever loaded.

## Things I got wrong, so you do not repeat them

- **I twice wrote a test that could not fail.** The bid-input test passed
  against the unfixed code because the DOM stub handed back the same element
  object forever; the free-agent tests passed against three separate reverts
  because the bars cover for each other. Both times the check that caught it was
  the same: re-apply the exact mutation in a scratch copy and watch it go red.
  Do that every time, not when it seems necessary.
- **My first consolidation of the draft-assistant lineup shape changed the
  recommendations.** Deriving the slots from `lineup-rules` correctly included
  D/ST and K, which put a kicker into the shortlist at pick 97. Nothing
  measures that, so the scope was put back and the reason recorded in the code.
  A refactor that improves the answer is still a behaviour change.
- **The handoff I read at the start was wrong** about which files import
  `lineup-rules.js`. Check the claim, including this one.

## Ground rules that bit repeatedly

- `npm test` is the gate. 15 suites, ~620 assertions. `node --check` proves
  almost nothing here.
- Never write to `imported_league.json` or `data/*.json` while testing — an
  early audit destroyed real user data that way. Copy to the scratchpad.
- Never invent a number, and never let "nothing to report" share a message with
  "could not reach the feed". Most findings this whole audit reduce to one of
  those two.
