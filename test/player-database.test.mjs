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
const hit = (n, pos, team) => findPlayer(db, n, pos, team);

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
  check('B. Robinson', hit('B. Robinson', 'RB', 'ATL')?.name === 'Bijan Robinson');
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

console.log('\nteam defenses');
{
  // A draft room says "Texans D/ST"; the consensus says "Houston Texans".
  ['Texans D/ST', 'Houston Texans D/ST', 'Houston Texans', 'Texans DST'].forEach((n) => {
    check(`resolves "${n}"`, hit(n, 'D/ST')?.name === 'Houston Texans');
  });
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
