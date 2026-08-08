"""
Set the `fixed` flag in audit/history.json from the tree, not from memory.

Round 6 was recorded as 55 of 71 fixed by the session that wrote the fixes.
Round 7 checked, and six of those had been marked against a file the diff
showed was never edited -- so the ledger the next round was told to trust was
itself a finding. This script exists so the flag is a measurement.

Each entry is a check that must pass against the CURRENT tree. A finding with
no check, or a check that fails, is left open; the flag is removed rather than
kept, so a fix that regresses un-marks itself on the next run.

Two rules learned writing it:

  - read code, not prose. Four checks failed on comments that RECORD the bug
    they fixed -- which is the shape CLAUDE.md asks for -- so `code()` strips
    comments before grepping. "draftedAtPick" surviving in a comment that says
    it was deleted is the fix, not the bug.
  - one check per finding, matched to what the finding actually says. I first
    marked "Dead code census" -- 61 exports with no importer -- as fixed
    because a single unrelated constant had been removed. It is open.

Run: python3 audit/verify-fixes.py && node audit/build-report.mjs
"""
import subprocess, os, json
ROOT='/Users/davemendlen/Documents/Projects/GridironEdge'
def read(f): return open(os.path.join(ROOT,f)).read()
import re
def code(f):
    """The file with comments stripped. Four of my first checks failed on
    comments that RECORD the bug they fixed, which is the shape this repo
    asks for -- so a fix ledger must read code, not prose."""
    t = read(f)
    t = re.sub(r'/\*.*?\*/', '', t, flags=re.S)
    t = re.sub(r'^\s*(//|\s\*).*$', '', t, flags=re.M)
    t = re.sub(r'//.*$', '', t, flags=re.M)
    return t
def sh(c): return subprocess.run(c, shell=True, cwd=ROOT, capture_output=True, text=True).stdout

