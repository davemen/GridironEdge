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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
