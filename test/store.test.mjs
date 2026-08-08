/**
 * The store must survive whatever is already in localStorage.
 *
 * Run: node test/store.test.mjs
 *
 * `this.state = JSON.parse(data)` replaced the defaults wholesale. A state saved
 * by an older schema is perfectly valid JSON, so the catch never fired — but it
 * might have no `leagues` key, and getActiveLeague() then threw reading a
 * property of undefined. That is a blank app on load, with a TypeError as the
 * only clue.
 *
 * Also covered: a failed write must still notify. `notify()` used to sit inside
 * the try, so hitting the quota — reachable, since each league keeps its own
 * copy of a 523-player database — silently skipped every listener while the app
 * carried on rendering state that was never saved.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const KEY = 'gridiron_edge_state';

// store.js publishes itself on window for the console; give it one.
globalThis.window = globalThis;

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

/** A fresh store module with localStorage seeded to `seed`. */
async function freshStore(seed, { failWrites = false } = {}) {
  const mem = new Map();
  if (seed !== undefined) mem.set(KEY, seed);
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) {
        const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
      }
      mem.set(k, String(v));
    },
    removeItem: (k) => mem.delete(k),
  };
  // A distinct query string per call defeats the module cache, so each case
  // gets a genuinely fresh constructor run.
  const mod = await import(join(ROOT, 'js/store.js') + `?t=${Math.random()}`);
  return mod.default;
}

