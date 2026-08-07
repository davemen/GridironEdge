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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
