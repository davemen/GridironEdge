/**
 * Load the app's real module graph under a stub DOM.
 *
 * Exits non-zero if anything throws while importing, which is what a browser
 * would hit before rendering a single pixel. Driven by syntax.test.mjs; run it
 * directly to see the actual error.
 */
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const mk = () => ({
  style: {},
  classList: { add() {}, remove() {}, contains() { return false; } },
  children: [], innerHTML: '', innerText: '', textContent: '', value: '',
  addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
  insertBefore() {}, setAttribute() {}, getAttribute() { return null; },
  querySelector: () => mk(), querySelectorAll: () => [], closest: () => null, focus() {},
});

globalThis.document = {
  body: mk(), documentElement: mk(),
  getElementById: () => mk(), querySelector: () => mk(), querySelectorAll: () => [],
  createElement: () => mk(), addEventListener() {},
};
globalThis.window = globalThis;
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
globalThis.setInterval = () => 0;

const base = new URL('../js/', import.meta.url).href;
await import(base + 'app.js');
