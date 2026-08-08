/**
 * Gridiron Edge — draft room diagnostic.
 *
 * Paste this whole file into the DevTools console while sitting in an ESPN
 * draft room, then copy the output back.
 *
 * Every scraper bug so far has come from guessing at ESPN's markup rather than
 * reading it. This reports exactly what each part of the scraper can and cannot
 * see, so the selectors can be aimed at the real page instead of an assumed one.
 *
 * It only reads the page -- nothing is clicked, submitted or sent anywhere. It does copy its own output to the clipboard.
 */
(function gridironDiagnose() {
  const out = { url: location.href, title: document.title, when: new Date().toISOString() };
  const clip = (s, n = 220) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

  // ---- 1. The nomination card: where the live bid should be
  const CARD_SELECTORS = [
    '.pickArea [data-testid="player-selected"]',
    '.pickArea .player-selected',
    '.pickArea',
    '[class*="pickArea" i]',
    '[class*="nomination" i]',
    '[class*="auctionPlayer" i]',
    '[data-testid*="auction" i]',
  ];
  out.nominationCard = CARD_SELECTORS.map((sel) => {
    let el = null;
    try { el = document.querySelector(sel); } catch (e) { return { sel, error: e.message }; }
    if (!el) return { sel, found: false };
    return {
      sel, found: true,
      className: clip(el.className, 120),
      text: clip(el.innerText, 300),
      dollarTokens: (el.innerText || '').match(/\$\s?\d+/g) || [],
    };
  });

  // ---- 2. Anything on the page that looks like a bid control
  const bidGuesses = [];
  try {
    document.querySelectorAll(
      '[data-testid*="bid" i], [class*="bid" i], [id*="bid" i], [aria-label*="bid" i]'
    ).forEach((el) => {
      const t = clip(el.innerText, 60);
      if (!t || t.length > 60) return;
      bidGuesses.push({
        tag: el.tagName.toLowerCase(),
        className: clip(el.className, 80),
        testid: el.getAttribute('data-testid') || null,
        text: t,
      });
    });
  } catch (e) { /* a probe, not a requirement: the row below reports what was found */ }
  out.bidCandidates = bidGuesses.slice(0, 25);

  // ---- 3. The results table the pick scraper needs
  const tables = [];
  try {
    document.querySelectorAll('div, table, tbody').forEach((el) => {
      if (!el || !el.children.length) return;
      const text = el.innerText ? el.innerText.trim() : '';
      if (text.length >= 15000 || text.length < 40) return;
      if (!text.includes('PLAYER') && !text.includes('Player')) return;
      const prices = (text.match(/\$\d+/g) || []).length;
      const hasRound = /\bRound\s+1\b/.test(text);
      if (!hasRound && prices < 3) return;
      tables.push({
        tag: el.tagName.toLowerCase(),
        className: clip(el.className, 90),
        len: text.length,
        hasRound, priceTokens: prices,
        firstRows: text.split('\n').slice(0, 6).map((r) => clip(r, 90)),
      });
    });
  } catch (e) { /* a probe, not a requirement: the row below reports what was found */ }
  tables.sort((a, b) => a.len - b.len);
  out.resultsTables = tables.slice(0, 4);
  out.resultsTableFound = tables.length > 0;

  // ---- 4. Team budgets
  const budgets = [];
  try {
    document.querySelectorAll('div, li, tr').forEach((el) => {
      if (!el || el.children.length === 0 || el.children.length > 6) return;
      const lines = (el.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean);
      if (lines.length < 2 || lines.length > 3) return;
      if (!/^\$\d+$/.test(lines[1])) return;
      budgets.push({ team: clip(lines[0], 40), budget: lines[1] });
    });
  } catch (e) { /* a probe, not a requirement: the row below reports what was found */ }
  out.budgetRows = budgets.slice(0, 14);
  out.budgetRowsFound = budgets.length;

  // ---- 5. Is a framework store present (the preferred, non-DOM path)?
  try {
    const root = document.querySelector('#fantasy-app, #root, [id*="app" i]');
    const keys = root ? Object.keys(root) : [];
    out.reactKeyPresent = keys.some((k) => k.startsWith('__react'));
  } catch (e) { out.reactKeyPresent = 'error'; }

  // ---- 6. Verdict
  out.verdict = {
    canReadNomination: out.nominationCard.some((c) => c.found && c.text),
    canReadLiveBid: out.nominationCard.some((c) => c.found && c.dollarTokens.length)
      || out.bidCandidates.length > 0,
    canReadResultsTable: out.resultsTableFound,
    canReadBudgets: budgets.length >= 2,
  };

  const json = JSON.stringify(out, null, 1);
  console.log('%c GRIDIRON EDGE DIAGNOSTIC ', 'background:#00e5ff;color:#000;font-weight:bold');
  console.log(out.verdict);
  console.log(json);
  try {
    copy(json);
    console.log('%c Copied to clipboard — paste it back. ', 'background:#16c784;color:#000');
  } catch (e) {
    console.log('Select the JSON above and copy it manually.');
  }
  return out.verdict;
})();
