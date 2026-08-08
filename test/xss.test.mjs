/**
 * A hostile draft payload must not become markup.
 *
 * Run: node test/xss.test.mjs
 *
 * The app builds its UI from template literals and assigns them with innerHTML,
 * and almost everything it interpolates is scraped from the live ESPN room or
 * fetched from a news API. A security audit demonstrated the full chain: a POST
 * to the local sync endpoint of the day, through the real importScrapedPayload,
 * into nine confirmed injection points across five panels. That endpoint is
 * gone; the same chain runs from a forged window message, which is what this
 * file drives.
 *
 * So this drives the REAL mapper and the REAL renderers with a payload carrying
 * markup in every field a manager can choose, and fails if a raw angle bracket
 * survives into any rendered target. It also asserts the payload actually
 * reached the sinks in escaped form -- otherwise "no injections" would pass
 * simply because nothing rendered.
 *
 * Three ways it could not see a sink, all found by a later audit while this
 * file was green, all fixed here:
 *
 *   - the news feed never succeeded. Every fetch stub refused every URL that
 *     was not the projections file, so the live-news branch never ran in any
 *     test in this repo -- esc() could be deleted from three headline sinks
 *     with all fifteen suites passing. A headline is third-party text from an
 *     API this app does not control, which is exactly what this file is for.
 *   - only the DOM-scrape mapper was exercised. A forged sync may set
 *     isDOMScraped:false and take the API mapper instead, with an entirely
 *     attacker-authored teams[], records, budgets and slot counts.
 *   - every created element shared the id 'created', and the recorder is keyed
 *     by id -- so each table row overwrote the last and only the FINAL row was
 *     ever scanned.
 *
 * The lesson from all three is the same one this file's own fixtures keep
 * teaching: a panel that never rendered is not a panel that rendered safely.
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
let createdCount = 0;
const cache = new Map();
const get = (id) => { if (!cache.has(id)) cache.set(id, mk(id)); return cache.get(id); };
globalThis.document = {
  body: mk('body'), documentElement: mk('html'),
  getElementById: get, querySelector: get, querySelectorAll: () => [],
  // Every created element gets its own id. They all shared the id 'created',
  // and `written` is keyed by id -- so each row of a table overwrote the last
  // and only the FINAL row was ever scanned. A hostile value in any earlier row
  // was invisible, which is how a raw `${t.record.wins}` in the standings
  // passed: the hostile team was not the last one rendered.
  createElement: () => mk(`created:${++createdCount}`), addEventListener() {},
};
globalThis.window = globalThis;
globalThis.setInterval = () => 0;
globalThis.setTimeout = (fn) => { try { fn(); } catch (e) { /* reported by the page */ } return 0; };
process.on('unhandledRejection', () => {});

const projections = JSON.parse(readFileSync(join(ROOT, 'data/projections-2026.json'), 'utf8'));

// A SUCCEEDING news feed, carrying the hostile string.
//
// Every fetch stub in this repo's tests refused every non-projections URL, so
// the live-news branch of renderAlertsPage never executed in any run -- the
// "News feed failed:" stack printed on every npm test was the visible symptom.
// A mutation run proved the cost: esc() could be deleted from three headline
// sinks and all fifteen suites stayed green. A headline is third-party text
// from an API this app does not control, which is exactly what this file is
// for, and it was the one input the file could not see.
const NEWS_TAG = '<img src=x onerror=alert(1)>';
const hostileNews = {
  articles: [
    {
      headline: `Josh Allen ruled out ${NEWS_TAG}`,
      description: `Bills quarterback Josh Allen is out for Week 1 ${NEWS_TAG}`,
      published: '2026-08-07T12:00:00Z',
      categories: [{ type: 'athlete', description: 'Josh Allen' },
                   { type: 'team', description: `Buffalo Bills ${NEWS_TAG}` }],
      links: { web: { href: `https://espn.com/${NEWS_TAG}` } },
    },
    {
      headline: `Bijan Robinson expected to start ${NEWS_TAG}`,
      description: `Falcons running back returns to practice ${NEWS_TAG}`,
      published: '2026-08-07T11:00:00Z',
      categories: [{ type: 'athlete', description: 'Bijan Robinson' }],
      links: { web: { href: 'https://espn.com/x' } },
    },
  ],
};
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('projections')) return { ok: true, json: async () => projections };
  if (u.includes('/news')) return { ok: true, json: async () => hostileNews };
  if (u.includes('trending')) return { ok: true, json: async () => [] };
  if (u.includes('players/nfl')) return { ok: true, json: async () => ({}) };
  throw new Error('network disabled in tests');
};

