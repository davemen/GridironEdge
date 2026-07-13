/**
 * Gridiron Edge Lineup Optimizer Engine
 */

export function optimizeLineup(roster, db, settings, strategy = 'floor') {
  if (!roster || roster.length === 0) return null;

  // Map IDs to full player objects
  const players = roster.map(pid => db[pid]).filter(Boolean);

  // Group by position eligibility
  const QBs = players.filter(p => p.position === 'QB');
  const RBs = players.filter(p => p.position === 'RB');
  const WRs = players.filter(p => p.position === 'WR');
  const TEs = players.filter(p => p.position === 'TE');
  const DSTs = players.filter(p => p.position === 'D/ST');
  const Ks = players.filter(p => p.position === 'K');

  // Helper score calculator based on strategy
  const calculateOptimizedScore = (player) => {
    // Check injury impact
    let injuryDeduction = 0;
    if (player.injuryStatus === 'Questionable') injuryDeduction = 2.0;
    if (player.injuryStatus === 'Doubtful') injuryDeduction = 6.0;
    if (player.injuryStatus === 'Out' || player.injuryStatus === 'IR') return -100;

    const baseProj = player.projectedPoints - injuryDeduction;
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

  const sortedQBs = scoreAndSort(QBs);
  const sortedRBs = scoreAndSort(RBs);
  const sortedWRs = scoreAndSort(WRs);
  const sortedTEs = scoreAndSort(TEs);
  const sortedDSTs = scoreAndSort(DSTs);
  const sortedKs = scoreAndSort(Ks);

  // Select primary starters
  const starters = [];
  const flexCandidates = [];

  // QB (1)
  if (sortedQBs[0]) starters.push(sortedQBs[0].player);
  
  // RB (2)
  if (sortedRBs[0]) starters.push(sortedRBs[0].player);
  if (sortedRBs[1]) starters.push(sortedRBs[1].player);
  // Remainder go to FLEX
  if (sortedRBs.length > 2) flexCandidates.push(...sortedRBs.slice(2));

  // WR (2)
  if (sortedWRs[0]) starters.push(sortedWRs[0].player);
  if (sortedWRs[1]) starters.push(sortedWRs[1].player);
  // Remainder go to FLEX
  if (sortedWRs.length > 2) flexCandidates.push(...sortedWRs.slice(2));

  // TE (1)
  if (sortedTEs[0]) starters.push(sortedTEs[0].player);
  if (sortedTEs.length > 1) flexCandidates.push(...sortedTEs.slice(1));

  // DST (1)
  if (sortedDSTs[0]) starters.push(sortedDSTs[0].player);

  // K (1)
  if (sortedKs[0]) starters.push(sortedKs[0].player);

  // FLEX (1) — pick highest remaining flex-eligible candidate
  const sortedFlex = flexCandidates.sort((a, b) => b.score - a.score);
  if (sortedFlex[0]) {
    starters.push(sortedFlex[0].player);
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
