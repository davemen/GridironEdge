/**
 * Run the REAL scraper from the shipped content script against fake draft rows.
 *
 * Run: node test/scraper.test.mjs
 *
 * Nothing else in the suite touches the extension, so every scraper change went
 * out unexecuted -- and one of them called .add() on what had become a Map. That
 * threw on the first row, the function's catch swallowed it, and the app
 * reported "102 picks made, 0 were read" with nothing to go on. Reading the code
 * had not caught it across several passes; running it catches it immediately.
 *
 * The rows below are copied verbatim from a live draft room, including the
 * duplicate panel entries that made a defense lose its owner.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'chrome-extension/content-main.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const ROWS = [
  "30\nBroncos D/ST\nDEN\nD/ST\nMac's Marauders\n144\n130.7\n$1",
  'Broncos D/ST\nDEN\nD/ST',
  'Broncos D/ST',
  "70\nTexans D/ST\nHOU\nD/ST\nMac's Marauders\n173\n128\n$1",
  'Texans D/ST\nHOU\nD/ST',
  '74\nSteelers D/ST\nPIT\nD/ST\nTeam 1\n113\n126.3\n$1',
  "1\nJosh Allen\nBUF\nQB\nMac's Marauders\n120\n387.9\n$19",
  "2\nBijan Robinson\nATL\nRB\nMac's Marauders\n99\n391.9\n$49",
  '3\nMike Evans Q\nSF\nWR\nTeam 3\n88\n210.1\n$3',
];
const mkEl = (text) => ({ innerText: text, children: [], tagName: 'DIV' });
const container = {
  innerText: 'Round 1 PLAYER TEAM PROJ PTS\n' + ROWS.join('\n'),
  children: ROWS.map(mkEl),
  querySelectorAll: () => ROWS.map(mkEl),
};
globalThis.setInterval = () => 0;
globalThis.setTimeout = () => 0;
globalThis.addEventListener = () => {};
globalThis.postMessage = () => {};
globalThis.window = globalThis;
globalThis.window.addEventListener = () => {};
globalThis.window.postMessage = () => {};
globalThis.document = {
  body: { innerText: 'PK 10 OF 128' },
  querySelectorAll: () => [container],
  querySelector: () => container,
  title: 'Fantasy Football Draft - ESPN',
};
globalThis.location = { href: 'https://fantasy.espn.com/football/draft?leagueId=1962034705', pathname: '/football/draft', search: '?leagueId=1962034705' };

// Expose the two functions under test without running the polling loop.
const i = src.indexOf('(function');
const j = src.lastIndexOf('})();');
const body = src.slice(src.indexOf('\n', i) + 1, j);
const fn = new Function(`${body}\nreturn { scrapeDraftDOM, findDraftSummaryContainer, findTeamSelectName, findLeagueTeamNames, scrapeRosterPanel };`);
const { scrapeDraftDOM, findDraftSummaryContainer, findTeamSelectName,
        findLeagueTeamNames, scrapeRosterPanel } = fn();

console.log('\nthe scraper runs at all');
const picks = scrapeDraftDOM() || [];
check('it did not throw', !globalThis.__GRIDIRON_EDGE_SCRAPE_ERROR__,
  globalThis.__GRIDIRON_EDGE_SCRAPE_ERROR__);
check('it parsed every distinct pick', picks.length === 6, `got ${picks.length}`);

console.log('\nthe duplicate panel rows do not cost a pick its owner');
const by = (n) => picks.find((p) => p.playerName === n);
// A defense appears in the results table AND as a bare roster-panel entry. The
// panel row has no pick number and no drafter; keeping it lost the owner.
['Broncos', 'Texans'].forEach((n) => {
  const p = by(n);
  check(`${n} kept the row with a drafter`,
    Boolean(p) && p.drafterTeamName === "Mac's Marauders",
    p && p.drafterTeamName);
  check(`${n} kept its real pick number`,
    Boolean(p) && p.overallPickNumber > 1, p && String(p.overallPickNumber));
  check(`${n} is a defense with its NFL team`,
    Boolean(p) && p.playerPosition === 'D/ST' && p.playerTeam !== 'FA',
    p && `${p.playerPosition} ${p.playerTeam}`);
});
check('another manager keeps his own defense',
  by('Steelers') && by('Steelers').drafterTeamName === 'Team 1');
check('a defense is never counted twice',
  picks.filter((p) => p.playerName === 'Broncos').length === 1);

console.log('\nordinary rows still parse');
check('a skill player keeps his team and price',
  by('Josh Allen') && by('Josh Allen').playerTeam === 'BUF'
    && by('Josh Allen').bidAmount === 19);
check('an injury tag does not break the name',
  Boolean(by('Mike Evans Q')));

console.log('\nthe best row wins whatever order the DOM gives them');
{
  // The fixture above lists the full results row BEFORE the bare panel rows,
  // so first-wins and best-wins pick the same row and the suite could not tell
  // them apart -- reverting the dedupe to first-wins passed all 30 checks. The
  // bug it guards against had the panel row first, which is the ordering here.
  const PANEL_FIRST = [
    'Broncos D/ST',
    'Broncos D/ST\nDEN\nD/ST',
    "30\nBroncos D/ST\nDEN\nD/ST\nMac's Marauders\n144\n130.7\n$1",
    'Texans D/ST\nHOU\nD/ST',
    "70\nTexans D/ST\nHOU\nD/ST\nMac's Marauders\n173\n128\n$1",
    // A third priced row: findDraftSummaryContainer needs three dollar figures
    // before it will accept a block as an auction results table, so that a lone
    // budget label cannot pass for one.
    "1\nJosh Allen\nBUF\nQB\nMac's Marauders\n120\n387.9\n$19",
  ];
  const panelFirst = {
    innerText: 'PLAYER TEAM POS DRAFTED BY COST\n' + PANEL_FIRST.join('\n'),
    children: PANEL_FIRST.map(mkEl),
    querySelectorAll: () => PANEL_FIRST.map(mkEl),
  };
  globalThis.document.querySelectorAll = () => [panelFirst];
  globalThis.document.querySelector = () => panelFirst;

  const out = scrapeDraftDOM() || [];
  const den = out.find((p) => p.playerName === 'Broncos');
  const hou = out.find((p) => p.playerName === 'Texans');
  check('the richer row wins even when the bare one came first',
    Boolean(den) && den.drafterTeamName === "Mac's Marauders",
    den && String(den.drafterTeamName));
  check('and it keeps the real pick number',
    Boolean(den) && den.overallPickNumber === 30, den && String(den.overallPickNumber));
  check('the same holds for the second defense',
    Boolean(hou) && hou.drafterTeamName === "Mac's Marauders"
      && hou.overallPickNumber === 70,
    hou && `${hou.drafterTeamName} @ ${hou.overallPickNumber}`);
  check('neither is counted twice',
    out.filter((p) => p.playerName === 'Broncos').length === 1);

  globalThis.document.querySelectorAll = () => [container];
  globalThis.document.querySelector = () => container;
}

console.log('\nan auction results table is found at all');
{
  // The header above is a snake's ("Round 1 ... PROJ PTS"), which is the only
  // shape this suite ever exercised -- so a container check that demanded the
  // literal "Round 1" passed every test while being unable to see an auction
  // room. An auction has no rounds; it has a column of prices.
  const AUCTION_HEADER = 'PLAYER TEAM POS DRAFTED BY COST';
  const withText = (text) => ({
    innerText: text,
    children: [mkEl('x')],
    querySelectorAll: () => ROWS.map(mkEl),
  });

  const auction = withText(AUCTION_HEADER + '\n' + ROWS.join('\n'));
  globalThis.document.querySelectorAll = () => [auction];
  check('an auction table with no "Round" is still found',
    findDraftSummaryContainer() === auction);

  // The snake path must keep working -- it is the one that was never broken.
  const snake = withText('Round 1 PLAYER TEAM PROJ PTS\nJosh Allen\nBUF\nQB');
  globalThis.document.querySelectorAll = () => [snake];
  check('a snake table with no prices is still found',
    findDraftSummaryContainer() === snake);

  // Widening the match must not make it match anything. A budget readout names
  // a player and a team and shows one dollar figure; it is not a results table.
  const decoy = withText('MY TEAM\nBudget $200\nPLAYER\nTEAM');
  globalThis.document.querySelectorAll = () => [decoy];
  check('a single dollar figure does not pass for a results table',
    findDraftSummaryContainer() === null);

  const empty = withText(AUCTION_HEADER + '\n$1 $2 $3\nNo players in queue');
  globalThis.document.querySelectorAll = () => [empty];
  check('the empty-queue panel is still rejected',
    findDraftSummaryContainer() === null);

  globalThis.document.querySelectorAll = () => [container];
}

console.log('\nthe roster dropdown says which team is yours');
{
  // Every select below is copied from a live 8-team auction room. The team
  // dropdown was previously identified by looking for the literal strings
  // "Team 1"/"Team 2"/"Team 8" in the element's innerText -- which is not
  // reliably the option text for a <select>, and which depends on opponents
  // leaving ESPN's placeholder names alone. Here all eight would have had to
  // stay default for the user's own team to be found.
  const mkSelect = (options, selectedIndex) => ({
    options: options.map((text) => ({ text })),
    selectedIndex,
    innerText: '', // what a <select> actually gave us in Safari
  });
  const TEAMS = [
    { teamId: 4, teamName: 'Team 4' }, { teamId: 1, teamName: 'Team 1' },
    { teamId: 7, teamName: 'Team 7' }, { teamId: 5, teamName: 'Team 5' },
    { teamId: 3, teamName: 'Team 3' }, { teamId: 9, teamName: "Mac's Marauders" },
    { teamId: 6, teamName: 'Team 6' }, { teamId: 8, teamName: 'Team 8' },
  ];
  const rosterSelect = mkSelect(
    ['Team 4', 'Team 1', 'Team 7', 'Team 5', 'Team 3', "Mac's Marauders",
     'Team 6', 'Team 8'], 5);
  // The decoys that share the page.
  const decoys = [
    mkSelect(['2026 Projected', '2025 Season'], 0),
    mkSelect(['All Pos.', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'D/ST', 'K'], 0),
    mkSelect(['All NFL Teams', 'Arizona Cardinals', 'Atlanta Falcons',
              'Baltimore Ravens', 'Buffalo Bills', 'Carolina Panthers'], 0),
    mkSelect(['All Rounds', 'Round 1', 'Round 2', 'Round 3'], 0),
  ];

  const withSelects = (list) => {
    globalThis.document.querySelectorAll = (sel) =>
      (sel === 'select' ? list : ROWS.map(mkEl));
  };

  withSelects([...decoys, rosterSelect]);
  check('the selected team is read from the dropdown',
    findTeamSelectName(TEAMS) === "Mac's Marauders",
    String(findTeamSelectName(TEAMS)));

  // The position and NFL-club dropdowns must never be mistaken for it.
  withSelects(decoys);
  check('no other dropdown on the page is mistaken for it',
    findTeamSelectName(TEAMS) === null, String(findTeamSelectName(TEAMS)));

  // And it must not answer when it has nothing to check against.
  withSelects([...decoys, rosterSelect]);
  check('with no teams scraped it declines to guess',
    findTeamSelectName([]) === null);

  // Viewing an opponent's roster reports that opponent, not a stale "you".
  const viewingOther = mkSelect(
    ['Team 4', 'Team 1', 'Team 7', 'Team 5', 'Team 3', "Mac's Marauders",
     'Team 6', 'Team 8'], 0);
  withSelects([...decoys, viewingOther]);
  check('it reports whichever roster is on screen',
    findTeamSelectName(TEAMS) === 'Team 4', String(findTeamSelectName(TEAMS)));

  globalThis.document.querySelectorAll = () => [container];
}

console.log('\nan auction room, which renders no draft board at all');
{
  // Copied from a live 8-team auction: the room contains exactly two <table>
  // elements -- the queue and one team's roster -- and no results table
  // anywhere. The scraper reported "16 picks made, 0 were read" because it was
  // hunting for a board that ESPN never draws.
  const cell = (t) => ({ innerText: t });
  const row = (cells) => ({ cells: cells.map(cell) });
  const mkTable = (rows) => ({ rows, tagName: 'TABLE' });

  const queueTable = mkTable([
    row(['RANK', 'PLAYER']),
    row(['', 'No players in queue']),
  ]);
  const rosterTable = mkTable([
    row(['POS', 'PLAYER', '$', 'BYE']),
    row(['QB', 'Empty', '-', '-']),
    row(['RB', 'C. McCaffrey', '$46', '8']),
    row(['RB', 'Empty', '-', '-']),
    row(['WR', 'J. Chase', '$47', '6']),
    row(['WR', 'Empty', '-', '-']),
    row(['BE', 'Empty', '-', '-']),
  ]);

  globalThis.document.querySelectorAll = (sel) =>
    (sel === 'table' ? [queueTable, rosterTable] : []);

  const panel = scrapeRosterPanel();
  check('the roster panel is read', panel.length === 2, `got ${panel.length}`);
  check('the queue table is not mistaken for a roster',
    panel.every((p) => p.playerName !== 'No players in queue'));
  check('empty slots are not players',
    panel.every((p) => !/^empty$/i.test(p.playerName)));
  check('the price comes across as a number',
    panel[0] && panel[0].bidAmount === 46, panel[0] && String(panel[0].bidAmount));
  check('the abbreviated name is kept verbatim for the database to resolve',
    panel[0] && panel[0].playerName === 'C. McCaffrey');
  check('the lineup slot is kept separate from the position',
    panel[0] && panel[0].rosterSlot === 'RB');

  // The league roster, from the dropdown rather than from thin air.
  const mkSelect = (options, selectedIndex) => ({
    options: options.map((text) => ({ text })), selectedIndex, innerText: '',
  });
  const teamSel = mkSelect(['Team 4', 'Team 1', 'Team 7', 'Team 5', 'Team 3',
    "Mac's Marauders", 'Team 6', 'Team 8'], 5);
  const filters = [
    mkSelect(['2026 Projected', '2025 Season'], 0),
    mkSelect(['All Pos.', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'D/ST', 'K'], 0),
    mkSelect(['All NFL Teams', 'Arizona Cardinals', 'Atlanta Falcons',
              'Baltimore Ravens', 'Buffalo Bills'], 0),
    mkSelect(['All Rounds', 'Round 1', 'Round 2', 'Round 3'], 0),
  ];
  globalThis.document.querySelectorAll = (sel) =>
    (sel === 'select' ? [...filters, teamSel] : []);

  const names = findLeagueTeamNames();
  check('the league is read from the dropdown, not invented',
    names.length === 8 && names.indexOf("Mac's Marauders") !== -1,
    JSON.stringify(names));
  check('no filter dropdown is mistaken for the league',
    names.indexOf('All Pos.') === -1 && names.indexOf('Round 1') === -1
      && names.indexOf('2026 Projected') === -1);

  // With none of it present, it must find nothing rather than manufacture a
  // league -- the old code produced eight teams named "Team 1".."Team 8".
  globalThis.document.querySelectorAll = () => [];
  check('an empty page yields no teams at all', findLeagueTeamNames().length === 0);
  check('and no roster', scrapeRosterPanel().length === 0);

  globalThis.document.querySelectorAll = () => [container];
}

console.log('\nESPN\'s id tables are the ones ESPN actually uses');
{
  // Read out of the shipped source rather than re-declared here: a copy in the
  // test would agree with itself forever while the scraper drifted.
  const grab = (name) => {
    const at = src.indexOf(`const ${name} = {`);
    if (at < 0) return null;
    const body = src.slice(src.indexOf('{', at), src.indexOf('};', at) + 1);
    try { return new Function(`return ${body}`)(); } catch (e) { return null; }
  };

  const posMap = grab('posMap');
  check('the position table exists', Boolean(posMap));
  if (posMap) {
    // defaultPositionId, not lineupSlotId. The slot space (0=QB, 4=WR, 6=TE,
    // 17=K) was applied to position ids, so a tight end came back as a WR and
    // QB, WR and K fell through to a hardcoded 'RB'.
    [[1, 'QB'], [2, 'RB'], [3, 'WR'], [4, 'TE'], [5, 'K'], [16, 'D/ST']]
      .forEach(([id, want]) => {
        check(`position id ${id} is ${want}`, posMap[id] === want,
          `got ${posMap[id]}`);
      });
    check('no lineup-slot id leaks in', posMap[0] === undefined && posMap[17] === undefined);
  }

  // Renamed from teamMap when the file's two verbatim copies of the club list
  // were merged into one declared at the top of the IIFE.
  const teamMap = grab('PRO_TEAM_BY_ID');
  check('the club table exists', Boolean(teamMap));
  if (teamMap) {
    // The tail (33 Ravens, 34 Texans) only exists in ESPN's legacy ordering,
    // in which 10 is Tennessee and 12 is Kansas City -- not the alphabetical
    // by-current-city order the old table assumed.
    [[10, 'TEN'], [12, 'KC'], [22, 'ARI'], [24, 'LAC'], [30, 'JAX'],
     [33, 'BAL'], [34, 'HOU']].forEach(([id, want]) => {
      check(`club id ${id} is ${want}`, teamMap[id] === want, `got ${teamMap[id]}`);
    });
    const vals = Object.values(teamMap);
    check('all 32 clubs, none twice', vals.length === 32
      && new Set(vals).size === 32, `${vals.length} entries, ${new Set(vals).size} distinct`);
  }
}

console.log('\nthe scraper says how much of the board it actually saw');
{
  // The engines read `coverage` and a test asserts they do -- but the PRODUCER
  // was unguarded: hardcoding it to { kind: 'full-board' } passed the whole
  // suite. A contract verified on one side only is a contract that can lie on
  // the other, and this one decides whether the market model answers at all.
  const seen = [];
  globalThis.postMessage = (msg) => { if (msg && msg.data) seen.push(msg.data); };
  globalThis.window.postMessage = globalThis.postMessage;

  const src2 = readFileSync(join(ROOT, 'chrome-extension/content-main.js'), 'utf8');
  const coverageOf = (text) => {
    const m = /coverage: finalPicks\.length[\s\S]{0,400}?;/.exec(text);
    return m ? m[0] : '';
  };
  const block = coverageOf(src2);
  check('the coverage field is derived, not a constant',
    /full-board/.test(block) && /own-roster-only/.test(block) && /swept-rosters/.test(block),
    'one of the three states is missing, so it cannot report them apart');
  check('and a full results table is what makes it full-board',
    /coverage: finalPicks\.length\s*\?\s*\{ kind: 'full-board' \}/.test(block),
    block.slice(0, 120));
  check('an own-roster scrape carries which team it knows about',
    /own-roster-only', knownTeamId/.test(block),
    '"we saw one roster" and "we saw the board" must not be the same message');
}

console.log('\nthe sweep runs where the page cannot reach it');
{
  // It used to be triggered by a window message into world MAIN, which any
  // script on ESPN's page can send -- proven to drive the roster dropdown
  // through every option during a live auction. It reads and writes the DOM
  // and nothing else, so it needed nothing from that world.
  const iso = readFileSync(join(ROOT, 'chrome-extension/content-isolated.js'), 'utf8');

  check('the scraper no longer listens for a sweep request',
    !src.includes('GRIDIRON_EDGE_SWEEP_REQUEST'),
    'a forgeable trigger is still installed in the page world');
  check('and no longer carries the sweep itself',
    !/function sweepAllRosters/.test(src));
  check('the isolated world does', /async function sweepAllRosters/.test(iso));
  check('and starts it only from a chrome.runtime message',
    /onMessage\.addListener[\s\S]{0,240}runSweep\(\)/.test(iso));

  // The two copies that remain in both files must not drift.
  const grab = (source, sig) => {
    const at = source.indexOf(sig);
    if (at < 0) return null;
    let depth = 0;
    for (let i = source.indexOf('{', at); i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) {
        return source.slice(at, i + 1).replace(/^[ \t]+/gm, '');
      }
    }
    return null;
  };
  ['function scrapeRosterPanel()', 'function findLeagueTeamNames()'].forEach((sig) => {
    const a = grab(src, sig), b = grab(iso, sig);
    check(`${sig.slice(9, -2)} is the same in both worlds`, Boolean(a) && a === b,
      !a || !b ? 'missing from one of them' : 'they differ');
  });

  // And the sweep is bounded, because sel.options came straight off the page.
  const bounds = (iso.match(/const MAX_SWEEP_(?:TEAMS|ROWS) = (\d+);/g) || []);
  check('the sweep caps how many options it will step through', bounds.length === 2,
    bounds.join(' '));
  check('and bounds it by the same team count the worker enforces',
    /MAX_SWEEP_TEAMS = 32;/.test(iso));

  // One instance per world, or the locks and observers are duplicated.
  // The scraper's marker must live on the DOM, not on `window`: it runs in
  // world MAIN as a declared content script and in the isolated world when
  // background.js injects it, and the two worlds have separate globals -- so a
  // window sentinel never saw the other copy and both installed. Measured at
  // 291ms over 27 bid ticks against 123ms for one.
  // The marker must NOT be somewhere the page can write. Round 6 put it on
  // documentElement.dataset -- shared by both worlds, and by the page: an
  // inline script at document_start set it first and BOTH copies returned
  // silently, leaving the page as the app's only source of draft data.
  check('the scraper does not take its install marker from the DOM',
    !/documentElement[\s\S]{0,120}dataset\s*\[/.test(src),
    'a page can write that, and then neither copy installs');
  check('it guards its own world instead',
    /window\.__GRIDIRON_EDGE_MAIN_INSTALLED__/.test(src));
  check('and the isolated half still refuses a second registration',
    /__GRIDIRON_EDGE_ISOLATED_INSTALLED__/.test(iso));

  // The double install is decided in the worker, which no page can reach.
  const bgSrc = readFileSync(join(ROOT, 'chrome-extension/background.js'), 'utf8');
  check('the worker refuses to inject the fallback twice for one tab',
    /injected\.has\(tabId\)[\s\S]{0,40}return/.test(bgSrc)
      && /injected\.add\(tabId\)/.test(bgSrc),
    'nothing stops a second copy, and the two worlds cannot see each other');
  check('and neither bookkeeping set grows for the life of the worker',
    /onRemoved[\s\S]{0,160}injected\.delete/.test(bgSrc));
}

console.log('\nand the moved sweep still actually sweeps');
{
  // Code motion is not a proof. This drives the real sweepAllRosters out of
  // the shipped isolated-world file against a fake roster panel and a fake
  // React-controlled <select>, and checks it visits every team, records each
  // one's roster, and puts the dropdown back.
  const iso = readFileSync(join(ROOT, 'chrome-extension/content-isolated.js'), 'utf8');

  const ROSTERS = {
    "Mac's Marauders": [['QB', 'Josh Allen', '$19'], ['RB', 'Bijan Robinson', '$49']],
    'Team 1': [['WR', 'Ja\'Marr Chase', '$44']],
    'Team 2': [['TE', 'Trey McBride', '$21'], ['K', 'Ka\'imi Fairbairn', '$1']],
  };
  const names = Object.keys(ROSTERS);
  let selected = 0;
  const cell = (t) => ({ innerText: t });
  const rosterTable = {
    get rows() {
      const body = ROSTERS[names[selected]] || [];
      return [{ cells: [cell('POS'), cell('PLAYER'), cell('$')] }]
        .concat(body.map((r) => ({ cells: r.map(cell) })))
        // Three rows minimum, or scrapeRosterPanel skips the table.
        .concat(body.length < 2 ? [{ cells: [cell('BE'), cell('Empty'), cell('')] }] : []);
    },
  };
  const dispatched = [];
  const select = {
    options: names.map((n, i) => ({ text: n, value: String(i) })),
    selectedIndex: 0,
    dispatchEvent(e) { dispatched.push(e.type); return true; },
  };
  globalThis.HTMLSelectElement = function () {};
  Object.defineProperty(globalThis.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    set(v) { selected = Number(v); this.selectedIndex = selected; },
    get() { return String(selected); },
  });
  globalThis.window.HTMLSelectElement = globalThis.HTMLSelectElement;
  globalThis.Event = function (type) { this.type = type; };
  globalThis.setTimeout = (fn, ms) => { fn(); return 0; };
  globalThis.document.querySelectorAll = (sel) =>
    (sel === 'select' ? [select] : sel === 'table' ? [rosterTable] : []);
  globalThis.chrome = { runtime: { id: 'x', onMessage: { addListener() {} }, sendMessage() {} } };
  globalThis.window.__GRIDIRON_EDGE_ISOLATED_INSTALLED__ = false;

  const ii = iso.indexOf('(function');
  const jj = iso.lastIndexOf('})();');
  const isoBody = iso.slice(iso.indexOf('\n', ii) + 1, jj);
  const isoFns = new Function(`${isoBody}\nreturn { sweepAllRosters, scrapeRosterPanel, findTeamSelectEl, runSweep, looksLikeAScrape };`)();

  check('the isolated half exposes a working dropdown finder',
    isoFns.findTeamSelectEl(names.map((teamName) => ({ teamName }))) === select);

  const res = await isoFns.sweepAllRosters(names.map((teamName) => ({ teamName })));
  check('the sweep reports success', res && res.ok === true, JSON.stringify(res));
  check('it visited every team', res.byTeam && res.byTeam.length === names.length,
    res.byTeam && String(res.byTeam.length));
  check('and read each roster, not the same one three times',
    res.byTeam[0].roster.length === 2 && res.byTeam[1].roster.length === 1
      && res.byTeam[2].roster.length === 2,
    res.byTeam && JSON.stringify(res.byTeam.map((t) => t.roster.length)));
  check('it kept the prices', res.byTeam[0].roster[0].bidAmount === 19,
    JSON.stringify(res.byTeam[0].roster[0]));
  // Leaving somebody else's roster on screen mid-auction is worse than not
  // running at all: you would be reading the wrong team's needs.
  check('and put the dropdown back where it found it', selected === 0, String(selected));
  check('driving the select through real events', dispatched.filter((e) => e === 'change').length
    === names.length + 1, dispatched.join(','));

  // Two teams whose panels never change must not each cost the full deadline:
  // "every team is empty" is exactly the state the automatic sweep fires in,
  // and it was measured at 11,011ms for twelve teams.
  const EMPTY = { 'A': [], 'B': [], 'C': [], 'D': [], 'E': [], 'F': [] };
  const emptyNames = Object.keys(EMPTY);
  selected = 0;
  const emptyTable = {
    rows: [{ cells: [cell('POS'), cell('PLAYER'), cell('$')] },
           { cells: [cell('BE'), cell('Empty'), cell('')] },
           { cells: [cell('BE'), cell('Empty'), cell('')] }],
  };
  select.options = emptyNames.map((n, i) => ({ text: n, value: String(i) }));
  globalThis.document.querySelectorAll = (sel) =>
    (sel === 'select' ? [select] : sel === 'table' ? [emptyTable] : []);
  const flat = await isoFns.sweepAllRosters(emptyNames.map((teamName) => ({ teamName })));
  check('it gives up once two panels in a row have not moved',
    flat.ok === true && flat.byTeam.length <= 3,
    `stepped ${flat.byTeam && flat.byTeam.length} of ${emptyNames.length} teams`);
  // It used to bail BEFORE recording, so the second unchanged team and
  // everything after it vanished -- the all-empty case returned one team of
  // twelve and then reported having swept the league.
  check('and still reports the teams it did read', flat.byTeam.length >= 2,
    `${flat.byTeam.length} teams recorded`);
  check('and says it stopped early', flat.truncated === true,
    'a sweep that gave up after two teams must not look like a full one');

console.log('\nthe pick walk reads each element\'s innerText once, not twice');
{
  // innerText forces layout every time it is touched, and the shape
  // `el.innerText ? el.innerText.trim() : ''` touches it twice. `readText`
  // exists to make that one read -- and four sites the function was supposed
  // to have replaced were still doing it two ways, while the comment above
  // readText said the consolidation was done. A comment cannot hold this; a
  // counter can.
  const NODES = 400;
  let reads = 0;
  const counting = Array.from({ length: NODES }, (_, i) => ({
    get innerText() { reads++; return `Player Name ${i}\nDEN\nRB\nTeam 1\n100\n210.1\n$3`; },
    children: [], tagName: 'DIV',
  }));
  const countingContainer = {
    get innerText() { reads++; return 'Round 1 PLAYER TEAM PROJ PTS'; },
    children: counting,
    querySelectorAll: () => counting,
  };
  const savedQsa = globalThis.document.querySelectorAll;
  const savedQs = globalThis.document.querySelector;
  const savedBody = globalThis.document.body;
  globalThis.document.querySelectorAll = () => [countingContainer];
  globalThis.document.querySelector = () => countingContainer;
  globalThis.document.body = { innerText: 'PK 10 OF 128' };

  reads = 0;
  const walked = scrapeDraftDOM() || [];
  const perNode = reads / NODES;
  check('the walk parsed the synthetic room', walked.length > 0, `${walked.length} picks`);
  check('and touched innerText at most once per element',
    perNode <= 1.2, `${reads} reads over ${NODES} elements (${perNode.toFixed(2)} each)`);

  globalThis.document.querySelectorAll = savedQsa;
  globalThis.document.querySelector = savedQs;
  globalThis.document.body = savedBody;
}

  console.log('\nthe sweep never credits a team with somebody else\'s roster');
  {
    // A non-empty panel that does not repaint in time is still showing the
    // PREVIOUS team's players. Pushing it anyway reported Team 2 holding Josh
    // Allen and Bijan Robinson while it actually held Ja'Marr Chase.
    const STUCK = { A: [['QB', 'Josh Allen', '$19']], B: [['WR', "Ja'Marr Chase", '$44']] };
    const stuckNames = Object.keys(STUCK);
    let shown = 0;
    const cell2 = (t) => ({ innerText: t });
    const frozen = {
      // The panel never follows the dropdown: every read returns team A's roster.
      get rows() {
        const body = STUCK[stuckNames[0]];
        return [{ cells: [cell2('POS'), cell2('PLAYER'), cell2('$')] }]
          .concat(body.map((r) => ({ cells: r.map(cell2) })))
          .concat([{ cells: [cell2('BE'), cell2('Empty'), cell2('')] }]);
      },
    };
    const sel2 = {
      options: stuckNames.map((n, i) => ({ text: n, value: String(i) })),
      selectedIndex: 0,
      dispatchEvent() { return true; },
    };
    globalThis.document.querySelectorAll = (q) =>
      (q === 'select' ? [sel2] : q === 'table' ? [frozen] : []);
    const stuck = await isoFns.sweepAllRosters(stuckNames.map((teamName) => ({ teamName })));
    const b = (stuck.byTeam || []).find((t) => t.teamName === 'B');
    check('a team whose panel never repainted is not reported at all',
      !b, b && JSON.stringify(b.roster));
    check('and the sweep says it was truncated', stuck.truncated === true);
    check('while the team that WAS on screen is still reported',
      (stuck.byTeam || []).some((t) => t.teamName === 'A'),
      'the initially selected panel is trustworthy without a repaint');

    // ...but ONLY while nothing has moved yet. `i === originalIndex` alone was
    // trusted at ANY position, and a room opened on any team but the first has
    // already been stepped away by the time that index comes round -- so the
    // panel is showing the PREVIOUS team, and the sweep credited this one with
    // somebody else's roster while reporting a clean board.
    const THREE = { P: [['QB', 'Josh Allen', '$19']], Q: [['WR', 'Chase', '$44']],
                    R: [['TE', 'McBride', '$21']] };
    const names3 = Object.keys(THREE);
    let live = 2;                  // the room is open on the THIRD team...
    let onScreen = 2;              // ...and its roster is what is on screen
    const table3 = { get rows() {
      const body = THREE[names3[onScreen]] || [];
      return [{ cells: [cell('POS'), cell('PLAYER'), cell('$')] }]
        .concat(body.map((r) => ({ cells: r.map(cell) })))
        .concat([{ cells: [cell('BE'), cell('Empty'), cell('')] }]);
    } };
    const sel3 = {
      options: names3.map((n, i) => ({ text: n, value: String(i) })),
      selectedIndex: 2, dispatchEvent() { return true; },
    };
    Object.defineProperty(globalThis.HTMLSelectElement.prototype, 'value', {
      configurable: true,
      // The panel follows the dropdown for the first two teams and then stops,
      // which is what a slow render looks like: it stays on Q.
      set(v) { live = Number(v); if (live < 2) onScreen = live; this.selectedIndex = live; },
      get() { return String(live); },
    });
    globalThis.document.querySelectorAll = (q) =>
      (q === 'select' ? [sel3] : q === 'table' ? [table3] : []);
    const late = await isoFns.sweepAllRosters(names3.map((teamName) => ({ teamName })));
    check('a room opened on a later team does not credit it with Q\'s roster',
      !(late.byTeam || []).some((t) => t.teamName === 'R'),
      JSON.stringify(late.byTeam));
    check('and it still read the two teams whose panels did repaint',
      (late.byTeam || []).length === 2, JSON.stringify(late.byTeam));
    check('and that sweep reports itself truncated', late.truncated === true);

    // Both caps returned ok:true with no signal, so a sweep bounded by the
    // 32-team cap reported 32 of 40 rosters as a swept league, and one bounded
    // by the 2,000-row cap reported the teams it reached as the whole board.
    const many = Array.from({ length: 40 }, (_, i) => `Club ${i}`);
    let manyShown = 0;
    const manyTable = { get rows() {
      return [{ cells: [cell('POS'), cell('PLAYER'), cell('$')] },
              { cells: [cell('QB'), cell(`Passer ${manyShown}`), cell('$5')] },
              { cells: [cell('BE'), cell('Empty'), cell('')] }];
    } };
    const manySel = {
      options: many.map((n, i) => ({ text: n, value: String(i) })),
      selectedIndex: 0, dispatchEvent() { return true; },
    };
    Object.defineProperty(globalThis.HTMLSelectElement.prototype, 'value', {
      configurable: true,
      set(v) { manyShown = Number(v); this.selectedIndex = manyShown; },
      get() { return String(manyShown); },
    });
    globalThis.document.querySelectorAll = (q) =>
      (q === 'select' ? [manySel] : q === 'table' ? [manyTable] : []);
    const capped = await isoFns.sweepAllRosters(many.map((teamName) => ({ teamName })));
    check('a league larger than the team cap is swept up to the cap',
      capped.byTeam.length === 32, String(capped.byTeam.length));
    check('and does not claim to have seen the rest', capped.truncated === true,
      '32 of 40 rosters reported as a complete sweep');

    // The row cap: one team holding 2,000 rows exhausts it, and the second
    // team is never read.
    const wide = ['Hoarders', 'Ordinary', 'Also'];
    let wideShown = 0;
    const wideTable = { get rows() {
      const n = wideShown === 0 ? 2000 : 1;
      return [{ cells: [cell('POS'), cell('PLAYER'), cell('$')] }]
        .concat(Array.from({ length: n }, (_, i) =>
          ({ cells: [cell('BE'), cell(`Filler ${wideShown}-${i}`), cell('$1')] })))
        .concat([{ cells: [cell('BE'), cell('Empty'), cell('')] }]);
    } };
    const wideSel = {
      options: wide.map((n, i) => ({ text: n, value: String(i) })),
      selectedIndex: 0, dispatchEvent() { return true; },
    };
    Object.defineProperty(globalThis.HTMLSelectElement.prototype, 'value', {
      configurable: true,
      set(v) { wideShown = Number(v); this.selectedIndex = wideShown; },
      get() { return String(wideShown); },
    });
    globalThis.document.querySelectorAll = (q) =>
      (q === 'select' ? [wideSel] : q === 'table' ? [wideTable] : []);
    const bounded = await isoFns.sweepAllRosters(wide.map((teamName) => ({ teamName })));
    check('the row cap stops the sweep', bounded.byTeam.length === 1,
      String(bounded.byTeam.length));
    check('and it says so rather than reporting a swept league',
      bounded.truncated === true);

    // A blank option -- ESPN renders a "-- select --" placeholder in some room
    // layouts -- is skipped, and skipping a team is a team unread. It counted
    // as nothing at all, so a five-option dropdown that yielded four rosters
    // reported a complete sweep of a five-team league.
    const withBlank = ['Anchors', 'Bruisers', '', 'Cyclones', 'Dynamos'];
    let blankShown = 0;
    const blankTable = { get rows() {
      return [{ cells: [cell('POS'), cell('PLAYER'), cell('$')] },
              { cells: [cell('QB'), cell(`Passer ${blankShown}`), cell('$5')] },
              { cells: [cell('BE'), cell('Empty'), cell('')] }];
    } };
    const blankSel = {
      options: withBlank.map((n, i) => ({ text: n, value: String(i) })),
      selectedIndex: 0, dispatchEvent() { return true; },
    };
    Object.defineProperty(globalThis.HTMLSelectElement.prototype, 'value', {
      configurable: true,
      set(v) { blankShown = Number(v); this.selectedIndex = blankShown; },
      get() { return String(blankShown); },
    });
    globalThis.document.querySelectorAll = (q) =>
      (q === 'select' ? [blankSel] : q === 'table' ? [blankTable] : []);
    const skipped = await isoFns.sweepAllRosters(
      withBlank.filter(Boolean).map((teamName) => ({ teamName })));
    check('a blank dropdown option is skipped', skipped.byTeam.length === 4,
      JSON.stringify(skipped.byTeam.map((t) => t.teamName)));
    check('and the sweep counts the skip as unread',
      skipped.truncated === true, 'four of five rosters reported as five');
  }

  console.log('\nthe sweep guards itself: one at a time, once a minute, one origin');
  {
    // A mutation run killed 3 of 13 mutants in this file. Surviving: the
    // postMessage target origin becoming '*', which broadcasts every team's
    // roster to any listener; the sixty-second floor; and the in-flight lock --
    // the exact race the file header says produced two sweeps fighting over the
    // dropdown. runSweep was invoked by no test at all, and the MutationObserver
    // path added this round never executed, because MutationObserver is not a
    // Node global and nothing defined one.
    const iso = readFileSync(join(ROOT, 'chrome-extension/content-isolated.js'), 'utf8');

    const posted = [];
    const observers = [];
    globalThis.MutationObserver = class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() { this.observing = true; }
      disconnect() { this.observing = false; }
    };
    globalThis.setTimeout = (fn) => { fn(); return 0; };
    globalThis.window.postMessage = (msg, origin) => { posted.push({ msg, origin }); };
    globalThis.postMessage = globalThis.window.postMessage;

    // Five names, because findLeagueTeamNames needs at least four options before
  // it will believe a <select> is the league rather than a filter.
  const ROST = {
    Anvils: [['QB', 'Josh Allen', '$19']],
    Bandits: [['WR', 'Chase', '$44'], ['RB', 'Bijan', '$49']],
    Comets: [['TE', 'McBride', '$21']],
    Drifters: [['K', 'Fairbairn', '$1'], ['D/ST', 'Texans', '$2']],
    Embers: [['RB', 'Gibbs', '$40']],
  };
    const nm = Object.keys(ROST);
    let sel3 = 0;
    const c = (t) => ({ innerText: t });
    const tbl = { get rows() {
      const body = ROST[nm[sel3]] || [];
      return [{ cells: [c('POS'), c('PLAYER'), c('$')] }]
        .concat(body.map((r) => ({ cells: r.map(c) })))
        .concat([{ cells: [c('BE'), c('Empty'), c('')] }]);
    } };
    const drop = {
      options: nm.map((n, i) => ({ text: n, value: String(i) })),
      selectedIndex: 0, dispatchEvent() { return true; },
    };
    Object.defineProperty(globalThis.HTMLSelectElement.prototype, 'value', {
      configurable: true,
      set(v) { sel3 = Number(v); this.selectedIndex = sel3; },
      get() { return String(sel3); },
    });
    globalThis.document.querySelectorAll = (q) =>
      (q === 'select' ? [drop] : q === 'table' ? [tbl] : []);
    globalThis.document.body = globalThis.document.body || { };

    await isoFns.runSweep();
    const result = posted.find((x) => x.msg && x.msg.type === 'GRIDIRON_EDGE_SWEEP_RESULT');
    check('a sweep posts its result', Boolean(result), JSON.stringify(posted.slice(0, 1)));
    // '*' would hand every team's roster to any script listening on the window.
    check('and never to a wildcard origin',
      result && result.origin === 'https://fantasy.espn.com', result && result.origin);
    check('the observer path actually ran', observers.length > 0,
      'MutationObserver was never constructed, so the settle path is untested');
    check('and every observer it made was disconnected',
      observers.every((o) => o.observing === false));

    // The throttle. A second sweep inside the minute must produce nothing.
    const before = posted.length;
    await isoFns.runSweep();
    check('a second sweep within the minute is refused', posted.length === before,
      `${posted.length - before} extra results`);

    // The in-flight lock, which the throttle above hides: two sweeps started
    // before either finishes is the race the file header describes, both
    // fighting to restore the dropdown. Started concurrently, both must
    // complete and neither may corrupt the other's answer.
    const both = await Promise.all([
      isoFns.sweepAllRosters(nm.map((teamName) => ({ teamName }))),
      isoFns.sweepAllRosters(nm.map((teamName) => ({ teamName }))),
    ]);
    // Exactly one runs. Both completing is the WRONG answer: two walks over one
    // dropdown each restore a selectedIndex the other has already moved, and
    // driven that way they returned different rosters for the same league.
    check('exactly one of two concurrent sweeps runs',
      both.filter((r) => r && r.ok).length === 1,
      JSON.stringify(both.map((r) => r && (r.ok ? 'ran' : r.reason))));
    check('and the other says why it did not',
      both.some((r) => r && r.reason === 'sweep-already-running'),
      JSON.stringify(both.map((r) => r && r.reason)));

    // The bounds, driven rather than grepped.
    check('a payload over the team cap is refused',
      isoFns.looksLikeAScrape({ leagueId: '1', teams: new Array(33).fill({}) }) === false);
    check('and one within it is accepted',
      isoFns.looksLikeAScrape({ leagueId: '1', teams: new Array(12).fill({}) }) === true);
  }
}



console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
