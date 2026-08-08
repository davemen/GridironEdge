/**
 * Gridiron Edge — preseason team assessment.
 *
 * A league imported from a draft room has no schedule, no records and no
 * scores, so every view built on a season had nothing to show. But it does have
 * the things that actually decide a season: who owns whom, what those players
 * are projected to score, and what each manager has left to spend. That is
 * enough to rank the league, forecast it, and say where a roster is weak --
 * without inventing a single number.
 *
 * Three things are computed here:
 *
 *   strength   the points a team's best legal starting lineup projects for,
 *              per week, with the positional detail behind it
 *   outlook    playoff, bye and title probability, by simulating seasons over a
 *              balanced round robin -- the schedule nobody has yet
 *   moves      where a roster loses the most points against the league, which
 *              is the difference between a shopping list and a wish list
 *
 * The outlook is explicitly a PRESEASON one. It assumes a balanced schedule
 * because no real one exists, and it says so wherever it is displayed. What it
 * is not is the placeholder it replaced, which forecast a fixture that had
 * never been scheduled between two teams that did not exist.
 */

import { FLEX_POS, REGULAR_WEEKS, rosterSize, starterSlots, flexCount, playoffFieldSize, byeCount }
  from './lineup-rules.js';
import { finite } from './numbers.js';

// Week-to-week scoring noise for a whole lineup, in points. Fantasy teams are
// far more volatile than their projections suggest: this is what makes a
// stronger roster only a favourite rather than a certainty.
//
// Imported, not declared. simulator.js modelled the same quantity at 12 while
// this file used 22, and both write to the same three spans on the
// Championship page. See scoring-model.js for the sensitivity that gap was
// worth and for the admission that neither number is measured.
import { WEEKLY_SD } from './scoring-model.js';


/**
 * The best legal starting lineup a roster can field, and what it projects.
 * Returns per-slot detail so a weakness can be named rather than just scored.
 */
export function bestLineup(roster, db, replacement = null, settings = undefined) {
  const players = (roster || []).map((id) => db[id]).filter(Boolean);
  const pool = {};
  players.forEach((p) => {
    (pool[p.position] = pool[p.position] || []).push(p);
  });
  Object.keys(pool).forEach((k) => {
    pool[k].sort((a, b) => finite(b.projectedPoints) - finite(a.projectedPoints));
  });

  const used = new Set();
  const slots = [];
  const lineup = starterSlots(settings);
  Object.keys(lineup).forEach((pos) => {
    for (let i = 0; i < lineup[pos]; i++) {
      const pick = (pool[pos] || []).find((p) => !used.has(p.id));
      if (pick) used.add(pick.id);
      // Mid-draft, an unfilled slot is not worth zero -- it is worth whatever
      // the manager will still be able to sign for it. Scoring it zero makes
      // whoever has drafted most so far look unbeatable, which at pick 16 of
      // 128 said a three-man roster wins the title 95% of the time.
      const fallback = replacement ? finite(replacement[pos]) : 0;
      slots.push({ slot: pos, player: pick || null,
                   points: pick ? finite(pick.projectedPoints) : fallback,
                   projected: !pick && fallback > 0 });
    }
  });
  for (let i = 0; i < flexCount(settings); i++) {
    const cands = FLEX_POS.flatMap((pos) => (pool[pos] || []).filter((p) => !used.has(p.id)));
    cands.sort((a, b) => finite(b.projectedPoints) - finite(a.projectedPoints));
    const pick = cands[0];
    if (pick) used.add(pick.id);
    const flexFallback = replacement
      ? Math.max(...FLEX_POS.map((pos) => finite(replacement[pos]))) : 0;
    slots.push({ slot: 'FLEX', player: pick || null,
                 points: pick ? finite(pick.projectedPoints) : flexFallback,
                 projected: !pick && flexFallback > 0 });
  }

  const points = slots.reduce((a, s) => a + s.points, 0);
  const bench = players.filter((p) => !used.has(p.id));
  const holes = slots.filter((s) => !s.player).map((s) => s.slot);
  return { slots, points, bench, holes, rostered: players.length };
}