CHECKS = {
 # ---- security
 ('security',0): lambda: 'pwd -P' in read('tools/package-extension.sh') and 'DEST_REAL' in read('tools/package-extension.sh'),
 ('security',1): lambda: '__GRIDIRON_EDGE_MAIN_INSTALLED__' in read('chrome-extension/content-main.js')
                          and 'documentElement.dataset' not in code('chrome-extension/content-main.js'),
 ('security',2): lambda: 'stillOnTheOriginalPanel = i === originalIndex && byTeam.length === 0' in read('chrome-extension/content-isolated.js'),
 ('security',3): lambda: 'draftedAtPick' not in code('js/store.js'),
 ('security',4): lambda: False,   # XSS sink reach -- NOT done
 ('security',5): lambda: "from '../js/escape.js'" in read('audit/build-report.mjs')
                          and 'replace(/&/g' not in read('audit/build-report.mjs'),
 # The Apple Team ID. This check used to name it, which put the secret back
 # into a tracked file in the very line asserting it was gone -- and made this
 # script the only occurrence of it in the working tree. A pattern cannot leak
 # what it matches: an Apple Team ID is ten upper-case alphanumerics, and the
 # word-boundary form is narrow enough not to fire on prose.
 ('security',6): lambda: not re.search(r'\b[A-Z][A-Z0-9]{9}\b', read('audit/history.json')),
 ('security',7): lambda: '--bind 127.0.0.1' in read('package.json'),
 ('security',8): lambda: 'coveragePartial' in read('js/engine/auction-advisor.js'),
 ('security',9): lambda: "'https://fantasy.espn.com'" in read('chrome-extension/content-isolated.js'),
 # ---- tests
 ('tests',0): lambda: sh('npm test 2>&1 | grep -c "^ℹ fail 0"').strip() == '1',
 ('tests',1): lambda: 'if (sel.options.length > MAX_SWEEP_TEAMS) truncated = true;' in read('chrome-extension/content-isolated.js')
                       and 'the row cap stops the sweep' in read('test/scraper.test.mjs'),
 ('tests',2): lambda: False,
 ('tests',3): lambda: 'two strong QBs in a one-QB league is a surplus' in read('test/engines.test.mjs'),
 ('tests',4): lambda: 'thirteen adjustments' in read('test/engines.test.mjs')
                       and 'a questionable starter gets a named replacement plan' in read('test/engines.test.mjs'),
 ('tests',5): lambda: "JSON.stringify(['ARI'])" in read('test/player-database.test.mjs'),
 ('tests',6): lambda: 'the observer path actually ran' in read('test/scraper.test.mjs'),
 ('tests',7): lambda: False,
 ('tests',8): lambda: False,
 ('tests',9): lambda: 'a bracket with no projections declines' in read('test/engines.test.mjs'),
 ('tests',10): lambda: False,
 ('tests',11): lambda: os.path.exists(os.path.join(ROOT,'test/dom-stub.mjs'))
                        and "from './dom-stub.mjs'" in read('test/xss.test.mjs')
                        and "from './dom-stub.mjs'" in read('test/render.test.mjs'),
 ('tests',12): lambda: all('const num = (v, d = 0)' not in code(f'js/engine/{n}')
                             for n in ('auction-advisor.js','bracket-strategy.js','team-strength.js',
                                       'news-monitor.js','roster-manager.js'))
                        and 'one coercion from' in read('test/engines.test.mjs'),
 ('tests',13): lambda: False,
 ('tests',14): lambda: False,
 ('tests',15): lambda: False,
 ('tests',16): lambda: False,
 # ---- performance
 ('performance',0): lambda: 'lineupShape' in read('js/engine/auction-advisor.js'),
 ('performance',1): lambda: 'dbRevision' in read('js/engine/auction-advisor.js'),
 ('performance',2): lambda: False,
 ('performance',3): lambda: 'DRAFT_SEARCH_DEBOUNCE_MS' in read('js/app.js'),
 ('performance',4): lambda: 'coveragePartial' in read('js/engine/auction-advisor.js'),
 ('performance',5): lambda: False,
 ('performance',6): lambda: sh("grep -c 'el.innerText ? el.innerText' chrome-extension/content-main.js").strip() in ('0','1')
                             and 'at most once per element' in read('test/scraper.test.mjs'),
 ('performance',7): lambda: False,
 ('performance',8): lambda: 'draftedAtPick' not in code('js/store.js'),
 ('performance',9): lambda: False,
 # ---- documentation
 ('documentation',0): lambda: '43%' not in code('js/engine/survival.js')
                          and 'own column still reads 9 / 75 / 91' in read('test/engines.test.mjs'),
 ('documentation',1): lambda: 'pick 40 and pick 35' in read('js/engine/survival.js'),
 ('documentation',2): lambda: 'HANDOFF states the real line count' in read('test/render.test.mjs'),
 ('documentation',3): lambda: False,
 ('documentation',4): lambda: 'nothing in the shipped app supplies one' in read('BACKTEST.md'),
 ('documentation',5): lambda: sh('npm test 2>&1 | grep -c "^ℹ fail 0"').strip() == '1',
 ('documentation',6): lambda: 'the mock database is smaller than one league' in read('test/auction-advisor.test.mjs'),
 ('documentation',7): lambda: 'const currentWeek = Math.max(1' in read('js/engine/simulator.js'),
 ('documentation',8): lambda: os.path.exists(os.path.join(ROOT,'js/engine/scoring-model.js')),
 ('documentation',9): lambda: False,
 ('documentation',10): lambda: False,
 ('documentation',11): lambda: False,
 ('documentation',12): lambda: False,
 ('documentation',13): lambda: False,
 # ---- readability
 ('readability',0): lambda: False,
 ('readability',1): lambda: 'byeCount' in read('js/engine/simulator.js') and 'byeCount' in read('js/engine/team-strength.js'),
 ('readability',2): lambda: 'Still open after this pick' in read('js/engine/draft-assistant.js'),
 ('readability',3): lambda: False,
 ('readability',4): lambda: 'if (!name) { truncated = true; continue; }' in read('chrome-extension/content-isolated.js'),
 ('readability',5): lambda: 'the only caller repo-wide is loadMockLeague' not in read('js/store.js'),
 ('readability',6): lambda: False,
 ('readability',7): lambda: False,
 ('readability',8): lambda: False,
 ('readability',9): lambda: 'Module-private, and that is the point' in read('js/engine/lineup-rules.js'),
 ('readability',10): lambda: 'hasOwnProperty' in read('js/store.js'),
 ('readability',11): lambda: False,   # the 61-dead-export census: not started
 ('readability',12): lambda: False,
}

h=json.load(open(os.path.join(ROOT,'audit/history.json')))
r=h['rounds'][-1]
fixed=0; total=0
for cat,v in r['categories'].items():
    for i,f in enumerate(v.get('findings') or []):
        total+=1
        chk = CHECKS.get((cat,i))
        ok = bool(chk and chk())
        if ok:
            f['fixed']=True; fixed+=1
        else:
            f.pop('fixed', None)
        print(f"{'FIXED ' if ok else '  open'} {cat}[{i}] {f.get('title','')[:70]}")
print(f"\n{fixed} of {total} verified fixed")
json.dump(h, open(os.path.join(ROOT,'audit/history.json'),'w'), indent=2)
