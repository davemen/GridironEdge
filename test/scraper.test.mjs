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
const fn = new Function(`${body}\nreturn { scrapeDraftDOM, findDraftSummaryContainer };`);
const { scrapeDraftDOM, findDraftSummaryContainer } = fn();

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
