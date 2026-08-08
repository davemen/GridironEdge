# Backtesting Gridiron Edge against 2021–2025

*Last checked against the code on 2026-08-07, at commit `6d8a9ea`. A date alone does not tie this file to a version -- every commit in this repo carries the same one. Every claim below about what the
app does or does not ship was verified at that date; three had gone stale and
are marked inline. This file is the record of measurement, so it needs to be
tied to a version of the code -- an audit could not check any of it without
that, and the stale claims were the predictable result.*

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
not a measurement). And K and D/ST are excluded from the backtests below, because nflverse does
not carry them in the same feed; they are close to noise in season-long value,
but their absence means roster construction here is 15 offensive spots.

> **Note (added after the fact).** That exclusion describes the 2021-2025
> measurements only. The shipped app now rosters and projects both: 33 kickers
> and 31 defenses, rebuilt from their counting stats under ESPN's default
> scoring by `tools/kickers_defense.py`, with rank curves fitted the same way
> as the other four positions. Sanity checks landed where they should — Aubrey
> and Boswell as the top kickers of 2023 and 2024, Baltimore and Minnesota as
> the top defenses. Nothing in this document re-measures the draft with them
> included.

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

> One caveat, corrected 2026-08-07: this used to say the app's player schema
> had no ECR standard deviation field and that the shipped version omitted the
> expert-disagreement term. Both are now false. All 523 players carry `ecrStd`,
> `js/player-database.js` maps it, and `js/engine/draft-assistant.js` applies
> `riskWeight * p.ecrStd`. The full v5 form ships. The figure the omission was
> worth -- the difference between v3 (+40) and v5 (+47) -- is therefore no
> longer being given up.

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
40 independent 14-week seasons and 3-round playoff brackets, alongside an
**oracle that drafts knowing every player's real final points in advance.**

| Drafter | Season points | Playoff % | **Title %** | 95% CI |
|---|---|---|---|---|
| Perfect foresight (ceiling) | 2611 | 100.0% | **85.8%** | [84.5, 87.0] |
| Gridiron Edge v5 (shipped) | 1940 | 71.8% | **12.2%** | [11.2, 13.3] |
| Expert consensus board | 1899 | 59.9% | **12.0%** | [10.9, 13.1] |
| Random team | — | 50.0% | 8.3% | — |

*1,440 drafts x 40 simulated seasons = 57,600 seasons per drafter.*

> **The sample size above is the one number in this table I cannot stand
> behind.** The prose used to open with "24,000 simulated seasons per drafter",
> which implies 600 drafts, against the caption's 1,440. Both cannot be true and
> the harness that would settle it lives outside this repo. The caption is kept
> because it shows its working and the prose figure did not; the contradiction
> is recorded rather than quietly resolved, because picking one and deleting the
> other is how a disagreement becomes a fact. Every confidence interval in the
> table was computed by the harness from its own sample, so they are unaffected
> by which of the two counts is right.*

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

It does **not** contradict Part 5. That was a controlled comparison — the same
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

## Part 11 — Reverse-engineering the median-ranking principle

Sean Koerner (The Action Network) has won FantasyPros' Most Accurate Ranker
awards repeatedly. His publicly-described method rests on three ideas, of which
one is distinctive and testable: **rank on the median outcome, not the mean.**
It comes from odds-making rather than fantasy convention.

The logic: fantasy scoring is right-skewed. Touchdowns are lumpy and barely
persist year to year, so a touchdown-dependent player's mean is dragged up by a
handful of weeks he cannot repeat. His median week is far lower. Rank on the mean
and you systematically over-rate him against a player whose points come from
volume.

Tested with an ex-ante proxy: the consensus projection discounted by what share
of the player's points came from touchdowns LAST season, centred so the average
player is unchanged.

### It makes rankings less accurate

| Year | Mean-based ρ | Median-based ρ | Winner |
|---|---|---|---|
| 2021 | 0.6513 | 0.6045 | mean |
| 2022 | 0.6860 | 0.6471 | mean |
| 2023 | 0.6254 | 0.6185 | mean |
| 2024 | 0.6203 | 0.5879 | mean |
| 2025 | 0.6306 | 0.5948 | mean |
| **Mean** | **0.6427** | 0.6106 | mean, 5/5 |

Unsurprising in hindsight: accuracy is scored against points that *actually
happened*, touchdowns included. Fading touchdown-scorers must hurt it.

### It wins more championships anyway