const { default: store } = await import(join(ROOT, 'js/store.js'));
const { default: espnClient, realDbReady } = await import(join(ROOT, 'js/espn-client.js'));
await realDbReady;
const app = await import(join(ROOT, 'js/app.js'));
// The escaper itself, asserted directly rather than inferred from a sink.
const { esc, attr } = await import(join(ROOT, 'js/escape.js'));

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const TAG = '<img src=x onerror=alert(1)>';
// Breaks out of a JS string inside an HTML attribute — the shape that made the
// old inline onclick handlers exploitable.
const BREAK = `X'); alert(document.domain); //`;

// The team id is hostile too. It is interpolated into `<option value="...">`
// in the auction panel -- attribute position, where a lone quote ends the
// attribute and starts a new one -- and only a hostile id can prove that sink.
// It has to match myTeamId, or the panel draws the "which team is yours?"
// prompt instead and the select is never built.
// A hostile team id, on the RIVAL rather than on us. It is interpolated into
// `<option value="...">` in the auction panel -- attribute position, where a
// lone quote ends the attribute and starts a new one -- and only a hostile id
// can prove that sink. It cannot be ours: the mapper refuses a non-numeric
// myTeamId, correctly, so a hostile id there would leave the panel drawing the
// "which team is yours?" prompt and the select never built at all.
const HOSTILE_ID = `2${BREAK}`;

const payload = {
  isDOMScraped: true, leagueId: '666', leagueName: `League ${TAG}`, myTeamId: 1,
  teams: [
    { teamId: 1, teamName: `Me ${TAG}`, faabRemaining: 100 },
    { teamId: HOSTILE_ID, teamName: `Rival "${TAG}`, faabRemaining: 100 },
  ],
  draftDetail: { picks: [
    { overallPickNumber: 1, playerName: `${TAG} Guy`, playerPosition: 'RB', playerTeam: 'ATL', drafterTeamId: 1, bidAmount: 10 },
    { overallPickNumber: 2, playerName: BREAK, playerPosition: 'WR', playerTeam: 'LAR', drafterTeamId: HOSTILE_ID, bidAmount: 5 },
  ] },
  currentNomination: { name: `${TAG} Nominee`, team: 'BUF', position: 'QB', bid: 5 },
  // A schedule, because two real injection sinks live behind one.
  //
  // renderHomePage's matchup card (match-my-name / match-opp-name) and the
  // championship action plan only draw when the league has fixtures. With no
  // schedule in this payload, neither branch ever executed -- so the suite
  // reported "no rendered target contains raw injected markup" while both were
  // rendering a hostile team name verbatim. A panel that never rendered is not
  // a panel that rendered safely, and the assertion could not tell them apart.
  schedule: [
    { week: 1, team1Id: 1, team2Id: HOSTILE_ID, team1Score: 0, team2Score: 0, completed: false },
    { week: 2, team1Id: HOSTILE_ID, team2Id: 1, team1Score: 0, team2Score: 0, completed: false },
  ],
};

console.log('\nevery page renders a hostile payload');
await espnClient.importScrapedPayload(payload);
const league = store.getActiveLeague();
// Set on the imported league, not in the payload: the DOM-scrape mapper builds
// its own league object and drops a `schedule` it was handed, so putting one in
// the payload left both schedule-gated sinks unreachable and the suite went on
// reporting them clean.
league.schedule = [
  { week: 1, team1Id: 1, team2Id: HOSTILE_ID, team1Score: 0, team2Score: 0, completed: false },
  { week: 2, team1Id: HOSTILE_ID, team2Id: 1, team1Score: 0, team2Score: 0, completed: false },
];
// The mapper zeroes every record, so the hostile one is set on the league the
// pages actually render. One real record and one hostile: the standings only
// draw the record column once a game has been played, so a payload where every
// record is a hostile string leaves that branch -- and the raw interpolation
// that used to be in it -- unreachable.
league.teams[0].record = { wins: 2, losses: 2, ties: 0 };
if (league.teams[1]) league.teams[1].record = { wins: `3${TAG}`, losses: `1${TAG}`, ties: 0 };
store.state.activeTab = 'home';