/**
 * What each team can still get for a slot it has not filled.
 *
 * Roughly the best player at that position who will not have been taken by the
 * time everyone has signed one -- the leagueSize-th best still available. It is
 * the level every manager can reach, so the difference between teams stays
 * their picks rather than how far into the draft they happen to be.
 */
export function replacementLevels(league) {
  const db = league.playerDatabase || {};
  const taken = new Set();
  (league.teams || []).forEach((t) => (t.roster || []).forEach((id) => taken.add(String(id))));
  ((league.draftState || {}).selections || []).forEach((sel) => {
    if (sel && sel.playerId) taken.add(String(sel.playerId));
  });
  const n = Math.max(1, league.leagueSize || (league.teams || []).length || 10);
  const out = {};
  Object.keys(starterSlots(league.rosterSettings)).forEach((pos) => {
    const avail = Object.values(db)
      .filter((p) => p.position === pos && !taken.has(String(p.id)))
      .map((p) => finite(p.projectedPoints))
      .sort((a, b) => b - a);
    if (!avail.length) { out[pos] = 0; return; }
    out[pos] = avail[Math.min(avail.length - 1, n - 1)];
  });
  return out;
}

/** Is the draft still running? */
function draftIncomplete(league) {
  const total = (league.leagueSize || (league.teams || []).length) * rosterSize(league);
  const made = ((league.draftState || {}).selections || []).length;
  return made < total;
}

/**
 * Every team ranked by the lineup it can field.
 *
 * While the draft is running that means the lineup it will PLAUSIBLY field --
 * unfilled slots valued at what is still signable rather than at zero. Once the
 * draft is done the two are the same thing.
 */