| TD discount | Points | Playoff % | Title % | vs mean-based |
|---|---|---|---|---|
| **2018–2020** | | | | |
| 0 (mean) | 1554 | 71.8% | 14.8% | — |
| 0.5 | 1593 | 81.0% | 18.1% | +3.4 [+0.5, +6.2] |
| **1.0** | 1639 | 83.3% | **21.1%** | **+6.4 [+2.3, +10.5]** |
| 2.0 | 1637 | 83.2% | 20.5% | +5.7 [+1.9, +9.6] |
| 3.0 | 1577 | 77.7% | 16.5% | +1.7 [−1.9, +5.4] |
| **2021–2025** | | | | |
| 0 (mean) | 1480 | 68.0% | 14.6% | — |
| 1.0 | 1454 | 59.0% | 16.7% | +2.2 [−1.3, +5.7] |
| 2.0 | 1481 | 62.0% | 22.5% | +7.9 [+3.3, +12.5] |

Replicated on two independent sets of seasons, same sign both times, with a clean
inverted-U in discount strength on the tuning years — too little does nothing,
too much distorts. That shape is what a real effect looks like; an artifact would
not peak and decline. Best estimate: **+2 to +6 points of championship
probability.** Shipped at discount 1.0, the peak on the tuning years.

### The interesting part

**Being the most accurate ranker and being the best team-builder are different
skills, and this principle trades one for the other.** It would lose an accuracy
contest scored on season points while winning more leagues.

Two honest caveats. First, this is a test of the *principle as publicly
described*, using a crude touchdown-share proxy — not a replication of anyone's
proprietary system. Second, accuracy contests are largely scored on **weekly**
rankings, and for a single week the median genuinely is the right target for
ordinal accuracy; my test was season-long. The tension above may simply be an
artefact of testing the season-long analogue.

Requires a `tdShare` field, **and nothing in the shipped app supplies one**, so
this adjustment is a no-op everywhere it runs. Stated plainly here because two
earlier versions of this paragraph said the opposite and `js/store.js` has
carried a comment contradicting them since round 6.

Three separate reasons, each sufficient on its own:

- `store.js setPriorSeasonScoring` writes the field and **has no caller**. grep
  across `js/`, `test/` and `index.html` returns its definition and this
  paragraph.
- `espn-client.js extractTdShare` does have a caller, but only inside
  `mapESPNLeague`'s public-API branch. `mapESPNLeague` delegates to
  `mapDOMScrapedLeague` whenever `isDOMScraped` is set, and that mapper never
  writes `tdShare`. CLAUDE.md names the extension port as the only way draft
  data enters the app, so the branch that populates the field is not the branch
  the app uses.
- `data/projections-2026.json` carries the field on 0 of 523 players.

The engine's behaviour without it is correct -- no `tdShare` means no
adjustment, not an invented one. What was wrong was this document claiming the
lever was pulled.

---

## Part 12 — Auction laboratory

Everything measured about auctions until now was in points and finishing rank.
This measures championships, and tests two levers that have no snake-draft
equivalent at all. Realistic front-loaded room, 240 auctions per configuration,
each followed by a full season and bracket.

| Configuration | Points | Playoff % | Title % | vs shipped |
|---|---|---|---|---|
| Balanced (45% of budget on 3 players) | 1544 | 83.6% | 30.6% | +1.7 [−2.8, +6.3] |
| **Adaptive engine (shipped)** | 1550 | 80.4% | **28.9%** | — |
| Adaptive + drain nomination | 1546 | 79.2% | 28.4% | −0.4 [−3.2, +2.3] |
| Adaptive + TD regression | 1472 | 66.2% | 28.0% | −0.9 [−5.9, +4.1] |
| Stars & scrubs (75% on 3) | 1482 | 70.6% | 26.0% | −2.9 [−7.4, +1.7] |
| Old `calculateAuctionBid()` | 1472 | 61.1% | 23.4% | **−5.5 [−9.8, −1.2]** |

Only one difference in that table is statistically significant, and it is the one
already known: the original formula is bad. Everything else is a null result, and
three of them are worth stating explicitly.

**Nomination strategy does nothing.** The classic advice is to nominate players
you do not want while rivals still have money, draining their budgets before your
targets come up. Measured effect: −0.4 points, confidence interval straddling
zero. It is one of the most repeated pieces of auction lore and there is no sign
of it here.

**Stars-and-scrubs loses.** Concentrating 75% of the budget on three players is
directionally worse than spreading it (−2.9). This is the third independent
confirmation of the same thing: concentration in the top 3 barely correlated with
titles in the elite league (+0.102 against +0.557 for total points), and trade
consolidation cost a point in Part 7. In an auction you *can* choose to be
top-heavy, unlike a snake draft — and you should not.

