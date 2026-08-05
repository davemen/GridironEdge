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

**Simulated 12-team, $200, second-price auctions, 2021–2025 (120 auctions per
model, run after the planner bug described below was fixed):**

| Bid model | Points | Avg rank | Budget spent | QBs rostered |
|---|---|---|---|---|
| Gridiron Edge `calculateAuctionBid()` | 1530 | 6.67 / 12 | **$49 of $200** | **3.00** |
| Static VOR dollar chart | 1820 | 4.12 | $200 | 1.82 |
| Market-adaptive engine (new) | 1836 | 4.03 | $200 | 2.17 |

Adaptive vs the app's formula: **+306 points**, 95% CI [+261, +351], t = 13.4.
Adaptive vs a static value chart: **+16 points**, 95% CI [−20, +52], t = 0.9.

**The old formula was catastrophically broken.** It finishes 7th of 12 while
leaving three quarters of its budget unspent, and it wins the quarterback
auctions nobody else wants because it is the only bidder who thinks they are
worth $58. Replacing it is worth roughly 300 points a season — overwhelming and
robust.

**Against a well-built static value chart, the result depends entirely on
whether the room is efficient.** In the table above the bots bid their private
values around par, so the market is efficient — and in an efficient market there
is nothing for adaptivity to exploit. The two models tie.

Real auction rooms are not efficient. They front-load: the first two dozen names
go for far more than par while everyone has money, and then good players go for
$2 because half the league is broke. The harness models this as a `human` room,
where bots bid 45% over their value on the opening 30 nominations and 15% under
thereafter. Same seasons, same players, same seats:

| Bid model | Points | Avg rank | Budget spent | QBs rostered |
|---|---|---|---|---|
| **Market-adaptive engine** | **1991** | **3.24** | $200 | 1.64 |
| Gridiron Edge `calculateAuctionBid()` | 1917 | 3.58 | $75 | 2.99 |
| Static VOR dollar chart | 1865 | 4.11 | $200 | 1.82 |

Adaptive vs the static chart: **+125 points**, 95% CI [+83, +168], **t = 5.8**.
Adaptive vs the app's formula: **+73 points**, 95% CI [+32, +115], t = 3.5.

This is the case the engine was built for, and it is the one that justifies its
complexity:

| Room | Adaptive − static chart | Verdict |
|---|---|---|
| Efficient (bots bid at par) | +16, CI [−20, +52] | tie, as theory predicts |
| Front-loaded (real behaviour) | **+125, CI [+83, +168]** | **decisive** |

A static value chart cannot see that four rivals just spent themselves broke.
The adaptive engine reprices every remaining player against who can still
actually bid, and buys the stars that fall.

One honest oddity worth recording: in the front-loaded room the *old* formula
beats the static chart by 52 points, despite being badly broken. It underspends
so severely that it accidentally hoards cash while everyone else overpays early,
then buys cheap. That is luck, not logic — it still loses to the adaptive engine,
and in the efficient room it finishes 7th of 12.

### A bug that invalidated an earlier version of this table

The first run of this comparison was measured with a defect in the planner: it
clamped each candidate's price down to whatever cash was left, so the plan could
"buy" a $50 player for $1. Budget stopped constraining anything, which pinned
every bid ceiling to the maximum possible bid. The fix is `if (px > afford)
continue`, plus a board deep enough to contain the $1–3 tail a roster is
actually finished with. The effect on live recommendations is large and visibly
correct:

| Situation | Before fix | After fix |
|---|---|---|
| Opening bid, elite RB (market $48) | ceiling $185, "Must Buy" | ceiling $48, not a Must Buy |
| Opening bid, QB1 (market $35) | ceiling $185, "Must Buy" | ceiling $36, not a Must Buy |
| Mid-auction, last elite RB, rivals hold cash | — | ceiling $61 vs market $51, **Must Buy** |

Exactly the intended behaviour: nothing is urgent while the board is full, and
scarcity plus rival purchasing power is what creates a Must Buy. Six regression
tests pin it.

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

### The lever is real, and larger than the draft

The engine's specific recommendations are not backtested, but the *lever* now is.
A deliberately simple weekly policy — one add/drop, choosing the free agent who
most improves the startable lineup, valued by preseason projection shrunk toward
actual production so far — was run over the same five seasons on top of v5
drafts. Nothing looks ahead: the week-8 decision sees only weeks 1-7.