export function rankTeams(league, options = {}) {
  const db = league.playerDatabase || {};
  const projectFinal = options.projectFinal !== undefined
    ? options.projectFinal : draftIncomplete(league);
  const replacement = projectFinal ? replacementLevels(league) : null;
  const rows = (league.teams || []).map((t) => {
    const lineup = bestLineup(t.roster, db, replacement, league.rosterSettings);
    return {
      teamId: t.teamId,
      teamName: t.teamName,
      isMe: t.teamId === league.myTeamId,
      budget: finite(t.faabRemaining, 0),
      rostered: lineup.rostered,
      points: lineup.points,
      holes: lineup.holes,
      slots: lineup.slots,
      bench: lineup.bench,
      projected: projectFinal,
    };
  });
  rows.sort((a, b) => b.points - a.points);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

/**
 * Preseason playoff, bye and title probability.
 *
 * Each team's weekly score is its projected lineup plus noise. A balanced round
 * robin decides seeding; the top seeds get byes and the bracket is played out.
 * With no real schedule this is the honest form of the question -- "how good is
 * this roster relative to the league" -- rather than a fixture-by-fixture
 * forecast that cannot exist yet.
 */
export function preseasonOutlook(league, runs = 2000, rng = Math.random) {
  const teams = rankTeams(league);
  const n = teams.length;
  if (n < 2) return null;
  const midDraft = draftIncomplete(league);

  // Decline when a team cannot be read, exactly as runSeasonSimulation does.
  //
  // The simulator learned to refuse; this engine did not, and this is the one
  // the app routes to whenever there is no schedule -- which is every
  // draft-room import, the primary case. It scored an unreadable roster at the
  // replacement value of every empty slot, so nine unread teams came out at
  // 102.8 points each and the dashboard read "titlePct 84.1, playoffPct 100".
  // 102.8 is the old 105.0 constant under a different name.
  //
  // The test is a MIXED league, not an incomplete one.
  //
  // Mid-draft with everybody part-drafted is fine and is what
  // `projectsUnfilledSlots` exists to label: the comparison is still between
  // rosters. Before anyone has picked, all teams are equally empty and "nobody
  // has an edge yet" is a true answer. What cannot be answered is a league
  // where SOME teams are readable and others are not a single player -- which
  // is exactly what an auction scrape produces, because the room renders one
  // roster at a time (coverage: own-roster-only). There the unread teams are
  // scored at the replacement value of every empty slot, so the one team the
  // app can see looks like a juggernaut against nine teams that do not exist.
  const unreadable = teams.filter((t) => t.rostered === 0);
  const partialBoard = (league.coverage && league.coverage.kind
    && league.coverage.kind !== 'full-board');
  // ALL unreadable is a case too, and it was the one that slipped through.
  //
  // "Everyone is equally empty" is a true answer only before anyone has
  // picked. A league whose projection file failed to load has every team
  // unreadable and no coverage field, so it fell past both clauses above and
  // simulated: measured through the real renderers, a dashboard reading 10.9%
  // championship, 60.3% playoff, and a note saying "Yours projects 0 points a
  // week against a league best of 0". projectionsMissing was true throughout
  // and never mentioned.
  const picksMade = ((league.draftState || {}).selections || []).length;
  const nothingToReadAtAll = unreadable.length === n
    && (picksMade > 0 || league.projectionsMissing);
  if ((unreadable.length > 0 && unreadable.length < n)
      || (partialBoard && unreadable.length)
      || nothingToReadAtAll) {
    return {
      unknown: true,
      reason: unreadable.length === n
        ? (league.projectionsMissing
          ? 'No player projections loaded, so no roster can be scored.'
          : 'No roster in this league resolved to projected players.')
        : `${unreadable.length} of ${n} teams have no roster the app can read, `
          + 'so there is nothing to rank them against.',
      playoffPct: null, byePct: null, titlePct: null,
      averageSeed: null, rank: teams[idxOfMeIn(teams)] ? teams[idxOfMeIn(teams)].rank : null,
      leagueSize: n, teams,
    };
  }

  // One derivation, shared with the in-season simulator -- these two engines
  // write the same three spans on screen and disagreed on every field size but
  // six.
  const playoffTeams = playoffFieldSize(n);
  const byeTeams = byeCount(playoffTeams);
  const idxOfMe = teams.findIndex((t) => t.isMe);
  if (idxOfMe < 0) return null;

  // Box-Muller, so the noise is genuinely normal rather than a sum of uniforms.
  const gauss = () => {
    const u = Math.max(1e-12, rng()), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  // A real round robin by the circle method: one team held fixed while the rest
  // rotate. Every team plays exactly one opponent a week and meets each rival
  // equally often. Pairing by an offset instead, as this first did, could draw
  // a team into two games in the same week and none in the next, which is not a
  // schedule and quietly biases the standings it produces.
  const wheel = [];
  for (let i = 0; i < n; i++) wheel.push(i);
  if (n % 2 === 1) wheel.push(-1);            // odd league: one bye each week
  const m = wheel.length;
  const pairingsFor = (w) => {
    const rot = [wheel[0]];
    for (let i = 1; i < m; i++) rot.push(wheel[((i - 1 + w) % (m - 1)) + 1]);
    const out = [];
    for (let i = 0; i < m / 2; i++) {
      const a = rot[i], b = rot[m - 1 - i];
      if (a >= 0 && b >= 0) out.push([a, b]);
    }
    return out;
  };

  const base = teams.map((t) => t.points);
  let madePlayoffs = 0, gotBye = 0, wonTitle = 0, seedTotal = 0;

  for (let r = 0; r < runs; r++) {
    const wins = new Array(n).fill(0);
    const pf = new Array(n).fill(0);
    for (let w = 0; w < REGULAR_WEEKS; w++) {
      const scores = base.map((p) => p + gauss() * WEEKLY_SD);
      scores.forEach((s, i) => { pf[i] += s; });
      pairingsFor(w).forEach(([i, j]) => {
        if (scores[i] > scores[j]) wins[i]++; else wins[j]++;
      });
    }
    const seeds = teams.map((_, i) => i)
      .sort((a, b) => (wins[b] - wins[a]) || (pf[b] - pf[a]));
    const mySeed = seeds.indexOf(idxOfMe) + 1;
    seedTotal += mySeed;
    if (mySeed <= playoffTeams) madePlayoffs++;
    if (mySeed <= byeTeams) gotBye++;

    // Bracket: single elimination, best seed against worst, byes in round one
    // for however many teams the field leaves without an opponent.
    const seedRank = new Map(seeds.map((t, i) => [t, i]));
    const playOne = (a, b) =>
      (base[a] + gauss() * WEEKLY_SD >= base[b] + gauss() * WEEKLY_SD ? a : b);
    let alive = seeds.slice(0, playoffTeams);
    while (alive.length > 1) {
      // Everyone beyond the largest power of two below the field size plays;
      // the top seeds sit out. With six teams that is 1 and 2 on a bye.
      let pow2 = 1;
      while (pow2 * 2 <= alive.length) pow2 *= 2;
      const playing = alive.length === pow2 ? alive.length : (alive.length - pow2) * 2;
      const byes = alive.slice(0, alive.length - playing);
      const field = alive.slice(alive.length - playing);
      const winners = [];
      while (field.length > 1) winners.push(playOne(field.shift(), field.pop()));
      alive = byes.concat(winners).sort((x, y) => seedRank.get(x) - seedRank.get(y));
    }
    if (alive[0] === idxOfMe) wonTitle++;
  }

  const pct = (x) => Math.round((x / runs) * 1000) / 10;
  return {
    playoffPct: pct(madePlayoffs),
    byePct: pct(gotBye),
    titlePct: pct(wonTitle),
    averageSeed: Math.round((seedTotal / runs) * 10) / 10,
    rank: teams[idxOfMe].rank,
    leagueSize: n,
    myPoints: Math.round(teams[idxOfMe].points * 10) / 10,
    bestPoints: Math.round(teams[0].points * 10) / 10,
    medianPoints: Math.round(teams[Math.floor(n / 2)].points * 10) / 10,
    teams,
    assumesBalancedSchedule: true,
    // Slots nobody has drafted yet are valued at what is still signable, so
    // these odds compare rosters rather than draft progress.
    projectsUnfilledSlots: midDraft,
  };
}

/** Index of the user's team in a ranked list, or -1. */
function idxOfMeIn(teams) {
  return teams.findIndex((t) => t.isMe);
}

/**
 * Where this roster loses the most points against the league.
 *
 * Each starting slot is compared with what the rest of the league gets from the
 * same slot. The biggest shortfalls are the moves worth making, and an unfilled
 * slot is always the biggest of all -- it scores zero every week.
 */
export function highestImpactMoves(league, freeAgents = []) {
  const teams = rankTeams(league);
  const me = teams.find((t) => t.isMe);
  if (!me) return [];

  // What the league gets from each slot, so "weak" is measured, not asserted.
  const bySlot = {};
  teams.forEach((t) => {
    t.slots.forEach((s) => {
      (bySlot[s.slot] = bySlot[s.slot] || []).push(s.points);
    });
  });
  const median = (arr) => {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  const bestFa = {};
  freeAgents.forEach((p) => {
    const pos = p.position;
    if (!bestFa[pos] || finite(p.projectedPoints) > finite(bestFa[pos].projectedPoints)) {
      bestFa[pos] = p;
    }
  });

  const moves = me.slots.map((s) => {
    const par = median(bySlot[s.slot] || []);
    const gap = par - s.points;
    const wantPos = s.slot === 'FLEX' ? null : s.slot;
    const fa = wantPos ? bestFa[wantPos] : FLEX_POS
      .map((p) => bestFa[p])
      .filter(Boolean)
      .sort((a, b) => finite(b.projectedPoints) - finite(a.projectedPoints))[0];
    const upgrade = fa ? finite(fa.projectedPoints) - s.points : 0;
    return {
      slot: s.slot,
      current: s.player ? s.player.name : null,
      currentPoints: Math.round(s.points * 10) / 10,
      leagueMedian: Math.round(par * 10) / 10,
      // Points per week behind the league at this slot. Negative means ahead.
      gap: Math.round(gap * 10) / 10,
      empty: !s.player,
      candidate: fa && upgrade > 0.5 ? fa : null,
      upgrade: fa && upgrade > 0.5 ? Math.round(upgrade * 10) / 10 : 0,
    };
  });

  // An empty slot outranks any shortfall; after that, biggest gap first.
  moves.sort((a, b) => (Number(b.empty) - Number(a.empty)) || (b.gap - a.gap));
  return moves.filter((m) => m.empty || m.gap > 0.5 || m.upgrade > 0.5);
}
