/**
 * The scrape -> resolve -> attribute pipeline.
 *
 * Run: node test/espn-client.test.mjs
 *
 * This is the layer between the browser and the engines, and it had 13% line
 * coverage with importScrapedPayload entirely unexecuted — no test file imported
 * this module at all. Everything downstream trusts what it produces: a
 * mis-attributed pick corrupts a roster *and* the budget model every bid ceiling
 * is derived from, and an unresolved name silently becomes a replacement-level
 * stub.
 *
 * So this drives the real importer with the payload shapes a live draft actually
 * produces, including the malformed ones.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.window = globalThis;
globalThis.document = { addEventListener() {}, querySelector: () => null };

const projections = JSON.parse(readFileSync(join(ROOT, 'data/projections-2026.json'), 'utf8'));
globalThis.fetch = async () => ({ ok: true, json: async () => projections });

const { default: store } = await import(join(ROOT, 'js/store.js'));
const { default: espnClient, realDbReady } = await import(join(ROOT, 'js/espn-client.js'));
await realDbReady;

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const pick = (n, name, pos, team, owner, bid) => ({
  overallPickNumber: n, playerName: name, playerPosition: pos,
  playerTeam: team, drafterTeamId: owner, bidAmount: bid,
});
const payload = (picks, over = {}) => ({
  isDOMScraped: true, leagueId: '1001', leagueName: 'Test League', myTeamId: 1,
  teams: [
    { teamId: 1, teamName: "Mac's Marauders", faabRemaining: 120 },
    { teamId: 2, teamName: 'Team 2', faabRemaining: 150 },
  ],
  draftDetail: { picks },
  ...over,
});

console.log('\na normal scrape');
{
  const l = await espnClient.importScrapedPayload(payload([
    pick(1, 'Bijan Robinson', 'RB', 'ATL', 1, 49),
    pick(2, "Ja'Marr Chase", 'WR', 'CIN', 2, 52),
    pick(3, 'Houston Texans', 'D/ST', 'HOU', 1, 2),
  ]));
  const me = l.teams.find((t) => t.teamId === 1);
  check('picks land on the right teams', me.roster.length === 2,
    `${me.roster.length} on my team`);
  check('names resolve to real projections',
    me.roster.every((id) => l.playerDatabase[id] && l.playerDatabase[id].projectedSeason > 0));
  check('a defense resolves like anyone else',
    me.roster.map((id) => l.playerDatabase[id].position).includes('D/ST'));
  check('the league becomes the active one', store.state.currentLeagueId === '1001');
}

console.log('\nabbreviated names, as a roster panel writes them');
{
  const l = await espnClient.importScrapedPayload(payload([
    pick(1, 'J. Allen', 'QB', 'BUF', 1, 19),
    pick(2, 'P. Nacua', 'WR', 'LAR', 1, 48),
    // Two Atlanta running backs share this initial and surname; only the price
    // separates Bijan (ranked 3rd) from Brian (160th).
    pick(3, 'B. Robinson', 'RB', 'ATL', 1, 49),
  ], { leagueId: '1002' }));
  const names = l.teams.find((t) => t.teamId === 1).roster.map((id) => l.playerDatabase[id].name);
  check('J. Allen resolves', names.includes('Josh Allen'), names.join(', '));
  check('P. Nacua resolves', names.includes('Puka Nacua'));
  check('the price picks the right B. Robinson', names.includes('Bijan Robinson'), names.join(', '));
}

console.log('\na pick whose owner cannot be identified');
{
  const l = await espnClient.importScrapedPayload(payload([
    pick(1, 'Bijan Robinson', 'RB', 'ATL', 1, 49),
    pick(2, "Ja'Marr Chase", 'WR', 'CIN', null, 52),
  ], { leagueId: '1003' }));
  const onRosters = l.teams.reduce((a, t) => a + t.roster.length, 0);
  check('it reaches nobody\'s roster', onRosters === 1, `${onRosters} rostered`);
  // It must still count as drafted, or the app offers a player somebody owns.
  check('but it is still off the board', l.draftState.selections.length === 2);
  check('and it is recorded with a null owner',
    l.draftState.selections.some((s) => s.teamId === null));
}

console.log('\nan unresolvable name');
{
  const l = await espnClient.importScrapedPayload(payload([
    pick(1, 'Zxqv Notaplayer', 'RB', 'XXX', 1, 5),
    pick(2, 'Bijan Robinson', 'RB', 'ATL', 1, 49),
  ], { leagueId: '1004' }));
  const me = l.teams.find((t) => t.teamId === 1);
  check('one bad name does not abort the import', me.roster.length === 2,
    `${me.roster.length} rostered`);
  const stub = me.roster.map((id) => l.playerDatabase[id]).find((p) => p.isUnknownPlayer);
  check('the unknown player is flagged, not invented', Boolean(stub));
  check('and gets replacement level rather than a mid-range guess',
    stub && stub.projectedPoints <= 9.0, stub && String(stub.projectedPoints));
}

console.log('\nmalformed payloads');
{
  const cases = [
    ['no picks at all', payload([], { leagueId: '1005' })],
    ['a pick with no position', payload([{ overallPickNumber: 1, playerName: 'Bijan Robinson', drafterTeamId: 1 }], { leagueId: '1006' })],
    ['a pick with no name', payload([pick(1, '', 'RB', 'ATL', 1, 5)], { leagueId: '1007' })],
    ['two picks sharing a number', payload([pick(1, 'Bijan Robinson', 'RB', 'ATL', 1, 49), pick(1, 'Josh Allen', 'QB', 'BUF', 1, 19)], { leagueId: '1008' })],
    ['a team list of one', { ...payload([], { leagueId: '1009' }), teams: [{ teamId: 1, teamName: 'Solo', faabRemaining: 200 }] }],
  ];
  for (const [label, p] of cases) {
    let threw = null;
    try { await espnClient.importScrapedPayload(p); } catch (e) { threw = e; }
    check(`survives ${label}`, !threw, threw && threw.message);
  }

  for (const [label, bad] of [['null', null], ['a string', 'nonsense'], ['an empty object', {}]]) {
    let rejected = false;
    try { await espnClient.importScrapedPayload(bad); } catch (e) { rejected = true; }
    check(`rejects ${label} rather than corrupting state`, rejected);
  }
}

console.log('\ntwo draft rooms open at once');
{
  await espnClient.importScrapedPayload(payload([pick(1, 'Josh Allen', 'QB', 'BUF', 1, 19)], { leagueId: 'AAA' }));
  const first = store.state.currentLeagueId;
  await espnClient.importScrapedPayload(payload([pick(1, 'Lamar Jackson', 'QB', 'BAL', 1, 20)], { leagueId: 'BBB' }));
  check('the live league is not swapped out under you', store.state.currentLeagueId === first,
    `${first} -> ${store.state.currentLeagueId}`);
  check('and the other one is flagged rather than lost', store.state.competingLeagueId === 'BBB');

  // Once the first room goes quiet, the new draft should take over.
  store.state.leagues[first].lastUpdated = new Date(Date.now() - 120000).toISOString();
  await espnClient.importScrapedPayload(payload([pick(1, 'Lamar Jackson', 'QB', 'BAL', 1, 20)], { leagueId: 'BBB' }));
  check('a stale league is replaced by the live one', store.state.currentLeagueId === 'BBB');
}

console.log('\nwhich team is yours');
{
  // An auction room lists every team's budget in the same shape as a roster
  // header, so the scraper often cannot tell which is yours. It used to answer
  // "team 1" anyway, and the mapper defaulted to 1 as well -- so the app showed
  // someone else's roster as yours with nothing on screen to say so.
  const L = 'OWNER';
  const noOwner = payload([pick(1, 'Josh Allen', 'QB', 'BUF', 2, 19)],
    { leagueId: L, myTeamId: undefined });
  let l = await espnClient.importScrapedPayload(noOwner);
  check('an unknown owner stays unknown rather than becoming team 1',
    l.myTeamId === null, String(l.myTeamId));
  check('and the league says the owner is unknown',
    l.myTeamIdSource === 'unknown', l.myTeamIdSource);
  // The previous block leaves another live league active, and the importer
  // deliberately refuses to switch away from one that is still being fed.
  store.state.currentLeagueId = L;
  check('so getMyTeam reports nothing rather than a stranger',
    store.getMyTeam() === null);

  // The user picks their team.
  l.myTeamId = 2;
  l.myTeamIdSource = 'user';
  store.saveLeague(L, l);

  // The regression that made picking a team look broken: saveLeague replaces
  // the whole league, so the next scrape -- one per pick, in a room changing
  // every second -- overwrote the choice immediately.
  l = await espnClient.importScrapedPayload(payload(
    [pick(1, 'Josh Allen', 'QB', 'BUF', 2, 19), pick(2, 'Bijan Robinson', 'RB', 'ATL', 2, 49)],
    { leagueId: L, myTeamId: undefined }));
  check('a live update does not overwrite the team you chose',
    l.myTeamId === 2, String(l.myTeamId));
  check('and it stays marked as your choice', l.myTeamIdSource === 'user');
  check('the roster on screen is now yours',
    Boolean(store.getMyTeam()) && store.getMyTeam().teamId === 2);

  // A scrape that DOES know still wins over a plain guess, but not over you.
  l = await espnClient.importScrapedPayload(payload(
    [pick(1, 'Josh Allen', 'QB', 'BUF', 1, 19)], { leagueId: L, myTeamId: 1 }));
  check('an explicit scrape still loses to your choice', l.myTeamId === 2);

  const fresh = await espnClient.importScrapedPayload(payload(
    [pick(1, 'Josh Allen', 'QB', 'BUF', 1, 19)], { leagueId: 'FRESH', myTeamId: 1 }));
  check('but on a league you never set, the scrape is used',
    fresh.myTeamId === 1 && fresh.myTeamIdSource === 'scrape');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