| Scenario | Points | Playoff % | **Title %** | Adds/season |
|---|---|---|---|---|
| Frozen rosters (every earlier result) | 1945 | 72.0% | **12.5%** | 0 |
| I work the wire, rivals do not | 1976 | 77.6% | **19.4%** | 3.6 |
| All 12 teams work the wire | 1960 | 68.1% | **11.2%** | 1.2 |

Working the wire against passive opponents: **+7.0 points of title probability**,
95% CI [+4.7, +9.2] over 300 seasons. That is a 55% relative increase, and it is
the largest single effect measured anywhere in this document — larger than the
entire draft rewrite.

**And it breaks the convexity rule from Part 6.** Those +7 points of title
probability come from only +31 points of roster quality. The draft edge of +41
points bought +0.2. The difference is *what kind* of points they are: draft
capital adds to your mean, while waiver claims repair holes — the injured
starter, the bye week, the back who lost his job — that would otherwise put a
zero in your lineup on a specific Sunday. Head-to-head football rewards raising
your floor far more than raising your average, which is why playoff rate moves
5.6 points on a 31-point gain.

The competitive caveat is equally important. When all twelve teams run the same
policy the edge vanishes (−1.3 points of title probability, CI [−3.1, +0.4],
indistinguishable from zero). **The wire is a lever against a passive league and
a tax in a sharp one.** Which one you are in is worth knowing before assuming
the +7 applies to you.

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

### You cannot win the season in the draft. You can lose it there.

Six drafters spanning the realistic range, through identical rooms:

| Drafter | Points | Playoff % | **Title %** | 95% CI | vs board |
|---|---|---|---|---|---|
| Perfect foresight | 2611 | 100.0% | 87.1% | [84.8, 89.3] | +75.0 |
| Expert consensus board | 1887 | 56.9% | **12.0%** | [9.9, 14.1] | — |
| Gridiron Edge v5 | 1910 | 67.7% | 8.9% | [7.1, 10.7] | −3.1 |
| Old Gridiron Edge (v1) | 1885 | 64.8% | 8.1% | [6.3, 9.9] | −3.9 |
| QB-first (a common human error) | 1747 | 35.1% | **1.6%** | [1.0, 2.3] | −10.4 |
| Random from the top 200 | 1430 | 1.7% | **0.1%** | [0.0, 0.3] | −11.9 |

**The upside is statistically zero.** Across three independent runs, v5's title
rate against a plain consensus board has come out +0.2, −0.3 and −3.1 points —
all inside the noise. A free cheat sheet already captures essentially all of the
title probability the draft has to offer.

**The downside is enormous and unambiguous.** Spending premium picks on
quarterbacks — not a contrived strategy, but the single most common mistake in
casual leagues, and exactly what the app's original logic did 69% of the time —
costs 10.4 points of title probability and cuts playoff odds from 57% to 35%.
Drafting without regard to rank at all ends the season in August: 1.7% playoff
odds, 0.1% titles.

So the draft is a **hazard to be avoided, not an edge to be won**. Its realistic
downside is at least 3.8x its realistic upside, and against a competent baseline
the upside is indistinguishable from nothing.

One genuine qualification: a better draft does reliably buy *playoff
appearances* — v5 runs 67.7% against the board's 56.9%, and 71.8% vs 59.9% in
the larger run, roughly +11 points either way. That is a real and repeatable
improvement in how often your season stays alive into December. It simply does
not convert into trophies, because three single-elimination games do not care
who had the better regular season.

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

## Part 7 — Rescoring with five in-season levers

Everything up to here froze rosters at the draft and handed every team a
*perfect* weekly lineup chosen with hindsight. That made two levers invisible by
construction — you cannot measure start/sit skill, or variance management, in a
world where everyone already plays the optimal lineup.

So the simulator was rebuilt: lineups are now **decided** each week from
information available at the time, and scored on what those players actually
did. Every team lands at 70–85% of the hindsight ceiling, which is where real
managers land. The baseline drops accordingly, and is more honest for it.

Five levers, added cumulatively (480 drafts each, 40 simulated seasons apiece):