**Touchdown regression backfires in auctions, and the reason matters.** The same
adjustment is worth +2 to +6 points of title probability in a snake draft and
costs about a point here, while cutting 78 points of scoring and 14 points of
playoff odds. The formats punish a private valuation differently:

- In a **snake**, down-ranking a player is free. You take someone else with the
  same pick, at the same cost.
- In an **auction**, you have to outbid a market that does not share your
  discount. A lower valuation does not get you a better player at a better
  price; it gets you *no player*, repeatedly, and a worse roster.

A valuation edge that works in one format can be actively harmful in the other.
The adjustment is applied in `draft-assistant.js` and deliberately absent from
`auction-advisor.js`. The reason is the paragraph above -- an auction punishes a
discount, because a lower valuation does not win a cheaper player, it wins no
player. This used to say the reason was "recorded in the file"; it was not, and
grepping `auction-advisor.js` for it found nothing.

> Absolute title rates in this table (23–31%) are inflated relative to the snake
> numbers because only the seat under test uses a strong bidder while the other
> eleven bid noisily around par. The comparisons between rows are sound; the
> level is not comparable to Part 7.

---

## Part 13 — Ingesting what is actually happening

Two data problems were found by asking what the app *populates* rather than what
the engines *can consume*. Both had the same shape: code that looked like it was
working while running on placeholder values.

**The ESPN importer gave every player identical usage.** Literally every imported
player received `snapShare: 0.60, targetShare: 0.15, carries: 5` — a quarterback
and a third receiver alike. Every usage-based judgement in the roster engine was
therefore reasoning from a constant. Replaced with real per-game usage parsed
from ESPN's stat splits, returning `undefined` when the feed has nothing so the
engine knows it does not know, rather than being handed a fabricated number.

Two shape errors surfaced while fixing it, each of which would have produced
confident nonsense: the engine's thresholds are per-game ("14 carries" means a
workhorse) but season totals were being passed, which would read every rostered
back as a workhorse; and the opportunity trend needs weekly deltas, while
snapshots hold cumulative totals — comparing those directly shows every player
trending up forever.

**Nothing read the news.** The waiver engine reasoned from a static injury field
and season projections, which is the wrong information for a Tuesday-morning
decision. `news-monitor.js` now reads two live feeds:

- **ESPN headlines**, classified into the seven events that move fantasy value:
  injury-out, injury-risk, returning, suspension, trade, promotion, demotion.
- **Sleeper trending adds/drops**, which replaces an *inference* about whether a
  rival will claim a player with a *measurement* of how many managers already
  have. Given that the first two active rivals take 60% of the waiver edge, being
  late is the expensive failure mode.

When a starter is ruled out, the engine promotes his backup — the player no
article names, and exactly the add worth being first to.

> A classification bug caught in testing, recorded because it would have been
> actively harmful: *"loses the starting job"* contains *"starting job"*, so it
> matched the **promotion** pattern and would have recommended precisely the
> wrong player. Negative readings are now tested before positive ones.

---

## Part 14 — Everything on

Each improvement was measured against whatever configuration existed when it was
tested, so no single number covered the whole shipped stack. Effects do not add
cleanly — two levers that both raise your floor overlap, and the convex title
curve means gains compound at the top and vanish at the bottom. So this runs the
real thing end to end.

**BASELINE** — expert consensus board, no in-season management. A competent but
passive manager with a cheat sheet.
**SHIPPED** — v5 draft + touchdown regression + round-dependent risk aversion,
then start/sit, waivers, playoff-week targeting and bracket variance switching
across all 17 weeks.

| Configuration | Points | Playoff % | Title % | 95% CI |
|---|---|---|---|---|
| Expert board, passive | 1414 | 52.0% | **9.1%** | [7.6, 10.5] |
| **Gridiron Edge, everything on** | 1455 | 58.7% | **18.1%** | [16.0, 20.2] |

**Championship probability doubles: 9.1% → 18.1%, +9.0 points, 95% CI
[+6.7, +11.4], t = 7.6.** Against a random team's 8.3%, that is 2.2x.

600 seasons per configuration. Note what does the work: points rise only 41
(1414 → 1455) while title odds double. Small edges in the right places convert
far better than raw scoring does — the same lesson the waiver experiment taught
in Part 5.

### What this number excludes

- **The news monitor.** There is no historical feed of injury and depth-chart
  headlines in this dataset, so its value is unmeasured and deliberately left
  out rather than assumed. Given that being late to the wire is the expensive
  failure mode, it is more likely to help than hurt — but that is a hypothesis,
  not a measurement.
