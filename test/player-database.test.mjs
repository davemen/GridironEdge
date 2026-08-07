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
import { toPlayerDatabase, findPlayer, playerKey } from '../js/player-database.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