| Configuration | Points | Playoff % | Title % | Step |
|---|---|---|---|---|
| Expert board, no in-season work | 1392 | 49.8% | 8.6% | — |
| + v5 draft | 1464 | 65.6% | 7.8% | −0.8 |
| + start/sit (opponent-adjusted) | 1461 | 66.5% | 7.8% | **+0.1** |
| + waivers | 1476 | 68.4% | 10.9% | **+3.1** |
| + playoff-week draft targeting | 1471 | 66.2% | 12.1% | **+1.1** |
| + bracket variance switching | 1471 | 66.2% | 16.0% | **+4.0** |
| + trade consolidation (all five) | 1465 | 63.0% | 15.0% | **−1.0** |
| All five, but rivals also work the wire | 1447 | 55.7% | 8.3% | −6.7 |

**Championship probability 8.6% → 15.0%, +6.4 points, 95% CI [+4.1, +8.7],
t = 5.4.** A 74% relative increase.

### Three of the five earn their place. Two do not.

**Bracket variance switching (+4.0) is the biggest single lever in this project**
and it costs nothing — season points are identical, because it only changes three
lineups. Every lineup tool maximises expected points, which is right for 14 weeks
and wrong for the three that award a trophy. In a single-elimination game you are
not trying to score a lot, you are trying to beat one team once. A favourite
should play the floor; an underdog should play the ceiling and accept the
downside, because the downside was a loss anyway. Shipped in
`js/engine/bracket-strategy.js`.

**Waivers (+3.1)** and **playoff-week targeting (+1.1)** also pay. Note that
playoff targeting *lowers* season points (1476 → 1471) while raising titles: it
is deliberately buying strength in the only three weeks that matter.

**Start/sit opponent adjustment (+0.1) is a dud.** Measuring every reasonable
estimator against the hindsight ceiling on one roster explains why:

| Estimator | Points | Efficiency |
|---|---|---|
| Hindsight-optimal | 2125 | 100% |
| Preseason projection | 1838 | 86.5% |
| Projection shrunk toward season-to-date | 1803 | 84.8% |
| Trailing 3 games | 1781 | 83.8% |

The ~15% managers leave on the bench is real but almost entirely
**irreducible** — it is the gap between any forecast and hindsight, not between
good and bad forecasting. The spread among sane methods is ~57 points. An earlier
draft of this document claimed a start/sit engine was worth 150–250 points; that
was wrong.

**Trade consolidation (−1.0) is also a dud**, and costs playoff odds (66.2% →
63.0%). Trading depth for a star makes the roster top-heavy, and the thinner
bench loses more to byes and injuries than the upgrade gains.

> A bug that nearly published two false nulls: `sim.load_pool()` rebuilds each
> player as a fresh dict with an explicit field list, and `team` and
> `playoff_mult` were not in it. Both schedule-aware levers silently fell back to
> a multiplier of 1.0 and reported "+0.0" — which reads like a measured null but
> was a wiring failure. The tell was the points column being identical *to the
> digit* across those rows; a real null still jitters.

---

## Part 8 — What happens when the whole league is sharp

Every edge in this document was measured against opponents drafting off ADP with
noise. That raises a fair objection: are these strategies good, or are they just
arbitraging bad opponents? Two experiments settle it.

### The draft is an equilibrium

All eleven rival seats were filled with v5 instead of ADP bots, and challengers
were dropped into the twelfth. A fair seat in a 12-team league is 8.3%.

| Challenger in one seat | Points | Playoff % | Title % |
|---|---|---|---|
| VONA (untuned) | 1436 | 49.2% | 8.6% |
| v5 (same as the room) | 1440 | 49.9% | 8.2% |
| Expert consensus board | 1317 | 28.5% | **2.3%** |
| Static VOR | 1349 | 37.4% | 2.2% |
| Old Gridiron Edge v1 | 1345 | 31.0% | 1.9% |
| Market ADP | 1283 | 22.2% | **1.1%** |

**Nothing exploits a sharp room.** The best challengers sit exactly at their fair
share — no edge in either direction. That is what an equilibrium looks like, and
it confirms from a completely different direction that the draft has no title
upside left to find.

