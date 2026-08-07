/**
 * Actually render every page against a realistic league.
 *
 * Run: node test/render.test.mjs
 *
 * This exists because a card went blank for several rounds and nothing caught
 * it. The cause was a deleted variable declaration -- `myRoster` was still used
 * a hundred lines below where it had been removed -- which is a ReferenceError
 * at render time and completely invisible to a syntax check or an import-time
 * boot check. It threw immediately after the container had been cleared, so the
 * card emptied and every section below it stopped drawing, which reads exactly
 * like "there is nothing to show".
 *
 * So: build a league the way a live draft produces one, call each renderer, and
 * fail on a throw. Also assert the panels that must never be silently blank
 * actually received content.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// ---- a DOM stub that remembers what was written to each element ------------
const written = new Map();
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

function makeEl(id) {
  const el = {
    id,
    style: { cssText: '' },
    classList: { add() {}, remove() {}, contains() { return false; } },
    children: [], parentElement: null,
    // Writing innerHTML or textContent DESTROYS the children, as it does in a
    // browser. Without that, an element appended and then wiped by the same
    // render is indistinguishable from one that survived -- which is the exact
    // bug this file exists to catch, and an earlier version of this stub still
    // could not see it because these setters left `children` untouched.
    // innerHTML and textContent are two views of ONE content, as in a browser:
    // writing either replaces the other and destroys the children. Keeping
    // them as independent fields made `el.innerHTML = el.innerHTML` -- a write
    // that wipes an element in any real render -- invisible to an assertion on
    // textContent, so the very destruction this file exists to catch passed.
    get innerHTML() { return written.get(id) || ''; },
    set innerHTML(v) {
      written.set(id, String(v));
      this._text = String(v).replace(/<[^>]*>/g, '');
      this.children.length = 0;
    },
    get textContent() { return this._text || ''; },
    set textContent(v) {
      this._text = String(v);
      written.set(id, String(v));
      this.children.length = 0;
    },
    innerText: '', _text: '', value: '',
    // A real element has both. Without `dataset` any code doing el.dataset.x
    // throws here but works in a browser, which is the wrong way round for a
    // test; without recorded children, an element appended and then discarded
    // by the same render looks identical to one that was never appended.
    dataset: {},
    addEventListener() {}, removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    // remove() emptied nothing, so an element the app had deleted still
    // answered getElementById with its last contents -- and a test asking
    // "is the banner gone?" read the text of a banner that was gone.
    remove() { this._text = ''; written.set(this.id, ''); this.children.length = 0; },
    insertBefore() {}, insertAdjacentHTML() {},
    setAttribute() {}, getAttribute() { return null; },
    querySelector: () => makeEl(id + ':child'), querySelectorAll: () => [],
    closest: () => null, focus() {},
  };
  el.parentElement = { parentElement: { appendChild() {} }, appendChild() {} };
  return el;
}
const elCache = new Map();
const getEl = (id) => {
  if (!elCache.has(id)) elCache.set(id, makeEl(id));
  return elCache.get(id);
};
globalThis.document = {
  body: makeEl('body'), documentElement: makeEl('html'),
  getElementById: (id) => getEl(id),
  querySelector: (sel) => getEl(sel), querySelectorAll: () => [],
  createElement: () => makeEl('created'), addEventListener() {},
};
globalThis.window = globalThis;
globalThis.setInterval = () => 0;
globalThis.setTimeout = (fn) => { try { fn(); } catch (e) { /* surfaced by the caller */ } return 0; };

const projections = JSON.parse(readFileSync(join(ROOT, 'data/projections-2026.json'), 'utf8'));
globalThis.fetch = async (url) => {
  if (String(url).includes('projections')) return { ok: true, json: async () => projections };
  // No network in a test: news and sync endpoints simply fail, which is a state
  // the pages have to survive anyway.
  throw new Error('network disabled in tests');
};

// The pages fire background fetches (news, sync) that are meant to fail here.
// Their rejections are handled inside the app; this only keeps the noise out of
// the test output.
process.on('unhandledRejection', () => {});

const { default: store } = await import(join(ROOT, 'js/store.js'));
const { toPlayerDatabase, findPlayer } = await import(join(ROOT, 'js/player-database.js'));
const app = await import(join(ROOT, 'js/app.js'));

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

