/**
 * Every shipped module must actually parse, and the app must actually boot.
 *
 * Run: node test/syntax.test.mjs
 *
 * This exists because a broken build shipped. `node --check file.js` was being
 * used to verify edits, and on a project with no package.json it treats the
 * file as CommonJS, hits the first `import` statement, and -- rather than
 * failing -- exits 0 without reading the rest. It reported success on a file
 * containing `const a = ;`. So a dangling `else` went out, app.js threw at load,
 * and the interface fell back to the setup screen that index.html ships as the
 * default view. Nothing else caught it: the engine tests import the engines
 * directly and never touch app.js.
 *
 * The fix is to parse as an ES module, which is what the browser does, and then
 * to load the real module graph so a bad import path or a throw at module scope
 * is caught here rather than by someone looking at a blank app.
 */
import { readdirSync, statSync, writeFileSync, mkdtempSync, cpSync } from 'fs';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function walk(dir, out = []) {
  readdirSync(dir).forEach((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith('.js')) out.push(p);
  });
  return out;
}

console.log('\nevery module parses as an ES module');
{
  // A scratch copy marked "type": "module", so node parses these the way a
  // browser does instead of silently bailing at the first import.
  const tmp = mkdtempSync(join(tmpdir(), 'ge-syntax-'));
  cpSync(join(ROOT, 'js'), join(tmp, 'js'), { recursive: true });
  writeFileSync(join(tmp, 'package.json'), '{"type":"module"}');

  const files = walk(join(ROOT, 'js'));
  check('found the source files', files.length > 5, `${files.length} found`);

  const broken = [];
  files.forEach((f) => {
    const rel = relative(ROOT, f);
    try {
      execFileSync(process.execPath, ['--check', join(tmp, rel)], { stdio: 'pipe' });
    } catch (e) {
      broken.push(`${rel}: ${String(e.stderr || e.message).split('\n').find((x) => x.includes('Error')) || 'parse failed'}`);
    }
  });
  check('no module has a syntax error', broken.length === 0, broken.join(' | '));

  // Guard the guard: the checker must actually reject broken source. If this
  // ever passes silently again, the suite is not protecting anything.
  writeFileSync(join(tmp, 'js', '__canary.js'), 'import x from "./store.js";\nconst a = ;\n');
  let rejected = false;
  try { execFileSync(process.execPath, ['--check', join(tmp, 'js', '__canary.js')], { stdio: 'pipe' }); }
  catch (e) { rejected = true; }
  check('the syntax check rejects broken source', rejected);
}

console.log('\nevery extension script parses too');
{
  // The extension was never parsed by anything in this suite, so every scraper
  // change shipped unchecked -- including one that called .add() on a Map and
  // silently killed all pick parsing.
  //
  // These are CLASSIC scripts, and checking them "in place" got that backwards:
  // the root package.json says "type":"module", so node applied module rules to
  // them. Proven in a copy -- a file with top-level `await` and `export`
  // PASSED, and a sloppy-mode `with` statement FAILED. So an import added to
  // content-main.js, which a browser rejects outright in a classic content
  // script, sailed through the gate that exists to catch exactly that.
  //
  // A scratch copy marked "type":"commonjs" parses them as what they are, the
  // mirror image of what the module block above does.
  const extFiles = walk(join(ROOT, 'chrome-extension'));
  check('found the extension scripts', extFiles.length >= 3, `${extFiles.length} found`);
  const classicTmp = mkdtempSync(join(tmpdir(), 'ge-classic-'));
  writeFileSync(join(classicTmp, 'package.json'), '{"type":"commonjs"}');
  const broken = [];
  extFiles.forEach((f) => {
    const dest = join(classicTmp, relative(ROOT, f).replace(/[\\/]/g, '_'));
    cpSync(f, dest);
    try {
      execFileSync(process.execPath, ['--check', dest], { stdio: 'pipe' });
    } catch (e) {
      broken.push(relative(ROOT, f));
    }
  });
  check('no extension script has a syntax error', broken.length === 0, broken.join(', '));

  // And the checker must reject what a classic script cannot contain, or it is
  // the same silent pass in a new place.
  const esmProbe = join(classicTmp, '__esm_probe.js');
  writeFileSync(esmProbe, 'export const x = 1;\n');
  let rejectedEsm = false;
  try { execFileSync(process.execPath, ['--check', esmProbe], { stdio: 'pipe' }); }
  catch (e) { rejectedEsm = true; }
  check('and an ES module is rejected as a classic script', rejectedEsm,
    'a content script with `export` would parse, and the browser would refuse it');
}

console.log('\nthe app boots');
{
  // Loading the real module graph catches a bad import path or anything that
  // throws at module scope -- neither of which a syntax check can see.
  let err = null;
  try {
    execFileSync(process.execPath, [join(ROOT, 'test', 'boot.mjs')], { stdio: 'pipe' });
  } catch (e) {
    err = String(e.stderr || e.message).trim().split('\n').slice(-6).join(' ');
  }
  check('app.js loads without throwing', err === null, err || '');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