**But the punishment for being behind explodes.** A plain consensus cheat sheet
takes 12% of titles in a naive room and **2.3%** in a sharp one. Drafting off raw
ADP takes 1.1%. So a league getting sharper does not create an opportunity — it
raises the stakes on not being the weakest drafter in it.

### The sharpness curve: how fast the waiver edge dies

The waiver edge was measured at +7 points against passive rivals and roughly zero
against fully active ones. The shape in between is what actually tells a manager
whether the wire is worth their Tuesday nights:

| Active rivals | Points | Playoff % | Title % |
|---|---|---|---|
| 0 | 1493 | 69.9% | **18.8%** |
| 2 | 1484 | 68.4% | 13.7% |
| 4 | 1479 | 66.7% | 12.5% |
| 7 | 1478 | 64.5% | 11.7% |
| 11 | 1475 | 62.2% | **10.3%** |

The decay is steep and front-loaded: **the first two active managers take 60% of
your edge.** By four, most of it is gone. Note that your own points barely move
across the whole sweep (1493 → 1475) while your title odds nearly halve — the wire
is a positional battle, not a scoring one.

The practical read: count how many managers in your league actually make weekly
claims. At zero or one, the wire is the best lever you have. At four or more, you
are working it to stand still.

---

## Part 9 — Is there any public information left?

Three candidate sources remained untested. All were run through the same filter:
does the signal predict the RESIDUAL of the estimate already in use? A signal
that only correlates with points, and not with the error, is already priced in.

### The betting market: already absorbed

Vegas publishes a total and a spread for every game, which together imply how
many points each team is expected to score. It is the only public source with
money enforcing its accuracy.

| Year | Player-weeks | r(Vegas, residual) | r(Vegas, points) |
|---|---|---|---|
| 2021 | 5,055 | 0.0147 | 0.1141 |
| 2022 | 4,706 | 0.0104 | 0.1099 |
| 2023 | 4,852 | 0.0151 | 0.1262 |
| 2024 | 5,190 | 0.0080 | 0.1041 |
| 2025 | 4,801 | 0.0165 | 0.1100 |
| **Mean** | | **0.0130** | 0.1128 |

Vegas correlates with scoring (0.113) and almost not at all with the error
(0.013 — **0.02% of the residual variance**). Statistically nonzero, practically
worthless. The projections have already absorbed it.

### Within-season usage trend: the one survivor

Every in-season estimate here has been driven by points scored so far. But points
are the noisy output; opportunity is the persistent input.

| Signal (last 3 weeks vs the 6 before) | 2021 | 2022 | 2023 | 2024 | 2025 | Mean | t |
|---|---|---|---|---|---|---|---|
| **Opportunity (targets + carries + ½ att)** | .067 | .063 | .106 | .134 | .061 | **.086** | **5.9** |
| Target share | .061 | .040 | .090 | .057 | .074 | .065 | 7.7 |
| Weighted opportunity (WOPR) | .066 | .029 | .088 | .048 | .073 | .061 | 5.9 |
| Air yards | .050 | −.041 | .035 | .050 | .020 | .023 | 1.3 |

**Opportunity trend is the only public signal found that the projections have not
already priced.** Same sign in all five seasons, 8,199 player-weeks. It is modest
— r = 0.086 explains under 1% of the residual — but it operates in-season, which
is where every lever that actually converts to titles lives. Shipped as
`opportunityTrend()` in `roster-manager.js`, requiring weekly `metricsHistory`
and returning 0 rather than inventing a trend when that is absent.

### What this means

The public information space is essentially fully priced. Tested and exhausted:
prior-season box scores, expert consensus, betting markets, air-yards trends.
The one survivor is a nudge, not a verdict.

**Dramatic improvement is therefore not available from modelling.** It requires
either information that is not public (injury and inactive news, practice
reports, beat reporting — an engineering problem, not a modelling one), or
choosing a different game to play. Which brings up the largest single number in
this document: a passive league is worth 18.8% and a sharp one 10.3%. That 8.5
point gap exceeds everything the five engineered levers add combined (+6.4). It
cannot be tuned for. It can only be chosen.

---

## Part 10 — 100 seasons in a league of excellent managers

