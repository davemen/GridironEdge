# Backtesting Gridiron Edge against 2021–2025

This documents what happened when the app was tested against five real NFL
seasons: what it got right, what it got badly wrong, what was changed as a
result, and — importantly — which of the original goals turned out not to be
achievable.

Everything below uses real data. No projections, rankings or results were
invented.

---

## Data

| Source | What it provides | Years |
|---|---|---|
| [nflverse](https://github.com/nflverse/nflverse-data) `stats_player_week` | Actual weekly PPR scoring | 2016–2025 |
| [FantasyFootballCalculator](https://fantasyfootballcalculator.com) API | Real preseason ADP, 12-team PPR, with per-player standard deviation | 2018–2024 |
| [FantasyPros](https://www.fantasypros.com/nfl/rankings/consensus-cheatsheets.php) week-0 cheatsheets | Expert Consensus Rank from 203–237 analysts | 2018–2025 |
| nflverse `players` | Birth dates, for age features | — |

Scoring is PPR, weeks 1–17, positions QB/RB/WR/TE.

**Two caveats, stated up front.** FantasyFootballCalculator published no 2024-25
offseason ADP file, so 2025 draft order is estimated from expert consensus via a
fit pooled over the years where both exist (ADP and ECR rank-correlate at
ρ = 0.95–0.98, so it is a close stand-in — but 2025 draft results are a proxy,
not a measurement). And K and D/ST are excluded throughout, because nflverse does
not carry them in the same feed; they are close to noise in season-long value,
but their absence means roster construction here is 15 offensive spots.

---

## Part 1 — Who was actually the best player each year, and would the app have known?

The app does not project players. It consumes `projectedPoints` and `adp` and
decides what to do with them. So "would the app have identified the optimal
player" is really a question about the rankings it is fed, not about its code.

Measured against where the 200+ FantasyPros analysts had each eventual #1:

| Year | QB | RB | WR | TE |
|---|---|---|---|---|
| 2021 | Josh Allen (QB2) | Jonathan Taylor (RB9) | **Cooper Kupp (WR16)** | Mark Andrews (TE5) |
| 2022 | Patrick Mahomes (QB3) | Austin Ekeler (RB3) | Justin Jefferson (WR1) | Travis Kelce (TE1) |
| 2023 | Josh Allen (QB3) | Christian McCaffrey (RB1) | CeeDee Lamb (WR5) | **Sam LaPorta (TE19, ECR 163)** |
| 2024 | Lamar Jackson (QB4) | Saquon Barkley (RB6) | Ja'Marr Chase (WR4) | **Brock Bowers (TE11, ECR 99)** |
| 2025 | Josh Allen (QB1) | Christian McCaffrey (RB4) | Puka Nacua (WR7) | Trey McBride (TE2) |

Across 20 position-seasons the consensus **nailed the eventual #1 four times
(20%)**, had them inside two rounds eight more times (40%), and effectively
missed twice — Sam LaPorta in 2023 went undrafted in most leagues.

The honest conclusion: **no version of this app would have "identified" the
optimal player ahead of time, because that information does not exist in
August.** What a draft tool can do is convert an imperfect ranking into a better
roster than the next manager gets from the same ranking. That is what the rest of
this measures.

---

## Part 2 — Can the app beat the experts at prediction? No.

I built a projection model to try. Strictly walk-forward: to project season Y it
trains only on seasons before Y.

First, an honest test of what each preseason signal is worth, over the top-200
drafted players:

| Signal | Rank correlation with actual season points |
|---|---|
| Market ADP | 0.498 |
| FantasyPros ECR | 0.522 |
| ECR converted to points via a positional-rank curve | **0.623** |
| Ridge model, 30 features incl. prior-year usage | 0.618 |
| Ridge model, focused feature set | 0.607 |

Converting an overall rank into *position-aware expected points* is worth a lot
(0.52 → 0.62), because the WR ranked 40th overall and the QB ranked 40th overall
are not remotely the same asset. Beyond that, **nothing I added beat the
consensus at ordering players.**

That is not for lack of signal. Testing each hypothesis against the *residual* of
the consensus — the part the experts got wrong — several are real and consistently
signed across all five seasons:

| Signal | Correlation with expert error | t |
|---|---|---|
| Expert disagreement (ECR standard deviation) | +0.176 | 7.3 |
| Prior-season touchdowns (fade them) | −0.169 | 5.2 |
| ADP-vs-ECR gap (trust ADP, fade the fallers) | −0.157 | 4.9 |
| Prior-season non-TD production (fade it too) | −0.166 | 3.8 |

The unified finding is **mean reversion is stronger than the rankings assume** —
the experts over-anchor on last season across the board, worst on touchdowns. And
where ADP disagrees with ECR, ADP is the sharper number; the draft room has camp
news the published list has not absorbed.

But each of these explains only 1–3% of the variance in expert error. After
honest shrinkage they improve *calibration* (mean absolute error 54.6 → 52.8
points) without reordering the board: rank correlation stays at 0.623.

**Conclusion: a 200-analyst consensus is not beatable at ranking players with
public box-score history.** Any claim to the contrary from this data would be
overfitting. The edge has to come from allocation.

---

## Part 3 — Snake drafts

Method: 12-team PPR snake, 15 rounds, starters QB/RB/RB/WR/WR/TE/FLEX. Eleven
bots draft off real ADP using each player's real ADP standard deviation as noise.
One seat runs the strategy under test. When the draft ends, every roster is scored
on what its players **actually did that season** (optimal weekly lineup, weeks
1–17). Every strategy drafts from the identical seat in the identical room, so
comparisons are paired.

v5's parameters were fitted on **2018–2020 only** and frozen before 2021–2025 was
scored.

**1,500 drafts per strategy (5 seasons × 12 seats × 25 seeds):**

| Strategy | Points | vs experts | 95% CI | Avg rank | Playoff % | Title % |
|---|---|---|---|---|---|---|
| **v5 (tuned 2018-20, frozen)** | 1938.6 | **+46.6** | [+39, +55] | 4.43 | **71.5%** | 11.9% |
| v3 VONA (untuned) | 1931.6 | +39.6 | [+30, +49] | 4.72 | 71.0% | 10.5% |
| Gridiron Edge, as written | 1902.4 | +10.4 | [+2, +19] | 5.29 | 67.8% | 8.4% |
| Expert consensus (FantasyPros ECR) | 1891.9 | — | — | 5.37 | 60.1% | 11.7% |
| Market crowd (raw ADP) | 1884.1 | −7.8 | [−16, +1] | 5.67 | 58.4% | 9.6% |
| Static VOR | 1870.0 | −21.9 | [−30, −14] | 5.82 | 56.9% | 10.5% |

Per-season gap versus expert consensus:

| Strategy | 2021 | 2022 | 2023 | 2024 | 2025 |
|---|---|---|---|---|---|
| v5 | +34 | +48 | +55 | +87 | +9 |
| As written | −9 | −83 | +42 | +87 | +16 |

The app as written had a genuine but small edge (+10, t = 3.4) and was
**negative in two of five seasons**. v5 is positive in all five.

### What was wrong with the original ranking

`score = (replacementVal * 1.5 + projectedPoints) * needMultiplier` values every
player in a vacuum. Two consequences showed up immediately in the simulation:

- It **drafted a quarterback in round 1, 69% of the time.** The QB rank curve is
  flat (QB1 ≈ 390 points, QB12 ≈ 264) while the RB curve is a cliff (RB1 ≈ 395,
  RB36 ≈ 132). Spending premium capital on the flattest position is the single
  most expensive mistake in a snake draft.
- It could not tell that a fourth good running back is worth far less than a
  second, because it never asked what the roster could actually *field*.

v5 replaces this with marginal starting-lineup value, scored against the best
replacement still likely to be available at your next pick (using real ADP
dispersion). This is shipped in `js/engine/draft-assistant.js`.

> One caveat on the version shipped in the app: v5's full form includes a small
> term on expert disagreement, and the app's player schema has no ECR standard
> deviation field. The shipped version omits that term, which in backtest is
> worth roughly the difference between v3 (+40) and v5 (+47).

### A finding worth stating plainly

Title odds barely moved (11.9% vs 11.7%) even though playoff odds moved a lot
(71.5% vs 60.1%). A three-round single-elimination playoff is close to a coin
flip. **A better draft reliably gets you into the tournament; it does not
reliably win it.** Anyone claiming a draft tool raises championship odds by a
large margin is not measuring carefully.

---

## Part 4 — Auction drafts

The auction logic was the most broken thing found, by a wide margin.

`calculateAuctionBid()` computes `(projectedPoints - baseline)² × multiplier`,
with `baseline = 14.5, multiplier = 0.8` for quarterbacks against `9.0 / 0.45`
for running backs. Two independent errors compound:

- **Quarterbacks are priced at roughly five times market.** A 23 ppg QB is valued
  at $58; the same-scoring RB at $91 while the real market pays ~$8–15 and ~$55–65
  respectively.
- **Only ~44% of the league's money is ever allocated.** Summed across the top 180
  players the formula distributes about $1,050 of the $2,400 in a 12-team, $200
  league. Because the curve is quadratic, everyone below the baseline collapses to
  $1–3.

In simulation these compound exactly as you would predict: the app wins the
quarterback auctions nobody else wants, then bids $1–3 on everything else and
loses every contested player.

**Simulated 12-team, $200, second-price auctions, 2021–2025 (300 auctions per model):**

| Bid model | Points | Avg rank | Budget spent | QBs rostered |
|---|---|---|---|---|
| Gridiron Edge `calculateAuctionBid()` | 1478 | 7.21 / 12 | **$50 of $200** | **3.00** |
| Static VOR dollar chart | 1729 | 5.00 | $200 | 1.73 |
| Market-adaptive engine (new) | 1733 | 5.31 | $200 | 1.91 |

Adaptive vs the app's formula: **+255 points**, 95% CI [+223, +287], t = 15.7.
Adaptive vs a static value chart: **+4 points**, 95% CI [-26, +35], t = 0.3.

**The old formula was catastrophically broken.** It finishes 7th of 12 while
leaving three quarters of its budget unspent, and it wins the quarterback
auctions nobody else wants because it is the only bidder who thinks they are
worth $58. Replacing it is worth roughly 255 points a season, and that result is
overwhelming and robust.

**The adaptive-versus-static-chart comparison is not settled, and the tie above
should not be trusted.** After that run I found a bug in the planner: it clamped
each candidate's price down to whatever cash was left, so it could "buy" a $50
player for $1. Budget stopped constraining the plan, which pinned every bid
ceiling to the maximum possible bid and made the engine wildly overpay. The fix
is in (`if (px > afford) continue`, plus a board deep enough to contain the $1-3
tail a roster is actually finished with), and the effect on live recommendations
is large and visibly correct:

| Situation | Before fix | After fix |
|---|---|---|
| Opening bid, elite RB (market $48) | ceiling $185, "Must Buy" | ceiling $48, not a Must Buy |
| Opening bid, QB1 (market $35) | ceiling $185, "Must Buy" | ceiling $36, not a Must Buy |
| Mid-auction, last elite RB, rivals hold cash | — | ceiling $61 vs market $51, **Must Buy** |

That is exactly the intended behaviour: nothing is urgent while the board is
full, and scarcity plus rival purchasing power is what creates a Must Buy. Six
regression tests now pin it. But the head-to-head re-run against the static
chart had not finished when this was written, so **the honest status is that the
adaptive engine is proven far better than what the app had, and unproven against
a well-built static value chart.**

There is also a structural reason to expect a tie in this particular simulation:
the bots bid their private values around par, so the simulated room is
*efficient*. In an efficient market there is nothing for adaptivity to exploit.
The machinery that tracks who is broke, who still needs the position, and how
observed prices compare to par only earns its keep when the room misprices --
which real auction rooms famously do, front-loading their budgets on the first
two dozen names. A `human` room mode exists in the harness to test exactly that
and has not yet been run to completion.

### The replacement

`js/engine/auction-advisor.js` derives a bid ceiling instead of assigning one:

```
planMissing = best roster still attainable if he goes to someone else
planWith(x) = best roster attainable if I pay $x for him
ceiling     = the largest x where planWith(x) >= planMissing
```

"Best attainable roster" is a greedy fill at **forecast** prices — what each
remaining player will actually cost given who still has money and need — so the
ceiling moves as the room moves. Must Buy is the same calculation read backwards:
if losing him drops the best attainable roster by a large margin, he is flagged,
and the ceiling is allowed to stretch past par.

Positions are never weighted by hand. A second quarterback adds almost nothing to
a starting lineup, so the planner declines to pay for one without being told to.

> A bug worth recording, because it is subtle and it silently zeroed every
> ceiling in the first implementation: the baseline plan originally still had the
> nominated player on the board. That quietly assumes you could buy him later
> anyway, so passing appeared to cost nothing. Both sides of the comparison must
> shop from a board without him.

---

## Part 5 — Waiver wire and bench

`js/engine/roster-manager.js` replaces the previous waiver evaluator, which
ranked free agents by projected points and dropped whoever on your roster scored
lowest.

The model treats roster spots as a portfolio: a bench player is not an asset you
own, he is a spot you are declining to give to someone else. Each hold is
re-decided against the best available alternative, weighted by the probability he
ever enters your starting lineup, the option value of a role change, and what
denying him to a rival is worth.

Season phase shifts the weighting: upside is a long-dated option that decays as
the season runs out, so a week-2 stash and a week-13 stash are not the same bet.
FAAB likewise stops being hoarded late, because unspent budget expires worthless.

**This part is not backtested.** Doing it properly needs in-season transaction
histories, weekly usage and injury timelines that the current data pipeline does
not carry. The engine is covered by 44 behavioural tests, but its point value is
unmeasured, and it should be read as a well-specified model rather than a proven
one.

Inputs the strategy calls for that no current data source supplies are declared
in `MISSING_INPUTS` and surfaced in the UI rather than guessed at: depth-chart
rank, route participation, rest-of-season and playoff strength of schedule,
injury recovery timelines, coaching changes, in-season trades, and league bidding
history.

---

## Part 6 — What championship probability is actually achievable?

The natural question is what following these recommendations does to your odds
of winning the league. Measured directly: every drafted roster was run through
40 independent 14-week seasons and 3-round playoff brackets — 24,000 simulated
seasons per drafter — alongside an **oracle that drafts knowing every player's
real final points in advance.**

| Drafter | Season points | Playoff % | **Title %** | 95% CI |
|---|---|---|---|---|
| Perfect foresight (ceiling) | 2611 | 100.0% | **85.8%** | [84.5, 87.0] |
| Gridiron Edge v5 (shipped) | 1940 | 71.8% | **12.2%** | [11.2, 13.3] |
| Expert consensus board | 1899 | 59.9% | **12.0%** | [10.9, 13.1] |
| Random team | — | 50.0% | 8.3% | — |

*1,440 drafts x 40 simulated seasons = 57,600 seasons per drafter.*

This is the most important table in the document, and it says something
uncomfortable.

**An 80% championship rate is achievable — but only by knowing the season's
results before you draft.** The oracle hits 85.8%, and it does so by fielding
2611 points against v5's 1940. That 670-point gap is not strategy. It is
forecast error, and Part 2 established that the forecast error in a 200-analyst
consensus is not meaningfully reducible with public data.

Put differently: of the 74 points of title probability separating the expert
board from perfect foresight, **v5 captures 0.3%** — a difference of +0.2
percentage points, statistically indistinguishable from zero. Not because the
draft logic is weak; it wins on points (+47, t ~ 12) and on playoff rate (71.8%
vs 59.9%, roughly +12 points) with high confidence. But almost all the title
headroom is locked behind knowing which players will be good, which nobody knows
in August.

The structural reason title odds move so little while playoff odds move so much:
a 6-team bracket is three consecutive single-elimination games. Being the best
team in the league raises your per-game win probability to perhaps 60%, and
0.6³ ≈ 22%. **A better draft reliably gets you into the tournament. It cannot
reliably win it.**

The honest way to express a high-confidence claim is across seasons. At 12.2%
per year, the probability of winning **at least one** title is roughly 48% over
five seasons and 73% over ten. Any per-season figure near 80% would require
information that does not exist when you draft.

### Would tuning for titles instead of points help?

Maximising points and maximising championship probability are not obviously the
same objective — consistency wins a 14-week regular season, variance wins
brackets. So the risk tilt was re-tuned against title rate directly, on
2018-2020:

| Risk tilt (toward expert disagreement) | Title % | Playoff % | Points |
|---|---|---|---|
| −0.5 (avoid uncertainty) | **20.0%** | 75.9% | 2046 |
| 0.0 | 11.0% | 66.7% | 1977 |
| +1.0 | 2.7% | 38.6% | 1800 |
| +3.0 | 0.3% | 5.0% | 1598 |

Chasing variance is strictly destructive, and the title-optimal setting is the
same one the points tuning already chose. **Maximising expected points is the
correct proxy for maximising championship odds here** — there is no free lunch
in deliberately building a high-variance roster.

### The caveat on the title numbers

Two independent measurements of v5's title rate against the expert board gave
14.8% vs 13.0% (600 drafts) and 12.8% vs 13.1% (360 drafts). The confidence
intervals overlap heavily in both. **The title-rate improvement is not
statistically established**, whereas the points gain (+47, t ≈ 12) and the
playoff-rate gain (roughly +9 percentage points) clearly are. Reporting only the
favourable run would be cherry-picking.

---

## Honest summary

| Claim | Verdict |
|---|---|
| The app can identify the optimal player before the season | **No.** Nobody can; consensus nails it 20% of the time. |
| The app can out-predict fantasy experts | **No.** Real signals exist (t = 5–7) but are too small to reorder the board. |
| The app's snake logic beat expert consensus | Marginally — +10 pts, negative in 2 of 5 seasons. Now +47 and positive in all five. |
| The app's auction logic was sound | **No.** Quarterbacks priced ~5× market and 56% of the budget never deployed. |
| Following these picks assures a championship | **No.** 12.2% per season against 12.0% for an expert board and 8.3% for a random team. |
| An 80% per-season title rate is reachable by tuning | **No.** Perfect foresight reaches 85.8%, and essentially the entire gap to it is forecast error. |
| This is "the world's best fantasy football selector" | Unsupported. It is measurably better than a consensus cheat sheet at building a roster, by a margin that is real, repeatable and modest. |

The largest honest gain is not in prediction, it is in **allocation** — and the
biggest single win was fixing a broken auction model, not out-thinking the
analysts.

### What would actually move the championship number

Since virtually all the remaining headroom is forecasting, not decision logic,
the only things that would meaningfully raise the 12.2%:

1. **In-season management**, which this backtest does not model at all. Every
   roster here is frozen at the draft. Waivers, streaming and start/sit decisions
   are 17 weeks of compounding edges and are very likely worth more than the
   draft itself. The engine in `roster-manager.js` targets exactly this and is
   currently **unvalidated** — that is the highest-value next measurement.
2. **Non-public information**: beat writer reports, practice participation,
   route-participation data, snap trends within a season. The residual tests show
   the consensus has already digested everything in the public box score.
3. **League-specific exploitation**: modelling the actual humans you play
   against. The auction engine begins this by tracking budgets and observed
   aggression; the same idea applies to waivers and trades.

---

## Reproducing

The analysis harness lives outside this repo (it downloads ~90 MB of season data).
The pipeline is: fetch nflverse weekly stats + FFC ADP + FantasyPros cheatsheets →
join on normalised names → fit positional rank curves on prior seasons only →
simulate drafts with ADP-noise bots → score resulting rosters on real weekly
results.

In-repo tests for the shipped engines:

```
node test/auction-advisor.test.mjs     # 27 checks
node test/roster-manager.test.mjs      # 44 checks
```
