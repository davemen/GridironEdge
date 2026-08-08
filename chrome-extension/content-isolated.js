/**
 * Isolated-world half of the sync bridge.
 *
 * The MAIN-world script scrapes the draft room and postMessages the result here;
 * this forwards it to the service worker, which stores it and pushes it to the
 * app page. (It used to POST to a local web server. There is no server now.)
 *
 * That makes this listener a trust boundary. The first version checked only
 * `event.source !== window`, which any script in the same frame satisfies. The
 * origin and the payload shape are checked now as well -- but read the next
 * paragraph before believing the boundary is closed.
 *
 * WHAT THESE CHECKS DO NOT STOP. The scraper is declared world: "MAIN", the
 * page's own world, so `event.source === window` and `event.origin ===
 * TRUSTED_ORIGIN` are satisfied BY CONSTRUCTION for any script running on
 * fantasy.espn.com -- an ad, a tag manager, an XSS on ESPN. A forged
 * GRIDIRON_EDGE_SYNC still reaches the worker; an audit proved it by loading
 * this file and firing the message. A nonce would not fix it: every script in
 * a frame sees every postMessage, so a token sent that way is not a secret.
 * The only real fix is to stop carrying the data through the page's world,
 * which needs the React/Redux read in content-main.js to move or go away.
 *
 * What HAS been closed is the sweep. It used to be a request posted INTO the
 * page world, so a forged message drove the roster dropdown through every
 * option while a live auction ran -- the extension writing into the page on an
 * attacker's say-so, rather than merely reading a lie. The sweep runs here
 * now, where the page cannot reach it, and only a chrome.runtime message from
 * the app can start it.
 */

