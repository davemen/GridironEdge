/**
 * Draft data reaches the page, fast, and only from ESPN.
 *
 * Run: node test/transport.test.mjs
 *
 * The app used to poll a local web server every three seconds for a file the
 * extension had POSTed. A live auction moves every second, so a bid landing just
 * after a tick waited almost the full interval — an age when the clock on screen
 * is counting down from ten. It also asked every user to run a web server, which
 * is a lot to ask and brought a listening socket, a CORS policy and a write
 * endpoint with it.
 *
 * The app now ships inside the extension, so the two halves talk directly: a
 * long-lived port for delivery, chrome.storage as the durable snapshot. This
 * exercises the REAL service worker and the REAL bridge against a simulated
 * chrome API, and asserts three things: the payload arrives, it arrives fast,
 * and a sender that is not ESPN is refused.
 */
const listeners = { storage: [], connect: [], message: [] };
const store = {};
let ports = [];
globalThis.chrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: null,
    getURL: (p) => `chrome-extension://test/${p}`,
    onMessage: { addListener: (f) => listeners.message.push(f) },
    onConnect: { addListener: (f) => listeners.connect.push(f) },
    connect: ({ name }) => {
      const appSide = { name, onMessage: { addListener: (f) => (appSide._f = f) },
                        onDisconnect: { addListener: () => {} }, disconnect() {} };
      const bgSide = { name, postMessage: (m) => appSide._f && appSide._f(m),
                       onDisconnect: { addListener: () => {} } };
      listeners.connect.forEach((f) => f(bgSide));
      return appSide;
    },
  },
  storage: {
    local: {
      get: (k, cb) => cb({ [k]: store[k] }),
      set: (obj, cb) => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) { changes[k] = { newValue: v }; store[k] = v; }
        listeners.storage.forEach((f) => f(changes, 'local'));
        cb && cb();
      },
    },
    onChanged: { addListener: (f) => listeners.storage.push(f),
                 removeListener: () => {} },
  },
  tabs: { query: async () => [], create: async () => {}, update: async () => {},
          // The worker watches draft tabs so it can fall back to isolated-world
          // injection where MAIN is unsupported (Safari).
          onUpdated: { addListener: () => {} } },
  scripting: { executeScript: async () => [] },
  action: { onClicked: { addListener: () => {} } },
};
globalThis.window = globalThis;
globalThis.setInterval = () => 0;

// Load the real service worker.
const { readFileSync } = await import('fs');
const { fileURLToPath } = await import('url');
const { join } = await import('path');
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const bg = readFileSync(join(ROOT, 'chrome-extension/background.js'), 'utf8');
new Function(bg)();

// Load the real bridge and subscribe as the app would.
const { listenForDrafts, describeSource, hasExtensionBridge } =
  await import(join(ROOT, 'js/bridge.js'));

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('\nthe app talks to the extension, not to a server');
check('the bridge detects the extension', hasExtensionBridge());
check('and reports it needs no server', describeSource().needsServer === false);
check('and names the live source', describeSource().kind === 'extension');

const timings = [];
let got = 0;
listenForDrafts((data) => { got++; if (data.__t) timings.push(performance.now() - data.__t); });

// Fire what the content script sends, exactly as background.js expects it.
const send = (n) => new Promise((resolve) => {
  const payload = { leagueId: 'L1', teams: [{ teamId: 1, faabRemaining: 200 - n }],
                    draftDetail: { picks: [] }, __t: performance.now() };
  listeners.message.forEach((f) =>
    f({ action: 'sync', data: payload },
      { origin: 'https://fantasy.espn.com' }, resolve));
});
for (let i = 0; i < 20; i++) await send(i);
await new Promise((r) => setTimeout(r, 20));

console.log('\ndelivery is immediate, not polled');
const med = timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)];
const worst = Math.max(...timings);
// `got >= 20` passed at 40 and printed "40 deliveries for 20 sends" as ok.
// Both routes carry every update, so each scrape was mapped, serialised,
// stored and rendered twice -- half the app's work in a live auction spent
// recomputing a draft it had just computed. An unbounded lower bound cannot
// see that; the count has to be exact.
check('every update was delivered', got >= 20, `${got} deliveries for 20 sends`);
check('and delivered exactly once', got === 20, `${got} deliveries for 20 sends`);
// The old transport could take the full 3s poll interval. Anything in the tens
// of milliseconds is a different category; the budget is loose on purpose.
check('median latency is sub-millisecond', med < 1, `${med.toFixed(3)}ms`);
check('worst case stays under 50ms', worst < 50, `${worst.toFixed(3)}ms`);

// And a rejected sender must not be stored.
console.log('\nonly ESPN may write');
const before = JSON.stringify(store);
listeners.message.forEach((f) => f({ action: 'sync', data: { leagueId: 'X', teams: [{}] } },
  { origin: 'https://evil.example' }, () => {}));
check('a sender that is not ESPN is refused', JSON.stringify(store) === before);

const beforeShape = JSON.stringify(store);
listeners.message.forEach((f) => f({ action: 'sync', data: { not: 'a league' } },
  { origin: 'https://fantasy.espn.com' }, () => {}));
check('a payload that is not a league is refused', JSON.stringify(store) === beforeShape);

