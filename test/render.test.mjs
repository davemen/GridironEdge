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
      // Writing innerHTML REPLACES the elements inside, as it does in a
      // browser: an input in that markup is a new node with the value the
      // markup gives it, not the node the user was typing in. Without this the
      // stub kept handing back the same object with the same `.value`, so
      // "the typed bid survived the re-render" passed whether or not anything
      // preserved it -- the exact shape of a test passing for the wrong reason.
      replaceInputs(String(v));
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
    // Backed by a map. getAttribute returning null unconditionally meant every
    // read-back branch took its false side forever.
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k)
      ? this._attrs[k] : null; },
    // One element per selector, cached. Returning a fresh child for every call
    // collided a tbody and a thead row on one key, so the standings body was
    // destroyed by the header write and the rows were never seen.
    _children: {},
    querySelector(sel) {
      if (!this._children[sel]) this._children[sel] = makeEl(`${id}:${sel}`);
      return this._children[sel];
    },
    querySelectorAll: () => [],
    closest: () => null,
    focus() { globalThis.document.activeElement = this; },
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    selectionStart: 0, selectionEnd: 0,
  };
  el.parentElement = { parentElement: { appendChild() {} }, appendChild() {} };
  return el;
}
const elCache = new Map();

/**
 * Ids this stub pretends do not exist.
 *
 * getElementById created an element for every id ever asked for, so it never
 * returned null -- and the app has 118 null guards plus several
 * create-if-absent branches (the dashboard caveat, the missing-picks banner)
 * whose false side had therefore never executed in any test. A stub that
 * always says yes cannot see the difference between "handled" and "would have
 * thrown".
 */
const absent = new Set();
const getEl = (id) => {
  if (absent.has(id)) return null;
  if (!elCache.has(id)) elCache.set(id, makeEl(id));
  return elCache.get(id);
};

/**
 * Re-create every element the freshly written markup declares.
 *
 * Only ids that are already known are touched, so this models replacement
 * rather than pretending to be a parser.
 */
function replaceInputs(html) {
  const tag = /<(input|select|textarea)\b[^>]*\bid="([^"]+)"[^>]*>/g;
  let m;
  while ((m = tag.exec(html)) !== null) {
    const [whole, , elId] = m;
    if (!elCache.has(elId)) continue;
    const fresh = makeEl(elId);
    const val = /\bvalue="([^"]*)"/.exec(whole);
    fresh.value = val ? val[1] : '';
    elCache.set(elId, fresh);
    if (globalThis.document && globalThis.document.activeElement
        && globalThis.document.activeElement.id === elId) {
      // The node it pointed at no longer exists. A browser moves focus to the
      // body; what matters here is that it is no longer this input.
      globalThis.document.activeElement = null;
    }
  }
}
globalThis.document = {
  body: makeEl('body'), documentElement: makeEl('html'),
  getElementById: (id) => getEl(id),
  querySelector: (sel) => getEl(sel), querySelectorAll: () => [],
  createElement: () => makeEl('created'), addEventListener() {},
};
globalThis.window = globalThis;
globalThis.setInterval = () => 0;
// setTimeout does NOT swallow. It used to catch and drop, so an undeclared
// identifier inside a timer callback -- a ReferenceError at render time, which
// is the exact bug this file exists to catch and the one its header describes
// -- exited 0. Proven by injecting one into a copy of the tree.
globalThis.setTimeout = (fn) => { fn(); return 0; };

const projections = JSON.parse(readFileSync(join(ROOT, 'data/projections-2026.json'), 'utf8'));
globalThis.fetch = async (url) => {
  if (String(url).includes('projections')) return { ok: true, json: async () => projections };
  // No network in a test: news and sync endpoints simply fail, which is a state
  // the pages have to survive anyway.
  throw new Error('network disabled in tests');
};