/** A league shaped the way a live auction draft produces one. */
function buildLeague({ picks = 3, unattributed = 0, noDraftOrder = false,
                       draftType = 'auction' } = {}) {
  const db = toPlayerDatabase(projections);
  const board = Object.values(db).sort((a, b) => b.projectedPoints - a.projectedPoints);
  const teams = [{ teamId: 5, teamName: "Mac's Marauders", roster: [], faabRemaining: 122,
                   record: { wins: 0, losses: 0, ties: 0 }, pointsScored: 0, pointsAllowed: 0 }];
  for (let i = 1; i <= 8; i++) {
    if (i === 5) continue;
    teams.push({ teamId: i, teamName: `Team ${i}`, roster: [], faabRemaining: 150,
                 record: { wins: 0, losses: 0, ties: 0 }, pointsScored: 0, pointsAllowed: 0 });
  }
  const selections = [];
  for (let i = 0; i < picks; i++) {
    teams[0].roster.push(board[i].id);
    selections.push({ pick: i + 1, playerId: board[i].id, teamId: 5, bidAmount: 40 });
  }
  for (let i = 0; i < unattributed; i++) {
    selections.push({ pick: picks + i + 1, playerId: board[picks + i].id, teamId: null, bidAmount: 10 });
  }
  return {
    leagueId: 'TEST', leagueName: 'Test', leagueSize: 8, myTeamId: 5,
    scoringFormat: 'PPR', teams, schedule: [], transactionHistory: [],
    rosterSettings: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, 'D/ST': 1, K: 1, BE: 7,
                      startersCount: 9, benchCount: 7 },
    waiverSettings: { faabBudget: 100, waiverType: 'FAAB', processingDays: [] },
    // Shaped like real espn-client output: it always sets draftOrder, and an
    // auction carries a live bid and the room's own max.
    draftState: { draftType, selections, currentPick: picks + unattributed + 1,
                  ...(noDraftOrder ? {} : { draftOrder: teams.map((t) => t.teamId) }),
                  currentNomination: null, currentNominationBid: null,
                  currentNominationMax: null },
    playerDatabase: db,
  };
}

function load(league) {
  written.clear();
  store.state.leagues = { [league.leagueId]: league };
  store.state.currentLeagueId = league.leagueId;
  store.state.playerDatabase = league.playerDatabase;
  store.state.activeTab = 'home';
}

// renderDraftPage was missing from this list, and when added it failed in all
// three scenarios: league.draftState.draftOrder[teamIndex] on a scraped league
// that has no draftOrder. The page a draft assistant exists to draw was the one
// page the smoke test did not draw.
const PAGES = ['renderHomePage', 'renderRosterPage', 'renderMatchupPage',
               'renderChampionshipPage', 'renderAlertsPage', 'renderWaiversPage',
               'renderLeaguePage', 'renderTradesPage', 'renderSettingsPage',
               'renderDraftPage'];

for (const scenario of [
  { name: 'mid-draft, 3 players', opts: { picks: 3 } },
  { name: 'mid-draft, 84 picks unattributed', opts: { picks: 3, unattributed: 84 } },
  { name: 'nothing drafted yet', opts: { picks: 0 } },
  // A DOM-scraped league has no draftOrder. This is the exact shape that made
  // renderDraftPage throw, so it gets its own scenario rather than relying on
  // the fixture happening to omit the field.
  { name: 'scraped league with no draftOrder', opts: { picks: 6, noDraftOrder: true } },
  // A snake league takes an entirely different branch of renderDraftPage.
  { name: 'snake draft', opts: { picks: 6, draftType: 'snake' } },
]) {
  console.log(`\n${scenario.name}`);
  const league = buildLeague(scenario.opts);
  load(league);
  for (const name of PAGES) {
    const fn = app[name];
    if (typeof fn !== 'function') { check(`${name} is exported`, false); continue; }
    let err = null;
    try { fn(league); } catch (e) { err = e; }
    check(`${name} renders`, !err, err && `${err.constructor.name}: ${err.message}`);
  }
  // The card that started this. Blank here means blank on screen.
  const moves = written.get('home-recommendations') || '';
  check('Highest-Impact Moves is not blank', moves.trim().length > 0,
    `got ${moves.length} chars`);
  const champ = written.get('dashboard-champ-prob') || '';
  check('Championship Outlook has a figure', /\d/.test(champ), `got "${champ}"`);
}

console.log('\nan auction the app can only partly see');
{
  // ESPN reports more picks than were read: an auction room renders one team's
  // roster and no results table, so this is its normal state, not an error.
  // The app closes the gap itself by stepping the room's dropdown through the
  // league, so while that can still work the banner must stay OUT of the way.
  // It appears only once scanning has stopped being able to fix it -- because
  // a gap that survives is permanent, and those players will keep being
  // offered as targets while somebody already owns them.
  const league = buildLeague({});
  league.picksMadeOnEspn = 46;
  league.draftState = league.draftState || {};
  league.draftState.selections = [{ playerId: 1 }, { playerId: 2 }];
  load(league);

  const sweep = app.autoSweepState();
  sweep.fruitless = 0;
  let err = null;
  try { app.renderMissingPicksBanner(league); } catch (e) { err = e; }
  check('the banner renders with a partly-read board', !err,
    err && `${err.constructor.name}: ${err.message}`);
  check('it stays quiet while the scan can still close the gap',
    document.getElementById('missing-picks-banner').textContent === '');

  // Two scans that added nothing: the gap is not closable.
  sweep.fruitless = 2;
  app.renderMissingPicksBanner(league);
  const banner = document.getElementById('missing-picks-banner');
  check('once scanning gives up it says how many were read',
    /46 picks; 2 were read/.test(banner.textContent), banner.textContent);
  check('and says scanning could not recover the rest',
    /Scanning every roster did not recover the other 44/.test(banner.textContent),
    banner.textContent);

  // A complete board says nothing at all, whatever the scan history.
  const full = buildLeague({});
  full.picksMadeOnEspn = 2;
  full.draftState = full.draftState || {};
  full.draftState.selections = [{ playerId: 1 }, { playerId: 2 }];
  load(full);
  app.renderMissingPicksBanner(full);
  check('a complete board shows no banner',
    document.getElementById('missing-picks-banner').textContent === '');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