// renderDraftPage included: its entire content is attacker-controllable
// scrape output, and it was the one page never checked for injection.
const PAGES = ['renderHomePage', 'renderRosterPage', 'renderMatchupPage',
               'renderDraftPage',
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

console.log('\nthe live news feed reaches the page, and is escaped');
{
  // renderAlertsPage fetches in the background and paints when it resolves, so
  // the assertion has to wait for it. Without this the panel is empty at the
  // moment of the check and a raw headline is invisible.
  written.clear();
  app.renderAlertsPage(league);
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise((r) => process.nextTick(r));
  for (let i = 0; i < 50; i++) await Promise.resolve();

  const all = [...written.values()].join('\n');
  check('the feed actually rendered', all.includes('Josh Allen'),
    `${written.size} targets written, none carrying a headline`);
  check('and its markup did not survive raw', !all.includes('<img src=x'),
    [...written.entries()].filter(([, h]) => h.includes('<img src=x')).map(([id]) => id).join(', '));
  check('the headline reached the sink, escaped', all.includes('&lt;img src=x'));
}

console.log('\nthe JSON mapper path is hostile too');
{
  // Everything above enters through the DOM-scrape mapper. A forged sync may
  // set isDOMScraped:false and take the API mapper instead -- an entirely
  // attacker-authored teams[], records, budgets and slot counts, none of which
  // pass through the scraper's constraints. Six sinks were proven raw this way
  // while this file was green.
  written.clear();
  const apiPayload = {
    id: '667',
    settings: {
      name: `API ${TAG}`, size: 2,
      rosterSettings: { lineupSlotCounts: { 0: `1${TAG}`, 2: 2, 4: 2, 6: 1, 20: 7 } },
      scheduleSettings: {}, scoringSettings: {},
      restrictionSettings: { waiverBudget: `100${TAG}` },
    },
    // Hostile on BOTH teams, and in the id as well as the name: an id is
    // interpolated into `<option value="...">`, which is attribute position,
    // and a record only reaches the standings for the team that holds it.
    teams: [
      { id: `1${TAG}`, location: 'Me', nickname: TAG,
        transactionCounter: { remainingBudget: `100${TAG}` },
        record: { overall: { wins: `0${TAG}`, losses: `0${TAG}`, ties: 0, pointsFor: 0 } },
        roster: { entries: [{ playerPoolEntry: { player: {
          id: 4001, fullName: `${TAG} Guy`, defaultPositionId: 2, proTeamId: 1 } } }] } },
      { id: `2${BREAK}`, location: 'Rival', nickname: `"${TAG}`,
        transactionCounter: { remainingBudget: `90${TAG}` },
        record: { overall: { wins: `1${TAG}`, losses: `2${TAG}`, ties: 0, pointsFor: 0 } },
        roster: { entries: [{ playerPoolEntry: { player: {
          id: 4002, fullName: BREAK, defaultPositionId: 3, proTeamId: 2 } } }] } },
    ],
    schedule: [],
  };
  const apiLeague = espnClient.mapESPNLeague(apiPayload);
  apiLeague.myTeamId = apiLeague.teams[0].teamId;
  apiLeague.schedule = [
    { week: 1, team1Id: apiLeague.teams[0].teamId, team2Id: apiLeague.teams[1].teamId,
      team1Score: 0, team2Score: 0, completed: false },
  ];
  store.state.leagues[apiLeague.leagueId] = apiLeague;
  store.state.currentLeagueId = apiLeague.leagueId;

  for (const name of PAGES) {
    let err = null;
    try { app[name](apiLeague); } catch (e) { err = e; }
    check(`${name} survives the JSON path`, !err, err && `${err.constructor.name}: ${err.message}`);
  }
  const raw = [...written.entries()].filter(([, h]) => h.includes('<img src=x') || h.includes(BREAK));
  check('no rendered target contains raw injected markup', raw.length === 0,
    raw.map(([id]) => id).join(', '));
  const escapedHits = [...written.values()].filter((h) => h.includes('&lt;img src=x')).length;
  check('the payload did reach the sinks, escaped', escapedHits > 0,
    `${escapedHits} escaped occurrences across ${written.size} targets`);

  // Not reachable from here, and deliberately recorded rather than left
  // looking covered: the trade panel's negotiation lines interpolate player
  // NAMES, and a hostile name never resolves to a real player, so it is valued
  // at replacement level -- below the 12-point floor the trade engine requires.
  // Those sinks are escaped as defence in depth; this fixture cannot prove it.

  // Attribute context specifically: a lone quote there ends the attribute and
  // starts a new one, which no between-tags check can see.
  const ATTR_BREAK = /<[a-zA-Z][^>]*=["'][^"']*["'][a-z-]+=/;
  const broken = [...written.entries()].filter(([, h]) => ATTR_BREAK.test(h));
  check('no value breaks out of an attribute', broken.length === 0,
    broken.map(([id]) => id).join(', '));

  store.state.leagues[league.leagueId] = league;
  store.state.currentLeagueId = league.leagueId;
}


console.log('\nesc() escapes every character it claims to');
{
  // Inferred from sinks before, and only for angle brackets: dropping the
  // quote, apostrophe, backtick and ampersand escapes each passed the whole
  // suite, because the attribute-break payload never reached a recorded sink
  // so nothing noticed it was unescaped. Asserted directly now.
  const cases = [
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
    ['`', '&#96;'],
  ];
  cases.forEach(([raw, want]) => {
    check(`esc(${JSON.stringify(raw)}) is ${want}`, esc(raw) === want, esc(raw));
  });

  // The null contract, which nothing pinned: `return ''` could become
  // `return 'null'` with the suite green, and every optional field in every
  // template would then render the word "null" where a blank belongs.
  check('esc(null) is empty', esc(null) === '', JSON.stringify(esc(null)));
  check('esc(undefined) is empty', esc(undefined) === '', JSON.stringify(esc(undefined)));
  check('esc(0) is "0", not empty', esc(0) === '0', JSON.stringify(esc(0)));
  check('esc(false) is "false"', esc(false) === 'false', JSON.stringify(esc(false)));

  // num()/int() are the numeric half of the same contract, and they were dead
  // code with a docstring in escape.js claiming every figure went through them.
  const { num, int } = await import(join(ROOT, 'js/escape.js'));
  check('num() renders a figure', num(12.34) === '12.3', num(12.34));
  check('num() refuses a hostile string', num(TAG) === '—', num(TAG));
  check('num() refuses null rather than printing it', num(null) === '—', num(null));
  check('int() rounds', int(12.6) === '13', int(12.6));
  check('int() refuses a hostile string', int(TAG) === '—', int(TAG));
  check('and neither can emit markup',
    !/[<>]/.test(String(num(TAG)) + String(int(TAG)) + String(num('<b>'))));
  // Ampersand first, or the escapes escape each other's output.
  check('esc does not double-escape its own output',
    esc('<') === '&lt;' && esc('&lt;') === '&amp;lt;');
  check('attr escapes as strictly as esc', attr === esc || attr('"') === '&quot;');
}

console.log('\nthe audit report is built from the same escaper as the app');
{
  // audit-report.html is generated from history.json, which five agents write
  // to every round -- titles, evidence and fix text straight out of a model.
  // The generator had its own three-character escaper that left ' and ` alone,
  // which is the drift js/escape.js exists to prevent, and a dozen numeric
  // sinks were interpolated raw on the grounds that a score is a number.
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { execFileSync } = await import('child_process');
  const dir = mkdtempSync(join(tmpdir(), 'gridiron-audit-'));
  mkdirSync(join(dir, 'audit'));
  mkdirSync(join(dir, 'js'));
  cpSync(join(ROOT, 'audit/build-report.mjs'), join(dir, 'audit/build-report.mjs'));
  cpSync(join(ROOT, 'js/escape.js'), join(dir, 'js/escape.js'));

  const cat = () => ({
    score: TAG, findings: [{ severity: TAG, title: TAG, where: TAG, evidence: TAG, fix: TAG }],
    justification: TAG, verified: TAG, notChecked: TAG,
  });
  writeFileSync(join(dir, 'audit/history.json'), JSON.stringify({
    rounds: [{
      round: TAG, date: TAG, commit: TAG,
      categories: { security: cat(), tests: cat(), performance: cat(),
                    documentation: cat(), readability: cat() },
    }],
  }));
  execFileSync(process.execPath, [join(dir, 'audit/build-report.mjs')], { stdio: 'ignore' });
  const out = readFileSync(join(dir, 'audit-report.html'), 'utf8');
  check('a hostile history file opens no tag of its own',
    !/<img|<script/i.test(out), (out.match(/<(img|script)[^>]*>/i) || [''])[0]);
  // ...and it reached the page, so the check above is not passing on an empty
  // render. `onerror=` as literal text is the escaped payload, not a sink.
  check('and the payload did reach the page, escaped',
    out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  check('and the generator defines no escaper of its own',
    !/replace\(\/&\/g/.test(readFileSync(join(ROOT, 'audit/build-report.mjs'), 'utf8')));
  // A score is not a number just because it is meant to be one: history.json is
  // JSON we did not write, and every score sink took it verbatim.
  check('a score that is not a number renders as a dash, not as markup',
    out.includes('>—<') || out.includes('—/100'), 'no numeric fallback reached the page');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