// The pages fire background fetches (news, sync) that are meant to fail here,
// and their rejections are handled inside the app. But this handler was
// unfiltered, so it also swallowed a genuine async ReferenceError -- one
// injected into fetchLiveBreakingNews exited 0 with no output. Only the
// expected failure is tolerated; anything else fails the run.
const EXPECTED_REJECTION = /network disabled in tests/;
process.on('unhandledRejection', (err) => {
  const message = (err && err.message) || String(err);
  if (EXPECTED_REJECTION.test(message)) return;
  console.log(`  FAIL an unhandled rejection escaped — ${message}`);
  process.exitCode = 1;
});

const { default: store } = await import(join(ROOT, 'js/store.js'));
const { toPlayerDatabase, findPlayer, dbRevision } = await import(join(ROOT, 'js/player-database.js'));
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
  // Everybody drafts, because in a real draft everybody drafts.
  //
  // This gave picks only to team 5 and left the other seven with nothing, which
  // is not a mid-draft league -- it is the one-readable-roster board an auction
  // scrape produces, and the odds engines now decline on it rather than scoring
  // seven teams they cannot see. So every assertion below that expects a figure
  // was expecting one computed from teams that did not exist.
  if (picks > 0) {
    teams.slice(1).forEach((t, ti) => {
      for (let i = 0; i < picks; i++) {
        const p = board[60 + ti * 12 + i];
        if (!p) continue;
        t.roster.push(p.id);
        selections.push({ pick: selections.length + 1, playerId: p.id,
                          teamId: t.teamId, bidAmount: 12 });
      }
    });
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

console.log('\nthe boot refresh tells the database it changed');
{
  // At boot the app renders from stored state, then the real projections
  // resolve and refreshStoredDatabase rewrites every stored record IN PLACE,
  // inserts the missing ones and deletes resolved stubs. All three leave a
  // stale index and a stale auction board unless the database says so -- and a
  // replace does not change the key count, so nothing downstream can notice by
  // counting.
  const league = buildLeague({ picks: 3 });
  const db = league.playerDatabase;
  const real = {};
  Object.keys(db).slice(0, 30).forEach((id) => {
    real[id] = { ...db[id], projectedPoints: db[id].projectedPoints + 100 };
  });
  const before = dbRevision(league.playerDatabase);
  store.state.leagues = { [league.leagueId]: league };
  app.refreshStoredDatabase(real);
  check('a replace-in-place bumps the revision',
    dbRevision(league.playerDatabase) > before,
    `${before} -> ${dbRevision(league.playerDatabase)}`);
  check('and the new projection is what is stored',
    league.playerDatabase[Object.keys(real)[0]].projectedPoints
      === real[Object.keys(real)[0]].projectedPoints);

  // A stub healed into a real player is a DELETE, which also cannot be seen by
  // counting -- the count goes down as another goes up.
  const withStub = buildLeague({ picks: 3 });
  const target = Object.values(withStub.playerDatabase)
    .find((p) => p.position === 'RB' && p.name);
  const stubId = `MOCK_${target.name.toLowerCase().replace(/\s+/g, '_')}`;
  withStub.playerDatabase[stubId] = { id: stubId, name: target.name,
    position: target.position, team: target.team, projectedPoints: 4.5 };
  withStub.teams[0].roster.push(stubId);
  store.state.leagues = { [withStub.leagueId]: withStub };
  const rev = dbRevision(withStub.playerDatabase);
  app.refreshStoredDatabase({ [target.id]: target });
  check('healing a stub removes it', !withStub.playerDatabase[stubId]);
  check('and bumps the revision too', dbRevision(withStub.playerDatabase) > rev,
    `${rev} -> ${dbRevision(withStub.playerDatabase)}`);
}

console.log("\nthe roster panel counts the league's OWN starting slots");
{
  // openStarterSlots takes the league's settings, and the argument is
  // optional -- which is exactly how four engines came to be computing with the
  // standard shape while the module claimed to be settings-aware. A display
  // helper that drops it is invisible unless something asserts on a league that
  // is not standard.
  const league = buildLeague({ picks: 0 });
  const db = league.playerDatabase;
  const board = Object.values(db).sort((a, b) => b.projectedPoints - a.projectedPoints);
  const two = (pos) => board.filter((p) => p.position === pos).slice(0, 2).map((p) => p.id);
  const team = { teamId: 5, teamName: 'T', roster: [...two('WR')] };

  league.rosterSettings = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, 'D/ST': 1, K: 1,
                            startersCount: 9, benchCount: 7 };
  check('with two receivers, a 2-WR league still wants one for the flex',
    /WR/.test(app.rosterNeedFor(team, league)), app.rosterNeedFor(team, league));

  league.rosterSettings = { ...league.rosterSettings, WR: 3, startersCount: 10 };
  const three = app.rosterNeedFor(team, league);
  check('a 3-WR league still wants receivers with two on the roster',
    /WR/.test(three), three);

  // The case that separates them: three receivers fills a 3-WR lineup's fixed
  // slots but not its flex, and fills a 2-WR lineup's slots AND flex.
  const team3 = { teamId: 5, teamName: 'T',
                  roster: board.filter((p) => p.position === 'WR').slice(0, 3).map((p) => p.id) };
  league.rosterSettings = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, 'D/ST': 1, K: 1,
                            startersCount: 9, benchCount: 7 };
  const need2 = app.rosterNeedFor(team3, league);
  league.rosterSettings = { ...league.rosterSettings, WR: 3, startersCount: 10 };
  const need3 = app.rosterNeedFor(team3, league);
  check('three receivers read differently in a 2-WR and a 3-WR league',
    need2 !== need3, `both said "${need2}"`);
  check('and the 2-WR league no longer wants a receiver', !/WR/.test(need2), need2);
  check('while the 3-WR league still does', /WR/.test(need3), need3);
}

