// Main world content script for Gridiron Edge ESPN Sync extension
// Accesses the page's React/Redux store directly and posts updates to the isolated content script

(function() {
  // One instance per world. This file is declared as a content script AND
  // injected by background.js as a fallback when a tab completes without
  // reporting a sync -- which a pre-draft lobby always does, because the
  // scraper deliberately sends nothing when the room is quiet. So the second
  // injection is the normal case. Each copy installed its own MutationObserver
  // and its own interval, doubling the scrape cost of every tick.
  if (window.__GRIDIRON_EDGE_MAIN_INSTALLED__) return;
  try { window.__GRIDIRON_EDGE_MAIN_INSTALLED__ = true; } catch (e) {
    // A page can refuse the write, and a page that wants to break its own
    // draft room does not need our help to do it.
    console.debug('[Gridiron Edge] sentinel write failed:', e && e.message);
  }

  // Version marker: lets a console check confirm whether Chrome is running the
  // current content script or a cached older one, which is the first thing to
  // rule out when a fix appears to have had no effect.
  try { window.__GRIDIRON_EDGE_VERSION__ = '2026.08.07-sweep'; } catch (e) {
          // Best effort: this reads the page and the page is not ours.
          console.debug('[Gridiron Edge] read failed:', e && e.message);
        }
  console.log("[Gridiron Edge Sync] Main world script initialized (" + window.__GRIDIRON_EDGE_VERSION__ + ").");

  /**
   * The 32 clubs, once per file.
   *
   * This table existed twice in here verbatim -- as a 32-branch if/else chain
   * for D/ST rows and again as NFL_NICKNAMES for the pick parser -- plus three
   * more copies under js/. No two had drifted, but adding a
   * franchise was a five-file edit and a wrong club silently picks the wrong
   * player out of two who share a surname.
   *
   * It cannot import js/nfl-teams.js: content scripts are classic scripts with
   * no module loader, and this repo has no build step to inline one. So the
   * rule is one copy per loading context, and this is the extension's.
   */
  const NFL_NICKNAMES = {
    patriots: 'NE', ravens: 'BAL', '49ers': 'SF', bills: 'BUF', cowboys: 'DAL',
    dolphins: 'MIA', jets: 'NYJ', eagles: 'PHI', chiefs: 'KC', raiders: 'LV',
    broncos: 'DEN', chargers: 'LAC', vikings: 'MIN', bears: 'CHI', packers: 'GB',
    lions: 'DET', buccaneers: 'TB', saints: 'NO', falcons: 'ATL', panthers: 'CAR',
    commanders: 'WAS', giants: 'NYG', cardinals: 'ARI', seahawks: 'SEA', rams: 'LAR',
    jaguars: 'JAX', colts: 'IND', titans: 'TEN', texans: 'HOU', steelers: 'PIT',
    browns: 'CLE', bengals: 'CIN',
  };

  /** ESPN's proTeamId space, as ESPN publishes it. */
  const PRO_TEAM_BY_ID = { 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL',
    7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV',
    14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ',
    21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB',
    28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU' };

  /**
   * An element's text, read ONCE.
   *
   * `el.innerText ? el.innerText.trim() : ''` evaluates the accessor twice,
   * and innerText forces layout every time it is touched. This shape appeared
   * at every point in the scrape that walks the room, so a tick that visited
   * 3,181 nodes made 13,976 innerText reads.
   *
   * Measured in real headless Chrome against a synthetic room of that size:
   * reading once and computing the team name lazily took 27 bid ticks from
   * 205ms of blocked main thread to 93ms. That is time blocked inside ESPN's
   * own page, next to the bid clock. The scraped output is unchanged -- proven
   * by running both versions over the same rows and diffing, which is the
   * comparison CLAUDE.md asks for before an optimisation counts.
   */
  function readText(el) {
    if (!el) return '';
    const t = el.innerText;
    return t ? t.trim() : '';
  }

  /** The club a defense name refers to, or null if the name names no club. */
  function clubFromName(name) {
    const lower = String(name || '').toLowerCase();
    const hit = Object.keys(NFL_NICKNAMES).find((nick) => lower.includes(nick));
    return hit ? NFL_NICKNAMES[hit] : null;
  }

  let lastSyncKey = null;

  // The result of the last "scan all rosters" sweep, and when it was taken.
  // A snapshot, not a feed: it is correct as of sweptAt and goes stale with
  // every pick after it, so the app is told the time rather than left to
  // assume the board is current.
  let sweptRosters = null;
  let sweptAt = 0;

  function findCurrentNomination() {
    try {
      const card = document.querySelector('.pickArea [data-testid="player-selected"], .pickArea .player-selected, .pickArea');
      if (!card) return null;

      const nameEl = card.querySelector('.playerinfo__playername');
      const teamEl = card.querySelector('.playerinfo__playerteam');
      const posEl = card.querySelector('.playerinfo__playerpos');

      if (nameEl) {
        const name = readText(nameEl);
        let team = readText(teamEl).toUpperCase() || 'FA';
        let position = readText(posEl).toUpperCase() || 'RB';

        if (name && name.length >= 2 && name.length <= 40) {
          if (position === 'D/ST') team = clubFromName(name) || team;
          // The live bid, read from ESPN's actual markup rather than inferred.
          // The draft room renders:
          //   <div data-testid="bidding-form" class="bidding-form__container">
          //     <div class="current-amount">Current offer: $35</div>
          //     <div class="manual-bid">Manual offer (max $99)</div>
          //
          // ".current-amount" is the number that ticks up as people bid, and
          // ".manual-bid" carries the most this manager can still afford, which
          // is worth having because it is ESPN's own answer to the budget
          // question the advisor otherwise computes itself.
          let bid = null;
          let maxAffordable = null;
          try {
            // There can be more than one ".current-amount" on the page -- bid
            // history rows carry the same class -- and taking the first found a
            // stale or opening value like $1 while the live offer was far
            // higher. Collect every candidate and take the largest, preferring
            // the one inside the bidding form when it exists.
            const amountEls = [
              ...document.querySelectorAll('[data-testid="bidding-form"] .current-amount'),
              ...(card ? card.querySelectorAll('.current-amount') : []),
              ...document.querySelectorAll('.current-amount'),
            ];
            const seenAmounts = [];
            amountEls.forEach(el => {
              const t = el && el.innerText ? el.innerText : '';
              const m = t.match(/\$\s?([\d,]+)/);
              if (m) seenAmounts.push(parseInt(m[1].replace(/,/g, ''), 10));
            });
            if (seenAmounts.length) bid = Math.max(...seenAmounts);

            const maxEl = card.querySelector('.manual-bid')
              || document.querySelector('[data-testid="bidding-form"] .manual-bid')
              || document.querySelector('.manual-bid');
            if (maxEl && maxEl.innerText) {
              const m = maxEl.innerText.match(/max\s*\$\s?([\d,]+)/i);
              if (m) maxAffordable = parseInt(m[1].replace(/,/g, ''), 10);
            }

            // Only if the labelled elements are missing does it fall back to
            // scanning the card for a dollar figure.
            if (bid === null) {
              const all = (card.innerText || '').match(/\$\s?\d+/g) || [];
              if (all.length) {
                bid = Math.max(...all.map(t => parseInt(t.replace(/[^0-9]/g, ''), 10)));
              }
            }
            if (bid !== null && (isNaN(bid) || bid < 0 || bid > 400)) bid = null;
            if (maxAffordable !== null && (isNaN(maxAffordable) || maxAffordable < 0)) {
              maxAffordable = null;
            }
          } catch (e) { bid = null; maxAffordable = null; }

          return { name, team, position, bid, maxAffordable };
        }
      }
    } catch (e) {
          // Best effort: this reads the page and the page is not ours.
          console.debug('[Gridiron Edge] read failed:', e && e.message);
        }
    return null;
  }

  /**
   * Locate the results table, in either draft format.
   *
   * This required the literal string "Round 1", which is a snake-draft artefact:
   * an auction has no rounds, players are nominated and bid on. In an auction
   * room the container was therefore never found, the DOM path returned nothing,
   * and the extension was blind in exactly the format the auction engine exists
   * to serve.
   *
   * That was fixed once, in a second copy of this scraper that lived in
   * popup.js, and the fix was lost when the two were merged into this one. Both
   * that copy and the comment still claiming the fix are gone: the manifest
   * registers no popup, so none of it was ever loaded. It matters more than it
   * did: Safari has no MAIN world, so the isolated-world DOM scrape is the only
   * path there, not a fallback.
   *
   * Either signature is accepted: round labelling for a snake, a column of
   * dollar amounts for an auction. Three separate figures are required for the
   * auction case so that a lone "$200" budget label on an unrelated panel cannot
   * pass for a results table.
   */
  function findDraftSummaryContainer() {
    const containers = document.querySelectorAll('div, table, tbody');
    for (const el of containers) {
      if (!el || el.children.length === 0) continue;
      const text = readText(el);
      if (!text.includes('PLAYER') || !text.includes('TEAM')) continue;
      if (text.length >= 15000 || text.includes('No players in queue')) continue;

      const isSnake = /Round\s+\d+/i.test(text);
      const isAuction = (text.match(/\$\s?\d+/g) || []).length >= 3;
      if (isSnake || isAuction) return el;
    }
    return null;
  }

  function scrapeDraftDOM() {
    try {
      const container = findDraftSummaryContainer();
      if (!container) return null;

  // Every club by nickname. A defense is the one "player" whose name IS a team,
  // so a results row can put the nickname before the position token, after it,
  // or on its own -- and a parser that assumes one order loses the pick. With
  // this, the nickname can be found anywhere in the row. The table itself is
  // declared once at the top of this file.

      const nflTeams = new Set(['DET', 'LAR', 'ATL', 'CIN', 'SEA', 'SF', 'GB', 'KC', 'BUF', 'DAL', 'PHI', 'MIA', 'NYJ', 'NE', 'LV', 'DEN', 'LAC', 'MIN', 'CHI', 'TB', 'NO', 'CAR', 'WAS', 'NYG', 'ARI', 'JAX', 'IND', 'TEN', 'HOU', 'BAL', 'PIT', 'CLE', 'FA']);
      // Feeds spell a team defense several ways, and the row is thrown away
      // entirely if the position token is not recognised.
      const DST_ALIASES = new Set(['D/ST', 'DST', 'DEF', 'D-ST']);
      const positions = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'FLEX', ...DST_ALIASES]);
      
      const elements = container.querySelectorAll('tr, [role="row"], [class*="row" i], [class*="item" i], div');
      const selections = [];
      // ident -> { index, score }. First-wins was wrong: the same defense appears
      // in the results table AND in the roster panel, and the panel's bare
      // "Broncos D/ST / DEN / D/ST" row has no pick number and no drafter. Seen
      // first, it won, and the real row carrying "Mac's Marauders" was thrown
      // away as its duplicate -- so the pick existed but belonged to nobody.
      const bestRowForPlayer = new Map();
      // Why each row was thrown away. Rows are dropped silently by design --
      // most of what this selector returns is not a pick -- but that also hides
      // the real picks being lost, which is how two defenses went missing for
      // three attempts running. Keep the ones that looked like a pick.
      const rejected = [];
      // Record every rejection that looked like it could have been a pick, not
      // only the defenses. Filtering to defenses made a dropped receiver
      // invisible, which is the same blindness that cost three rounds on D/ST.
      const note = (why, text) => {
        if (rejected.length >= 60) return;
        // A row with a position token or a club name had a real chance of being
        // a pick; page furniture did not.
        if (/\b(QB|RB|WR|TE|K|D\/?ST|FLEX)\b/i.test(text)) {
          rejected.push({ why, text: text.replace(/\n/g, ' | ').slice(0, 140) });
        }
      };

      elements.forEach(el => {
        if (!el || typeof el.innerText !== 'string') return;
        const text = el.innerText.trim();
        if (el.children.length > 8 || text.length > 150 || text.length < 10) return;
        const parts = text.split(/[\s\n]+/);
        // "Broncos D/ST" is a complete row and only two tokens long. Requiring
        // three discarded it, and with it the pick.
        const looksDst = parts.some((x) => DST_ALIASES.has(x.toUpperCase()))
          || parts.some((x) => NFL_NICKNAMES[x.toLowerCase()]);
        if (parts.length < (looksDst ? 2 : 3)) { note('too few tokens', text); return; }
        
        let pick = -1;
        let nameStartIdx = 1;
        
        const firstPartNum = parseInt(parts[0], 10);
        if (!isNaN(firstPartNum) && firstPartNum > 0 && firstPartNum <= 300) {
          pick = firstPartNum;
          nameStartIdx = 1;
        } else if (parts[0].toLowerCase() === 'pick' || parts[0].toLowerCase() === 'pk') {
          const secondPartNum = parseInt(parts[1], 10);
          if (!isNaN(secondPartNum) && secondPartNum > 0 && secondPartNum <= 300) {
            pick = secondPartNum;
            nameStartIdx = 2;
          }
        }

        // A row that does not lead with a pick number used to be thrown away
        // outright. Auction results rows frequently do not have one -- they lead
        // with the player -- so those picks never reached the app at all, which
        // is how an already-drafted player came back as a recommendation. Parse
        // it anyway and number it by arrival.
        if (pick === -1) nameStartIdx = 0;

        // Reject rows that actually contain several players. The selector
        // includes plain divs, so a wrapper's innerText can concatenate the
        // whole table -- which produced player names like
        // "Bijan Robinson ATL RB Team 3 370.8 353 $47 2 Christian McCaffrey".
        let teamTokenCount = 0;
        for (let i = nameStartIdx; i < parts.length; i++) {
          if (nflTeams.has(parts[i].toUpperCase())) teamTokenCount++;
        }
        if (teamTokenCount > 1) { note('names more than one NFL team', text); return; }

        // Take the FIRST team and position token, not the last. Scanning the
        // whole row and overwriting on every match meant a merged row pointed
        // at a later player's team while the name swallowed everything before
        // it.
        let teamIdx = -1;
        let posIdx = -1;
        for (let i = nameStartIdx; i < parts.length; i++) {
          const pUpper = parts[i].toUpperCase();
          if (teamIdx === -1 && nflTeams.has(pUpper)) teamIdx = i;
          if (posIdx === -1 && positions.has(pUpper)) posIdx = i;
          if (teamIdx !== -1 && posIdx !== -1) break;
        }

        // A defense carries no separate NFL team abbreviation -- its name IS the
        // team -- so requiring one threw every D/ST pick away before it reached
        // the app, and the D/ST slot stayed empty however the draft went. The
        // team requirement is relaxed for defenses only; for everyone else it
        // still guards against a wrapper div swallowing the whole table.
        // A row naming a club and no position is still a defense -- that is the
        // one position whose name identifies it. Requiring a position token
        // dropped the pick outright.
        const nickIdx = parts.findIndex((x, i) => i >= nameStartIdx && NFL_NICKNAMES[x.toLowerCase()]);
        const isDst = (posIdx !== -1 && DST_ALIASES.has(parts[posIdx].toUpperCase()))
          || (posIdx === -1 && nickIdx !== -1);

        if (posIdx === -1 && !isDst) { note('no position token', text); return; }
        if (posIdx !== -1 && teamIdx === -1 && !isDst) { note('no NFL team token', text); return; }

        if (isDst || (posIdx !== -1 && teamIdx !== -1)) {

          const endIdx = teamIdx === -1 ? posIdx : Math.min(teamIdx, posIdx);
          const nameParts = parts.slice(nameStartIdx, endIdx);
          let playerName = nameParts.join(' ');
          let teamAbbr = teamIdx === -1 ? 'FA' : parts[teamIdx];

          const maxIdx = Math.max(teamIdx, posIdx);
          const remaining = parts.slice(maxIdx + 1);

          // The winning bid sits in this row as a "$45" token. It used to be
          // discarded along with the other noise while isolating the team name,
          // which left the auction engine unable to tell an aggressive manager
          // from a disciplined one -- it had to assume every rival paid exactly
          // par. Capture it before filtering.
          let bidAmount = null;
          remaining.forEach(tok => {
            if (bidAmount === null && /^\$\d+$/.test(tok)) {
              const v = parseInt(tok.slice(1), 10);
              if (!isNaN(v) && v >= 0 && v <= 400) bidAmount = v;
            }
          });

          const drafterParts = remaining.filter(p => {
            if (p === '-' || p.startsWith('$') || p.startsWith('-$')) return false;
            // A trailing position or team token is column noise, not a manager.
            // Without this the roster panel's row named its drafter "D/ST".
            if (positions.has(p.toUpperCase()) || nflTeams.has(p.toUpperCase())) return false;
            const num = parseFloat(p);
            if (!isNaN(num)) {
              if (p.includes('.') || num > 32) return false;
            }
            return true;
          });
          const drafterTeamName = drafterParts.join(' ') || `Team ${pick}`;

          // Dedupe by who was bought, not by the leading number. That number is
          // not always a pick number, and two rows sharing one silently dropped
          // the second -- losing a real pick with no error anywhere.
          // For a defense, take the nickname from anywhere in the row rather
          // than only from the tokens before the position. Slicing by position
          // yields an empty name whenever the row reads "D/ST Broncos", and an
          // empty name meant the pick was dropped without a trace.
          if (isDst) {
            const nickTok = parts.find((x) => NFL_NICKNAMES[x.toLowerCase()]);
            if (nickTok) {
              playerName = nickTok;
              if (teamIdx === -1) teamAbbr = NFL_NICKNAMES[nickTok.toLowerCase()];
            }
          }

          const ident = (playerName + '|' + (isDst ? 'D/ST' : parts[posIdx])).toLowerCase();
          if (!playerName) { note('no player name found', text); return; }

          // Of two rows naming the same player, keep the one that says more:
          // a real pick number and a named drafter beat a bare panel entry.
          const score = (pick !== -1 ? 2 : 0)
            + (drafterParts.length ? 2 : 0)
            + (bidAmount !== null ? 1 : 0);
          const prior = bestRowForPlayer.get(ident);
          if (prior) {
            if (score <= prior.score) { note('duplicate of ' + playerName, text); return; }
            note('replaced a poorer row for ' + playerName, text);
            selections[prior.index] = null;      // compacted below
          }
          bestRowForPlayer.set(ident, { index: selections.length, score });
          selections.push({
            overallPickNumber: pick === -1 ? selections.length + 1 : pick,
            playerName,
            playerTeam: teamAbbr,
            // Normalise so the app sees one spelling.
            playerPosition: isDst ? 'D/ST' : parts[posIdx],
            drafterTeamName,
            bidAmount
          });
        }
      });

      // Drop the placeholders left by rows that were superseded.
      const kept = selections.filter(Boolean);
      selections.length = 0;
      kept.forEach((x) => selections.push(x));

      // Reachable from the console whether or not anything parsed, so a pick
      // that was dropped can be seen rather than deduced.
      try { window.__GRIDIRON_EDGE_REJECTED__ = rejected; } catch (e) { /* best effort */ }

      if (selections.length > 0) {
        selections.sort((a, b) => a.overallPickNumber - b.overallPickNumber);
        return selections;
      }
    } catch (e) {
      // Returning null in silence is how a TypeError on the very first row
      // became "102 picks made, 0 were read" with nothing at all to go on.
      console.error('[Gridiron Edge] Draft scrape failed:', e);
      try { window.__GRIDIRON_EDGE_SCRAPE_ERROR__ = String((e && e.stack) || e); } catch (_) {
          // Best effort: this reads the page and the page is not ours.
          console.debug('[Gridiron Edge] read failed:', _ && _.message);
        }
    }
    return null;
  }

  function isReduxStore(obj) {
    return obj && typeof obj.getState === 'function' && typeof obj.dispatch === 'function' && typeof obj.subscribe === 'function';
  }

  function searchObjForStore(obj, visited = new Set()) {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return null;
    visited.add(obj);

    if (isReduxStore(obj)) return obj;
    if (isReduxStore(obj.store)) return obj.store;

    try {
      for (const k of Object.keys(obj)) {
        try {
          const val = obj[k];
          if (isReduxStore(val)) return val;
        } catch (e) {
          // Best effort: this reads the page and the page is not ours.
          console.debug('[Gridiron Edge] read failed:', e && e.message);
        }
      }
    } catch (e) {
          // Best effort: this reads the page and the page is not ours.
          console.debug('[Gridiron Edge] read failed:', e && e.message);
        }
    return null;
  }

  function findStoreState() {
    if (window.__PRELOADED_STATE__) return window.__PRELOADED_STATE__;
    if (window.espn?.draft) return window.espn.draft;

    for (const key of Object.keys(window)) {
      if (key.toLowerCase().includes('draft') || key.toLowerCase().includes('espn') || key.toLowerCase().includes('redux') || key.toLowerCase().includes('state')) {
        try {
          const val = window[key];
          if (val && typeof val === 'object') {
            if (val.picks || val.selections || val.teams || val.draftDetail || val.settings) {
              return val;
            }
          }
        } catch (e) {
          // Best effort: this reads the page and the page is not ours.
          console.debug('[Gridiron Edge] read failed:', e && e.message);
        }
      }
    }

    const allElements = document.querySelectorAll('*');
    const visitedFibers = new Set();
    for (const el of allElements) {
      const keys = Object.keys(el);
      const reactKey = keys.find(key => key.startsWith('__reactContainer$') || key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
      if (reactKey) {
        let node = el[reactKey];
        while (node) {
          if (visitedFibers.has(node)) break;
          visitedFibers.add(node);

          let store = searchObjForStore(node.memoizedProps) || 
                      searchObjForStore(node.stateNode) || 
                      searchObjForStore(node.updateQueue) || 
                      searchObjForStore(node.memoizedState);
          if (store) {
            const state = store.getState();
            if (state) return state;
          }
          node = node.return;
        }
      }
    }
    return null;
  }

  let lastSeenPicks = [];

  function findDataInState(obj, depth = 0, visited = new Set()) {
    if (depth > 6 || !obj || typeof obj !== 'object' || visited.has(obj)) return null;
    visited.add(obj);

    let picks = obj.picks || obj.selections || (obj.draftDetail && obj.draftDetail.picks);
    let teams = obj.teams || (obj.draftDetail && obj.draftDetail.teams) || (obj.settings && obj.settings.teams);

    if (Array.isArray(picks) && Array.isArray(teams) && (picks.length > 0 || teams.length > 0)) {
      return { teams, picks };
    }

    for (const key of Object.keys(obj)) {
      try {
        const val = obj[key];
        if (val && typeof val === 'object') {
          const result = findDataInState(val, depth + 1, visited);
          if (result) return result;
        }
      } catch (e) {
          // Best effort: this reads the page and the page is not ours.
          console.debug('[Gridiron Edge] read failed:', e && e.message);
        }
    }
    return null;
  }

  function scrapeTeamsAndBudgets() {
    const teams = [];
    try {
      const elements = document.querySelectorAll('div');
      const seenTeams = new Set();
      
      elements.forEach(el => {
        if (!el || el.children.length > 5) return;
        const text = readText(el);
        if (!text || text.length > 100 || text.length < 5) return;
        
        const lines = text.split('\n');
        if (lines.length >= 2) {
          const nameLineRaw = lines[0].trim();
          if (/^\d+\.\s+/.test(nameLineRaw)) {
            const nameLine = nameLineRaw.replace(/^\d+\.\s*/, '');

            // The pick train renders three lines, not two:
            //   "1. Team 7" / "AUTO" / "$103"
            // Reading lines[1] therefore found "AUTO", never a dollar amount,
            // so every budget silently fell back to $200 and the whole market
            // model -- who is broke, who can still outbid you -- ran blind.
            // Take the first dollar figure anywhere below the name instead.
            let budgetLine = '';
            for (let i = 1; i < lines.length; i++) {
              const candidate = lines[i].trim();
              if (/^\$\s?[\d,]+$/.test(candidate)) { budgetLine = candidate; break; }
            }

            if (budgetLine.startsWith('$')) {
              const budgetVal = parseInt(budgetLine.replace(/[^0-9]/g, ''), 10);
              if (!isNaN(budgetVal) && budgetVal >= 0 && budgetVal <= 400) {
                if (nameLine.length > 2 && nameLine.length < 30 && !seenTeams.has(nameLine)) {
                  seenTeams.add(nameLine);
                  teams.push({
                    teamName: nameLine,
                    budget: budgetVal
                  });
                }
              }
            }
          }
        }
      });
    } catch (e) {
          // Best effort: this reads the page and the page is not ours.
          console.debug('[Gridiron Edge] read failed:', e && e.message);
        }
    return teams;
  }

  function extractDataFromStore(state) {
    if (!state) return null;
    
    const extracted = findDataInState(state);
    if (!extracted) return null;

    const teams = extracted.teams.map(t => ({
      teamId: t.teamId || t.id,
      teamName: t.teamName || t.name || `Team ${t.teamId || t.id}`,
      managerName: t.managerName || `Manager ${t.teamId || t.id}`,
      faabRemaining: typeof t.faabRemaining === 'number' ? t.faabRemaining : (typeof t.draftBudget === 'number' ? t.draftBudget : (typeof t.budget === 'number' ? t.budget : 200))
    }));

    const picks = extracted.picks.map(p => {
      // defaultPositionId, which is NOT the lineupSlotId space this table used
      // to hold. Slot ids are 0=QB, 4=WR, 6=TE, 17=K; position ids are
      // 1=QB, 2=RB, 3=WR, 4=TE, 5=K, 16=D/ST. Applied to a position id, the
      // slot table reported a tight end (4) as a WR and dropped QB, WR and K
      // through to the literal 'RB' below. A wrong position then makes
      // findPlayer refuse the match, so the pick became an unresolved stub at
      // replacement level -- or, worse, matched a different player.
      const posMap = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
      const posId = p.player?.defaultPositionId;
      const position = posMap[posId] || p.playerPosition || p.player?.position || 'RB';
      
      // ESPN's actual proTeamId table. The previous one assumed the ids ran
      // alphabetically by current city, and its own tail disproved that: 33 and
      // 34 only exist in the legacy ordering, where the Ravens and the
      // expansion Texans were appended. It produced 'HOU' from both 10 and 34,
      // and was wrong for every club from 10 up. The abbreviation is not
      // cosmetic -- it is what separates two defenses and two running backs
      // who share a surname, so a wrong club silently picks the wrong player.
      const nflTeamId = p.player?.proTeamId;
      const team = PRO_TEAM_BY_ID[nflTeamId] || p.playerTeam || p.player?.proTeam || 'FA';

      return {
        overallPickNumber: p.overallPickNumber || p.pickNumber || p.pick,
        playerName: p.playerName || p.player?.fullName || p.name,
        playerPosition: position,
        playerTeam: team,
        // Null, never 1, and never via `||`.
        //
        // Defaulting an unattributed pick to the first team corrupts that
        // roster AND the budget model every bid ceiling is derived from -- the
        // DOM path says exactly this, at length, four lines of comment, and
        // then this path quietly did the opposite. `||` also swallowed a
        // legitimate teamId of 0, and the diagnostic that counts unattributed
        // picks filters on `== null`, so it was structurally blind here.
        drafterTeamId: typeof (p.drafterTeamId ?? p.teamId) === 'number'
          ? (p.drafterTeamId ?? p.teamId) : null
      };
    });

    return { teams, picks };
  }

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

  function findTeamSelectName(teams) {
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
        // Most of the dropdown must be teams we already know about. A single
        // coincidental match -- an NFL club sharing a manager's team name --
        // is not enough.
        if (hits.length >= 2 && hits.length >= Math.ceil(opts.length * 0.6)) {
          const active = sel.options[sel.selectedIndex];
          const name = active && String(active.text || '').trim();
          if (name && known.indexOf(name.toLowerCase()) !== -1) return name;
        }
      }
    } catch (e) {
      // Best effort: this reads the page and the page is not ours.
      console.debug('[Gridiron Edge] read failed:', e && e.message);
    }
    return null;
  }

  /**
   * The team name shown as yours, or null if the page does not single one out.
   *
   * This matched "1. Some Team" over "$200" and returned the first one it hit.
   * In a snake room that block is your own roster header, so it worked. In an
   * auction the budget panel lists EVERY team in exactly that shape, so it
   * returned whichever team the DOM happened to put first -- normally team 1 --
   * and reported it as yours with no indication it was a guess. You then saw
   * someone else's roster, and every bid ceiling was computed against it.
   *
   * Finding several candidates is not weak evidence that the first is yours; it
   * is evidence the page is listing everybody. Say so, and let the interface ask.
   */
  function findMyTeamNameFromDOM() {
    const candidates = [];
    try {
      const elements = document.querySelectorAll('div');
      for (const el of elements) {
        if (!el || el.children.length > 5) continue;
        const text = readText(el);
        if (!text || text.length > 100 || text.length < 5) continue;

        const lines = text.split('\n');
        if (lines.length >= 2) {
          const nameLineRaw = lines[0].trim();
          if (/^\d+\.\s+/.test(nameLineRaw)) {
            const nameLine = nameLineRaw.replace(/^\d+\.\s*/, '');
            const budgetLine = lines[1].trim();
            if (budgetLine.startsWith('$') && !text.toUpperCase().includes('AUTO')) {
              if (candidates.indexOf(nameLine) === -1) candidates.push(nameLine);
              if (candidates.length > 1) return null; // a roster, not a list
            }
          }
        }
      }
    } catch (e) {
          // Best effort: this reads the page and the page is not ours.
          console.debug('[Gridiron Edge] read failed:', e && e.message);
        }
    return candidates.length === 1 ? candidates[0] : null;
  }

  /**
   * A few characters that change when the room does.
   *
   * The full scan walks every div in the document reading innerText, which
   * forces a synchronous layout. That was tolerable on a two-second timer; now
   * that a MutationObserver can call this eight times a second it is not. This
   * reads three small things -- the live bid, how many picks exist, and the
   * page's own progress counter -- and lets an unchanged room cost almost
   * nothing. textContent, not innerText, because innerText is the part that
   * forces layout.
   */
  function cheapProbe() {
    try {
      const bidEl = document.querySelector('.current-amount, [data-testid="bidding-form"]');
      const bid = bidEl ? (bidEl.textContent || '').trim() : '';
      const nomEl = document.querySelector('.pickArea, [class*="pickArea" i]');
      const nom = nomEl ? (nomEl.textContent || '').trim().slice(0, 120) : '';
      const counter = (document.querySelector('[class*="pickTimer" i], [class*="draftStatus" i]')
        || {}).textContent || '';
      // Digits stripped from the counter, and only from it. It sits beside the
      // countdown clock, which ticks at least once a second -- so the probe's
      // fingerprint changed every second in a live room and the full scan ran
      // every time, which is the one situation the probe exists to prevent.
      // The bid and the nomination carry every change that matters; the clock
      // carries none. Measured: 20 of 20 clock-only mutation batches ran the
      // full scan before this, 0 of 20 after.
      const stable = counter.replace(/[\d:]/g, '').trim().slice(0, 40);
      return `${bid}|${nom}|${stable}`;
    } catch (e) {
      // If the probe cannot run, fall through to the full scan rather than
      // silently deciding nothing changed.
      return null;
    }
  }
  let lastProbe = null;

  function checkAndSync(force) {
    try {
      // Cheap out before the expensive scan. The probe is deliberately allowed
      // to be wrong in the safe direction: a change it misses is caught by the
      // safety-net interval, which passes force.
      const probe = cheapProbe();
      if (!force && probe !== null && probe === lastProbe) return;
      lastProbe = probe;

      let data = null;
      const urlParams = new URLSearchParams(window.location.search);
      let leagueId = urlParams.get('leagueId') || urlParams.get('leagueid') || 'scraped-draft';
      let season = urlParams.get('seasonId') || urlParams.get('seasonid') || new Date().getFullYear();
      // NaN when the URL does not say, so "the URL named team 1" stays
      // distinguishable from "nobody said". It used to default to 1, which made
      // the two indistinguishable and always produced an answer.
      const urlTeamId = parseInt(urlParams.get('teamId') || urlParams.get('teamid'), 10);
      const currentNom = findCurrentNomination();

      // Computed lazily. findMyTeamNameFromDOM walks every div on the page and
      // reads innerText on each -- a layout-forcing read -- and it is the THIRD
      // fallback below, tried only after the URL teamId and the roster panel's
      // dropdown have both failed. Running it eagerly cost about 6,000
      // innerText reads a tick for an answer usually thrown away.
      let myTeamNameCache;
      const myTeamNameLazy = () => {
        if (myTeamNameCache === undefined) myTeamNameCache = findMyTeamNameFromDOM();
        return myTeamNameCache;
      };

      /**
       * Which team is yours, or null.
       *
       * The URL parameter wins: it is what ESPN itself used to route you into
       * your own draft room, where the name match is inference over markup that
       * ESPN is free to change. The order used to be the other way round, so a
       * bad name guess overrode a correct, explicit teamId.
       *
       * Returning null is a real answer. Reporting a team we are not sure about
       * silently attributes someone else's roster to you, and every bid ceiling
       * is then computed against the wrong roster -- with nothing on screen to
       * suggest anything is wrong.
       */
      function resolveMyTeamId(teams) {
        if (!Array.isArray(teams) || !teams.length) return null;
        if (!isNaN(urlTeamId) && teams.some((t) => t.teamId === urlTeamId)) {
          return urlTeamId;
        }
        // The roster panel's dropdown, checked against the teams we scraped.
        // Exact, so it is tried before the loose substring match below.
        const selected = findTeamSelectName(teams);
        if (selected) {
          const lower = selected.toLowerCase();
          const exact = teams.find((t) => (t.teamName || '').toLowerCase() === lower);
          if (exact) return exact.teamId;
        }
        const myTeamName = myTeamNameLazy();
        if (myTeamName) {
          const lower = myTeamName.toLowerCase();
          const match = teams.find((t) => {
            const name = (t.teamName || '').toLowerCase();
            return name === lower || lower.includes(name) || name.includes(lower);
          });
          if (match) return match.teamId;
        }
        return null;
      }

      // 1. Try React store extraction
      try {
        const storeState = findStoreState();
        const extracted = extractDataFromStore(storeState);
        if (extracted) {
          const resolvedTeamId = resolveMyTeamId(extracted.teams);

          data = {
            isDOMScraped: false,
            leagueId,
            season,
            leagueName: document.title || 'ESPN Mock Draft Room',
            myTeamId: resolvedTeamId,
            teams: extracted.teams,
            draftDetail: {
              picks: extracted.picks
            },
            currentNomination: currentNom
          };
        }
      } catch (e) {
        console.warn("[Gridiron Edge Sync] Store extraction failed:", e.message);
      }

      // 2. Fallback to DOM Scraper
      if (!data) {
        const selections = scrapeDraftDOM() || [];
        if (selections.length > 0) {
          lastSeenPicks = selections;
        }

        const isDraftPage = window.location.pathname.includes('/draft');
        const rosterPanel = scrapeRosterPanel();
        if (lastSeenPicks.length === 0 && !rosterPanel.length
            && !(isDraftPage && currentNom)) return;

        const scrapedForNames = scrapeTeamsAndBudgets();
        let uniqueTeams = Array.from(new Set([
          // The pick train lists every team whether or not they have drafted,
          // so it is a better roster of the league than names recovered from
          // pick rows, which only cover teams that already own somebody.
          ...scrapedForNames.map(b => b.teamName),
          ...lastSeenPicks.map(p => p.drafterTeamName),
          // An auction renders no pick rows at all, so neither of the above
          // finds anything there. The roster dropdown lists the whole league.
          ...findLeagueTeamNames(),
        ].filter(Boolean)));
        // No invented league. Eight teams called "Team 1".."Team 8" used to be
        // manufactured here, and a fabricated league renders exactly like a real
        // one -- opponent budgets, inflation and every bid ceiling built on top
        // of names nobody chose. Reporting nothing lets the page say it knows
        // nothing, which is the truth.
        if (uniqueTeams.length === 0) {
          console.warn('[Gridiron Edge] No teams found on the page; sending nothing.');
          return;
        }

        // Reuse the walk above. This called scrapeTeamsAndBudgets() a second
        // time with no arguments and nothing changed in between, so a whole
        // extra pass over every div in the document -- 3,120 nodes and 6,238
        // innerText reads, each one forcing layout -- was thrown away.
        const scrapedBudgets = scrapedForNames;

        const teams = uniqueTeams.map((tName, index) => {
          const budgetMatch = scrapedBudgets.find(b => b.teamName.toLowerCase() === tName.toLowerCase() || tName.toLowerCase().includes(b.teamName.toLowerCase()) || b.teamName.toLowerCase().includes(tName.toLowerCase()));
          const budget = budgetMatch ? budgetMatch.budget : 200;
          return {
            teamId: index + 1,
            teamName: tName,
            managerName: `Manager ${index + 1}`,
            faabRemaining: budget
          };
        });

        // Who bought the player. The drafter's name is rebuilt from whatever
        // tokens were left over in the pick row, so it rarely matches the pick
        // train's version character for character -- and this used to demand
        // exact equality, then blame team 1 for every miss. That silently piled
        // the whole draft onto one roster: if you were team 1 you owned
        // everybody, and if you were not, your roster never filled at all.
        // Punctuation has to go. "Mac's Marauders" against "Macs Marauders
        // Team", or a curly apostrophe against a straight one, is not a match by
        // any string comparison -- and this is the third time in this codebase
        // that an apostrophe has silently broken a lookup.
        const norm = (x) => String(x || '')
          .toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          // Apostrophes are REMOVED, not spaced -- "Mac's" and "Daves" have to
          // land on the same string. Turning them into spaces produces
          // "mac s marauders", which matches neither spelling. This is the
          // identical mistake that once priced Ja'Marr Chase at replacement.
          .replace(/['\u2019\u2018\u0060]/g, '')
          .replace(/[^a-z0-9 ]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        const findDrafter = (name) => {
          const n = norm(name);
          if (!n) return null;
          const exact = teams.filter(t => norm(t.teamName) === n);
          if (exact.length === 1) return exact[0];

          // Token containment rather than substring. A substring test matches
          // "Team 8" inside "Team 87" and hands a pick to the wrong manager;
          // comparing whole words cannot do that. Require exactly one team to
          // match, so an ambiguous name stays unattributed instead of guessing.
          const nt = n.split(' ').filter(Boolean);
          const covers = (a, b) => a.length && a.every(w => b.includes(w));
          const hits = teams.filter(t => {
            const tt = norm(t.teamName).split(' ').filter(Boolean);
            return covers(nt, tt) || covers(tt, nt);
          });
          return hits.length === 1 ? hits[0] : null;
        };

        let unattributed = 0;
        const finalPicks = lastSeenPicks.map(p => {
          const team = findDrafter(p.drafterTeamName);
          if (!team) unattributed++;
          return {
            overallPickNumber: p.overallPickNumber,
            playerName: p.playerName,
            playerPosition: p.playerPosition || p.position,
            playerTeam: p.playerTeam || p.team,
            // Null, not 1. An unattributed pick still takes the player off the
            // board, but guessing an owner corrupts that team's roster AND the
            // budget model every bid ceiling is derived from.
            drafterTeamId: team ? team.teamId : null,
            bidAmount: typeof p.bidAmount === 'number' ? p.bidAmount : null
          };
        });
        if (unattributed) {
          console.warn('[Gridiron Edge] ' + unattributed + ' of ' + finalPicks.length
            + ' picks could not be matched to a team.');
        }

        const resolvedTeamId = resolveMyTeamId(teams);

        // An auction room renders no results table, so finalPicks is empty
        // there however well it is parsed. The roster panel is the one place
        // picks actually appear -- for the team the dropdown has selected. Fold
        // those in, attributed to that team and to no other.
        //
        // Only when the results table gave us nothing: where both exist the
        // results table covers every team and this covers one, and merging them
        // would double-count the overlap.
        let rosterPicks = [];
        // A completed sweep covers every team, so it supersedes the single
        // panel. The panel is still read for whichever team is selected now,
        // because that one is live and the swept copy is a snapshot.
        if (!finalPicks.length && sweptRosters && sweptRosters.length) {
          const bySweptName = {};
          sweptRosters.forEach((s) => { bySweptName[s.teamName] = s.roster; });
          if (resolvedTeamId !== null) {
            const mine = teams.find((t) => t.teamId === resolvedTeamId);
            if (mine && rosterPanel.length) bySweptName[mine.teamName] = rosterPanel;
          }
          teams.forEach((t) => {
            (bySweptName[t.teamName] || []).forEach((r) => {
              rosterPicks.push({
                overallPickNumber: null,
                playerName: r.playerName,
                playerPosition: null,
                playerTeam: null,
                drafterTeamId: t.teamId,
                bidAmount: r.bidAmount,
              });
            });
          });
        } else if (!finalPicks.length && rosterPanel.length && resolvedTeamId !== null) {
          rosterPicks = rosterPanel.map((r) => ({
            // The room shows no pick number for a roster entry, and inventing a
            // sequence would put these in a draft order that never happened.
            overallPickNumber: null,
            playerName: r.playerName,
            // The slot is where the player is lined up (BE, FLEX), not what he
            // plays. The database resolves the real position from the name.
            playerPosition: null,
            playerTeam: null,
            drafterTeamId: resolvedTeamId,
            bidAmount: r.bidAmount,
          }));
        }

        data = {
          isDOMScraped: true,
          leagueId,
          season,
          leagueName: document.title || 'ESPN Mock Draft Room',
          myTeamId: resolvedTeamId,
          teams,
          draftDetail: {
            picks: finalPicks.length ? finalPicks : rosterPicks
          },
          // What this payload does NOT cover. An auction gives us one roster,
          // so the app must not present it as the state of the draft: the other
          // teams' picks are unknown, not absent. Those are different facts and
          // the interface has to be able to tell them apart.
          coverage: finalPicks.length
            ? { kind: 'full-board' }
            : (sweptRosters && sweptRosters.length
              ? { kind: 'swept-rosters', sweptAt: sweptAt }
              : { kind: 'own-roster-only', knownTeamId: resolvedTeamId }),
          currentNomination: currentNom
        };
      }

      // Keep the last payload reachable from the console. Every scraper bug so
      // far has been diagnosed by guessing at ESPN's markup and shipping a fix
      // blind; this makes what was actually parsed inspectable in one command.
      try {
        window.__GRIDIRON_EDGE_LAST__ = data;
        window.__GRIDIRON_EDGE_DEBUG__ = function () {
          const d = window.__GRIDIRON_EDGE_LAST__;
          if (!d) { console.log('No payload captured yet.'); return; }
          const picks = (d.draftDetail && d.draftDetail.picks) || [];
          const mine = picks.filter(function (p) { return p.drafterTeamId === d.myTeamId; });
          const orphan = picks.filter(function (p) { return p.drafterTeamId == null; });
          console.log('%c GRIDIRON EDGE — what the scraper sees ',
            'background:#00e5ff;color:#000;font-weight:bold');
          console.log('source           :', d.isDOMScraped ? 'DOM scrape' : 'ESPN store');
          console.log('league / my team :', d.leagueId, '/ id', d.myTeamId);
          console.log('teams found      :', (d.teams || []).map(function (t) {
            return t.teamId + ':' + t.teamName + ' ($' + t.faabRemaining + ')'; }).join('  '));
          console.log('picks parsed     :', picks.length,
                      '| mine:', mine.length, '| unattributed:', orphan.length);
          console.table(picks.slice(-12).map(function (p) {
            return { pick: p.overallPickNumber, player: p.playerName, pos: p.playerPosition,
                     nfl: p.playerTeam, ownerId: p.drafterTeamId, bid: p.bidAmount };
          }));
          console.log('MY PICKS:', mine.map(function (p) { return p.playerName; }).join(', ') || '(none)');
          var rej = window.__GRIDIRON_EDGE_REJECTED__ || [];
          if (rej.length) {
            console.log('%c ROWS DROPPED THAT LOOKED LIKE PICKS ',
              'background:#f59e0b;color:#000;font-weight:bold');
            console.table(rej);
          } else {
            console.log('No pick-looking rows were dropped.');
          }
          return d;
        };
      } catch (e) { /* console access is best effort */ }

      // ESPN prints its own progress ("PK 87 OF 128"). Carrying it lets the app
      // notice when it has parsed fewer picks than the room has actually made --
      // which is what a drafted player reappearing as a recommendation looks
      // like from the inside.
      try {
        const m = (document.body.innerText || '').match(/PK\s*(\d+)\s*OF\s*(\d+)/i);
        if (m) {
          data.picksMadeOnEspn = parseInt(m[1], 10) - 1;   // the printed one is on the clock
          data.rosterSpotsTotal = parseInt(m[2], 10);
        }
      } catch (e) { /* the counter is a nicety, not a requirement */ }

      // When this was read. The app used to get staleness from the sync file's
      // mtime; with no server it has to travel with the payload.
      data.scrapedAt = Date.now();

      const picksCount = data.draftDetail.picks.length;
      const nomName = currentNom ? currentNom.name : '';
      // The bid belongs in the key. Without it the loop treats "same player,
      // higher bid" as no change and stops syncing mid-auction -- which is
      // exactly when the advice needs to move.
      const nomBid = currentNom && currentNom.bid != null ? currentNom.bid : '';
      const budgets = (data.teams || []).map(t => t.faabRemaining).join(',');
      const syncKey = `${picksCount}_${nomName}_${nomBid}_${budgets}`;

      if (lastSyncKey === syncKey) {
        return;
      }

      lastSyncKey = syncKey;
      console.log("[Gridiron Edge Sync] Auto-sync detected change. Dispatching postMessage...", syncKey, "isDOMScraped:", data.isDOMScraped);

      // Dispatch to the window for content-isolated.js to pick up
      // Two ways out, because this script runs in two places. In the MAIN world
      // it has no extension APIs and must hand off via postMessage to the
      // isolated half; injected as a fallback into the isolated world it can
      // message the worker itself. Targeted at ESPN rather than '*' so the
      // scraped draft is not broadcast to every listener in the frame.
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({ action: 'sync', data });
      } else {
        window.postMessage({ type: 'GRIDIRON_EDGE_SYNC', data },
          'https://fantasy.espn.com');
      }
    } catch (err) {
      console.warn("[Gridiron Edge Sync] Sync loop error:", err.message);
    }
  }

  /**
   * React to the room, do not wait for a timer.
   *
   * A live auction moves every second: a bid ticks, someone nominates, a budget
   * drops. On a fixed two-second poll a change landing just after a tick waited
   * almost two seconds to reach the app — an eternity when the clock on screen
   * is counting down from ten.
   *
   * A MutationObserver fires as ESPN repaints, so a bid reaches the advisory
   * panel in tens of milliseconds. It is coalesced on an animation frame, since
   * one React render can produce dozens of mutations, and rate-limited so a
   * pathological repaint loop cannot spin the scraper.
   */
  const MIN_GAP_MS = 120;          // never scrape more than ~8x a second
  const SAFETY_NET_MS = 3000;      // in case the observer misses a change
  let lastRun = 0;
  let queued = false;
  let forceNext = true;      // the first run always does the full scan

  // rAF where it exists, a timer where it does not -- the scraper is also loaded
  // headlessly by the test suite, and a missing global should not stop it.
  const nextFrame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 16);

  function runSoon() {
    if (queued) return;
    queued = true;
    nextFrame(() => {
      queued = false;
      const since = Date.now() - lastRun;
      if (since < MIN_GAP_MS) {
        setTimeout(runSoon, MIN_GAP_MS - since);
        return;
      }
      lastRun = Date.now();
      try {
        checkAndSync(forceNext);
        forceNext = false;
      } catch (e) {
        console.error('[Gridiron Edge] Sync failed:', e);
      }
    });
  }

  // The sweep does not live here any more.
  //
  // It used to be triggered by a window message, and this script is declared
  // world: "MAIN" -- the page's own world -- so `event.source === window` and
  // the origin check were satisfied by ANY script in the frame. A forged
  // request was proven to drive the roster dropdown through every option
  // during a live auction, and eight forged messages produced eight concurrent
  // sweeps whose `finally` blocks raced to restore the selection. An in-flight
  // flag and a sixty-second floor bounded that; they could not close it,
  // because a message anyone can send is a message anyone can send.
  //
  // The sweep reads and writes the DOM and nothing else, so it needed nothing
  // from this world. It runs in content-isolated.js now, which the page cannot
  // reach, started only by a chrome.runtime message from the app. Its result
  // arrives here as data, on the channel below, and is folded into the payload
  // by the same assembler as everything else.
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.origin !== 'https://fantasy.espn.com') return;
      const msg = event.data;
      if (!msg || msg.type !== 'GRIDIRON_EDGE_SWEEP_RESULT') return;
      if (!Array.isArray(msg.byTeam)) return;
      // A page script can forge this, exactly as it can forge a whole sync --
      // the payload gate at the worker is what bounds both. What it can no
      // longer do is make the extension operate the draft room's dropdown.
      sweptRosters = msg.byTeam;
      sweptAt = Date.parse(msg.sweptAt) || Date.now();
      // Out through the ordinary path, so the payload is assembled the same
      // way as any other update rather than by a second assembler that could
      // disagree with it.
      forceNext = true;
      lastSyncKey = null;
      runSoon();
    });
  }

  try {
    const observer = new MutationObserver(runSoon);
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
    });
  } catch (e) {
    console.warn('[Gridiron Edge] Live observation unavailable, '
      + 'falling back to polling only:', e.message);
  }

  // The observer catches everything the page repaints; this catches the rest --
  // a value that changed without a DOM mutation, or an observer that was
  // detached by a page navigation.
  setInterval(() => { forceNext = true; runSoon(); }, SAFETY_NET_MS);
  runSoon();
})();
