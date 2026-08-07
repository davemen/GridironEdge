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
  tabs: { query: async () => [], create: async () => {}, update: async () => {} },
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
check('every update was delivered', got >= 20, `${got} deliveries for 20 sends`);
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