console.log('\na board the app can only half see shows no odds');
{
  // The engines decline rather than scoring teams they cannot read. Both
  // dashboards must show that, because a percentage cannot carry "we could not
  // see the other nine rosters" -- and this is the ordinary state of an auction
  // scrape, where the room renders one roster at a time.
  const half = buildLeague({ picks: 6 });
  half.teams.forEach((t) => { if (t.teamId !== 5) t.roster = []; });
  half.draftState.selections = half.draftState.selections.filter((sel) => sel.teamId === 5);
  load(half);
  app.renderHomePage(half);
  const champ = written.get('dashboard-champ-prob') || '';
  check('the dashboard shows a dash, not a figure', champ.trim() === '—', `got "${champ}"`);
  const caveat = written.get('dashboard-caveat') || '';
  check('and says why', /no roster the app can read/i.test(caveat), caveat.slice(0, 90));

  app.renderChampionshipPage(half);
  const plan = written.get('sim-action-plan') || '';
  check('the championship page says so too',
    /nothing to compare|no roster the app can read/i.test(plan), plan.slice(0, 90));

  // And the ordinary case is unaffected.
  const whole = buildLeague({ picks: 6 });
  load(whole);
  app.renderHomePage(whole);
  check('a readable board still shows a figure',
    /\d/.test(written.get('dashboard-champ-prob') || ''),
    written.get('dashboard-champ-prob'));
}