All twelve seats running the full stack: tuned draft, opponent-aware start/sit,
weekly waivers, playoff-week targeting, bracket variance switching. Excellent but
not identical — each agent sees players through its own small projection noise,
the way real analysts disagree at the margin. 100 seasons, 1,200 team-seasons,
25 schedule draws each.

By symmetry everyone wins one in twelve. The question is what the winners did.

### Draft slot is worth nothing

| Slot | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Title % | 8.6 | 8.7 | 8.0 | 8.4 | 6.6 | 7.3 | 9.7 | 7.4 | 8.1 | 8.8 | 9.0 | 9.4 |

Correlation between slot number and title rate: **+0.013**. The 6.6–9.7% spread
is noise around the 8.3% fair share. Stop worrying about where you pick.

### What actually separates champions

| Feature | r(title) | Worst quartile | Best quartile |
|---|---|---|---|
| **Season points** | **+0.557** | 0.1% | **26.0%** |
| Weekly floor (20th pct) | +0.513 | 0.3% | 23.4% |
| Weekly ceiling (80th pct) | +0.476 | 0.4% | 23.1% |
| Top-3 players' points | +0.412 | 0.9% | 20.2% |
| Best player's points | +0.295 | 1.3% | 16.1% |
| Draft picks that beat their ADP | +0.223 | 3.2% | 13.0% |
| Concentration in top 3 | +0.102 | 4.9% | 9.8% |
| Week-to-week volatility | +0.017 | 7.6% | 10.0% |
| **Points added via waivers** | **−0.078** | 10.1% | 6.8% |

Total points dominates everything. Floor and ceiling matter about equally, and
realised volatility does not matter at all — there is no clever roster shape that
beats simply scoring more.

**Concentration is nearly worthless (+0.102) while total points is +0.557.** Being
top-heavy does not win; being good everywhere does. This is the same result that
sank trade consolidation in Part 7, arrived at from a different direction.

### The waiver correlation is negative, and it is a trap

Teams that added more from waivers won *less*. That is reverse causation:
in a league where everyone works the wire, you make claims because your roster
broke — injuries, busts — not because you found treasure. Waiver activity is a
distress signal, not a strategy.

It does **not** contradict Part 6. That was a controlled comparison — the same
roster with and without waivers, worth +7 points of title probability. This is an
observational correlation across *different* rosters. Both are true.

Note also the volume: **0.9 adds per team per season**, against 3.5 when
unopposed. When twelve good managers work the same wire, there is almost nothing
left to add.

### The league-winning player comes from the first three rounds

Where each champion's single most valuable pick was drafted:

| Round | 1 | 2 | 3 | 4 | 5 | 6+ |
|---|---|---|---|---|---|---|
| Share | **35.0%** | 19.5% | 13.0% | 9.5% | 9.5% | 13.5% |

**67.5% of champions' best players came from rounds 1–3.** The folk wisdom that
leagues are won on late-round sleepers is not what the data shows — sleepers are
memorable because they are rare. Champions also hit on about one more pick than
the field (5.69 vs 4.72 picks beating their ADP) and their best pick came
earlier (round 3.07 vs 3.88).

### How much of this is skill

| Scoring quartile | Points | Playoff % | Title % |
|---|---|---|---|
| Q1 | 1236 | 9.1% | 0.1% |
| Q2 | 1393 | 35.3% | 1.4% |
| Q3 | 1499 | 65.6% | 5.8% |
| Q4 | 1655 | 90.1% | **26.0%** |

Season points explain **31%** of title variance — so 69% is luck, even among
equals. The single highest-scoring team in a season wins the title **42%** of
the time. That 42% is the practical ceiling on excellence: build the best roster
in your league and you are still a coin flip away, twice.

---

## Honest summary

| Claim | Verdict |
|---|---|
| The app can identify the optimal player before the season | **No.** Nobody can; consensus nails it 20% of the time. |
| The app can out-predict fantasy experts | **No.** Real signals exist (t = 5–7) but are too small to reorder the board. |
| The app's snake logic beat expert consensus | Marginally — +10 pts, negative in 2 of 5 seasons. Now +47 and positive in all five. |
| The app's auction logic was sound | **No.** Quarterbacks priced ~5× market, 75% of the budget never deployed. |
| Following these picks assures a championship | **No.** With all five levers, 15.0% against an 8.6% baseline. |
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
