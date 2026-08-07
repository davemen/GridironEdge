# Handoff — 2026-08-07

Read `CLAUDE.md` first; it is the rules. This is the state and the queue.

## The standing instruction

Run the **5-point audit** — five independent parallel agents (security, tests,
performance, documentation, readability), each proving findings by execution
rather than by reading. After each round: record it in `audit/history.json`,
regenerate `audit-report.html` (`node audit/build-report.mjs`), fix the
findings, and repeat **until every category is ≥ 90**. Do not stop before that.

Prompts that work are in the memory file `repo-audit-prompt.md`. Two structural
choices matter: run all five in parallel, and use **fresh** agents each round so
"I fixed it" is verified by someone who did not write the fix. Round 4's most
valuable output was re-checking round 3's claims — three fixes held, one did not.

## Where the scores are

| | R1 | R2 | R3 | R4 |
|---|---|---|---|---|
| security | 31 | 62 | 52 | 58 |
| tests | 54 | 61 | 38 | 47 |
| perf | 42 | 55 | 52 | 62 |
| docs | 58 | 66 | 44 | 61 |
| readability | 58 | 61 | 62 | 58 |

Scores drop when a round reaches ground the last one did not. That is the
system working, not a regression. Mutation score: 27% (R3) → 39% (R4).

**Fixes landed after round 4 was recorded and not yet scored** — a round 5 will
measure them: `test/engines.test.mjs` (the three untested engines), the worker's
payload bounds, `coverage` finally being read, the `targetBoard` cache, and the
draft board's competing price.

## Do these next, in this order

1. **`GRIDIRON_EDGE_SYNC` and `GRIDIRON_EDGE_SWEEP_REQUEST` are forgeable.**
   `chrome-extension/content-main.js` runs in world MAIN, so `event.source ===
   window` and the origin check are satisfied by any script on ESPN's page — an
   ad, a tag manager. Proven in headless Chrome: a forged sync reached
   `background.js` and passed its gate; a forged sweep drove the roster dropdown
   through every option. There is an in-flight guard and a 60s floor, which
   bound the damage but do not close it. **The fix is to run the sweep from the
   isolated world**, which the page cannot reach, and to nonce the sync channel.
   This is what makes every XSS finding remotely reachable rather than
   self-inflicted.

2. **`mapDOMScrapedLeague` invents the league's roster settings**
   (`js/espn-client.js:401`). A hardcoded 1 QB / 2 RB / 2 WR / 1 TE / 1 FLEX /
   7 bench, with no marker that it is a guess. Every extension payload takes
   this path, so a 3-WR or 2-flex league gets wrong needs, wrong bid ceilings
   and an invented "WRs: 2 / 2" denominator. The API path reads the real slot
   counts, so the two mappers disagree. Violates the first rule in CLAUDE.md.

3. **Four live copies of the starting lineup.** `js/engine/lineup-rules.js`
   claims to be the single definition; `lineup-optimizer.js`, `app.js` and
   `draft-assistant.js` each carry their own and none imports it. `slotList()`
   and `rosterSize()` have **zero importers repo-wide**. They agree today only
   because item 2 fabricates settings that match.

4. **Raise the mutation score.** It needs to roughly double. Known survivors,
   all recorded with the exact mutation in `audit/history.json`: the
   name-based drafted-player bar, `team-strength`'s replacement-level fallback,
   `espn-client`'s replacement constants, most of `lineup-rules`' constants,
   and `store.js`'s merge semantics. `test/render.test.mjs`'s stub still never
   returns null from `getElementById`, so create-if-absent branches never run.

5. **Performance, all measured, all still open:** the scrape walks every div
   twice per tick (~2,514 innerText reads) and one walk is usually discarded;
   `sweepAllRosters` takes 11.2s in its common case (empty rosters early in an
   auction, which is exactly when the auto-sweep fires); the auction panel is
   rebuilt by whole-subtree `innerHTML` once a second, recreating the bid input
   the user may be typing in.

## The extension itself

Installed at `/Applications/GridironEdge.app`, build `2026.08.07-sweep`.
Rebuild and install with `./tools/install-safari.sh` — it does the four steps
that are each individually easy to forget, including **launching the app**,
without which Safari does not list the extension at all.

Proven against a live Safari auction today: the roster scraper, team
identification from the room's dropdown, and the automatic scan (9 picks → 118
of 122). After any install, **reload the ESPN draft room tab** — content scripts
are injected at page load, so an open tab keeps the old ones and keeps scraping,
which is why a missing new route looks like a bug in the new code. Both halves
print their build to that tab's console; check them.

Untested against a live room: nothing new since the scan was proven.

## Things I got wrong today, so you do not repeat them

- **I twice concluded a scraper bug from a partial DOM dump and was wrong both
  times** — first that the container check was the whole problem, then that an
  auction renders no draft board at all. Both were corrected by asking for more
  of the actual markup. Ask for the DOM before theorising.
- **A test that passes can be passing for the wrong reason.** My `targetBoard`
  cache test passed while the mutation it was meant to catch survived, because
  the fixture changed two things at once. The fixture that isolates it is an
  *unattributed pick* — off the board, no budget moved.
- **I wrote comments that my own later change falsified within hours** (the
  sweep's "Never automatic"). When behaviour changes, the header above it is
  part of the change.

## Ground rules that bit repeatedly

- `npm test` is the gate. 15 suites. `node --check` proves almost nothing here.
- Never write to `imported_league.json` or `data/*.json` while testing — an
  early audit destroyed real user data that way. Copy to `/tmp`.
- Never invent a number, and never let "nothing to report" share a message with
  "could not reach the feed". Most findings this whole audit reduce to one of
  those two.