(function() {
  // One instance, guarding a double registration of this file.
  //
  // This one CAN live on window: only the manifest loads this file, and only
  // into the isolated world, so there is no second world for a copy to hide in.
  // Its sibling content-main.js is the one background.js re-injects -- into the
  // OTHER world -- which is why that file's marker has to live on the DOM. This
  // comment used to claim background.js re-injects this file; it injects the
  // other one, and the only executeScript in the repo says so.
  if (window.__GRIDIRON_EDGE_ISOLATED_INSTALLED__) return;
  window.__GRIDIRON_EDGE_ISOLATED_INSTALLED__ = true;

  const TRUSTED_ORIGIN = 'https://fantasy.espn.com';

  /**
   * Enough shape to reject anything that is not a scrape result. This is not a
   * schema validator -- it is a gate that stops arbitrary objects reaching disk.
   *
   * BYTE-IDENTICAL to the copy in background.js, and test/transport.test.mjs
   * fails if the two ever differ. A content script and a service worker cannot
   * share a module -- neither is loaded as one, and this repo has no build step
   * to inline it -- so two copies are unavoidable, and they have now drifted
   * twice in opposite directions: first the worker lacked the byte cap this
   * one had, then this one lacked the count caps the worker gained. Each time,
   * one path accepted a payload the other refused.
   *
 * Both hops stringify the payload to measure it, so a sync pays for that twice.
 * That is a deliberate trade: passing a size along would mean trusting a number
 * from the sender, and the two gates staying textually identical is what stops
 * them drifting apart again -- which has happened twice, in opposite directions.
 */
  const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
  const MAX_TEAMS = 32;
  const MAX_PICKS = 1000;

  function looksLikeAScrape(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (typeof data.leagueId !== 'string' && typeof data.leagueId !== 'number') return false;
    if (!Array.isArray(data.teams) || data.teams.length === 0) return false;
    const picks = data.draftDetail && data.draftDetail.picks;
    if (picks !== undefined && !Array.isArray(picks)) return false;
    if (data.teams.length > MAX_TEAMS) return false;
    if (picks && picks.length > MAX_PICKS) return false;
    try {
      if (JSON.stringify(data).length > MAX_PAYLOAD_BYTES) return false;
    } catch (e) {
      return false;   // circular or otherwise unserialisable
    }
    return true;
  }


  // ---------------------------------------------------------------------
  // Reading every team's roster
  //
  // These run HERE, in the isolated world, not in the scraper. They touch only
  // the DOM -- no React internals -- so nothing about them needs the page's
  // world, and being here is what makes them unreachable from it.
  //
  // findTeamSelectEl and sweepAllRosters are ONLY here -- nothing in the
  // scraper called them once the trigger moved. scrapeRosterPanel and
  // findLeagueTeamNames are byte-identical to the copies in content-main.js,
  // which still reads the live panel for the selected team and still needs the
  // team list; test/scraper.test.mjs fails if those two ever differ. Two
  // classic scripts in a repo with no build step cannot share a module, so
  // identical copies with a test behind them is the strongest available form
  // of one definition.
  // ---------------------------------------------------------------------

  /**
   * The league's team names, taken from the roster panel's own dropdown.
   *
   * An auction room usually renders no draft-results table: one live room,
   * checked directly, contained exactly two <table> elements, the queue and one
   * team's roster. Usually, not never -- findDraftSummaryContainer accepts an
   * auction results table when it finds one, and HANDOFF.md records concluding
   * "an auction renders no draft board at all" as a mistake made from a partial
   * DOM dump. So the team list often cannot be recovered from pick rows, because
   * there are none. It used to fall back to inventing eight teams
   * called "Team 1".."Team 8", which is the failure this codebase keeps
   * repeating: a fabricated league is indistinguishable on screen from a real
   * one, and every opponent budget derived from it is fiction.
   *
   * The dropdown is real data. It is identified by elimination: the room's
   * other selects are position, NFL club, season and round filters, and every
   * one of those either leads with an "All ..." option or starts with a year.
   */
  function findLeagueTeamNames() {
    try {
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        if (!sel || !sel.options || sel.options.length < 4) continue;
        const opts = Array.prototype.map.call(sel.options,
          (o) => String(o.text || '').trim()).filter(Boolean);
        if (opts.length < 4) continue;
        const isFilter = opts.some((o) => /^all\b/i.test(o)
          || /^round\s+\d/i.test(o)
          || /^\d{4}\b/.test(o));
        if (isFilter) continue;
        return opts;
      }
    } catch (e) {
      console.debug('[Gridiron Edge] read failed:', e && e.message);
    }
    return [];
  }

  /**
   * The roster on screen, as picks. Player, lineup slot and price.
   *
   * This is the only pick data an auction room actually renders. It covers one
   * team -- whichever the dropdown has selected -- so it is deliberately not
   * presented as the draft board. It is enough to fill in your own roster,
   * which was the whole of what was missing.
   *
   * The slot is a lineup position (BE and FLEX among them), not the player's
   * position, so it is reported separately and never used as one.
   */
  function scrapeRosterPanel() {
    try {
      const tables = document.querySelectorAll('table');
      for (const table of tables) {
        const rows = table.rows;
        if (!rows || rows.length < 3) continue;
        const head = Array.prototype.map.call(rows[0].cells || [],
          (c) => String(c.innerText || '').trim().toUpperCase());
        const posCol = head.indexOf('POS');
        const nameCol = head.indexOf('PLAYER');
        if (posCol === -1 || nameCol === -1) continue; // the queue table has no POS
        const priceCol = head.indexOf('$');

        const out = [];
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].cells;
          if (!cells || cells.length <= nameCol) continue;
          const name = String(cells[nameCol].innerText || '').trim();
          if (!name || /^empty$/i.test(name) || name === '-') continue;
          let bid = null;
          if (priceCol > -1 && cells[priceCol]) {
            const m = String(cells[priceCol].innerText || '').match(/\d+/);
            if (m) bid = parseInt(m[0], 10);
          }
          out.push({
            playerName: name,
            rosterSlot: String(cells[posCol].innerText || '').trim(),
            bidAmount: bid,
          });
        }
        if (out.length) return out;
      }
    } catch (e) {
      console.debug('[Gridiron Edge] roster read failed:', e && e.message);
    }
    return [];
  }

  /** The roster panel's team dropdown as an element, or null. */
  function findTeamSelectEl(teams) {
    if (!Array.isArray(teams) || teams.length < 2) return null;
    const known = teams
      .map((t) => String(t.teamName || '').trim().toLowerCase())
      .filter(Boolean);
    if (known.length < 2) return null;
    try {
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        if (!sel || !sel.options || sel.options.length < 2) continue;
        const opts = Array.prototype.map.call(sel.options,
          (o) => String(o.text || '').trim());
        const hits = opts.filter((o) => known.indexOf(o.toLowerCase()) !== -1);
        if (hits.length >= 2 && hits.length >= Math.ceil(opts.length * 0.6)) return sel;
      }
    } catch (e) {
      console.debug('[Gridiron Edge] read failed:', e && e.message);
    }
    return null;
  }

  /**
   * Read every team's roster by stepping the dropdown through the league.
   *
   * An auction renders one roster at a time, so this is the only way to see
   * the whole board without the Draft Summary tab. It is not part of the
   * ordinary scrape -- that runs many times a second, and this writes to the
   * page you are drafting in. It is asked for separately and no more than once
   * a minute; the throttle is what bounds the flicker, not any promise that it
   * only runs when a user presses something. The app asks for it by itself.
   *
   * The selection is restored in a finally block. Leaving somebody else's
   * roster on screen mid-auction is worse than not running at all -- you would
   * be reading the wrong team's needs while the clock is going.
   *
   * The <select> is React-controlled, so assigning .value is ignored: React
   * tracks the previous value on the node and skips the change. The native
   * setter has to be called directly before the event is dispatched.
   */
  // How long to wait for the roster panel to redraw before giving up on a team.
  const PANEL_SETTLE_MS = 250;

  /**
   * Resolve as soon as the roster panel changes, or after `capMs`.
   *
   * The sweep used to poll `signature()` every 60ms until a 900ms deadline, so
   * a team whose roster genuinely matched the last one cost the entire 900ms.
   * Watching the DOM answers on the repaint itself; the cap is only reached
   * when nothing happened, which is the case that has to end quickly.
   */
  function waitForPanelChange(signature, before, capMs) {
    return new Promise((resolve) => {
      let done = false;
      let observer = null;
      let timer = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        if (timer !== null) clearTimeout(timer);
        resolve(value);
      };
      try {
        observer = new MutationObserver(() => {
          const now = signature();
          if (now !== before) finish(now);
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      } catch (e) {
        // No observer available: fall back to the cap alone, which is still
        // correct, just slower for a team that did change.
        observer = null;
      }
      timer = setTimeout(() => finish(signature()), capMs);
    });
  }

  const MAX_SWEEP_TEAMS = 32;
  const MAX_SWEEP_ROWS = 2000;

  async function sweepAllRosters(teams) {
    // The lock lives HERE, on the function that writes to the page, not only on
    // its caller. runSweep held it, so anything else reaching this function --
    // or two runSweeps whose throttle had lapsed -- put two walks on one
    // dropdown, each restoring a selectedIndex the other had already moved.
    // Driven concurrently, the two returned DIFFERENT rosters for the same
    // league, which is the race the header at the top of this file describes.
    if (sweepInFlight) return { ok: false, reason: 'sweep-already-running' };
    sweepInFlight = true;
    try {
      return await sweepOnce(teams);
    } finally {
      sweepInFlight = false;
    }
  }

  async function sweepOnce(teams) {
    const sel = findTeamSelectEl(teams);
    if (!sel) return { ok: false, reason: 'no-team-dropdown' };

    const proto = (typeof window !== 'undefined' && window.HTMLSelectElement)
      ? window.HTMLSelectElement.prototype : null;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    const nativeSet = desc && desc.set;

    const originalIndex = sel.selectedIndex;
    const signature = () => JSON.stringify(scrapeRosterPanel());
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const byTeam = [];
    let rows = 0;
    let unchanged = 0;
    // Whether this sweep stopped early. The app has to be able to tell a sweep
    // that saw the league from one that gave up after two teams -- all three
    // break paths used to return ok:true with no signal at all, and the payload
    // then reported swept-rosters coverage having seen one roster.
    let truncated = false;

    try {
      // Bounded. `sel.options.length` came straight off the page, at up to
      // 900ms an option: a hostile page planting a <select> with 20,000
      // options would have held the draft room for hours. A league has at most
      // MAX_SWEEP_TEAMS teams, and anything past that is not a league.
      // Every early exit sets `truncated`, not just the unchanged-twice one.
      // Three of the four did not, so a sweep bounded by the row cap returned
      // 7 of 12 teams reporting a clean board, and one bounded by the team cap
      // returned 32 of 40 the same way -- a coverage claim about a board the
      // scraper only partly saw.
      const stop = Math.min(sel.options.length, MAX_SWEEP_TEAMS);
      if (sel.options.length > MAX_SWEEP_TEAMS) truncated = true;
      for (let i = 0; i < stop; i++) {
        const name = String(sel.options[i].text || '').trim();
        if (!name) { truncated = true; continue; }
        // And bounded in what it accumulates, for the same reason the worker
        // bounds the payload: this ends up in chrome.storage, which holds 10MB.
        if (rows >= MAX_SWEEP_ROWS) { truncated = true; break; }
        const before = signature();

        if (nativeSet) nativeSet.call(sel, sel.options[i].value);
        else sel.selectedIndex = i;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));

        // Wait for the panel to actually repaint.
        //
        // Two teams can legitimately hold identical rosters -- both empty, early
        // in an auction -- so a signature that never changes is not an error.
        // But polling it to a 900ms deadline meant every such team cost the full
        // 900ms, and "every team is empty" is precisely the state the automatic
        // sweep fires in: measured at 11,011ms for twelve teams, three times
        // over, with the roster panel cycling the whole while.
        //
        // A MutationObserver answers as soon as the panel actually redraws, so
        // the deadline is only ever paid by a team whose roster genuinely has
        // not changed -- and it is a quarter of what it was.
        const after = await waitForPanelChange(signature, before, PANEL_SETTLE_MS);
        const moved = after !== before;
        const roster = JSON.parse(after);

        // Record the team BEFORE deciding whether to stop. Bailing first meant
        // the second unchanged team and everything after it was dropped: the
        // all-rosters-empty case -- the state the automatic sweep fires in --
        // returned one team of twelve and then reported swept-rosters coverage
        // having seen one.
        //
        // But only when the panel is trustworthy. A non-empty panel that did not
        // repaint is still showing the PREVIOUS team's roster, and pushing it
        // credits this team with somebody else's players -- worse than not
        // reporting them. Two cases are trustworthy without a repaint: an empty
        // panel (nothing to confuse it with) and the team that was ALREADY
        // selected when the sweep started, whose roster is what is on screen.
        // `i === originalIndex` is only trustworthy while NOTHING has moved
        // yet. Once the sweep has stepped the dropdown away, a panel that did
        // not repaint is showing the PREVIOUS team -- and with the room opened
        // on any team but the first, that credited a team with somebody else's
        // roster while reporting a clean sweep.
        const stillOnTheOriginalPanel = i === originalIndex && byTeam.length === 0;
        if (moved || roster.length === 0 || stillOnTheOriginalPanel) {
          rows += roster.length;
          byTeam.push({ teamName: name, roster });
        } else {
          truncated = true;
        }

        if (!moved) {
          // Two in a row that did not move means the panel is not repainting
          // for us at all -- likelier than every remaining team being
          // identical. Stop rather than burning the deadline once per team.
          if (++unchanged >= 2) { truncated = true; break; }
        } else {
          unchanged = 0;
        }
      }
    } finally {
      if (nativeSet && sel.options[originalIndex]) {
        nativeSet.call(sel, sel.options[originalIndex].value);
      } else {
        sel.selectedIndex = originalIndex;
      }
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    return { ok: true, byTeam, truncated };
  }

  // The sweep writes into the page you are drafting in, so it is bounded: one
  // at a time, and no more than once a minute. These locks live here rather
  // than in the scraper because there they were closure locals in a file the
  // worker re-injects -- so a second injection created a second set of locks,
  // and two sweeps raced to restore the dropdown.
  let sweepInFlight = false;
  let sweepLastAt = 0;
  const SWEEP_MIN_GAP_MS = 60 * 1000;

  async function runSweep() {
    if (sweepInFlight) return;
    if (Date.now() - sweepLastAt < SWEEP_MIN_GAP_MS) return;
    // Stamped BEFORE the await, not after. Setting it on the way out meant a
    // throw skipped it entirely, so the once-a-minute floor did not apply to a
    // sweep that failed: 25 sweeps in 0ms against a 60s minimum, into a live
    // draft room.
    sweepLastAt = Date.now();
    try {
      const teams = findLeagueTeamNames().map((teamName) => ({ teamName }));
      const res = await sweepAllRosters(teams);
      if (!res || !res.ok) {
        console.warn('[Gridiron Edge Sync] Sweep did not run:', res && res.reason);
        return;
      }
      // Handed to the scraper as data, because the scraper is what assembles
      // the payload. This grants the page nothing it did not already have --
      // it could forge a whole sync before, and this is a strictly smaller lie
      // -- while removing what it could do: make the extension operate the
      // dropdown of a draft room mid-auction.
      window.postMessage({
        type: 'GRIDIRON_EDGE_SWEEP_RESULT',
        byTeam: res.byTeam,
        truncated: Boolean(res.truncated),
        sweptAt: new Date().toISOString(),
      }, TRUSTED_ORIGIN);
    } catch (e) {
      console.warn('[Gridiron Edge Sync] Sweep failed:', e && e.message);
    }
  }

  // The build marker goes in the log line on purpose. Content scripts are
  // injected at page load, so a draft room opened before an extension update
  // keeps running the old code -- and it keeps scraping, so nothing looks
  // wrong while a newly added message route is simply absent. Printing the
  // build makes "is this tab running the new scraper?" answerable.
  console.log("[Gridiron Edge Sync] Isolated script initialized (2026.08.07-sweep).");

  window.addEventListener('message', (event) => {
    // Same frame AND the right site. event.source alone proves almost nothing:
    // every script in this frame shares this window.
    if (event.source !== window) return;
    if (event.origin !== TRUSTED_ORIGIN) return;

    // The MAIN-world scraper saying it exists. Relayed so the worker stops
    // injecting a second copy into a tab that already has a working one.
    if (event.data && event.data.type === 'GRIDIRON_EDGE_MAIN_ALIVE') {
      try {
        if (chrome.runtime && chrome.runtime.id) chrome.runtime.sendMessage({ action: 'mainAlive' });
      } catch (err) {
        console.debug('[Gridiron Edge Sync] could not relay the scraper ping:', err.message);
      }
      return;
    }

    if (event.data && event.data.type === 'GRIDIRON_EDGE_SYNC') {
      if (!looksLikeAScrape(event.data.data)) {
        console.warn('[Gridiron Edge Sync] Ignored a sync message that is not a league payload.');
        return;
      }
      try {
        // Test if context is valid
        if (!chrome.runtime || !chrome.runtime.id) {
          showRefreshBanner();
          return;
        }
        // Forward securely to background.js using MV3 runtime APIs
        chrome.runtime.sendMessage({ action: 'sync', data: event.data.data });
      } catch (err) {
        console.warn("[Gridiron Edge Sync] Failed to forward sync message to background:", err.message);
        showRefreshBanner();
      }
    }
  });

  /**
   * Relay a "scan all rosters" request to the scraper, and its answer back.
   *
   * The scraper is declared world: "MAIN", where chrome.runtime does not
   * exist -- so a chrome.runtime.onMessage listener placed there never
   * registers, and the request reached the tab and was answered by nobody.
   * That surfaced as "the draft room did not respond".
   *
   * This half is the one with extension APIs, so the request lands here and
   * crosses to the scraper by postMessage on the shared window.
   *
   * Nothing is sent back along this channel. Replying meant holding the
   * message port open across an await with `return true`, and Safari does not
   * keep it: the caller's callback fired with no result and no lastError, so a
   * sweep that was about to run reported "the draft room did not respond".
   *
   * The sweep's result travels the ordinary sync route instead -- the same one
   * carrying every pick -- so the app finds out it worked by the picks
   * arriving. That is the only evidence worth reporting anyway: a success
   * message from a scraper that then produced nothing would be worse than no
   * message at all.
   */
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.action !== 'sweepRosters') return false;
      runSweep();
      // No reply, deliberately -- see above. `false` closes the channel now
      // rather than leaving the sender waiting on one that will never answer.
      return false;
    });
  }

  function showRefreshBanner() {
    if (document.getElementById('gridiron-refresh-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'gridiron-refresh-banner';
    banner.style.position = 'fixed';
    banner.style.top = '10px';
    banner.style.left = '50%';
    banner.style.transform = 'translateX(-50%)';
    banner.style.backgroundColor = '#d50000';
    banner.style.color = '#ffffff';
    banner.style.textAlign = 'center';
    banner.style.padding = '12px 24px';
    banner.style.fontSize = '14px';
    banner.style.fontFamily = 'Inter, system-ui, sans-serif';
    banner.style.fontWeight = '700';
    banner.style.borderRadius = '8px';
    banner.style.boxShadow = '0 4px 20px rgba(0,0,0,0.4)';
    banner.style.zIndex = '999999';
    banner.style.border = '2px solid rgba(255,255,255,0.2)';
    
    // Built rather than templated, and the handler is bound rather than inlined:
    // an inline onclick in an extension-injected banner is the same hazard the
    // app was just cleaned of.
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:12px;';
    const label = document.createElement('span');
    label.textContent = '🔄 Gridiron Edge Sync Extension reloaded.';
    const btn = document.createElement('button');
    btn.textContent = 'Refresh Page to Sync';
    btn.style.cssText = 'background:#ffffff; color:#d50000; border:none; padding:6px 12px;'
      + 'border-radius:4px; font-weight:700; cursor:pointer; font-size:12px;';
    btn.addEventListener('click', () => window.location.reload());
    row.appendChild(label);
    row.appendChild(btn);
    banner.appendChild(row);
    document.body.appendChild(banner);
  }
})();