console.log('\na stored state that is not what we expect');
{
  const cases = [
    ['nothing stored', undefined],
    ['corrupt JSON', '{'],
    ['an older schema with no leagues', '{"currentLeagueId":"L1","activeTab":"home"}'],
    ['leagues explicitly null', '{"leagues":null,"currentLeagueId":"L1"}'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON string', '"hello"'],
    ['a JSON null', 'null'],
  ];
  for (const [label, seed] of cases) {
    let store, threw = null;
    try {
      store = await freshStore(seed);
      // The call that used to throw.
      store.getActiveLeague();
      store.getMyTeam();
    } catch (e) { threw = e; }
    check(`survives ${label}`, !threw, threw && `${threw.constructor.name}: ${threw.message}`);
    if (!threw) {
      check(`  ...and still has a leagues object`, store.state.leagues
        && typeof store.state.leagues === 'object');
    }
  }
}

console.log('\na dangling currentLeagueId does not survive load');
{
  const store = await freshStore('{"currentLeagueId":"gone","leagues":{}}');
  check('an id pointing at no league is cleared', store.getActiveLeague() === null);
}

console.log('\na failed write still reaches the interface');
{
  const store = await freshStore('{"leagues":{},"currentLeagueId":null}', { failWrites: true });
  let notified = 0;
  store.subscribe(() => { notified++; });
  store.save();
  await Promise.resolve(); await Promise.resolve();
  check('listeners are notified even when the write fails', notified > 0, `${notified}`);
  check('and the failure is recorded rather than swallowed', store.persistFailed === true);
}

console.log('\nrepeated saves collapse into one render');
{
  const store = await freshStore('{"leagues":{},"currentLeagueId":null}');
  let notified = 0;
  store.subscribe(() => { notified++; });
  store.save(); store.save(); store.save();
  await Promise.resolve(); await Promise.resolve();
  // Three saves in one turn used to mean three full re-renders of the draft page.
  check('three saves in a turn notify once', notified === 1, `${notified} notifications`);
}

console.log('\ndrafting in one league does not touch another');
{
  // The shared player database means every league holds the SAME record
  // objects. store.js used to write `drafted`, `draftedAtPick`, `draftedCost`
  // and `ownerId` onto them, so a pick in one league marked the player drafted
  // in all of them -- and it persisted, because the shared copy is what carries
  // it. A false availability reading is indistinguishable on screen from a true
  // one. Nothing read any of the four, so they were pure cost.
  const shared = {
    P1: { id: 'P1', key: 'a one', name: 'A One', position: 'RB', team: 'FA', projectedPoints: 20 },
    P2: { id: 'P2', key: 'b two', name: 'B Two', position: 'WR', team: 'FA', projectedPoints: 18 },
  };
  const mk = (id) => ({
    leagueId: id, leagueSize: 2, myTeamId: 1,
    rosterSettings: { startersCount: 2, benchCount: 1 },
    teams: [1, 2].map((t) => ({ teamId: t, teamName: `T${t}`, roster: [],
      faabRemaining: 200, record: { wins: 0, losses: 0, ties: 0 } })),
    schedule: [],
    draftState: { draftType: 'auction', selections: [], currentPick: 1, draftOrder: [1, 2] },
    playerDatabase: shared,
  });
  store.state.leagues = {};
  store.state.currentLeagueId = null;
  store.state.playerDatabase = { ...shared };
  store.saveLeague('LG_A', mk('LG_A'));
  store.saveLeague('LG_B', mk('LG_B'));

  store.state.currentLeagueId = 'LG_A';
  store.recordDraftPickAuction('P1', 1, 55);

  const a = store.state.leagues.LG_A, b = store.state.leagues.LG_B;
  check('the pick is recorded in the league it was made in',
    a.draftState.selections.length === 1 && a.teams[0].roster.includes('P1'));
  check('and the other league has no pick', b.draftState.selections.length === 0,
    JSON.stringify(b.draftState.selections));
  check('and nobody in the other league rostered him',
    b.teams.every((t) => !t.roster.includes('P1')),
    JSON.stringify(b.teams.map((t) => t.roster)));
  // The record itself must carry no draft state at all -- that is what made it
  // leak, and what the roster and the selections already answer.
  const clean = (id) => {
    const r = store.state.playerDatabase[id] || shared[id];
    return r.drafted === undefined && r.draftedCost === undefined
      && r.draftedAtPick === undefined && r.ownerId === undefined;
  };
  check('and the player record itself was not written to', clean('P1'),
    JSON.stringify(store.state.playerDatabase.P1));

  // BOTH record paths, because they are separate functions with separate
  // writes -- reverting only the snake one went unnoticed the first time this
  // was checked, which is the whole reason the pair is asserted.
  store.recordDraftPick(1, 'P2');
  check('and the snake path leaves it alone too', clean('P2'),
    JSON.stringify(store.state.playerDatabase.P2));
  check('while still recording the pick',
    store.state.leagues.LG_A.draftState.selections.some((sel) => sel.playerId === 'P2'));

  // Undo and reset touch the same records; they must not write either.
  store.undoLastDraftPick();
  check('undo leaves the record alone', clean('P2'));
  store.resetDraft();
  check('and so does reset', clean('P1') && clean('P2'));
}

console.log('\nthe player database is stored once, not once per league');
{
  // Each league carried its own copy of the same 523 records: about 128KB
  // serialised, 2.7MB at twenty-one leagues, against a 5-10MB quota.
  store.state.leagues = {};
  store.state.currentLeagueId = null;
  const shared = {};
  for (let i = 0; i < 200; i++) {
    shared[`FP_p${i}`] = { id: `FP_p${i}`, key: `p ${i}`, name: `Player ${i}`,
      position: 'WR', team: 'FA', projectedPoints: 10 };
  }
  store.state.playerDatabase = shared;

  const withStub = (id) => ({
    ...shared,
    [`MOCK_${id}`]: { id: `MOCK_${id}`, key: `stub ${id}`, name: `Stub ${id}`,
      position: 'RB', team: 'FA', projectedPoints: 4.5 },
  });

  store.saveLeague('one', { leagueId: 'one', teams: [], playerDatabase: withStub('a') });
  const oneSize = (globalThis.localStorage.getItem('gridiron_edge_state') || '').length;
  store.saveLeague('two', { leagueId: 'two', teams: [], playerDatabase: withStub('b') });
  const twoSize = (globalThis.localStorage.getItem('gridiron_edge_state') || '').length;

  // A second league must cost a stub, not a database.
  const perLeague = twoSize - oneSize;
  check('a second league adds a few hundred bytes, not a database',
    perLeague < oneSize / 4, `${perLeague} chars for the second league, `
      + `against ${oneSize} for the first`);

  // And it must come back whole, including the stub only that league holds --
  // a pick recorded under a stub id is unreadable without it.
  store.load();
  const one = store.state.leagues.one;
  const two = store.state.leagues.two;
  check('every shared record is restored',
    Object.keys(one.playerDatabase).length === Object.keys(shared).length + 1,
    `${Object.keys(one.playerDatabase).length} records`);
  check("and each league keeps its own stubs, not the other's",
    Boolean(one.playerDatabase.MOCK_a) && !one.playerDatabase.MOCK_b
      && Boolean(two.playerDatabase.MOCK_b) && !two.playerDatabase.MOCK_a);
  check('a shared record is intact', one.playerDatabase.FP_p7
    && one.playerDatabase.FP_p7.name === 'Player 7');
}

console.log('\nstored state is bounded, and its keys are just keys');
{
  // Nothing capped state.leagues, and each league carries its own copy of the
  // 523-player database -- 21 leagues measured 2.7MB against a 5-10MB quota.
  // Once save() starts failing, the app runs on state that is never persisted.
  store.state.leagues = {};
  store.state.currentLeagueId = null;
  for (let i = 1; i <= 12; i++) {
    store.saveLeague(`L${i}`, { leagueId: `L${i}`, teams: [], playerDatabase: {} });
    // Distinct, ascending, and set explicitly. Twelve saves land in the same
    // millisecond, so without this there is no "oldest" and the assertion
    // below is decided by the sort's stability -- which made it flaky roughly
    // one run in five.
    store.state.leagues[`L${i}`].lastUpdated = new Date(1000 + i * 1000).toISOString();
  }
  const kept = Object.keys(store.state.leagues);
  check('the number of stored leagues is capped', kept.length <= 8, `${kept.length} kept`);
  check('and the league just synced is one of them', kept.includes('L12'), kept.join(','));
  check('the oldest went first', !kept.includes('L1'), kept.join(','));
  check('and the active league still resolves',
    Boolean(store.getActiveLeague()) && store.state.currentLeagueId === 'L12');

  // A key that came off the wire must not be able to reach the prototype.
  const before = Object.keys(store.state.leagues).length;
  store.saveLeague('__proto__', { leagueId: '__proto__', teams: [] });
  check('a league id of __proto__ is refused',
    Object.keys(store.state.leagues).length === before);
  check('and nothing reached Object.prototype', ({}).leagueId === undefined
    && ({}).teams === undefined);
  check('the store is still usable afterwards',
    Object.getPrototypeOf(store.state.leagues) === Object.prototype);
}

console.log('\nthe draft-mutation API, which no test had ever called');
{
  // 176 lines -- recordDraftPick, recordDraftPickAuction, undoLastDraftPick,
  // resetDraft, rebuildRostersFromDraft, processTransaction -- referenced by no
  // test. Surviving mutants included `faabRemaining - bidAmount` becoming
  // `+ bidAmount`, so winning a lot ADDED money; dropping the total-picks
  // bound; and inverting the snake direction. rebuildRostersFromDraft is the
  // only thing that writes team.roster from draft state.
  const mkLeague = () => ({
    leagueId: 'DRAFT', leagueName: 'D', leagueSize: 4, myTeamId: 1,
    rosterSettings: { startersCount: 2, benchCount: 1 },
    teams: [1, 2, 3, 4].map((id) => ({ teamId: id, teamName: `T${id}`, roster: [],
      faabRemaining: 200, record: { wins: 0, losses: 0, ties: 0 } })),
    schedule: [],
    draftState: { draftType: 'snake', selections: [], currentPick: 1,
                  draftOrder: [1, 2, 3, 4] },
    playerDatabase: {
      P1: { id: 'P1', key: 'a one', name: 'A One', position: 'RB', team: 'FA', projectedPoints: 20 },
      P2: { id: 'P2', key: 'b two', name: 'B Two', position: 'WR', team: 'FA', projectedPoints: 18 },
      P3: { id: 'P3', key: 'c three', name: 'C Three', position: 'QB', team: 'FA', projectedPoints: 16 },
    },
  });
  const load = () => {
    const l = mkLeague();
    store.state.leagues = { DRAFT: l };
    store.state.currentLeagueId = 'DRAFT';
    store.state.playerDatabase = { ...l.playerDatabase };
    return l;
  };

  // An auction win COSTS money.
  let l = load();
  store.recordDraftPickAuction('P1', 2, 57);
  const buyer = l.teams.find((t) => t.teamId === 2);
  check('winning a lot deducts the bid', buyer.faabRemaining === 143,
    String(buyer.faabRemaining));
  check('and the pick is recorded against the winner',
    l.draftState.selections.length === 1 && l.draftState.selections[0].teamId === 2);
  check('and the roster is rebuilt from it', buyer.roster.includes('P1'),
    JSON.stringify(buyer.roster));
  check('a budget cannot go negative', (() => {
    store.recordDraftPickAuction('P2', 2, 999);
    return l.teams.find((t) => t.teamId === 2).faabRemaining === 0;
  })());

  // Snake ownership: round 1 runs 1,2,3,4 and round 2 runs 4,3,2,1.
  l = load();
  store.recordDraftPick(1, 'P1');
  store.recordDraftPick(5, 'P2');
  const owner = (pick) => l.draftState.selections.find((sel) => sel.pick === pick).teamId;
  check('pick 1 belongs to the first seat', owner(1) === 1, String(owner(1)));
  check('pick 5 belongs to the LAST seat, because the snake turns',
    owner(5) === 4, String(owner(5)));
  // A snake pick must reach the roster too -- rebuildRostersFromDraft is the
  // only thing that puts it there, and it is called from both record paths.
  check('and the player lands on that seat\'s roster',
    l.teams.find((t) => t.teamId === 4).roster.includes('P2'),
    JSON.stringify(l.teams.map((t) => t.roster)));

  // The bound: 4 teams x 3 slots = 12 picks, and pick 13 does not exist.
  l = load();
  store.recordDraftPick(13, 'P1');
  check('a pick beyond the end of the draft is refused',
    l.draftState.selections.length === 0, JSON.stringify(l.draftState.selections));

  // Undo restores the board.
  l = load();
  store.recordDraftPick(1, 'P1');
  store.recordDraftPick(2, 'P2');
  store.undoLastDraftPick();
  check('undo removes the last pick', l.draftState.selections.length === 1);
  check('and rewinds the clock', l.draftState.currentPick === 2,
    String(l.draftState.currentPick));
  check('and takes the player off the roster',
    !l.teams.some((t) => t.roster.includes('P2')),
    JSON.stringify(l.teams.map((t) => t.roster)));

  // Reset clears everything.
  l = load();
  store.recordDraftPick(1, 'P1');
  store.resetDraft();
  check('reset empties the selections', l.draftState.selections.length === 0);
  check('and every roster with them', l.teams.every((t) => t.roster.length === 0));

  // rebuildRostersFromDraft is the sole writer of team.roster.
  l = load();
  l.draftState.selections = [
    { pick: 1, playerId: 'P1', teamId: 3 },
    { pick: 2, playerId: 'P2', teamId: 3 },
    { pick: 3, playerId: 'P3', teamId: 1 },
  ];
  l.teams.forEach((t) => { t.roster = ['STALE']; });
  store.rebuildRostersFromDraft(l);
  check('rebuilding rosters follows the selections, not what was there before',
    JSON.stringify(l.teams.find((t) => t.teamId === 3).roster) === JSON.stringify(['P1', 'P2'])
      && JSON.stringify(l.teams.find((t) => t.teamId === 1).roster) === JSON.stringify(['P3']),
    JSON.stringify(l.teams.map((t) => t.roster)));
  check('and a team with no picks has no roster',
    l.teams.find((t) => t.teamId === 2).roster.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
