/**
 * Gridiron Edge Lineup Optimizer Engine
 *
 * Which players start, given a roster and this league's slot counts.
 *
 * `settings` used to be accepted and never read: a 2QB/3WR/2FLEX league and a
 * 1QB/1RB/1WR league produced byte-identical starters, because the fill was a
 * straight-line if-chain -- push a QB, push two RBs, push two WRs -- with the
 * standard shape written into the control flow. Three callers passed real
 * league settings into it. The slots come from lineup-rules now, which derives
 * them from those settings, so the shape is described in one place.
 */
import { slotList, FLEX_POS } from './lineup-rules.js';

export function optimizeLineup(roster, db, settings, strategy = 'floor') {
  if (!roster || roster.length === 0) return null;

  // Map IDs to full player objects
  const players = roster.map(pid => db[pid]).filter(Boolean);

  // Helper score calculator based on strategy
  const calculateOptimizedScore = (player) => {
    // Check injury impact
    let injuryDeduction = 0;
    if (player.injuryStatus === 'Questionable') injuryDeduction = 2.0;
    if (player.injuryStatus === 'Doubtful') injuryDeduction = 6.0;
    if (player.injuryStatus === 'Out' || player.injuryStatus === 'IR') return -100;

    let baseProj = player.projectedPoints - injuryDeduction;

    // Apply Usage Adjustments from player.metrics
    if (player.metrics) {
      const metrics = player.metrics;
      let usageMultiplier = 1.0;

      // Snap Share Adjustments
      if (metrics.snapShare !== undefined) {
        if (metrics.snapShare >= 0.85) usageMultiplier += 0.05; // Elite snap count anchor
        if (metrics.snapShare < 0.50) usageMultiplier -= 0.10;  // High risk of low utilization
      }

      // Target Share Adjustments (Pass Catchers)
      if (['WR', 'TE', 'RB'].includes(player.position) && metrics.targetShare !== undefined) {
        if (metrics.targetShare >= 0.25) usageMultiplier += 0.08; // High-volume target earner
        if (metrics.targetShare < 0.12) usageMultiplier -= 0.05;  // Low volume pass catcher
      }

      // Rushing Carries Adjustments
      if (player.position === 'RB' && metrics.carries !== undefined) {
        if (metrics.carries >= 16) usageMultiplier += 0.05; // Workhorse RB
        if (metrics.carries < 8) usageMultiplier -= 0.08;   // Committee / third-down back
      } else if (player.position === 'QB' && metrics.carries !== undefined) {
        if (metrics.carries >= 6) usageMultiplier += 0.08; // Running QB cheat code
      }

      baseProj = baseProj * usageMultiplier;

      // Red Zone high-value opportunity adjustments
      if (metrics.redZoneTargets) {
        baseProj += metrics.redZoneTargets * 0.5; // Touchdown high-value targets boost
      }
      if (metrics.redZoneCarries) {
        baseProj += metrics.redZoneCarries * 0.4; // Touchdown high-value carries boost
      }
    }

    // Apply Matchup Difficulty Adjustments using the opponent D/ST
    let matchupAdjustment = 1.0;
    if (player.opponent && db) {
      const opponentDefense = Object.values(db).find(
        p => p.position === 'D/ST' && p.team === player.opponent
      );
      if (opponentDefense) {
        if (opponentDefense.projectedPoints >= 8.2) {
          matchupAdjustment = 0.94; // Tough defense penalty
        } else if (opponentDefense.projectedPoints <= 6.8) {
          matchupAdjustment = 1.06; // Weak defense boost
        }
      }
    }
    baseProj = baseProj * matchupAdjustment;

    const vol = player.volatility || 3.0;

    // Floor strategy minimizes variance; ceiling strategy maximizes it
    return strategy === 'ceiling' 
      ? baseProj + (0.5 * vol) 
      : baseProj - (0.5 * vol);
  };

  // Sort lists by computed optimization score
  const scoreAndSort = (list) => {
    return [...list].map(p => ({
      player: p,
      score: calculateOptimizedScore(p)
    })).sort((a, b) => b.score - a.score);
  };

  // One sorted queue per position; each slot takes the best one still unused.
  const byPos = new Map();
  const sortedFor = (pos) => {
    if (!byPos.has(pos)) byPos.set(pos, scoreAndSort(players.filter(p => p.position === pos)));
    return byPos.get(pos);
  };

  // Fill the league's own slots, in the order the lineup grid shows them, so
  // the flex is offered whatever the fixed slots did not take -- rather than
  // whatever a hardcoded "slice(2)" assumed they would leave behind.
  const starters = [];
  const taken = new Set();
  const slots = slotList(settings);

  for (const slot of slots.filter(s => !s.isFlex)) {
    const next = sortedFor(slot.pos).find(e => !taken.has(e.player.id));
    if (next) { taken.add(next.player.id); starters.push(next.player); }
  }

  const flexCandidates = FLEX_POS
    .flatMap(pos => sortedFor(pos))
    .filter(e => !taken.has(e.player.id))
    .sort((a, b) => b.score - a.score);

  for (const _slot of slots.filter(s => s.isFlex)) {
    const next = flexCandidates.find(e => !taken.has(e.player.id));
    if (next) { taken.add(next.player.id); starters.push(next.player); }
  }

  // Bench is anything not selected as starter
  const starterIds = new Set(starters.map(s => s.id));
  const bench = players.filter(p => !starterIds.has(p.id));

  // Generate conditional replacement plans for questionable starters
  const replacementPlans = [];
  starters.forEach(s => {
    if (s.injuryStatus === 'Questionable' || s.injuryStatus === 'Doubtful') {
      const positionBackups = bench.filter(b => b.position === s.position && b.injuryStatus === 'Healthy');
      const backup = positionBackups[0] || bench.filter(b => ['RB', 'WR', 'TE'].includes(b.position))[0];
      if (backup) {
        replacementPlans.push({
          starter: s,
          backup: backup,
          condition: `If ${s.name} is ruled OUT, slot in ${backup.name} (${backup.position}-${backup.team}).`
        });
      }
    }
  });

  // Optimization explanation
  const explanation = [];
  if (strategy === 'ceiling') {
    explanation.push("Upside-oriented strategy active. Volatility has been weighted positively to raise roster ceiling against our matchup opponent.");
  } else {
    explanation.push("Reliability-oriented strategy active. Valued floor stability and consistent routes run to protect weekly points.");
  }

  return {
    starters,
    bench,
    replacementPlans,
    explanation
  };
}
