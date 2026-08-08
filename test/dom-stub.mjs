/**
 * The DOM stub, in one place.
 *
 * render.test.mjs and xss.test.mjs each grew their own, and they diverged in
 * the ways that decide what a test can see. render's had learned, over several
 * audits, that innerHTML and
 * textContent are two views of one content, that writing either destroys the
 * children, that getAttribute must be backed by a map, that querySelector must
 * cache per selector, and that getElementById has to be able to answer null.
 * xss.test.mjs -- the SECURITY suite -- had none of those, so the weaker stub
 * was the one guarding the escaping.
 *
 * That is the whole cost of a forked fixture: it is not the duplication, it is
 * that a lesson learned in one copy does not reach the other. Each comment
 * below records the bug that produced it.
 *
 * espn-client.test.mjs keeps its own two-line document deliberately. It needs
 * `querySelector` to answer null -- it is testing the mappers, not a render --
 * and this stub answers with an element for every selector by design. A stub
 * that is genuinely a different shape is not a fork.
 */

/**
 * Every write, whichever sink made it. render.test.mjs asks "did this panel
 * receive content", and textContent counts.
 */
export const written = new Map();

/**
 * innerHTML writes ONLY.
 *
 * The two sinks are not equivalent and an escaping suite must not treat them
 * as one: `el.textContent = '<img src=x onerror=alert(1)>'` puts that string
 * on screen as text and is the CORRECT handling, while the same string through
 * innerHTML is the bug. xss.test.mjs scans this map; unifying the two produced
 * three false failures the moment the suites shared a stub, which is a fair
 * warning about what a shared fixture has to keep distinct.
 */
export const htmlWritten = new Map();
const mem = new Map();

/** A localStorage that is a Map, installed on globalThis. */
export function installLocalStorage() {
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

export function makeEl(id) {
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
      htmlWritten.set(id, String(v));
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
export const elCache = new Map();

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
export const absent = new Set();
export const getEl = (id) => {
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
/**
 * Install the stub as globalThis.document.
 *
 * `createElement` gives every element its own id. They all shared the id
 * 'created' in xss.test.mjs, and `written` is keyed by id -- so each row of a
 * table overwrote the last and only the FINAL row was ever scanned. A hostile
 * value in any earlier row was invisible, which is how a raw ${t.record.wins}
 * in the standings passed: the hostile team was not the last one rendered.
 */
let createdCount = 0;
export function installDocument() {
  globalThis.document = {
    body: makeEl('body'), documentElement: makeEl('html'),
    getElementById: (id) => getEl(id),
    querySelector: (sel) => getEl(sel), querySelectorAll: () => [],
    createElement: () => makeEl(`created:${++createdCount}`), addEventListener() {},
  };
  return globalThis.document;
}
