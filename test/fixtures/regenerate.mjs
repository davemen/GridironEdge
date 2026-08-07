// Generate the golden fixture from the CURRENT engine. This is a deliberate,
// committed act: regenerating it is how you record an intended behaviour change.
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
const B = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const { toPlayerDatabase } = await import(join(B,'js/player-database.js'));
const { recommendBid, targetBoard, planValue, lineupPoints } = await import(join(B,'js/engine/auction-advisor.js'));
const proj = JSON.parse(readFileSync(join(B,'data/projections-2026.json'),'utf8'));
const db = toPlayerDatabase(proj);
const all = Object.values(db).sort((a,b)=>b.projectedPoints-a.projectedPoints);

function league(picks, size, seed) {
  const teams=[]; for(let i=0;i<size;i++) teams.push({teamId:i+1,teamName:'T'+(i+1),roster:[],faabRemaining:200});
  const sel=[];
  for(let i=0;i<picks;i++){ const t=teams[(i*7+seed)%size]; const p=all[i];
    t.roster.push(p.id); const bid=((i*13+seed)%40)+1; t.faabRemaining-=bid;
    sel.push({playerId:p.id,teamId:t.teamId,bidAmount:bid}); }
  return {leagueId:'GOLD',myTeamId:1,leagueSize:size,teams,playerDatabase:db,schedule:[],
    rosterSettings:{startersCount:9,benchCount:7},
    draftState:{draftType:'auction',selections:sel,currentPick:picks+1}};
}
const cases=[];
for (const size of [8,10,12]) for (const picks of [0,11,29,64,113]) for (const seed of [0,3]) {
  const l = league(picks,size,seed);
  const avail = all.filter(x=>!l.draftState.selections.some(s=>s.playerId===x.id));
  for (const idx of [0,17,88,240]) {
    const p = avail[idx]; if (!p) continue;
    for (const bid of [0,15,60]) {
      const r = recommendBid(l,p,bid);
      cases.push({ size,picks,seed,player:p.name,bid,
        out:[r.maxBid,r.recommendedBid,r.expectedPrice,r.action,r.mustBuy,
             Math.round(r.lossIfMissed*100)/100,r.budgetAfterWin,r.inflation] });
    }
  }
}
// A few planValue probes too — the function the optimisation actually rewrote.
const plans=[];
for (const size of [8,12]) for (const picks of [0,29,64]) {
  const l = league(picks,size,1);
  const detail = planValue(l.teams[0].roster.map(id=>db[id]), 140, 9,
    all.slice(0,110).map(p=>({player:p,price:Math.max(1,Math.round(p.projectedSeason/12))})),
    null, true);
  plans.push({ size,picks, value: Math.round(detail.value*1e6)/1e6, spend: detail.spend,
               bought: detail.bought.map(b=>`${b.player.name}@${b.price}`) });
}
writeFileSync(join(B,'test/fixtures/auction-golden.json'),
  JSON.stringify({ generated: 'run: node test/fixtures/regenerate.mjs', cases, plans }, null, 1));
console.log(`wrote ${cases.length} recommendBid cases and ${plans.length} planValue plans`);
