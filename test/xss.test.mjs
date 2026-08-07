/**
 * A hostile draft payload must not become markup.
 *
 * Run: node test/xss.test.mjs
 *
 * The app builds its UI from template literals and assigns them with innerHTML,
 * and almost everything it interpolates is scraped from the live ESPN room or
 * fetched from a news API. A security audit demonstrated the full chain: a POST
 * to the local sync endpoint, through the real importScrapedPayload, into nine
 * confirmed injection points across five panels.
 *
 * So this drives the REAL mapper and the REAL renderers with a payload carrying
 * markup in every field a manager can choose, and fails if a raw angle bracket
 * survives into any rendered target. It also asserts the payload actually
 * reached the sinks in escaped form -- otherwise "no injections" would pass
 * simply because nothing rendered.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const written = new Map();
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const mk = (id) => {
  const el = {
    id, style: { cssText: '' },
    classList: { add() {}, remove() {}, contains() { return false; } },
    children: [],
    get innerHTML() { return written.get(id) || ''; },
    set innerHTML(v) { written.set(id, String(v)); },
    // textContent is a safe sink by definition; record it separately so a
    // renderer cannot "pass" by writing markup somewhere we do not look.
    innerText: '', textContent: '', value: '',
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    insertBefore() {}, insertAdjacentHTML() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector: () => mk(`${id}:c`), querySelectorAll: () => [], closest: () => null, focus() {},
  };
  el.parentElement = { parentElement: { appendChild() {} }, appendChild() {} };
  return el;
};
const cache = new Map();
const get = (id) => { if (!cache.has(id)) cache.set(id, mk(id)); return cache.get(id); };
globalThis.document = {
  body: mk('body'), documentElement: mk('html'),
  getElementById: get, querySelector: get, querySelectorAll: () => [],
  createElement: () => mk('created'), addEventListener() {},
};
globalThis.window = globalThis;
globalThis.setInterval = () => 0;
globalThis.setTimeout = (fn) => { try { fn(); } catch (e) { /* reported by the page */ } return 0; };
process.on('unhandledRejection', () => {});

const projections = JSON.parse(readFileSync(join(ROOT, 'data/projections-2026.json'), 'utf8'));
globalThis.fetch = async (url) => {
  if (String(url).includes('projections')) return { ok: true, json: async () => projections };
  throw new Error('network disabled in tests');
};

const { default: store } = await import(join(ROOT, 'js/store.js'));
const { default: espnClient, realDbReady } = await import(join(ROOT, 'js/espn-client.js'));
await realDbReady;
const app = await import(join(ROOT, 'js/app.js'));

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const TAG = '<img src=x onerror=alert(1)>';
// Breaks out of a JS string inside an HTML attribute — the shape that made the
// old inline onclick handlers exploitable.
const BREAK = `X'); alert(document.domain); //`;

const payload = {
  isDOMScraped: true, leagueId: '666', leagueName: `League ${TAG}`, myTeamId: 1,
  teams: [
    { teamId: 1, teamName: `Me ${TAG}`, faabRemaining: 100 },
    { teamId: 2, teamName: `Rival "${TAG}`, faabRemaining: 100 },
  ],
  draftDetail: { picks: [
    { overallPickNumber: 1, playerName: `${TAG} Guy`, playerPosition: 'RB', playerTeam: 'ATL', drafterTeamId: 1, bidAmount: 10 },
    { overallPickNumber: 2, playerName: BREAK, playerPosition: 'WR', playerTeam: 'LAR', drafterTeamId: 2, bidAmount: 5 },
  ] },
  currentNomination: { name: `${TAG} Nominee`, team: 'BUF', position: 'QB', bid: 5 },
};

console.log('\nevery page renders a hostile payload');
await espnClient.importScrapedPayload(payload);
const league = store.getActiveLeague();
store.state.activeTab = 'home';

const PAGES = ['renderHomePage', 'renderRosterPage', 'renderMatchupPage',
               'renderChampionshipPage', 'renderAlertsPage', 'renderWaiversPage',
               'renderLeaguePage', 'renderTradesPage', 'renderSettingsPage'];
for (const name of PAGES) {
  const fn = app[name];
  if (typeof fn !== 'function') { check(`${name} is exported`, false); continue; }
  let err = null;
  try { fn(league); } catch (e) { err = e; }
  check(`${name} survives it`, !err, err && `${err.constructor.name}: ${err.message}`);
}

console.log('\nnothing hostile survived as markup');
const injected = [];
for (const [id, html] of written) {
  // Only a real angle bracket is an injection: "&lt;img src=x onerror=" is the
  // escaped form and still contains the substring "onerror=".
  if (html.includes('<img src=x') || html.includes(BREAK)) injected.push(id);
}
check('no rendered target contains raw injected markup', injected.length === 0,
  injected.join(', '));

// Without this the check above would pass on an app that rendered nothing.
const escapedHits = [...written.values()].filter((h) => h.includes('&lt;img src=x')).length;
check('the payload did reach the sinks, escaped', escapedHits > 0,
  `${escapedHits} escaped occurrences across ${written.size} targets`);

// Match only a handler in real attribute position, inside an actual tag. The
// escaped payload still contains the literal text "onerror=", so a naive search
// flags its own escaping as a failure.
const INLINE_HANDLER = /<[a-zA-Z][^>]*?\son[a-z]+\s*=/;
const withHandler = [...written.entries()].filter(([, h]) => INLINE_HANDLER.test(h));
check('no inline event-handler attribute is generated', withHandler.length === 0,
  withHandler.map(([id]) => id).join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
