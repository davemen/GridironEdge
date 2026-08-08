/**
 * Name resolution against the real projection set.
 *
 * Run: node test/player-database.test.mjs
 *
 * Every failure this guards against produced the same silent symptom: a page
 * that looked empty or a player valued at replacement level, with no error
 * anywhere. A name that does not resolve is not a small problem here -- it is
 * the difference between a bid ceiling built on a real projection and one built
 * on nothing.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { toPlayerDatabase, findPlayer, playerKey, noteChange } from '../js/player-database.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const proj = JSON.parse(readFileSync(join(ROOT, 'data/projections-2026.json'), 'utf8'));
const db = toPlayerDatabase(proj);

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const hit = (n, pos, team, bid) => findPlayer(db, n, pos, team, bid);

console.log('\nthe projection set covers a whole roster');
{
  const counts = {};
  Object.values(db).forEach((p) => { counts[p.position] = (counts[p.position] || 0) + 1; });
  ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST'].forEach((pos) => {
    check(`has ${pos}`, (counts[pos] || 0) > 10, `${counts[pos] || 0} found`);
  });
}

console.log('\nfull names');
{
  check('plain name', hit('Bijan Robinson', 'RB')?.name === 'Bijan Robinson');
  // An apostrophe stripped one way and spaced the other left the consensus
  // number one receiver unresolvable and priced at replacement level.
  check('apostrophe', hit("Ja'Marr Chase", 'WR')?.name === "Ja'Marr Chase");
  check('key strips punctuation consistently', playerKey("Ja'Marr Chase") === 'jamarr chase',
    playerKey("Ja'Marr Chase"));
}

console.log('\nabbreviated first names, as ESPN writes a roster panel');
{
  // "B. Robinson" reaches "Bijan Robinson" by neither exact nor substring
  // match, so a real roster resolved to nothing and the page sat empty.
  check('J. Allen', hit('J. Allen', 'QB', 'BUF')?.name === 'Josh Allen');
  // B. Robinson needs the price too -- Atlanta rosters two of them. Covered
  // below; here just assert the abbreviation itself is understood.
  check('B. Robinson', hit('B. Robinson', 'RB', 'ATL', 49)?.name === 'Bijan Robinson');
  check('P. Nacua', hit('P. Nacua', 'WR', 'LAR')?.name === 'Puka Nacua');

  // Jonathan Taylor and J'Mari Taylor share an initial, a surname AND a
  // position. Only the NFL team separates them.
  check('team separates a shared initial and surname',
    hit('J. Taylor', 'RB', 'IND')?.name === 'Jonathan Taylor');
  check('and picks the other one when the team says so',
    hit('J. Taylor', 'RB', 'JAC')?.name === "J'Mari Taylor");
  check('reports unknown rather than guessing when nothing separates them',
    hit('J. Taylor', 'RB') === null);
}

console.log('\nthe generator and this file must normalise names identically');
{
  // The generator wrote "a j brown" and this file produced "aj brown", so the
  // key never matched and A.J. Brown could not be found at all. Keys are now
  // re-derived here from the name, which makes the mismatch impossible rather
  // than fixed once.
  check('A.J. Brown resolves', hit('A.J. Brown', 'WR', 'PHI')?.name === 'A.J. Brown');
  check('so does the unpunctuated spelling', hit('AJ Brown', 'WR', 'PHI')?.name === 'A.J. Brown');
  check('and a name with a period mid-surname',
    hit('Amon-Ra St. Brown', 'WR', 'DET')?.name === 'Amon-Ra St. Brown');
}

console.log('\na malformed record cannot break a lookup');
{
  // The mapper inserts placeholder records with no match key. Reading one threw
  // partway through the import and aborted the entire sync, so one unknown name
  // emptied the whole app instead of costing a single roster slot.
  const withStub = { ...db, MOCK_X: { id: 'MOCK_X', name: 'Someone', position: 'WR' } };
  let threw = false;
  try { findPlayer(withStub, 'Some Other Guy', 'WR'); } catch (e) { threw = true; }
  check('a record with no key does not throw', !threw);
}

console.log('\nnever crosses positions');
{
  // "Washington" contains-matches the receiver Parker Washington, who was
  // filling a roster slot nobody drafted him into.
  check('a defense lookup returns a defense',
    hit('Washington', 'D/ST')?.position === 'D/ST');
  check('a defense resolves by city as well as nickname',
    hit('Washington', 'D/ST')?.name === 'Washington Commanders');
  check('the receiver is still reachable as a receiver',
    hit('Parker Washington', 'WR')?.name === 'Parker Washington');
}

console.log('\nthe price separates two players nothing else can');
{
  // Bijan Robinson and Brian Robinson Jr. are both Atlanta running backs, so
  // name, position and team all fail. The money does not: nobody pays $49 for
  // the 160th-ranked player, or $1 for the 3rd.
  check('$49 buys Bijan', hit('B. Robinson', 'RB', 'ATL', 49)?.name === 'Bijan Robinson');
  check('$1 buys Brian', hit('B. Robinson', 'RB', 'ATL', 1)?.name === 'Brian Robinson Jr.');
  check('with no price it stays unknown', hit('B. Robinson', 'RB', 'ATL') === null);
}

console.log('\nteam defenses');
{
  // A draft room says "Texans D/ST"; the consensus says "Houston Texans".
  ['Texans D/ST', 'Houston Texans D/ST', 'Houston Texans', 'Texans DST'].forEach((n) => {
    check(`resolves "${n}"`, hit(n, 'D/ST')?.name === 'Houston Texans');
  });
  // Every club, in every spelling a draft room uses. Matching on any shared
  // word passed the Houston case and quietly broke four others: "new england"
  // collides with New Orleans and both New York clubs on the word "new", and
  // resolved to nothing at all -- so those defenses could not be drafted.
  const dsts = Object.values(db).filter((p) => p.position === 'D/ST');
  let wrong = 0, ambiguous = 0;
  dsts.forEach((d) => {
    const nick = d.name.split(' ').pop();
    const city = d.name.split(' ').slice(0, -1).join(' ');
    [d.name, `${d.name} D/ST`, nick, `${nick} D/ST`, city, `${city} D/ST`].forEach((form) => {
      const got = hit(form, 'D/ST');
      if (!got) ambiguous++;
      else if (got.name !== d.name) wrong++;
    });
  });
  check('no defense ever resolves to the wrong club', wrong === 0, `${wrong} wrong`);
  // Only the two-club cities may come back unresolved, and only by city alone:
  // "New York" is Giants or Jets, "Los Angeles" is Rams or Chargers.
  check('only genuinely ambiguous city names go unresolved', ambiguous === 8,
    `${ambiguous} unresolved of ${dsts.length * 6}`);
  check('the NFL abbreviation settles New York',
    hit('New York', 'D/ST', 'NYG')?.name === 'New York Giants'
      && hit('New York', 'D/ST', 'NYJ')?.name === 'New York Jets');
  check('and Los Angeles',
    hit('Los Angeles', 'D/ST', 'LAR')?.name === 'Los Angeles Rams'
      && hit('Los Angeles', 'D/ST', 'LAC')?.name === 'Los Angeles Chargers');

  // The tag regex must not be stateful: a /g regex carries lastIndex between
  // .test() calls and would match on one lookup and miss on the next.
  const repeats = [0, 1, 2, 3].map(() => hit('Texans D/ST', 'D/ST')?.name);
  check('repeated lookups are stable', new Set(repeats).size === 1, repeats.join(','));
}

console.log('\nunknown players stay unknown');
{
  check('a made-up name resolves to nothing', hit('Zxqv Notaplayer', 'RB') === null);
  check('an empty name resolves to nothing', hit('', 'RB') === null);
}

console.log('\nthe index knows when it is stale, without walking every key');
{
  // The validity check was `cached.size === Object.keys(db).length`, and
  // Object.keys allocates an array of every key on every lookup: 89% of
  // findPlayer's cost was that one comparison. It is a counter now, so the two
  // ways the index can go stale still have to be caught.
  const someone = Object.values(db)[0];
  check('an ordinary lookup resolves', Boolean(findPlayer(db, someone.name)));

  // A caller spreading the database drops the non-enumerable index entirely.
  const clone = { ...db };
  check('a spread copy still resolves', Boolean(findPlayer(clone, someone.name)));

  // A record inserted after the index was built must be findable. This is not
  // hypothetical: the mapper adds a placeholder for every name it could not
  // resolve, on every sync.
  const added = { id: 'MOCK_zz_test', key: 'zz test', name: 'Zz Test',
                  position: 'RB', team: 'FA', projectedPoints: 4.5 };
  clone[added.id] = added;
  noteChange(clone);
  check('a record added after indexing is found',
    Boolean(findPlayer(clone, 'Zz Test')),
    'the index served a stale answer for a player that is present');
  check('and the rest still resolve', Boolean(findPlayer(clone, someone.name)));

  // Two in a row, because a counter that only ever notices the first would
  // pass the check above.
  const second = { id: 'MOCK_yy_test', key: 'yy test', name: 'Yy Test',
                   position: 'WR', team: 'FA', projectedPoints: 4.5 };
  clone[second.id] = second;
  noteChange(clone);
  check('and so is a second one', Boolean(findPlayer(clone, 'Yy Test')));
}

console.log('\nthe counts the docs assert are the counts the data has');
{
  // "523 players from the consensus of 88 analysts" appears in README.md,
  // CLAUDE.md, player-database.js, store.js, this suite and BACKTEST.md, and
  // no test checked any of it -- while CLAUDE.md's own rule says not to assert
  // a count in a comment unless a test checks it. Two counts in this repo have
  // already drifted that way (22 mock players when there were 31, 459 players
  // when there were 523).
  const docs = [
    ['README.md', readFileSync(join(ROOT, 'README.md'), 'utf8')],
    ['CLAUDE.md', readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8')],
    ['js/player-database.js', readFileSync(join(ROOT, 'js/player-database.js'), 'utf8')],
  ];
  const players = proj.players.length;
  const experts = proj.experts;
  check(`the data holds ${players} players`, players === Object.keys(db).length,
    `${players} in the file, ${Object.keys(db).length} in the database`);
  docs.forEach(([name, text]) => {
    // Backticked figures are quoted, not claimed: CLAUDE.md cites `459 players`
    // as an example of a count that drifted, which is the rule being taught.
    const claimed = [...text.matchAll(/(.?)\b(\d{3})\s*(?:players|-player)/g)]
      .filter((m) => m[1] !== '`')
      .map((m) => Number(m[2]));
    const wrong = claimed.filter((n) => n !== players);
    check(`${name} says ${players}, not something else`, wrong.length === 0,
      `claims ${wrong.join(', ')} against ${players}`);
  });
  check('the expert count is a real field', typeof experts === 'number' && experts > 0,
    String(experts));
  docs.forEach(([name, text]) => {
    const claimed = [...text.matchAll(/consensus of (\d+) analysts/g)].map((m) => Number(m[1]));
    const wrong = claimed.filter((n) => n !== experts);
    check(`${name}'s analyst count matches the data`, wrong.length === 0,
      `claims ${wrong.join(', ')} against ${experts}`);
  });
}

console.log('\nthe club table, which had 100% coverage and killed nothing');
{
  // Executed by every import and asserted by nothing: all five mutations
  // survived, including proTeamAbbrev returning String(proTeamId) -- the exact
  // bug the module header says it exists to fix, "a player on Kansas City had
  // the club 12". A wrong club is not cosmetic: it is what separates two
  // defenses and two running backs who share a surname.
  const { proTeamAbbrev, PRO_TEAM_BY_ID, NFL_NICKNAMES, NFL_ABBREVS } =
    await import(join(ROOT, 'js/nfl-teams.js'));

  // ESPN's legacy ordering, where 10 is Tennessee and 12 Kansas City -- not the
  // alphabetical-by-city order an earlier table assumed.
  [[1, 'ATL'], [10, 'TEN'], [12, 'KC'], [16, 'MIN'], [17, 'NE'], [22, 'ARI'],
   [24, 'LAC'], [30, 'JAX'], [33, 'BAL'], [34, 'HOU']].forEach(([id, want]) => {
    check(`proTeamId ${id} is ${want}`, proTeamAbbrev(id) === want, proTeamAbbrev(id));
  });
  check('a string id resolves the same as a number', proTeamAbbrev('12') === 'KC');
  // Null, never the id. Returning String(id) is what put the club "12" on a
  // player, and it reads as data.
  check('an unknown id is null, not the id', proTeamAbbrev(999) === null,
    String(proTeamAbbrev(999)));
  check('and so is nothing at all',
    proTeamAbbrev(undefined) === null && proTeamAbbrev(null) === null
      && proTeamAbbrev('') === null && proTeamAbbrev('KC') === null);

  check('all 32 clubs, none twice',
    Object.keys(PRO_TEAM_BY_ID).length === 32
      && new Set(Object.values(PRO_TEAM_BY_ID)).size === 32);
  check('the abbreviation list is abbreviations, not ids',
    NFL_ABBREVS.length === 32 && NFL_ABBREVS.every((a) => /^[A-Z]{2,3}$/.test(a)),
    NFL_ABBREVS.slice(0, 3).join(','));
  check('every nickname maps to a real club',
    Object.keys(NFL_NICKNAMES).length === 32
      && Object.values(NFL_NICKNAMES).every((a) => NFL_ABBREVS.includes(a)));
  [['chiefs', 'KC'], ['ravens', 'BAL'], ['49ers', 'SF'], ['texans', 'HOU'],
   ['commanders', 'WAS']].forEach(([nick, want]) => {
    check(`the ${nick} are ${want}`, NFL_NICKNAMES[nick] === want, NFL_NICKNAMES[nick]);
  });

  // The extension keeps its own copy because a content script cannot import.
  // It must not drift from this one.
  const ext = readFileSync(join(ROOT, 'chrome-extension/content-main.js'), 'utf8');
  const extTable = (() => {
    const at = ext.indexOf('const PRO_TEAM_BY_ID = {');
    if (at < 0) return null;
    const body = ext.slice(ext.indexOf('{', at), ext.indexOf('};', at) + 1);
    try { return new Function(`return ${body}`)(); } catch (e) { return null; }
  })();
  check("the extension's copy of the club table exists", Boolean(extTable));
  check('and agrees with this one exactly',
    JSON.stringify(extTable) === JSON.stringify(PRO_TEAM_BY_ID),
    'the two loading contexts disagree about which club an id names');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