// ...but our own pages must still be allowed through, on every engine.
//
// The worker built its own origin as "chrome-extension://" + runtime.id. Safari
// serves extension pages from safari-web-extension://, so that literal matched
// nothing there and the popup's own Sync was refused by the worker shipping
// beside it. Deriving the origin from getURL() is what makes both engines work,
// and the mock's getURL host deliberately differs from runtime.id so a
// reintroduction of the concatenated form fails here.
// Written out rather than derived, so this asserts the value instead of
// repeating whatever the worker computes. The mock's getURL host ("test")
// deliberately differs from runtime.id ("test-extension-id"), so the old
// concatenated form fails here.
const OWN = 'chrome-extension://test';
const beforeOwn = JSON.stringify(store);
listeners.message.forEach((f) => f(
  { action: 'sync', data: { leagueId: 'OWN', teams: [{ id: 1 }] } },
  { origin: OWN }, () => {}));
check('our own extension page may sync', JSON.stringify(store) !== beforeOwn,
  `own origin ${OWN} was refused`);

// The same worker code, loaded against a Safari-shaped runtime.
{
  const safariListeners = [];
  const safariStore = {};
  const realChrome = globalThis.chrome;
  globalThis.chrome = {
    ...realChrome,
    runtime: {
      ...realChrome.runtime,
      id: 'ABCDEF12-3456',
      getURL: (p) => `safari-web-extension://ABCDEF12-3456/${p}`,
      onMessage: { addListener: (f) => safariListeners.push(f) },
      onConnect: { addListener: () => {} },
    },
    storage: {
      ...realChrome.storage,
      local: { get: (k, cb) => cb({ [k]: safariStore[k] }),
               set: (o, cb) => { Object.assign(safariStore, o); cb && cb(); } },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
  new Function(bg)();
  safariListeners.forEach((f) => f(
    { action: 'sync', data: { leagueId: 'S', teams: [{ id: 1 }] } },
    { origin: 'safari-web-extension://ABCDEF12-3456' }, () => {}));
  check('a Safari extension page may sync', Object.keys(safariStore).length > 0);

  // And the boundary still holds on that engine.
  const beforeEvil = JSON.stringify(safariStore);
  safariListeners.forEach((f) => f(
    { action: 'sync', data: { leagueId: 'X', teams: [{ id: 1 }] } },
    { origin: 'safari-web-extension://SOMEONE-ELSE' }, () => {}));
  check('another Safari extension may not', JSON.stringify(safariStore) === beforeEvil);
  globalThis.chrome = realChrome;
}

console.log('\nthe worker refuses a payload that is too big to be a draft');
{
  // content-isolated.js capped payloads at 5MB; this copy of the same check
  // did not, and the worker is reachable without passing through it -- the
  // content script messages it directly whenever it has extension APIs. A 9MB
  // payload was accepted here and rejected there. chrome.storage.local holds
  // 10MB with no unlimitedStorage, so an oversized write displaces the draft.
  const big = { leagueId: 'BIG', teams: [{ teamId: 1 }],
                draftDetail: { picks: [] }, filler: 'x'.repeat(6 * 1024 * 1024) };
  const beforeBig = JSON.stringify(store);
  listeners.message.forEach((f) => f({ action: 'sync', data: big },
    { origin: 'https://fantasy.espn.com' }, () => {}));
  check('an oversized payload is refused', JSON.stringify(store) === beforeBig);

  // Counts, not only bytes: a forged sync can name as many teams as it likes
  // and every one of them is rendered.
  const many = { leagueId: 'MANY',
                 teams: Array.from({ length: 500 }, (_, i) => ({ teamId: i })),
                 draftDetail: { picks: [] } };
  const beforeMany = JSON.stringify(store);
  listeners.message.forEach((f) => f({ action: 'sync', data: many },
    { origin: 'https://fantasy.espn.com' }, () => {}));
  check('an implausible number of teams is refused',
    JSON.stringify(store) === beforeMany);

  // ...and a real draft still gets through, or the cap would pass by refusing
  // everything.
  const ok = { leagueId: 'OK', teams: [{ teamId: 1, faabRemaining: 200 }],
               draftDetail: { picks: [{ overallPickNumber: 1 }] } };
  const beforeOk = JSON.stringify(store);
  listeners.message.forEach((f) => f({ action: 'sync', data: ok },
    { origin: 'https://fantasy.espn.com' }, () => {}));
  check('an ordinary draft still stores', JSON.stringify(store) !== beforeOk);
}

console.log('\nthe popup only offers to scrape ESPN itself');
{
  // `tab.url.includes('fantasy.espn.com')` accepted any URL that merely
  // mentioned the host, which enabled Sync on an attacker's page and pointed
  // the scraper at it.
  const popup = readFileSync(join(ROOT, 'chrome-extension/popup.js'), 'utf8');
  const m = popup.match(/function isEspnUrl[\s\S]*?\n}/);
  check('the popup has a real host check', Boolean(m));
  if (m) {
    const isEspnUrl = new Function(`${m[0]}; return isEspnUrl;`)();
    [
      ['https://fantasy.espn.com/football/draft', true],
      ['https://fantasy.espn.com/football/league?leagueId=1', true],
      ['https://evil.example/?fantasy.espn.com', false],
      ['https://fantasy.espn.com.evil.example/', false],
      ['http://fantasy.espn.com/', false],
      ['https://notfantasy.espn.com/', false],
      ['about:blank', false],
      ['', false],
    ].forEach(([url, want]) => {
      check(`${want ? 'accepts' : 'rejects'} ${url || '(empty)'}`,
        isEspnUrl(url) === want);
    });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