- **Auctions**, which are measured separately in Parts 4 and 12.
- **Any assumption that your league is passive.** This baseline is a competent
  manager who does not work the wire. Against a league where several rivals are
  active, the waiver component erodes sharply — 18.8% down to 10.3% as rivals
  wake up (Part 8).

The ceiling has not moved: perfect foresight is still 85.8%, and essentially all
of the remaining gap is forecast error rather than decision quality.

---

## Part 15 — Tuning the auction, in two rooms

Four parameters swept by coordinate ascent, twice over, in two very different
rooms: one where every rival prices players correctly off a value chart and
spends its whole budget, and one where rivals bid noisily and front-load badly.
Each winner then validated on 120 fresh seasons with all twelve seats.

| Room | Sweep said | Validation |
|---|---|---|
| Average (front-loaded) | 27.8% → 37.3% | **−0.8 pp**, 95% CI [−7.8, +6.2] |
| Expert (correct pricing) | 25.4% → 28.6% | **+2.0 pp**, 95% CI [−0.8, +4.7] |

**Both are nulls, and the average-room result is the more instructive.** The
sweep showed a 9.5-point gain that vanished entirely under validation. Four
values were tried for one parameter and three for another on only 40 auctions —
four chances to get lucky, and it got lucky. Reporting the sweep number would
have claimed a 35% improvement where there was a 1% decline. The tuned config
was not shipped.

The engine's existing settings are already at a local optimum on bid multiplier,
Must Buy threshold, Must Buy premium and bench weight. Further parameter fiddling
is not where auction value lives; the +306 points over the old formula is.

### One real finding: posture should not be a constant

The two rooms pulled the parameters in **opposite directions**:

| Parameter | Average room | Expert room |
|---|---|---|
| Bid vs forecast | 0.95 (bid under) | 1.20 (bid over) |
| Must Buy threshold | 18 (rare) | 10 (default) |

That is mechanically sensible. Against people who overpay early, patience wins —
you let them exhaust themselves and buy the fallout. Against people who price
correctly and spend fully, hanging back means you never win anything and the good
players are simply gone.

Neither direction is individually significant, so this is a hypothesis rather
than a result. But it argues against hard-coding any posture, and in favour of
the engine reading the room — which it already does through market inflation and
rival budgets, and now also through what rivals have actually been paying.

### Bench weight does nothing

Every setting from 0.06 to 0.22 returned identical results in both rooms. In a
snake draft, depth is whatever is left after the stars are gone. In an auction
you can always buy a $1 replacement, so how you value depth is not a decision
the format actually forces.

### Room quality dominates everything

| | Points | Playoff % | Title % |
|---|---|---|---|
| Average room | 1526 | 94.9% | **32.6%** |
| Expert room | 1425 | 60.0% | **24.9%** |

The same engine, the same seasons, the same code — an eight-point swing in title
probability from nothing but who else is in the room. That is larger than any
parameter change tested here, and consistent with Part 8: the quality of your
opposition matters more than the quality of your tuning.

---

## Part 16 — Three valuation bugs found by asking why two numbers matched

The question that started this: *why are "bid now" and "walk away" always the
same number, and shouldn't walk away be higher?* Chasing it turned up three
separate defects, none of which the existing tests could see.

**1. Par allocated more money than the room contains.** Every roster spot costs
at least $1, so par gives each player a $1 floor plus a share of the surplus.
The floor was being handed to every player in the pool — all 523 of them — when
an 8-team league rosters 128. Par summed to $1,931 against $1,600 of actual
money, a 21% over-allocation that inflated every forecast price and, through
them, every ceiling. The floor now goes only to players who will actually be
rostered; par sums to the money in the room, exactly.

**2. The flex was counted once per position instead of once.** `openStarterSlots`
gave the flex allowance to running backs, receivers *and* tight ends
independently, claiming eight flex-eligible starting slots where the lineup has
six. A roster of two backs and three receivers — starters and flex complete —
still reported an open running back slot and kept a full bid ceiling for one.

**3. Bidding advice and the walk-away price were the same number.** For a Must
Buy, `recommendedBid` was *set* to the ceiling. Opening at your walk-away price
captures no surplus at all: it is the number you should be prepared to stop at,
not the one you start at. Must Buy now raises the ceiling and leaves the opening
bid where it belongs — the least that still wins.