console.log('\nevery page survives an element that is not there');
{
  // index.html and js/app.js drift: a renamed container, or a panel not yet
  // added to the markup, gives getElementById(null) -- and the guard for that
  // is the branch this stub could never reach.
  const league = buildLeague({ picks: 6 });
  load(league);

  // Every id the app asks for, gathered by watching a clean render.
  const asked = new Set();
  const realGet = globalThis.document.getElementById;
  globalThis.document.getElementById = (id) => { asked.add(id); return realGet(id); };
  for (const name of PAGES) { try { app[name](league); } catch (e) { /* recorded below */ } }
  globalThis.document.getElementById = realGet;
  check('the pages ask for containers by id', asked.size > 20, `${asked.size} ids`);

  // The branches that exist BECAUSE an element may be absent -- the app builds
  // these itself when the markup does not carry them. Their false side had
  // never run, because the stub always said yes.
  const CREATED_ON_DEMAND = ['dashboard-caveat', 'missing-picks-banner'];
  for (const id of CREATED_ON_DEMAND) {
    absent.add(id);
    let err = null;
    try {
      app.renderHomePage(league);
      if (app.renderMissingPicksBanner) app.renderMissingPicksBanner(league);
    } catch (e) { err = e; }
    absent.delete(id);
    check(`a missing ${id} is created rather than thrown on`, !err,
      err && `${err.constructor.name}: ${err.message}`);
  }

  // How much of the rest is unguarded, measured rather than asserted. The app
  // does not claim every container is optional -- index.html ships all of them
  // -- but the number is worth knowing, and worth not growing.
  let unguarded = 0;
  for (const id of asked) {
    absent.add(id);
    for (const name of PAGES) {
      try { app[name](league); } catch (e) { unguarded++; break; }
    }
    absent.delete(id);
  }
  console.log(`  note ${unguarded} of ${asked.size} container ids take a page `
    + 'down if index.html stops carrying them');
  check('and it is not getting worse', unguarded <= 40, `${unguarded} unguarded`);
}

console.log('\na bid being typed survives the next sync');
{
  // The recommendation panel is rebuilt by innerHTML on every sync -- up to
  // eight a second in a live auction -- which destroys and recreates the bid
  // input. A typed override reverted to the scraped figure on the next tick.
  const auction = buildLeague({ picks: 12, draftType: 'auction' });
  auction.draftState.currentNomination = 'Josh Allen';
  auction.draftState.currentNominationBid = 4;
  load(auction);
  app.renderDraftPage(auction);

  const bid = getEl('auction-current-bid');
  bid.value = '37';
  bid.focus();
  check('the user is typing in the bid box', document.activeElement === bid);

  app.renderDraftPage(auction);
  check('the typed bid survives a re-render', getEl('auction-current-bid').value === '37',
    `became "${getEl('auction-current-bid').value}" -- the scraped figure won`);

  // And when nobody is typing, the scrape is still allowed to update it.
  document.activeElement = null;
  auction.draftState.currentNominationBid = 9;
  app.renderDraftPage(auction);
  check('and the scrape still updates it when nobody is typing',
    getEl('auction-current-bid').value !== '37',
    'the box is now stuck on a stale value instead');
}

console.log('\nthe board of who is left renders in both draft types');
{
  // renderDraftPage used to return as soon as it had drawn the auction panel,
  // so the players table below it was never filled in an auction -- it kept
  // whatever a previous snake render had left, or stayed empty. The pricing
  // block was guarded on draftType === 'auction' AND sat after that return, so
  // it could not run at all: the Target Value column was an em dash in every
  // row of every render, which reads exactly like "we have no price for him".
  const tbody = getEl('draft-player-table-body');
  const header = getEl('draft-target-value-col');

  const auction = buildLeague({ picks: 12, draftType: 'auction' });
  load(auction);
  app.renderDraftPage(auction);
  const auctionRows = tbody.children.length;
  check('an auction fills the players table', auctionRows > 0, `${auctionRows} rows`);
  const priced = tbody.children.filter((r) => /\$\d/.test(r._text || '')).length;
  check('and prices the rows the watchlist covers', priced > 0,
    `0 of ${auctionRows} rows carry a price -- the column is dead again`);
  check('the Target Value column is shown in an auction', header.style.display === '');

  const snake = buildLeague({ picks: 6, draftType: 'snake' });
  load(snake);
  app.renderDraftPage(snake);
  check('a snake draft fills the players table', tbody.children.length > 0,
    `${tbody.children.length} rows`);
  // A dollar ceiling has no meaning without an auction, and a column of dashes
  // reads as missing data rather than as a column that does not apply.
  check('and hides the Target Value column', header.style.display === 'none',
    `display is "${header.style.display}"`);
  const snakePriced = tbody.children.filter((r) => /\$\d/.test(r._text || '')).length;
  check('and shows no dollar figure anywhere', snakePriced === 0, `${snakePriced} rows priced`);
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