A fourth issue was behavioural rather than arithmetic. When the forecast price
already exceeded the ceiling — precisely when you should not be bidding — the
action still read `BID`, because it tested `currentBid < price * 0.85` and
`currentBid` was zero. There is now a `PASS` state, distinct from `EXIT`: `EXIT`
means the bidding has passed your ceiling, `PASS` means it is going to.

### Steering toward the holes

Related, and asked for directly: once the starting slots and flex are filled,
the engine should push money into the empty slots rather than into more of what
is already set.

It did not, and the reason is instructive. The planner maximises points and is
not wrong about them — with a set lineup and nine bench slots left, leftover
money genuinely has almost nowhere good to go, so paying $28 for a fourth
receiver worth 26 bench points looked like a fair trade. What it could not see
is the risk: the plan assumes it can buy the quarterback later at his *forecast*
price, and a forecast is not a guarantee. Spend the money and miss, and the slot
is empty all season.

So the engine now reads its own shopping list, ring-fences whatever it earmarked
for slots that still need a starter, and holds a 25% margin on top. A player who
fills none of those slots may bid only what is left — and never above market,
because depth is worth having at a discount and worth nothing at a premium. He
also gets bid a dollar at a time rather than jumped to just above market, since
jumping is how you *win* a player and winning is not the goal there.

The cap lifts entirely once every starting slot is filled. At that point
leftover money *should* buy the best bench available, and clamping it to market
would leave you tying every auction and finishing with a row of $1 players.

### Measuring it

The first attempt at an A/B was confounded and worth recording as a warning. In
the simulation, `market_values` feeds the bots' private valuations as well as
the engine's, so fixing par moved the entire simulated market — the control
models shifted too (the app formula fell from 1959 to 1929), and none of the
comparison meant anything. In the real app, par is only what the engine
*believes*; ESPN sets the price the room actually pays.

Rerun with the world's prices held fixed and only the engine's beliefs varying,
which is the change as it actually ships. 12 teams, $200, 15 spots, second-price,
2021-2025, front-loaded room, 360 auctions per arm, common random numbers:

| | Points | Rank | Titles | Win rate vs app formula |
|---|---|---|---|---|
| Before | 2034.4 ± 11.5 | 3.05 | 27.8% | 66.7% |
| After | 2084.0 ± 12.1 | 2.62 | **44.4%** | 77.2% |

The controls confirm the isolation held: the app formula went 1922.1 → 1936.8
and the static VOR chart 1901.1 → 1892.0, both inside their standard errors.
Only the engine moved.

+49.6 points a season, and title probability from 27.8% to 44.4% (t = 4.7)
against a 8.3% baseline in a twelve-team league. That is the largest single
improvement measured in this document, and unlike the tuning sweeps in Parts 12
and 15 it survived isolation — because these were bugs, not parameters. Par
summing to more money than exists is wrong whatever the simulation says; the
measurement confirms how much it was costing.

---

## Honest summary

| Claim | Verdict |
|---|---|
| The app can identify the optimal player before the season | **No.** Nobody can; consensus nails it 20% of the time. |
| The app can out-predict fantasy experts | **No.** Real signals exist (t = 5–7) but are too small to reorder the board. |
| The app's snake logic beat expert consensus | Marginally — +10 pts, negative in 2 of 5 seasons. Now +47 and positive in all five. |
| The app's auction logic was sound | **No.** Quarterbacks priced ~5× market, 75% of the budget never deployed. |
| Following these picks assures a championship | **No.** 18.1% with everything on, against a 9.1% baseline. Doubled, not assured. |
| An 80% per-season title rate is reachable by tuning | **No.** Perfect foresight reaches 85.8%, and essentially the entire gap to it is forecast error. |
| This is "the world's best fantasy football selector" | Unsupported. It is measurably better than a consensus cheat sheet at building a roster, by a margin that is real, repeatable and modest. |

The largest honest gain is not in prediction, it is in **allocation** — and the
biggest single win was fixing a broken auction model, not out-thinking the
analysts.

### What would actually move the championship number

Since virtually all the remaining headroom is forecasting, not decision logic,
the only things that would meaningfully raise the 12.2%:

1. **The roster engine's specific recommendations**, which remain unvalidated. In-season management as a category *is* modelled — Part 5 measures the waiver lever at +7.0pp over 300 seasons, Part 7 rebuilt the simulator to decide lineups weekly, and Part 14 reports the full stack at 18.1%. What has not been measured is whether roster-manager.js picks the right players, only that having the lever is worth something. Every
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
npm test                               # the gate: 15 suites
node test/auction-advisor.test.mjs     # 42 checks, one suite on its own
node test/perf.test.mjs                # the 360 pinned answers
```
