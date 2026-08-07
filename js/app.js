/**
 * Gridiron Edge Main Coordinator Script
 */

import store from './store.js';
import { findPlayer } from './player-database.js';
import espnClient, { realDbReady } from './espn-client.js';
import { getDraftRecommendations, calculateAuctionBid } from './engine/draft-assistant.js';
import { recommendBid, targetBoard, buildLeagueState } from './engine/auction-advisor.js';
import { optimizeLineup } from './engine/lineup-optimizer.js';
import { recommendLineupStrategy } from './engine/bracket-strategy.js';
import { evaluateWaivers, getWaiverRecommendations, CATEGORY, ACTION } from './engine/roster-manager.js';
import { refreshNews, fetchLeagueNews, normalizeName, relevanceTo, EVENT_IMPACT }
  from './engine/news-monitor.js';
import { generateTradeProposals } from './engine/trade-generator.js';
import { runSeasonSimulation } from './engine/simulator.js';
import { rankTeams, preseasonOutlook, highestImpactMoves } from './engine/team-strength.js';

// Cache DOM elements
const views = {
  setup: document.getElementById('view-setup'),
  home: document.getElementById('view-home'),
  draft: document.getElementById('view-draft'),
  roster: document.getElementById('view-roster'),
  matchup: document.getElementById('view-matchup'),
  waivers: document.getElementById('view-waivers'),
  trades: document.getElementById('view-trades'),
  league: document.getElementById('view-league'),
  championship: document.getElementById('view-championship'),
  alerts: document.getElementById('view-alerts'),
  settings: document.getElementById('view-settings')
};

const navBar = document.getElementById('app-nav');
const syncIndicator = document.getElementById('sync-indicator');
const alertRibbon = document.getElementById('urgent-alert-ribbon');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');

let activeDraftFilter = 'all';
let draftSearchQuery = '';
// 'auto' lets the bracket engine decide floor vs ceiling from who you play.
// The manual buttons override it.
let weeklyLineupStrategy = 'auto';

let lastSyncFileTimestamp = null;

// Check for a local sync file saved by server.py
async function checkLocalSyncFile() {
  try {
    const response = await fetch('/imported_league.json?cb=' + Date.now());
    if (response.ok) {
      const data = await response.json();
      
      const picksCount = data.draftDetail?.picks?.length || 0;
      const nomObj = typeof data.currentNomination === 'object' ? data.currentNomination : null;
      const currentNom = nomObj ? nomObj.name : (data.currentNomination || '');
      // The bid and every team's budget belong in this key. Keying on picks and
      // player name alone means "same player, higher bid" looks identical, so
      // the page stopped re-importing for the whole duration of the bidding --
      // which is exactly when the advice needs to move. Same mistake the
      // extension's sync loop had.
      const nomBid = nomObj && nomObj.bid != null ? nomObj.bid : '';
      const budgets = (data.teams || []).map((t) => t.faabRemaining).join(',');
      const stateKey = `${picksCount}_${currentNom}_${nomBid}_${budgets}`;

      if (lastSyncFileTimestamp !== stateKey) {
        lastSyncFileTimestamp = stateKey;
        console.log('Draft state changed, importing:', data.leagueName || data.leagueId);
        const mapped = await espnClient.importScrapedPayload(data);
        
        // Automatically re-render if the user is on the Live Draft page
        const activeTabEl = document.querySelector('.nav-item.active');
        if (activeTabEl && activeTabEl.getAttribute('data-tab') === 'draft') {
          renderDraftPage(mapped);
        }
      }
    }
  } catch (e) {
    // Silent fail if local sync file is missing
  }
}

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupThemeToggle();
  setupSetupWizard();
  setupDraftControls();
  setupMatchupControls();
  setupSettingsControls();
  setupModals();

  // A league is persisted with the player database it was imported against, so
  // a stored one predating a projection update keeps the old, smaller set --
  // which is how a drafted defense could stay invisible after the defenses were
  // added, with no error anywhere. Fold the current projections in on boot so a
  // stale store heals itself instead of waiting for the next live sync.
  realDbReady.then((db) => refreshStoredDatabase(db));

  // Check for auto local sync file first
  checkLocalSyncFile();

  // Start polling every 3 seconds for live dashboard updates
  setInterval(checkLocalSyncFile, 3000);

  // Subscribe to store updates
  store.subscribe((state) => {
    renderApp(state);
  });

  // Perform initial rendering
  renderApp(store.state);
});

/**
 * Fold freshly loaded projections into every stored league.
 *
 * Existing entries are updated rather than replaced so live draft state --
 * drafted flags, prices paid, weekly metric history -- survives; genuinely new
 * players are added. Roster ids already point at these keys, so a pick that was
 * previously stored as an unresolvable stub resolves on the next render.
 */
function refreshStoredDatabase(realDb) {
  if (!realDb || !Object.keys(realDb).length) return;
  let changed = 0;
  Object.values(store.state.leagues || {}).forEach((league) => {
    if (!league || !league.playerDatabase) return;
    Object.keys(realDb).forEach((id) => {
      const prior = league.playerDatabase[id];
      if (!prior) { league.playerDatabase[id] = realDb[id]; changed++; return; }
      // Incoming projections win; anything the draft or the season wrote stays.
      league.playerDatabase[id] = { ...prior, ...realDb[id] };
    });
  });
  // Picks that could not be resolved when they were imported are stored as
  // MOCK_ stubs carrying a replacement-level guess. Once the real player exists
  // they should stop being stubs -- otherwise a defense drafted before the
  // defenses were added stays a stub forever, and no amount of reloading helps.
  let healed = 0;
  Object.values(store.state.leagues || {}).forEach((league) => {
    if (!league || !league.playerDatabase) return;
    const remap = new Map();
    Object.keys(league.playerDatabase).forEach((id) => {
      if (!id.startsWith('MOCK_')) return;
      const stub = league.playerDatabase[id];
      const real = findPlayer(realDb, stub.name || id.slice(5).replace(/_/g, ' '),
                              stub.position);
      if (real) { remap.set(id, real.id); healed++; }
    });
    if (!remap.size) return;
    (league.teams || []).forEach((t) => {
      t.roster = (t.roster || []).map((id) => remap.get(id) || id);
    });
    ((league.draftState || {}).selections || []).forEach((sel) => {
      if (remap.has(sel.playerId)) sel.playerId = remap.get(sel.playerId);
    });
    remap.forEach((_, stubId) => { delete league.playerDatabase[stubId]; });
  });

  if (changed || healed) {
    console.log(`[Gridiron Edge] Stored league database: ${changed} players added, `
      + `${healed} unresolved picks matched to real players.`);
    store.save();
  }
}

// Setup Page View Navigation Tab Listeners
function setupNavigation() {
  const navLinks = navBar.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      const tab = link.getAttribute('data-tab');
      store.setActiveTab(tab);
    });
  });
}

// Setup Theme Switcher
function setupThemeToggle() {
  const toggleBtn = document.getElementById('theme-toggle');
  
  // Set default theme from store
  document.documentElement.setAttribute('data-theme', store.state.theme);
  toggleBtn.innerHTML = store.state.theme === 'light' ? '☾' : '◐';

  toggleBtn.addEventListener('click', () => {
    store.toggleTheme();
    toggleBtn.innerHTML = store.state.theme === 'light' ? '☾' : '◐';
  });
}

// Setup Onboarding Setup View Buttons
function setupSetupWizard() {
  const btnLoadSandbox = document.getElementById('btn-load-sandbox');
  const btnSyncPublic = document.getElementById('btn-sync-public');
  const setupLeagueId = document.getElementById('setup-league-id');

  btnLoadSandbox.addEventListener('click', () => {
    showLoading('Loading Sandbox Mock Data...');
    setTimeout(() => {
      espnClient.loadMockLeague();
      hideLoading();
      store.setActiveTab('home');
    }, 800);
  });

  btnSyncPublic.addEventListener('click', async () => {
    const id = setupLeagueId.value.trim();
    if (!id) {
      alert('Please enter a valid ESPN League ID.');
      return;
    }
    showLoading('Connecting to public ESPN APIs...');
    try {
      const mapped = await espnClient.fetchPublicLeague(id);
      store.saveLeague(mapped.leagueId, mapped);
      store.setActiveLeagueId(mapped.leagueId);
      hideLoading();
      store.setActiveTab('home');
    } catch (err) {
      hideLoading();
      alert(`Sync Failed: ${err.message}`);
    }
  });
}

// Setup Live Draft Interaction Handlers
function setupDraftControls() {
  const btnReset = document.getElementById('btn-draft-reset');
  const btnUndo = document.getElementById('btn-draft-undo');
  const searchInput = document.getElementById('draft-player-search');

  btnReset.addEventListener('click', () => {
    if (confirm('Are you sure you want to reset the draft board? This will clear all draft picks.')) {
      store.resetDraft();
    }
  });

  btnUndo.addEventListener('click', () => {
    store.undoLastDraftPick();
  });

  // Filter tabs (All, QB, RB, WR, TE, Flex, D/ST)
  const inlineTabs = document.querySelectorAll('[data-draft-tab]');
  inlineTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      inlineTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeDraftFilter = tab.getAttribute('data-draft-tab');
      renderDraftPage();
    });
  });

  // Search input live filtering
  searchInput.addEventListener('input', (e) => {
    draftSearchQuery = e.target.value.toLowerCase().trim();
    renderDraftPage();
  });
}

// Setup Matchup Lineup Strategy Buttons
function setupMatchupControls() {
  const btnAuto = document.getElementById('btn-lineup-strategy-auto');
  const btnFloor = document.getElementById('btn-lineup-strategy-floor');
  const btnCeil = document.getElementById('btn-lineup-strategy-ceil');
  const all = [btnAuto, btnFloor, btnCeil].filter(Boolean);
  const select = (active, mode) => {
    all.forEach(b => b.className = b === active ? 'btn-primary' : 'btn-secondary');
    weeklyLineupStrategy = mode;
    renderMatchupPage();
  };

  if (btnAuto) btnAuto.addEventListener('click', () => select(btnAuto, 'auto'));

  btnFloor.addEventListener('click', () => {
    select(btnFloor, 'floor');
  });

  btnCeil.addEventListener('click', () => {
    select(btnCeil, 'ceiling');
  });
}

// Setup Settings Page Save & Disconnect Handlers
function setupSettingsControls() {
  const btnDisconnect = document.getElementById('btn-settings-disconnect');
  const btnSave = document.getElementById('btn-settings-save');
  const btnCancel = document.getElementById('btn-settings-cancel');

  btnDisconnect.addEventListener('click', () => {
    if (confirm('Are you sure you want to disconnect your league? All local progress and simulations will be cleared.')) {
      store.state.currentLeagueId = null;
      store.state.leagues = {};
      store.save();
    }
  });

  btnCancel.addEventListener('click', () => {
    store.setActiveTab('home');
  });

  btnSave.addEventListener('click', () => {
    const league = store.getActiveLeague();
    if (!league) return;

    const selectTeam = document.getElementById('settings-my-team-id');
    const selectScoring = document.getElementById('settings-scoring');
    const selectDraft = document.getElementById('settings-draft-type');

    league.myTeamId = parseInt(selectTeam.value);
    league.scoringFormat = selectScoring.value;
    league.draftState.draftType = selectDraft.value;

    store.saveLeague(league.leagueId, league);
    alert('Settings saved successfully.');
    store.setActiveTab('home');
  });
}

// Setup Dialog Box Modals (Bookmarklet & JSON pastes)
function setupModals() {
  const btnShowBookmarklet = document.getElementById('btn-show-bookmarklet');
  const btnCloseBookmarklet = document.getElementById('btn-close-bookmarklet-modal');
  const modalBookmarklet = document.getElementById('modal-bookmarklet');
  const bookmarkletLink = document.getElementById('bookmarklet-drag-link');

  const btnPasteJson = document.getElementById('btn-paste-json');
  const btnClosePaste = document.getElementById('btn-close-paste-modal');
  const btnCancelPaste = document.getElementById('btn-paste-modal-cancel');
  const btnSubmitPaste = document.getElementById('btn-paste-modal-submit');
  const modalPaste = document.getElementById('modal-paste');
  const pasteTextArea = document.getElementById('paste-text-area');

  // Bookmarklet source code
  const bookmarkletCode = `javascript:(async function(){
    const views = ['mSettings', 'mRoster', 'mTeam', 'mMatchup', 'mMatchupScore', 'mStandings', 'mTransactionHistory'];
    const urlParams = new URLSearchParams(window.location.search);
    let leagueId = urlParams.get('leagueId') || urlParams.get('leagueid');
    let season = urlParams.get('seasonId') || urlParams.get('seasonid') || new Date().getFullYear();

    if (!leagueId) {
      const parts = window.location.pathname.split('/');
      const leagueIdIdx = parts.indexOf('leagues');
      if (leagueIdIdx !== -1 && parts[leagueIdIdx + 1]) {
        leagueId = parts[leagueIdIdx + 1];
      }
    }

    if (!urlParams.get('seasonId') && !urlParams.get('seasonid')) {
      const parts = window.location.pathname.split('/');
      const fflIdx = parts.indexOf('ffl');
      if (fflIdx !== -1 && parts[fflIdx + 1]) {
        season = parts[fflIdx + 1];
      }
    }

    if(!leagueId){
      alert('Error: Gridiron Edge could not find your League ID. Make sure you are on fantasy.espn.com league page or draft page!');
      return;
    }

    const url = 'https://fantasy.espn.com/apis/v3/games/ffl/seasons/' + season + '/segments/0/leagues/' + leagueId + '?view=' + views.join('&view=');
    
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Status: ' + response.status);
      const data = await response.json();
      
      const textarea = document.createElement('textarea');
      textarea.value = JSON.stringify(data);
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      alert('League payload successfully copied to clipboard! Return to Gridiron Edge and paste.');
    } catch (err) {
      alert('Error extracting league data. Make sure you are logged in to ESPN Fantasy.');
    }
  })();`;

  bookmarkletLink.setAttribute('href', bookmarkletCode);

  // Bookmarklet modal toggle
  btnShowBookmarklet.addEventListener('click', () => {
    modalBookmarklet.style.opacity = 1;
    modalBookmarklet.style.pointerEvents = 'all';
  });
  btnCloseBookmarklet.addEventListener('click', () => {
    modalBookmarklet.style.opacity = 0;
    modalBookmarklet.style.pointerEvents = 'none';
  });

  // Paste JSON modal toggle
  btnPasteJson.addEventListener('click', () => {
    modalPaste.style.opacity = 1;
    modalPaste.style.pointerEvents = 'all';
  });
  const closePasteModal = () => {
    modalPaste.style.opacity = 0;
    modalPaste.style.pointerEvents = 'none';
    pasteTextArea.value = '';
  };
  btnClosePaste.addEventListener('click', closePasteModal);
  btnCancelPaste.addEventListener('click', closePasteModal);

  btnSubmitPaste.addEventListener('click', async () => {
    const jsonText = pasteTextArea.value.trim();
    if (!jsonText) {
      alert('Please paste valid JSON payload.');
      return;
    }
    try {
      showLoading('Importing JSON league structure...');
      // Awaited: the import now waits for real projections, so without this the
      // spinner would clear early and a failure would escape this try/catch as
      // an unhandled rejection.
      await espnClient.importScrapedPayload(jsonText);
      hideLoading();
      closePasteModal();
      modalBookmarklet.style.opacity = 0;
      modalBookmarklet.style.pointerEvents = 'none';
      store.setActiveTab('home');
    } catch (e) {
      hideLoading();
      alert(`Invalid format: ${e.message}`);
    }
  });
}

/** Players nobody has drafted and nobody owns. */
function freeAgentsIn(league) {
  const taken = new Set();
  (league.teams || []).forEach(t => (t.roster || []).forEach(id => taken.add(String(id))));
  ((league.draftState || {}).selections || []).forEach(s => {
    if (s && s.playerId) taken.add(String(s.playerId));
  });
  return Object.values(league.playerDatabase || {}).filter(p => !taken.has(String(p.id)));
}

/** Says plainly when the league on screen is demo data rather than yours. */
function renderSandboxBanner(league) {
  let el = document.getElementById('sandbox-banner');
  const isMock = Boolean(league && (league.isSandbox || league.leagueId === '48317-espn-mock'));
  if (!isMock) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'sandbox-banner';
    el.style.cssText = 'background:linear-gradient(90deg,#7c2d12,#b45309);color:#fff;'
      + 'padding:0.6rem 1rem;font-size:0.85rem;font-weight:600;text-align:center;'
      + 'border-bottom:1px solid #f59e0b;';
    document.body.insertBefore(el, document.body.firstChild);
  }
  el.innerHTML = 'SANDBOX — every team, roster and number on screen is demo data, '
    + 'not your league. Sync a draft, or import a league, to replace it.';
}

// Central Redraw Router
function renderApp(state) {
  const league = store.getActiveLeague();
  
  if (!league) {
    // Show setup view, hide navigation
    views.setup.classList.add('active');
    Object.keys(views).forEach(key => {
      if (key !== 'setup') views[key].classList.remove('active');
    });
    navBar.style.display = 'none';
    syncIndicator.style.display = 'none';
    alertRibbon.style.display = 'none';
    return;
  }

  // Show navigation bar
  navBar.style.display = 'flex';
  views.setup.classList.remove('active');

  // The sandbox is invented data. It looked identical to a real league on every
  // screen, so a stale one could be mistaken for a broken sync for a long time.
  renderSandboxBanner(league);

  // Re-draw active navigation tab links
  const links = navBar.querySelectorAll('.nav-link');
  links.forEach(l => {
    if (l.getAttribute('data-tab') === state.activeTab) {
      l.classList.add('active');
    } else {
      l.classList.remove('active');
    }
  });

  // Hide all view panels and display the active tab
  Object.keys(views).forEach(key => {
    if (key === state.activeTab) {
      views[key].classList.add('active');
    } else {
      views[key].classList.remove('active');
    }
  });

  // Draw synced timestamp
  if (state.lastSyncTime) {
    syncIndicator.style.display = 'inline-block';
    const date = new Date(state.lastSyncTime);
    syncIndicator.innerHTML = `Synced: ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  // Handle Roster injury alert warnings at the top ribbon
  const myRoster = store.getMyTeam()?.roster || [];
  const injuredPlayer = myRoster.map(id => league.playerDatabase[id]).find(p => p && p.injuryStatus !== 'Healthy');
  if (injuredPlayer) {
    alertRibbon.style.display = 'flex';
    document.getElementById('urgent-alert-text').innerHTML = `Lineup Warning: <strong>${injuredPlayer.name}</strong> (${injuredPlayer.position}-${injuredPlayer.team}) is ${injuredPlayer.injuryStatus}. Action required before kickoff.`;
    document.getElementById('alert-action-btn').onclick = () => store.setActiveTab('matchup');
  } else {
    alertRibbon.style.display = 'none';
  }

  // Trigger page-specific redraws
  switch (state.activeTab) {
    case 'home':
      renderHomePage(league);
      break;
    case 'draft':
      renderDraftPage(league);
      break;
    case 'roster':
      renderRosterPage(league);
      break;
    case 'matchup':
      renderMatchupPage(league);
      break;
    case 'waivers':
      renderWaiversPage(league);
      break;
    case 'trades':
      renderTradesPage(league);
      break;
    case 'league':
      renderLeaguePage(league);
      break;
    case 'championship':
      renderChampionshipPage(league);
      break;
    case 'alerts':
      renderAlertsPage(league);
      break;
    case 'settings':
      renderSettingsPage(league);
      break;
  }
}

/**
 * What to do next, while the draft is still running.
 *
 * Waiver claims and trades are not available yet, so the highest-impact move is
 * always the same shape: which slot is costing you the most, who is the best
 * player left who fills it, and -- in an auction -- what he should cost and
 * where to stop. Every figure here is computed, not asserted: the gap is
 * measured against what the rest of the league gets from the same slot, and the
 * prices come from the same engine the Live Draft tab uses.
 */
function draftMovesHtml(league, ranked, meRanked) {
  const moves = highestImpactMoves(league, freeAgentsIn(league));
  const isAuction = (league.draftState || {}).draftType === 'auction';
  const nom = (league.draftState || {}).currentNomination;
  let html = '';

  // A live nomination outranks everything -- it is the only decision with a
  // clock on it.
  if (nom) {
    const nomPlayer = findNominatedPlayer(league.playerDatabase || {},
      typeof nom === 'object' ? nom.name : nom);
    if (nomPlayer) {
      try {
        const bid = (league.draftState || {}).currentNominationBid || 0;
        const rec = recommendBid(league, nomPlayer, bid);
        const tone = rec.action === 'BID' ? 'high-confidence'
          : rec.action === 'HOLD' ? 'medium-confidence' : 'low-confidence';
        const badge = rec.action === 'BID' ? 'badge-green'
          : rec.action === 'HOLD' ? 'badge-gold' : 'badge-red';
        html += `
          <div class="recommendation-item ${tone}">
            <div class="item-action-title">On the block: ${nomPlayer.name} (${nomPlayer.position})
              <span class="badge-solid ${badge}">${(ACTION_STYLE[rec.action] || {}).label || rec.action}</span></div>
            <div class="item-details">
              ${rec.recommendedBid > 0 ? `Bid $${rec.recommendedBid}, walk away at $${rec.maxBid}. ` : ''}
              Market forecast $${rec.expectedPrice}. ${rec.reason}
            </div>
          </div>`;
      } catch (e) { /* a nomination we cannot price is not worth a broken card */ }
    }
  }

  const top = moves.filter((m) => m.candidate).slice(0, 3);
  top.forEach((m) => {
    const p = m.candidate;
    let price = '';
    if (isAuction) {
      try {
        const rec = recommendBid(league, p, 0);
        if (rec.maxBid > 0) price = ` Worth up to $${rec.maxBid}; market says about $${rec.expectedPrice}.`;
      } catch (e) { /* fall back to the points case below */ }
    }
    // An unfilled slot is not worth zero -- it is worth whatever is still
    // signable there -- so the gain quoted is over that, not over nothing.
    const why = m.empty
      ? `${m.slot} is unfilled. The best you could still sign projects `
        + `${m.currentPoints}/wk; he beats that by ${m.upgrade}.`
      : `${m.slot} projects ${m.currentPoints}/wk, ${m.gap} behind the league median of ${m.leagueMedian}.`;
    html += `
      <div class="recommendation-item ${m.empty ? 'high-confidence' : 'medium-confidence'}">
        <div class="item-action-title">Target ${p.name} (${p.position})
          <span class="badge-solid ${m.empty ? 'badge-green' : 'badge-gold'}">+${m.upgrade}/wk</span></div>
        <div class="item-details">${why}${price}</div>
      </div>`;
  });

  if (!html) {
    const done = meRanked && !meRanked.holes.length;
    html = `<div class="empty-state">${done
      ? 'Every starting slot is filled. Remaining picks are bench depth — take the best player left.'
      : 'Nothing available improves a starting slot yet.'}</div>`;
  }
  return html;
}

// Render Dashboard (Home) View
function renderHomePage(league = store.getActiveLeague()) {
  if (!league) return;

  const myTeam = store.getMyTeam();
  const db = league.playerDatabase;
  const hasSchedule = Array.isArray(league.schedule) && league.schedule.length > 0;

  // Before a season exists, runSeasonSimulation has no fixtures and returns
  // zero for everything, and the rank came from sorting 0-0 records -- which
  // reported #6 directly above a standings table showing #1. Both now read the
  // same preseason engine the standings do, so they cannot disagree.
  const outlook = hasSchedule ? null : preseasonOutlook(league, 1500);
  const sim = hasSchedule ? runSeasonSimulation(league, 200) : null;

  const champPct = sim ? sim.champPct : (outlook ? outlook.titlePct : 0);
  const playoffPct = sim ? sim.playoffPct : (outlook ? outlook.playoffPct : 0);
  document.getElementById('dashboard-champ-prob').innerHTML = `${champPct}%`;
  document.getElementById('dashboard-champ-bar').style.width = `${champPct}%`;
  document.getElementById('dashboard-playoff-prob').innerHTML = `${playoffPct}%`;

  const ranked = rankTeams(league);
  const meRanked = ranked.find(t => t.isMe);
  let myRank;
  if (hasSchedule) {
    const sortedByRecord = [...league.teams].sort((a, b) => {
      if (b.record.wins !== a.record.wins) return b.record.wins - a.record.wins;
      return b.pointsScored - a.pointsScored;
    });
    myRank = sortedByRecord.findIndex(t => t.teamId === league.myTeamId) + 1;
  } else {
    myRank = meRanked ? meRanked.rank : 0;
  }
  document.getElementById('dashboard-rank').innerHTML = myRank ? `#${myRank}` : '—';

  // Mid-draft these odds are read off half-built rosters, so leading the league
  // may only mean you have drafted more of yours so far. Say that while it is
  // true rather than presenting a settled forecast.
  const rosterSize = (league.rosterSettings?.startersCount || 9)
    + (league.rosterSettings?.benchCount || 7);
  const picksMade = ((league.draftState || {}).selections || []).length;
  const picksTotal = (league.leagueSize || league.teams.length) * rosterSize;
  const rankEl = document.getElementById('dashboard-rank');
  let caveat = document.getElementById('dashboard-caveat');
  if (!caveat && rankEl && rankEl.parentElement && rankEl.parentElement.parentElement) {
    caveat = document.createElement('div');
    caveat.id = 'dashboard-caveat';
    caveat.style.cssText = 'font-size:0.72rem;color:var(--text-muted);margin-top:0.5rem;line-height:1.35;';
    rankEl.parentElement.parentElement.appendChild(caveat);
  }
  if (caveat) {
    caveat.innerHTML = hasSchedule ? ''
      : (picksMade < picksTotal
          ? `Preseason, draft in progress — ${picksMade} of ${picksTotal} picks made. `
            + `Rosters are still filling, so this moves with every pick.`
          : 'Preseason — assumes a balanced schedule until fixtures are published.');
  }

  // The most dangerous competitor is the best roster that is not yours, not
  // whichever name the simulator happened to return.
  const rival = ranked.find(t => !t.isMe);
  document.getElementById('home-rival').innerHTML = rival
    ? `${rival.teamName} <span style="font-size:0.8rem; color:var(--text-muted);">${rival.points.toFixed(1)}/wk</span>`
    : '—';

  // Strength and weakness, measured against what the rest of the league gets
  // from the same starting slot, rather than a two-line guess about receiver
  // counts that could call an empty roster "Core Quarterback".
  const moves = highestImpactMoves(league, freeAgentsIn(league));
  const worst = moves[0];
  const bySlotGap = meRanked
    ? meRanked.slots.filter(s => s.player).map((s) => {
        const peers = ranked.flatMap(t => t.slots.filter(x => x.slot === s.slot).map(x => x.points));
        const med = peers.slice().sort((a, b) => a - b)[Math.floor(peers.length / 2)] || 0;
        return { slot: s.slot, name: s.player.name, edge: s.points - med };
      }).sort((a, b) => b.edge - a.edge)
    : [];
  const best = bySlotGap[0];

  document.getElementById('home-strength').innerHTML = best && best.edge > 0
    ? `${best.slot}: ${best.name} <span style="font-size:0.8rem; color:var(--text-muted);">+${best.edge.toFixed(1)}/wk vs league</span>`
    : (meRanked && meRanked.rostered ? 'No slot is ahead of the league yet' : 'Nothing drafted yet');

  document.getElementById('home-weakness').innerHTML = worst
    ? (worst.empty
        ? `${worst.slot} is empty <span style="font-size:0.8rem; color:var(--text-muted);">scores zero</span>`
        : `${worst.slot}: ${worst.current} <span style="font-size:0.8rem; color:var(--text-muted);">${worst.gap.toFixed(1)}/wk behind league</span>`)
    : 'No slot is measurably behind the league';

  // Render top 3 recommendations list
  const listContainer = document.getElementById('home-recommendations');
  listContainer.innerHTML = '';

  // While the draft is running, waiver claims and trade proposals are not
  // actions you can take -- and when both engines returned nothing the card
  // said "Roster is fully optimized" over six empty starting slots. What is
  // actually highest-impact during a draft is who to buy next and what to pay.
  const drafting = picksMade < picksTotal;
  const waiverRec = drafting ? null : getWaiverRecommendations(league)[0];
  const tradeRec = drafting ? null : generateTradeProposals(league)[0];
  const activeAlert = myRoster.map(id => db[id]).find(p => p && p.injuryStatus !== 'Healthy');

  let itemsHtml = '';
  if (activeAlert) {
    itemsHtml += `
      <div class="recommendation-item low-confidence">
        <div class="item-action-title">Configure Backup starter <span class="badge-solid badge-red">Urgent</span></div>
        <div class="item-details">${activeAlert.name} is questionable. Wire conditional replacement roster slot in Matchups.</div>
      </div>
    `;
  }
  if (waiverRec) {
    itemsHtml += `
      <div class="recommendation-item high-confidence">
        <div class="item-action-title">Claim ${waiverRec.addPlayer.name} (${waiverRec.addPlayer.position}) <span class="badge-solid badge-green">+$${waiverRec.bid} Bid</span></div>
        <div class="item-details">Drop ${waiverRec.dropPlayer?.name || 'Bench'}. Confidence: ${waiverRec.confidence}. ${waiverRec.reason}</div>
      </div>
    `;
  }
  if (tradeRec) {
    itemsHtml += `
      <div class="recommendation-item medium-confidence">
        <div class="item-action-title">Trade for ${tradeRec.getPlayer.name} <span class="badge-solid badge-gold">${tradeRec.probability}% Accept</span></div>
        <div class="item-details">Give ${tradeRec.givePlayer.name} to ${tradeRec.opponentName}. Addresses RB/WR balance.</div>
      </div>
    `;
  }

  if (drafting) itemsHtml = draftMovesHtml(league, ranked, meRanked) + itemsHtml;

  if (!itemsHtml) {
    itemsHtml = '<div class="empty-state">No current actions needed — every starting slot '
      + 'is filled and nothing on the wire beats what you have.</div>';
  }
  listContainer.innerHTML = itemsHtml;

  // Matchup Quickview.
  //
  // A league imported from a draft room carries no schedule, no records and no
  // scores -- there is no season yet. This card used to be left holding the
  // placeholder markup it shipped with ("Championship Bound 114.2 vs Fumble
  // Recovery 121.5, 45% win probability"), which read as a real matchup and was
  // pure invention. Say what is actually true instead.
  const sched = Array.isArray(league.schedule) ? league.schedule : [];
  const myGames = sched.filter(m => m.team1Id === league.myTeamId || m.team2Id === league.myTeamId);
  // The next game that has not been played, else the last one.
  const week5Match = myGames.find(m => !m.played) || myGames[myGames.length - 1] || null;
  const weekLabel = document.querySelector('.current-week-num');
  if (weekLabel) weekLabel.textContent = week5Match ? ` (Week ${week5Match.week})` : '';

  if (!week5Match) {
    // Empty, and said so. There is no fixture, so there is no matchup -- and a
    // head-to-head card filled with something else is the fake data this was
    // meant to remove. The real preseason read lives on the standings and the
    // championship plan, where it is labelled for what it is.
    document.getElementById('match-my-name').innerHTML = '';
    document.getElementById('match-my-proj').innerHTML = '—';
    document.getElementById('match-opp-name').innerHTML = '';
    document.getElementById('match-opp-proj').innerHTML = '—';
    document.getElementById('matchup-strategy-hint').innerHTML =
      '<strong>No matchup yet.</strong><br>Fixtures are published once the draft is '
      + 'finished, and this fills in on its own from the next sync — opponent, '
      + 'projections and the floor-versus-ceiling call for the week. Until then, '
      + 'roster strength and championship odds are on the Championship Plan tab.';
  } else {
    const isTeam1 = week5Match.team1Id === league.myTeamId;
    const myProj = isTeam1 ? week5Match.team1Proj : week5Match.team2Proj;
    const oppProj = isTeam1 ? week5Match.team2Proj : week5Match.team1Proj;
    const oppId = isTeam1 ? week5Match.team2Id : week5Match.team1Id;
    const oppTeam = league.teams.find(t => t.teamId === oppId);

    document.getElementById('match-my-name').innerHTML = myTeam?.teamName || 'My Team';
    document.getElementById('match-my-proj').innerHTML = myProj.toFixed(1);
    document.getElementById('match-opp-name').innerHTML = oppTeam ? oppTeam.teamName : 'Opponent';
    document.getElementById('match-opp-proj').innerHTML = oppProj.toFixed(1);

    const hint = document.getElementById('matchup-strategy-hint');
    if (myProj < oppProj - 5) {
      hint.innerHTML = `<strong>Matchup Strategy: Underdog (High Upside Ceiling)</strong><br>Swap high-variance players in FLEX slots to chase maximum scoring curves.`;
    } else {
      hint.innerHTML = `<strong>Matchup Strategy: Favorite (Reliable Floor)</strong><br>Favor consistent playmakers and routes run to protect your lead.`;
    }
  }

  // Draw Standings Table.
  //
  // With no games played there is no record to show -- but there IS a roster,
  // and the lineup it can field is a real, computed ranking of the league.
  // Showing 0-0 down the whole column said nothing; this says who is ahead.
  const standingsTable = document.getElementById('home-standings-table');
  const standingsBody = standingsTable.querySelector('tbody');
  const standingsHead = standingsTable.querySelector('thead tr');
  standingsBody.innerHTML = '';

  const played = sortedTeams.some(t => (t.record?.wins || 0) + (t.record?.losses || 0) > 0);
  if (!played) {
    if (standingsHead) {
      standingsHead.innerHTML = '<th>Rank</th><th>Team</th><th>Roster</th><th>Proj / wk</th>';
    }
    rankTeams(league).forEach((t) => {
      const row = document.createElement('tr');
      if (t.isMe) {
        row.style.background = 'var(--accent-cyan-glow)';
        row.style.fontWeight = '700';
      }
      const gaps = t.holes.length
        ? `<span style="color:var(--accent-gold); font-size:0.75rem;"> ${t.holes.length} open</span>`
        : '';
      row.innerHTML = `
        <td>${t.rank}</td>
        <td>${t.teamName} ${t.isMe ? '<span style="font-size:0.75rem; color:var(--accent-cyan);">(Me)</span>' : ''}</td>
        <td>${t.rostered}${gaps}</td>
        <td>${t.points.toFixed(1)}</td>
      `;
      standingsBody.appendChild(row);
    });
    return;
  }

  if (standingsHead) {
    standingsHead.innerHTML = '<th>Rank</th><th>Team</th><th>Record</th><th>Points</th>';
  }
  sortedTeams.forEach((t, index) => {
    const row = document.createElement('tr');
    if (t.teamId === league.myTeamId) {
      row.style.background = 'var(--accent-cyan-glow)';
      row.style.fontWeight = '700';
    }
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${t.teamName} ${t.teamId === league.myTeamId ? '<span style="font-size:0.75rem; color:var(--accent-cyan);">(Me)</span>' : ''}</td>
      <td>${t.record.wins}-${t.record.losses}</td>
      <td>${t.pointsScored.toFixed(1)}</td>
    `;
    standingsBody.appendChild(row);
  });
}

/**
 * Is the local sync server up, and is the extension actually feeding it?
 *
 * A web page cannot start a process -- that is a browser security boundary with
 * no way around it. What it can do is make the failure impossible to miss,
 * because the states below look identical from the draft screen and only one of
 * them means the advice on it is live.
 */
async function checkDraftReadiness() {
  const onLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!onLocalhost) {
    return { ok: false, kind: 'not-local',
      message: 'This page is not served from your machine, so the ESPN extension '
        + 'has nowhere to send draft data. Live sync only works on '
        + 'http://localhost:8000.' };
  }
  try {
    const res = await fetch('/health?cb=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('status ' + res.status);
    const h = await res.json();
    if (!h.syncFileExists) {
      return { ok: false, kind: 'no-sync',
        message: 'Server is running, but the extension has never synced. Open your '
          + 'ESPN draft room and confirm the extension is loaded there.' };
    }
    if (h.syncFileAgeSeconds > 120) {
      const mins = Math.round(h.syncFileAgeSeconds / 60);
      return { ok: false, kind: 'stale',
        message: `Server is running, but the last sync was ${mins} minutes ago. The `
          + 'draft room may be closed, or Chrome may be running an old copy of the '
          + 'extension \u2014 check window.__GRIDIRON_EDGE_VERSION__ in its console.' };
    }
    return { ok: true, kind: 'live',
      message: `last sync ${Math.round(h.syncFileAgeSeconds)}s ago` };
  } catch (e) {
    return { ok: false, kind: 'down',
      message: 'The local sync server is not running. Start it, then reload this page.' };
  }
}

function renderDraftReadiness(state) {
  const host = document.getElementById('draft-readiness');
  if (!host) return;
  if (state.ok) {
    host.innerHTML = `
      <div style="padding:0.5rem 0.85rem; border-radius:6px; margin-bottom:0.75rem;
                  background:rgba(22,199,132,0.10); border-left:3px solid #16c784;
                  font-size:0.82rem; color:var(--text-secondary);">
        <strong style="color:#16c784;">DRAFT SYNC LIVE</strong> \u2014 ${state.message}
      </div>`;
    return;
  }
  const cmd = 'cd ~/Documents/Projects/GridironEdge && python3 server.py';
  host.innerHTML = `
    <div style="padding:0.85rem 1rem; border-radius:6px; margin-bottom:1rem;
                background:rgba(255,82,82,0.10); border:1px solid rgba(255,82,82,0.45);">
      <div style="font-weight:800; color:#ff5252; font-size:0.78rem;
                  letter-spacing:0.6px; margin-bottom:0.3rem;">
        DRAFT SYNC NOT LIVE \u2014 recommendations are running on stale or mock data
      </div>
      <div style="font-size:0.85rem; color:var(--text-secondary); line-height:1.45;">
        ${state.message}
      </div>
      ${(state.kind === 'down' || state.kind === 'not-local') ? `
        <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.6rem;">
          <code style="flex:1; padding:0.4rem 0.6rem; border-radius:4px; font-size:0.78rem;
                       background:rgba(0,0,0,0.3); color:var(--text-primary);
                       overflow-x:auto; white-space:nowrap;">${cmd}</code>
          <button class="btn-secondary" id="btn-copy-server-cmd"
                  style="padding:0.35rem 0.7rem; font-size:0.78rem; white-space:nowrap;">
            Copy command
          </button>
        </div>` : ''}
    </div>`;
  const btn = document.getElementById('btn-copy-server-cmd');
  if (btn) {
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        btn.textContent = 'Copied \u2014 paste in Terminal';
      } catch (e) {
        btn.textContent = 'Copy failed \u2014 select it manually';
      }
    };
  }
}

// Render Live Draft Command Center
function renderDraftPage(league = store.getActiveLeague()) {
  if (!league) return;
  checkDraftReadiness().then(renderDraftReadiness).catch(() => {});

  const currentPick = league.draftState.currentPick;
  const db = league.playerDatabase;

  // Render recent picks panel
  const picksList = document.getElementById('draft-recent-picks');
  picksList.innerHTML = '';
  
  const totalPicks = league.leagueSize * (league.rosterSettings.startersCount + league.rosterSettings.benchCount);
  document.getElementById('draft-info-pick').innerHTML = `${currentPick} / ${totalPicks}`;
  document.getElementById('draft-info-round').innerHTML = Math.floor((currentPick - 1) / league.leagueSize) + 1;

  // Build picking list
  const picksHtml = [];
  // Show next 4 picks and past 4 picks
  const selections = league.draftState.selections || [];
  
  for (let p = Math.max(1, currentPick - 3); p <= Math.min(totalPicks, currentPick + 5); p++) {
    const selection = selections.find(s => s.pick === p);
    
    // Determine team index
    const round = Math.floor((p - 1) / league.leagueSize) + 1;
    const relPick = (p - 1) % league.leagueSize;
    let teamIndex = relPick;
    if (league.draftState.draftType === 'snake' && round % 2 === 0) {
      teamIndex = league.leagueSize - 1 - relPick;
    }
    const teamId = league.draftState.draftOrder[teamIndex];
    const team = league.teams.find(t => t.teamId === teamId);

    const isCurrent = p === currentPick;
    const isUser = teamId === league.myTeamId;
    let details = 'Picking...';
    if (selection) {
      const pl = db[selection.playerId];
      details = pl ? `${pl.name} (${pl.position}-${pl.team})` : 'Selected';
    }

    picksHtml.push(`
      <div style="display:flex; justify-content:space-between; align-items:center; padding: 0.5rem 0.75rem; border-radius: var(--border-radius-sm); border: 1px solid ${isCurrent ? 'var(--accent-cyan)' : 'var(--border-color)'}; background: ${isCurrent ? 'var(--accent-cyan-glow)' : 'var(--bg-surface-elevated)'};">
        <span style="font-weight: 700; font-size: 0.85rem; color: ${isUser ? 'var(--accent-green)' : 'var(--text-secondary)'};">
          R${round} P${p} - ${team ? team.teamName : 'Opponent'}
        </span>
        <span style="font-size:0.9rem; font-weight: 600;">${details}</span>
      </div>
    `);
  }
  picksList.innerHTML = picksHtml.join('');

  // Fetch recommendations
  const rec = getDraftRecommendations(league);
  const recPanel = document.getElementById('draft-rec-panel');
  const alertTier = document.getElementById('draft-tier-warning');
  const alertTierText = document.getElementById('draft-tier-warning-text');

  if (!rec) {
    recPanel.innerHTML = '<div class="empty-state">Draft Completed. Review your roster in the My Team dashboard.</div>';
    alertTier.style.display = 'none';
    return;
  }

  // Draw Scarcity alert banner
  if (rec.tierWarning) {
    alertTier.style.display = 'flex';
    alertTierText.innerHTML = rec.tierWarning;
  } else {
    alertTier.style.display = 'none';
  }

  // Draft recommended card contents
  const isAuction = league.draftState.draftType === 'auction';

  if (isAuction) {
    renderAuctionBoard(league, db, rec);
    return;
  }

  {
    recPanel.innerHTML = `
      <h3 style="color:var(--accent-cyan); font-size: 1.3rem; margin-bottom: 0.5rem; font-family:var(--font-family-title);">Draft ${rec.primaryPick.name} now.</h3>
      <div style="font-size: 0.95rem; color: var(--text-primary); display:flex; flex-direction:column; gap:0.4rem; margin-bottom: 1rem;">
        <p><strong>Rationale:</strong> ${rec.whyBest}</p>
        <p><strong>Expected Advantage:</strong> ${rec.advantage}</p>
        <p><strong>Risk Level:</strong> ${rec.riskLevel}</p>
        <p><strong>Future Roster Plan:</strong> ${rec.planChange}</p>
      </div>
      
      <div style="border-top:1px solid var(--border-color); padding-top:0.75rem;">
        <h4 style="font-size:0.85rem; text-transform:uppercase; color:var(--text-secondary); margin-bottom:0.5rem;">Shortlist Alternatives:</h4>
        <div style="display:flex; flex-wrap:wrap; gap:0.5rem;">
          ${rec.alternatives.slice(0,4).map(p => `
            <button class="btn-secondary" style="padding:0.35rem 0.65rem; font-size:0.8rem;" onclick="window.store.recordDraftPick(${currentPick}, '${p.id}')">
              + ${p.name} (${p.position})
            </button>
          `).join('')}
        </div>
      </div>
      
      <div style="margin-top: 1rem;">
        <button class="btn-success" style="width:100%;" onclick="window.store.recordDraftPick(${currentPick}, '${rec.primaryPick.id}')">
          Draft ${rec.primaryPick.name} (${rec.primaryPick.position})
        </button>
      </div>
    `;
  }

  // Draw players table body
  const tableBody = document.getElementById('draft-player-table-body');
  tableBody.innerHTML = '';

  // Get available list from db
  const draftedIds = new Set((league.draftState.selections || []).map(s => s.playerId));
  let list = Object.values(db).filter(p => !draftedIds.has(p.id));

  // Filter lists based on selected tabs
  if (activeDraftFilter === 'QB') list = list.filter(p => p.position === 'QB');
  else if (activeDraftFilter === 'RB') list = list.filter(p => p.position === 'RB');
  else if (activeDraftFilter === 'WR') list = list.filter(p => p.position === 'WR');
  else if (activeDraftFilter === 'TE') list = list.filter(p => p.position === 'TE');
  else if (activeDraftFilter === 'flex') list = list.filter(p => ['RB', 'WR', 'TE'].includes(p.position));
  else if (activeDraftFilter === 'dst-k') list = list.filter(p => ['D/ST', 'K'].includes(p.position));

  // Search query filter
  if (draftSearchQuery) {
    list = list.filter(p => p.name.toLowerCase().includes(draftSearchQuery) || p.team.toLowerCase().includes(draftSearchQuery));
  }

  // Sort by adp
  list.sort((a,b) => a.adp - b.adp);

  // Recalculate next user pick absolute order to re-run probability math
  const nextP = rec.willBeAvailable;

  const myTeam = store.getMyTeam();
  const budget = myTeam ? myTeam.faabRemaining : 200;
  const remainingSpots = (league.rosterSettings.startersCount + league.rosterSettings.benchCount) - (myTeam ? myTeam.roster.length : 0);
  const opponentsFaab = league.teams.filter(t => t.teamId !== league.myTeamId).map(t => t.faabRemaining);
  const maxOpponentBid = Math.max(...opponentsFaab, 0);

  list.forEach(p => {
    const row = document.createElement('tr');
    
    // Determine availability status bar color
    // Calculate availability at next pick (approx)
    const sd = Math.max(3, p.adp * 0.1); 
    const z = (currentPick + league.leagueSize - p.adp) / sd;
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    let pVal = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    if (z < 0) pVal = 1 - pVal;
    const avPct = Math.min(100, Math.max(0, Math.round((1 - pVal) * 100)));

    let avBadge = 'badge-green';
    if (avPct < 30) avBadge = 'badge-red';
    else if (avPct < 70) avBadge = 'badge-gold';

    const bidInfo = calculateAuctionBid(p, budget, Math.max(1, remainingSpots), maxOpponentBid, league.leagueSize);
    const targetBid = bidInfo ? bidInfo.recommendedBid : 0;

    row.innerHTML = `
      <td><strong>${p.name}</strong></td>
      <td><span class="badge-solid badge-cyan">${p.position}</span></td>
      <td>${p.team}</td>
      <td><span style="display:inline-flex; align-items:center;">${p.projectedPoints.toFixed(1)}${generateSparkline(p.matchProjs)}</span></td>
      <td>${p.adp.toFixed(1)}</td>
      <td><strong style="color:var(--accent-green); font-weight:700;">$${targetBid}</strong></td>
      <td><span class="badge-solid ${avBadge}">${avPct}%</span></td>
      <td>
        <button class="btn-primary" style="padding:0.25rem 0.5rem; font-size:0.75rem;" id="draft-btn-${p.id}">Draft</button>
      </td>
    `;
    tableBody.appendChild(row);

    // Bind draft button click
    document.getElementById(`draft-btn-${p.id}`).onclick = () => {
      store.recordDraftPick(currentPick, p.id);
    };
  });

  if (list.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="8" class="empty-state">No matching available players.</td></tr>`;
  }
}

/* =========================================================================
 * Auction draft board — market-adaptive
 *
 * An auction is a live market, so the advice has to move with it. Everything
 * below re-derives from current league state on every render: teams' budgets,
 * open slots, positional needs, market inflation, and what each remaining
 * player will actually cost given who can still afford him.
 * ========================================================================= */

const ACTION_STYLE = {
  BID:  { color: '#16c784', label: 'BID' },
  HOLD: { color: '#ffb020', label: 'HOLD' },
  EXIT: { color: '#ff5252', label: 'EXIT' },
  // He will sell for more than he is worth to this roster. Distinct from EXIT,
  // which means the bidding has already passed your ceiling.
  PASS: { color: '#ff9800', label: 'LET HIM GO' },
};

function findNominatedPlayer(db, name) {
  if (!name) return null;
  const target = String(name).toLowerCase().trim();
  const all = Object.values(db);
  return all.find(p => p.name.toLowerCase() === target)
      || all.find(p => {
           const n = p.name.toLowerCase();
           return n.includes(target) || target.includes(n);
         })
      || null;
}

/** The live advisory card. Re-rendered on every bid change. */
function auctionAdvisoryHtml(rec) {
  const style = ACTION_STYLE[rec.action] || ACTION_STYLE.HOLD;
  const overspend = !rec.affordable;

  const mustBuyBanner = rec.mustBuy ? `
    <div style="background:linear-gradient(90deg,#7c2d12,#b45309); border:1px solid #f59e0b;
                border-radius:6px; padding:0.6rem 0.85rem; margin-bottom:0.9rem;
                display:flex; align-items:center; gap:0.6rem;">
      <span style="font-size:1.1rem;">🔥</span>
      <div>
        <div style="font-weight:800; letter-spacing:1px; font-size:0.78rem; color:#fff;">MUST BUY</div>
        <div style="font-size:0.8rem; color:#fde68a;">
          Missing him costs about ${rec.lossIfMissed} lineup points — this is where your budget should go.
        </div>
      </div>
    </div>` : '';

  const stat = (label, value, color) => `
    <div style="flex:1; min-width:110px;">
      <div style="font-size:0.66rem; color:var(--text-secondary); text-transform:uppercase;
                  letter-spacing:0.5px; font-weight:600;">${label}</div>
      <div style="font-size:1.25rem; font-weight:800; color:${color || 'var(--text-primary)'};">${value}</div>
    </div>`;

  return `
    ${mustBuyBanner}
    <div style="display:flex; flex-wrap:wrap; gap:1rem; margin-bottom:0.9rem;">
      ${stat('Current bid', '$' + rec.currentBid)}
      ${stat('Bid now', rec.recommendedBid > 0 ? '$' + rec.recommendedBid : '—', style.color)}
      ${stat('Walk-away ceiling', '$' + rec.maxBid, rec.mustBuy ? '#f59e0b' : 'var(--accent-green)')}
      ${stat('Market forecast', '$' + rec.expectedPrice)}
      ${stat('Action', style.label, style.color)}
      ${stat('Confidence', rec.confidence.toUpperCase())}
    </div>

    <p style="margin:0 0 0.9rem 0; font-size:0.88rem; color:var(--text-secondary); line-height:1.45;">
      ${rec.reason}
    </p>

    <div style="display:flex; flex-wrap:wrap; gap:1rem; padding:0.7rem 0.85rem;
                background:rgba(0,0,0,0.25); border-radius:6px;
                border:1px solid ${overspend ? 'rgba(255,82,82,0.45)' : 'rgba(255,255,255,0.06)'};">
      ${stat('Budget if you win', '$' + rec.budgetAfterWin,
             rec.budgetAfterWin < 0 ? '#ff5252' : undefined)}
      ${stat('Needed to fill roster', '$' + rec.budgetToCompleteRoster,
             overspend ? '#ff5252' : undefined)}
      ${stat('Slots left after', rec.spotsAfterWin)}
      ${stat('Market inflation', rec.inflation + 'x',
             rec.inflation > 1.15 ? '#ffb020' : rec.inflation < 0.9 ? '#16c784' : undefined)}
    </div>

    ${rec.tradeoff ? `
      <p style="margin:0.75rem 0 0 0; font-size:0.82rem; color:#ffb020; line-height:1.4;">
        ⚠️ ${rec.tradeoff}
      </p>` : ''}
    ${overspend ? `
      <p style="margin:0.5rem 0 0 0; font-size:0.82rem; color:#ff5252; line-height:1.4;">
        Winning at this price leaves you short of what the rest of your roster is forecast to cost.
      </p>` : ''}
  `;
}

/** Every team's money and needs — the state the recommendations are reading. */
function auctionMarketTableHtml(league) {
  const state = buildLeagueState(league);
  const rows = state.teams.map(t => {
    const needs = Object.keys(t.needs).map(p => `${p}${t.needs[p] > 1 ? '×' + t.needs[p] : ''}`).join(' ');
    const isMe = t.teamId === state.myTeamId;
    return `
      <tr style="${isMe ? 'background:rgba(0,229,255,0.07);' : ''}">
        <td style="padding:0.3rem 0.5rem; font-weight:${isMe ? 700 : 400};">${t.teamName}${isMe ? ' (you)' : ''}</td>
        <td style="padding:0.3rem 0.5rem; text-align:right;">$${t.budget}</td>
        <td style="padding:0.3rem 0.5rem; text-align:right;">$${t.maxBid}</td>
        <td style="padding:0.3rem 0.5rem; text-align:right;">${t.spotsLeft}</td>
        <td style="padding:0.3rem 0.5rem; color:var(--text-secondary); font-size:0.78rem;">${needs || '—'}</td>
      </tr>`;
  }).join('');

  return `
    <details style="margin-top:1rem;">
      <summary style="cursor:pointer; font-size:0.8rem; text-transform:uppercase; letter-spacing:0.5px;
                      color:var(--text-secondary); font-weight:700;">
        League market state — who can still outbid you
      </summary>
      <table style="width:100%; margin-top:0.6rem; font-size:0.82rem; border-collapse:collapse;">
        <thead>
          <tr style="color:var(--text-secondary); font-size:0.7rem; text-transform:uppercase;">
            <th style="text-align:left; padding:0.3rem 0.5rem;">Team</th>
            <th style="text-align:right; padding:0.3rem 0.5rem;">Budget</th>
            <th style="text-align:right; padding:0.3rem 0.5rem;">Max bid</th>
            <th style="text-align:right; padding:0.3rem 0.5rem;">Slots</th>
            <th style="text-align:left; padding:0.3rem 0.5rem;">Starter needs</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
}

function renderAuctionBoard(league, db, rec) {
  const recPanel = document.getElementById('draft-rec-panel');
  const state = buildLeagueState(league);
  const nominated = findNominatedPlayer(db, league.draftState.currentNomination);

  // Targets worth planning around, whether or not one is on the block.
  let watchlist = [];
  try {
    watchlist = targetBoard(league, 6);
  } catch (e) {
    console.error('Auction target board failed:', e);
  }

  const watchHtml = watchlist.length ? `
    <div style="border-top:1px solid var(--border-color); padding-top:0.85rem; margin-top:1rem;">
      <h4 style="font-size:0.8rem; text-transform:uppercase; color:var(--text-secondary);
                 margin:0 0 0.6rem 0; letter-spacing:0.5px;">Priority targets</h4>
      <div style="display:flex; flex-direction:column; gap:0.35rem;">
        ${watchlist.map(w => `
          <div style="display:flex; align-items:center; gap:0.6rem; font-size:0.85rem;
                      padding:0.35rem 0.5rem; border-radius:4px;
                      background:${w.mustBuy ? 'rgba(245,158,11,0.14)' : 'rgba(255,255,255,0.03)'};
                      border-left:3px solid ${w.mustBuy ? '#f59e0b' : 'transparent'};">
            ${w.mustBuy ? '<span title="Must Buy">🔥</span>' : '<span style="width:1em;"></span>'}
            <span style="flex:1; font-weight:${w.mustBuy ? 700 : 500};">${w.player.name}</span>
            <span style="color:var(--text-secondary); font-size:0.78rem;">${w.player.position}</span>
            <span style="color:var(--accent-green); font-weight:700;">up to $${w.maxBid}</span>
            <span style="color:var(--text-secondary); font-size:0.78rem;">mkt $${w.expectedPrice}</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  if (!nominated) {
    recPanel.innerHTML = `
      <h3 style="color:var(--accent-cyan); font-size:1.15rem; margin:0 0 0.35rem 0;
                 font-family:var(--font-family-title);">Auction board — waiting on a nomination</h3>
      <p style="font-size:0.86rem; color:var(--text-secondary); margin:0 0 0.5rem 0;">
        You have <strong style="color:var(--accent-green);">$${state.me.budget}</strong> for
        <strong>${state.me.spotsLeft}</strong> open spots. Nominate a player, or record a rival's
        winning bid, and the board updates immediately.
      </p>
      ${watchHtml}
      ${auctionMarketTableHtml(league)}
    `;
    return;
  }

  // The live bid from the draft room, when the extension can see it. The input
  // stays editable so a stale or mis-read scrape can always be corrected.
  const scrapedBid = typeof league.draftState.currentNominationBid === 'number'
    ? league.draftState.currentNominationBid : null;

  const draw = (bid) => {
    const r = recommendBid(league, nominated, bid);
    document.getElementById('auction-advisory').innerHTML = auctionAdvisoryHtml(r);
    const priceInput = document.getElementById('nom-winner-price');
    if (priceInput && document.activeElement !== priceInput) {
      priceInput.value = Math.max(1, r.recommendedBid || Math.min(r.maxBid || 1, bid + 1));
    }
  };

  const initial = recommendBid(league, nominated, scrapedBid ?? 0);

  recPanel.innerHTML = `
    <div style="background:linear-gradient(135deg,#0f172a,#1e293b); padding:1.25rem;
                border-radius:8px; border:2px solid ${initial.mustBuy ? '#f59e0b' : 'var(--accent-cyan)'};
                margin-bottom:1.25rem;
                box-shadow:0 0 15px ${initial.mustBuy ? 'rgba(245,158,11,0.25)' : 'rgba(0,229,255,0.18)'};">
      <h4 style="color:var(--accent-cyan); text-transform:uppercase; letter-spacing:1px;
                 font-size:0.7rem; margin:0 0 0.4rem 0; font-weight:700;">On the block</h4>
      <h2 style="margin:0 0 0.9rem 0; font-size:1.4rem; font-family:var(--font-family-title);">
        ${nominated.name}
        <span style="font-size:0.9rem; color:var(--text-secondary);">
          (${nominated.position} — ${nominated.team})
        </span>
      </h2>

      <div style="display:flex; align-items:center; gap:0.6rem; margin-bottom:1rem;">
        <label style="font-size:0.75rem; color:var(--text-secondary); text-transform:uppercase;
                      font-weight:600;">Current bid $</label>
        <input type="number" id="auction-current-bid" value="${scrapedBid ?? 0}"
               min="0" step="1" class="input-control"
               style="width:110px; padding:0.35rem 0.5rem; font-size:0.95rem; font-weight:700;">
        <span style="font-size:0.75rem; color:${scrapedBid !== null ? 'var(--accent-green)' : 'var(--text-secondary)'};">
          ${scrapedBid !== null
            ? 'live from the draft room — edit to override'
            : 'not detected from the draft room — type the current bid'}
        </span>
      </div>

      <div id="auction-advisory">${auctionAdvisoryHtml(initial)}</div>

      <div style="background:rgba(0,0,0,0.25); padding:0.75rem; border-radius:6px;
                  border:1px solid rgba(255,255,255,0.05); margin-top:1rem;">
        <h5 style="margin:0 0 0.5rem 0; text-transform:uppercase; font-size:0.68rem;
                   color:var(--text-secondary); font-weight:700;">Record the winner</h5>
        <div style="display:flex; align-items:center; gap:0.5rem;">
          <select class="input-control" id="nom-winner-team"
                  style="flex:2; padding:0.4rem; font-size:0.85rem; height:32px;">
            ${league.teams.map(t => `<option value="${t.teamId}" ${t.teamId === league.myTeamId ? 'selected' : ''}>${t.teamName}</option>`).join('')}
          </select>
          <input type="number" class="input-control" id="nom-winner-price"
                 value="${initial.recommendedBid || 1}" min="1"
                 style="flex:1; padding:0.4rem; font-size:0.85rem; height:32px;">
          <button class="btn btn-success" id="btn-nom-record-win"
                  style="flex:1.5; padding:0.45rem 1rem; font-size:0.85rem; font-weight:700;
                         height:32px; border:none; border-radius:4px; cursor:pointer;
                         background:var(--accent-green); color:#fff;">Record Pick</button>
        </div>
      </div>
    </div>
    ${watchHtml}
    ${auctionMarketTableHtml(league)}
  `;

  const bidInput = document.getElementById('auction-current-bid');
  bidInput.oninput = () => draw(Math.max(0, parseInt(bidInput.value, 10) || 0));

  document.getElementById('btn-nom-record-win').onclick = () => {
    const teamId = parseInt(document.getElementById('nom-winner-team').value, 10);
    const price = parseInt(document.getElementById('nom-winner-price').value, 10) || 1;
    store.recordDraftPickAuction(nominated.id, teamId, price);
    league.draftState.currentNomination = null;
    store.saveLeague(league.leagueId, league);
    renderDraftPage(league);
  };
}

// Render Team Roster View
function renderRosterPage(league = store.getActiveLeague()) {
  const myTeam = store.getMyTeam();
  if (!myTeam) return;

  const db = league.playerDatabase;
  const rosterGrid = document.getElementById('roster-list-grid');
  rosterGrid.innerHTML = '';

  const myRosterIds = myTeam.roster || [];
  const players = myRosterIds.map(id => db[id]).filter(Boolean);

  // Group by rosters slot configuration rules
  const slots = [
    { label: 'QB', pos: 'QB', required: 1 },
    { label: 'RB1', pos: 'RB', required: 1 },
    { label: 'RB2', pos: 'RB', required: 1 },
    { label: 'WR1', pos: 'WR', required: 1 },
    { label: 'WR2', pos: 'WR', required: 1 },
    { label: 'TE', pos: 'TE', required: 1 },
    { label: 'FLEX', pos: ['RB', 'WR', 'TE'], required: 1, isFlex: true },
    { label: 'D/ST', pos: 'D/ST', required: 1 },
    { label: 'K', pos: 'K', required: 1 }
  ];

  // Distribute players to slots
  const allocatedIds = new Set();
  const starters = [];
  const bench = [];

  // Best available at each slot, not first drafted. `players` is in draft
  // order, so picking the first match put whoever was taken earliest in RB1 and
  // could leave a better back on the bench.
  const byProj = (a, b) => (b.projectedPoints || 0) - (a.projectedPoints || 0);
  slots.forEach(slot => {
    const match = players
      .filter(p => !allocatedIds.has(p.id)
                && (slot.isFlex ? slot.pos.includes(p.position) : p.position === slot.pos))
      .sort(byProj)[0];

    if (match) {
      allocatedIds.add(match.id);
      starters.push({ slot: slot.label, player: match });
    } else {
      starters.push({ slot: slot.label, player: null });
    }
  });

  // Remaining players go to bench
  players.forEach(p => {
    if (!allocatedIds.has(p.id)) {
      bench.push(p);
    }
  });

  // Draw starters list
  starters.forEach(s => {
    const slotRow = document.createElement('div');
    slotRow.className = `roster-slot ${s.slot.startsWith('FLEX') ? 'active-flex' : ''}`;
    
    let infoHtml = '<span style="color:var(--text-muted);">Empty Slot</span>';
    let opp = '';
    let proj = '';
    let badge = '';

    if (s.player) {
      let injBadge = '';
      if (s.player.injuryStatus !== 'Healthy') {
        injBadge = `<span class="badge-solid badge-red" style="font-size:0.65rem; margin-left:0.25rem;">${s.player.injuryStatus}</span>`;
      }
      infoHtml = `
        <div>
          <span class="player-name">${s.player.name}</span> ${injBadge}
          <span class="player-team-pos">${s.player.position} — ${s.player.team}</span>
        </div>
      `;
      opp = s.player.opponent ? `vs ${s.player.opponent}` : 'FA';
      proj = `<span style="display:inline-flex; align-items:center;">${s.player.projectedPoints.toFixed(1)}${generateSparkline(s.player.matchProjs)}</span>`;
      badge = `<span class="badge-solid badge-cyan">Starter</span>`;
    }

    slotRow.innerHTML = `
      <span class="slot-pos">${s.slot}</span>
      <div class="player-info-cell">${infoHtml}</div>
      <span class="player-opponent">${opp}</span>
      <span class="player-proj">${proj}</span>
      <div class="player-status" style="text-align:right;">${badge}</div>
    `;
    rosterGrid.appendChild(slotRow);
  });

  // Draw every bench slot the league has, filled or not. Drawing only the
  // filled ones meant that early in a draft -- exactly when you most want to see
  // how much room is left -- the bench section was invisible.
  bench.sort(byProj);
  const benchSlots = Math.max(bench.length,
                              league.rosterSettings?.benchCount || bench.length);
  for (let index = 0; index < benchSlots; index++) {
    const b = bench[index];
    const slotRow = document.createElement('div');
    slotRow.className = 'roster-slot';

    if (!b) {
      slotRow.innerHTML = `
        <span class="slot-pos">BENCH</span>
        <div class="player-info-cell"><span style="color:var(--text-muted);">Empty Slot</span></div>
        <span class="player-opponent"></span>
        <span class="player-proj"></span>
        <div class="player-status" style="text-align:right;"></div>
      `;
      rosterGrid.appendChild(slotRow);
      continue;
    }

    let injBadge = '';
    if (b.injuryStatus !== 'Healthy') {
      injBadge = `<span class="badge-solid badge-red" style="font-size:0.65rem; margin-left:0.25rem;">${b.injuryStatus}</span>`;
    }

    slotRow.innerHTML = `
      <span class="slot-pos">BENCH</span>
      <div class="player-info-cell">
        <div>
          <span class="player-name">${b.name}</span> ${injBadge}
          <span class="player-team-pos">${b.position} — ${b.team}</span>
        </div>
      </div>
      <span class="player-opponent">${b.opponent ? `vs ${b.opponent}` : 'FA'}</span>
      <span class="player-proj" style="display:inline-flex; align-items:center;">${(b.projectedPoints || 0).toFixed(1)}${generateSparkline(b.matchProjs)}</span>
      <div class="player-status" style="text-align:right;">
        <span class="badge-solid badge-gold" style="background:transparent; border-color:var(--text-muted); color:var(--text-secondary);">Bench</span>
      </div>
    `;
    rosterGrid.appendChild(slotRow);
  }

  // Health assessment card
  const healthCard = document.getElementById('roster-health-analysis');
  const healthyCount = players.filter(p => p.injuryStatus === 'Healthy').length;
  const healthyPct = Math.round((healthyCount / Math.max(1, players.length)) * 100);

  healthCard.innerHTML = `
    <div>
      <span style="font-size:0.8rem; color:var(--text-muted); text-transform:uppercase; display:block;">Roster Health Score</span>
      <span style="font-size:2rem; font-weight:800; color:${healthyPct > 80 ? 'var(--accent-green)' : 'var(--accent-gold)'};">${healthyPct}% Healthy</span>
      <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.25rem;">${players.length - healthyCount} players holding injury flags.</p>
    </div>
    
    <div style="border-top:1px solid var(--border-color); padding-top:1rem;">
      <h4 style="font-size:0.85rem; text-transform:uppercase; color:var(--text-secondary); margin-bottom:0.5rem;">Position Counts:</h4>
      <div style="display:flex; justify-content:space-between; font-size:0.9rem; color:var(--text-primary);">
        <span>QBs: <strong>${players.filter(p=>p.position==='QB').length} / ${league.rosterSettings.QB}</strong></span>
        <span>RBs: <strong>${players.filter(p=>p.position==='RB').length} / ${league.rosterSettings.RB}</strong></span>
        <span>WRs: <strong>${players.filter(p=>p.position==='WR').length} / ${league.rosterSettings.WR}</strong></span>
        <span>TEs: <strong>${players.filter(p=>p.position==='TE').length} / ${league.rosterSettings.TE}</strong></span>
      </div>
    </div>

    <div style="border-top:1px solid var(--border-color); padding-top:1rem; font-size:0.85rem; color:var(--text-secondary);">
      <strong>Position Depth Check:</strong><br>
      Our Wide Receiver room is deep and healthy. We can afford to trade backup WRs to acquire starting RB reinforcements.
    </div>
  `;
}

/**
 * Show what the bracket calls for, and why. Rendered above the lineup so the
 * reasoning arrives before the roster does.
 */
function renderBracketAdvice(advice, applied) {
  const host = document.getElementById('matchup-strategy-hint');
  if (!host) return;
  if (!advice) { host.innerHTML = ''; return; }

  const tone = advice.strategy === 'ceiling' ? '#a78bfa' : '#16c784';
  const badge = advice.isPlayoffs
    ? `<span style="font-size:0.68rem; font-weight:800; letter-spacing:0.6px;
         color:${tone};">PLAYOFF WEEK ${advice.week} — PLAY THE
         ${advice.strategy === 'ceiling' ? 'CEILING' : 'FLOOR'}</span>`
    : `<span style="font-size:0.68rem; font-weight:700; letter-spacing:0.6px;
         color:var(--text-secondary);">WEEK ${advice.week} — REGULAR SEASON</span>`;

  host.innerHTML = `
    <div style="padding:0.7rem 0.9rem; border-radius:6px; margin-bottom:0.75rem;
                background:rgba(255,255,255,0.03); border-left:3px solid ${tone};">
      <div style="display:flex; gap:0.9rem; flex-wrap:wrap; align-items:center;">
        ${badge}
        ${advice.opponent ? `<span style="font-size:0.78rem; color:var(--text-secondary);">
          vs ${advice.opponent.teamName} — win probability
          <strong>${Math.round(advice.winProbability * 100)}%</strong></span>` : ''}
        <span style="font-size:0.72rem; color:var(--text-secondary);">
          confidence ${advice.confidence}</span>
        ${applied !== advice.strategy ? `<span style="font-size:0.72rem; color:#ffb020;">
          (you have overridden this to ${applied})</span>` : ''}
      </div>
      <div style="font-size:0.83rem; color:var(--text-secondary); margin-top:0.35rem;
                  line-height:1.45;">${advice.reason}</div>
    </div>`;
}

// Render Matchup View
function renderMatchupPage(league = store.getActiveLeague()) {
  const myTeam = store.getMyTeam();
  if (!myTeam) return;

  // The engine's own read on floor vs ceiling. In the bracket this is the
  // single most valuable in-season call there is (+4.0 points of championship
  // probability in backtest), and it is the opposite of intuition half the
  // time: favourites should play it safe, underdogs should chase variance.
  let advice = null;
  try {
    advice = recommendLineupStrategy(league);
  } catch (e) {
    console.error('Bracket strategy failed:', e);
  }
  const strategy = weeklyLineupStrategy === 'auto' && advice
    ? advice.strategy
    : weeklyLineupStrategy;

  const opt = optimizeLineup(myTeam.roster, league.playerDatabase, league.rosterSettings, strategy);
  renderBracketAdvice(advice, strategy);
  const startersGrid = document.getElementById('matchup-starters-grid');
  startersGrid.innerHTML = '';

  if (!opt) {
    startersGrid.innerHTML = '<div class="empty-state">No players on this roster yet. '
      + 'Once the draft fills it, lineup advice appears here on the next sync.</div>';
    return;
  }

  // Draw optimized starters
  opt.starters.forEach((p, idx) => {
    const slotRow = document.createElement('div');
    slotRow.className = 'roster-slot';

    slotRow.innerHTML = `
      <span class="slot-pos">Slot ${idx + 1}</span>
      <div class="player-info-cell">
        <div>
          <span class="player-name">${p.name}</span>
          <span class="player-team-pos">${p.position} — ${p.team}</span>
        </div>
      </div>
      <span class="player-opponent">${p.opponent ? `vs ${p.opponent}` : ''}</span>
      <span class="player-proj" style="color: var(--accent-green);">${p.projectedPoints.toFixed(1)}</span>
      <div class="player-status" style="text-align:right;">
        <span class="badge-solid badge-cyan">Optimize</span>
      </div>
    `;
    startersGrid.appendChild(slotRow);
  });

  // Optimization rationale explanation text
  const rationaleBox = document.getElementById('matchup-rationale-text');
  let ratHtml = `<li>${opt.explanation[0]}</li>`;
  
  if (opt.replacementPlans.length > 0) {
    opt.replacementPlans.forEach(plan => {
      ratHtml += `
        <li style="border-left: 2px solid var(--accent-red); padding-left: 0.5rem; list-style:none;">
          <strong style="color:var(--accent-red);">Replacement Backup Plan:</strong> ${plan.condition}
        </li>
      `;
    });
  } else {
    ratHtml += `<li>No starters currently carry active injury flags. Lineup is locked.</li>`;
  }
  rationaleBox.innerHTML = ratHtml;
}

/* =========================================================================
 * Waiver wire & bench — managed as one portfolio of roster spots.
 *
 * Every bench player is re-decided against the best thing available, every
 * week. Nothing is held because it was drafted highly; it is held because the
 * spot returns more with him in it than without.
 * ========================================================================= */

const ACTION_BADGE = {
  [ACTION.PRIORITY]:    { cls: 'badge-green',  tone: '#16c784', urgent: 'MUST ADD' },
  [ACTION.ADD]:         { cls: 'badge-green',  tone: '#16c784' },
  [ACTION.SPECULATIVE]: { cls: 'badge-purple', tone: '#a78bfa', urgent: 'HIGH-UPSIDE STASH' },
  [ACTION.DEFENSIVE]:   { cls: 'badge-gold',   tone: '#ffb020', urgent: 'DEFENSIVE ADD' },
  [ACTION.MONITOR]:     { cls: 'badge-gold',   tone: '#8a94a6' },
  [ACTION.HOLD]:        { cls: 'badge-gold',   tone: '#8a94a6' },
};

const CATEGORY_TONE = {
  [CATEGORY.CORE]:        '#16c784',
  [CATEGORY.STASH]:       '#a78bfa',
  [CATEGORY.HANDCUFF]:    '#38bdf8',
  [CATEGORY.MATCHUP]:     '#8a94a6',
  [CATEGORY.DEFENSIVE]:   '#ffb020',
  [CATEGORY.REPLACEABLE]: '#f59e0b',
  [CATEGORY.DROP]:        '#ff5252',
};

const pct = (v) => `${Math.round((v || 0) * 100)}%`;

function benchRowHtml(b, isWeakest) {
  const tone = CATEGORY_TONE[b.category] || '#8a94a6';
  const o = b.outcomes || {};
  return `
    <div style="padding:0.6rem 0.75rem; border-radius:6px; margin-bottom:0.4rem;
                background:${isWeakest ? 'rgba(255,82,82,0.10)' : 'rgba(255,255,255,0.03)'};
                border-left:3px solid ${isWeakest ? '#ff5252' : tone};">
      <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
        <strong style="flex:1; min-width:140px;">${b.player.name}</strong>
        <span style="font-size:0.75rem; color:var(--text-secondary);">${b.player.position}</span>
        <span style="font-size:0.72rem; font-weight:700; color:${tone};
                     text-transform:uppercase; letter-spacing:0.4px;">${b.category}</span>
        ${isWeakest ? '<span style="font-size:0.7rem; font-weight:800; color:#ff5252;">WEAKEST — SAFE TO DROP</span>' : ''}
        <span style="font-size:0.8rem; color:var(--text-secondary);">Hold ${b.holdValue}</span>
      </div>
      <div style="font-size:0.82rem; color:var(--text-secondary); margin-top:0.3rem; line-height:1.4;">
        ${b.reason}
      </div>
      <div style="display:flex; gap:0.9rem; flex-wrap:wrap; margin-top:0.35rem;
                  font-size:0.72rem; color:var(--text-secondary);">
        <span>starts ${pct(b.startProbability)}</span>
        <span>breakout ${pct(b.breakoutProbability)}</span>
        <span>bust ${pct(b.bustProbability)}</span>
        <span>RoS ${b.restOfSeasonPoints} pts</span>
        <span>playoffs ${b.playoffPoints} pts</span>
        ${b.blockingValue > 0 ? `<span style="color:#ffb020;">blocks ${b.blockingValue}</span>` : ''}
        ${b.claimProbability > 0.4 ? `<span style="color:#ffb020;">${pct(b.claimProbability)} claimed if dropped</span>` : ''}
      </div>
      <div style="font-size:0.7rem; color:var(--text-secondary); margin-top:0.25rem; opacity:0.8;">
        weekly starter ${pct(o.weeklyStarter)} · matchup ${pct(o.matchupStarter)} ·
        injury-only ${pct(o.injuryOnly)} · replaceable ${pct(o.replaceable)}
      </div>
    </div>`;
}

function waiverCardHtml(t, idx) {
  const badge = ACTION_BADGE[t.action] || { cls: 'badge-gold', tone: '#8a94a6' };
  const f = t.faab;
  return `
    <div class="recommendation-item" style="border-left:3px solid ${badge.tone};">
      <div class="item-action-title">
        <span>${t.action}: <strong>${t.addPlayer.name}</strong>
          (${t.addPlayer.position}-${t.addPlayer.team})</span>
        <span class="badge-solid ${badge.cls}">${t.confidence} confidence</span>
      </div>
      ${badge.urgent ? `<div style="font-size:0.72rem; font-weight:800; color:${badge.tone};
        letter-spacing:0.6px; margin-bottom:0.35rem;">${badge.urgent}</div>` : ''}

      <div class="item-meta">
        <span>Drop: <strong>${t.dropPlayer ? t.dropPlayer.name : 'open spot'}</strong></span>
        <span>Net rest-of-season: <strong>${t.netRestOfSeason >= 0 ? '+' : ''}${t.netRestOfSeason}</strong> pts</span>
        <span>Immediate lineup: <strong>${t.immediateLineupGain > 0 ? '+' + t.immediateLineupGain : '—'}</strong>/wk</span>
      </div>

      <div class="item-details">${t.reason}</div>

      <div style="display:flex; gap:0.9rem; flex-wrap:wrap; margin:0.5rem 0;
                  font-size:0.74rem; color:var(--text-secondary);">
        <span>acquisition value ${t.acquisitionValue}</span>
        <span>breakout ${pct(t.breakoutProbability)}</span>
        <span>bust ${pct(t.bustProbability)}</span>
        <span>scarcity ${pct(t.positionalScarcity)}</span>
        <span>playoff ${t.playoffPoints} pts</span>
        ${t.blockingValue > 0 ? `<span style="color:#ffb020;">blocking ${t.blockingValue}</span>` : ''}
        <span style="color:${t.claimProbability > 0.55 ? '#ff5252' : 'inherit'};">
          ${pct(t.claimProbability)} chance a rival claims him${t.likelySuitors.length ? ' (' + t.likelySuitors[0] + ')' : ''}
        </span>
      </div>

      <div style="background:rgba(0,0,0,0.22); border:1px solid rgba(255,255,255,0.05);
                  border-radius:6px; padding:0.6rem 0.75rem; margin-bottom:0.5rem;">
        <div style="font-size:0.7rem; text-transform:uppercase; letter-spacing:0.5px;
                    color:var(--text-secondary); font-weight:700; margin-bottom:0.4rem;">
          FAAB ladder — probability of winning the claim
        </div>
        <div style="display:flex; gap:1.2rem; flex-wrap:wrap; font-size:0.82rem;">
          <span>min <strong>$${f.minimum}</strong> (${pct(f.winProbability.minimum)})</span>
          <span style="color:var(--accent-green);">recommended <strong>$${f.recommended}</strong>
            (${pct(f.winProbability.recommended)})</span>
          <span>aggressive <strong>$${f.aggressive}</strong> (${pct(f.winProbability.aggressive)})</span>
          <span>max justified <strong>$${f.maximum}</strong> (${pct(f.winProbability.maximum)})</span>
        </div>
        <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:0.35rem;">
          Leaves $${f.budgetAfter} of $${f.budget}. ${f.opportunityCost}
        </div>
      </div>

      ${t.triggers.length ? `<div class="item-alternatives">
        <strong>Watch for:</strong> ${t.triggers.join(' · ')}</div>` : ''}

      <div style="margin-top:0.75rem; text-align:right;">
        <button class="btn-success" style="padding:0.35rem 0.75rem; font-size:0.8rem;"
                id="claim-btn-${idx}">Submit claim at $${f.recommended}</button>
      </div>
    </div>`;
}

/**
 * Pull live news before evaluating the wire, then re-render.
 *
 * The panel on this page already showed headlines, but purely as reading
 * material -- nothing it fetched reached the engine. This makes the same
 * information change the recommendations: an injury promotes the backup nobody
 * has written about yet, and league-wide add volume replaces a guess about
 * whether a rival will claim someone with a measurement of how many already
 * have.
 */
let newsState = { status: 'idle', summary: null };

async function refreshNewsAndRerender(league) {
  if (newsState.status === 'loading') return;
  newsState = { status: 'loading', summary: null };
  renderWaiversPage(league);
  try {
    const res = await refreshNews(league);
    newsState = { status: res.newsAvailable ? 'ok' : 'unavailable', summary: res };
  } catch (e) {
    console.error('News refresh failed:', e);
    newsState = { status: 'unavailable', summary: { errors: [e.message] } };
  }
  renderWaiversPage(league);
}

function newsBannerHtml(league) {
  const s = newsState.summary;
  if (newsState.status === 'loading') {
    return `<div style="padding:0.6rem 0.9rem; margin-bottom:0.9rem; border-radius:6px;
      background:rgba(255,255,255,0.04); font-size:0.82rem; color:var(--text-secondary);">
      Checking injury, trade and depth-chart news…</div>`;
  }
  if (newsState.status === 'unavailable') {
    return `<div style="padding:0.6rem 0.9rem; margin-bottom:0.9rem; border-radius:6px;
      background:rgba(255,82,82,0.10); border-left:3px solid #ff5252; font-size:0.82rem;
      color:var(--text-secondary);">
      <strong style="color:#ff5252;">News feeds unreachable.</strong>
      Recommendations are running on projections and usage only — an injury from
      this morning will not be reflected.
      <button id="btn-news-retry" class="btn-secondary"
        style="margin-left:0.6rem; padding:0.2rem 0.6rem; font-size:0.75rem;">Retry</button>
    </div>`;
  }
  if (newsState.status === 'ok' && s) {
    // A generic feed is reading material. What matters is bad news about a
    // player you own, and opportunity among players you do not.
    const row = (x, tone) => `
      <div style="display:flex; gap:0.6rem; align-items:baseline; padding:0.3rem 0;
                  font-size:0.82rem; border-bottom:1px solid rgba(255,255,255,0.05);">
        <strong style="color:${tone}; min-width:150px;">${x.player}</strong>
        <span style="color:var(--text-secondary); font-size:0.75rem;">${x.position}-${x.team}</span>
        <span style="flex:1; color:var(--text-secondary);">
          ${x.headline || `${x.addsLast24h.toLocaleString()} managers added him in 24h`}
        </span>
        ${x.urgency === 'high' ? '<span style="color:#ff5252; font-size:0.7rem; font-weight:800;">URGENT</span>' : ''}
      </div>`;

    const mine = (s.affectsMyTeam || []).slice(0, 6);
    const opps = (s.opportunities || []).slice(0, 6);

    return `
    <div style="padding:0.7rem 0.9rem; margin-bottom:0.9rem; border-radius:6px;
                background:rgba(255,255,255,0.03); border-left:3px solid #16c784;">
      <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;
                  margin-bottom:0.5rem;">
        <strong style="color:#16c784; font-size:0.82rem;">News applied</strong>
        <span style="font-size:0.75rem; color:var(--text-secondary);">
          ${s.itemsClassified} headlines · ${s.playersAffected} players re-valued ·
          ${s.trendingTracked} tracked for add volume
        </span>
        <button id="btn-news-retry" class="btn-secondary"
          style="margin-left:auto; padding:0.2rem 0.6rem; font-size:0.75rem;">Refresh</button>
      </div>

      ${mine.length ? `
        <div style="font-size:0.7rem; text-transform:uppercase; letter-spacing:0.6px;
                    color:#ff5252; font-weight:800; margin:0.5rem 0 0.2rem;">
          Affects your roster</div>
        ${mine.map((x) => row(x, '#ff5252')).join('')}` : ''}

      ${opps.length ? `
        <div style="font-size:0.7rem; text-transform:uppercase; letter-spacing:0.6px;
                    color:#16c784; font-weight:800; margin:0.7rem 0 0.2rem;">
          Worth claiming</div>
        ${opps.map((x) => row(x, '#16c784')).join('')}` : ''}

      ${!mine.length && !opps.length ? `
        <div style="font-size:0.82rem; color:var(--text-secondary);">
          Nothing in the last day affects your roster or the players you could claim.
        </div>` : ''}
    </div>`;
  }
  return `<div style="margin-bottom:0.9rem;">
    <button id="btn-news-retry" class="btn-secondary"
      style="padding:0.3rem 0.75rem; font-size:0.8rem;">Check injury &amp; trade news</button>
  </div>`;
}

function renderWaiversPage(league = store.getActiveLeague()) {
  if (!league) return;

  const listContainer = document.getElementById('waiver-recommendations-list');
  listContainer.innerHTML = '';

  let report;
  try {
    report = evaluateWaivers(league);
  } catch (e) {
    console.error('Roster portfolio evaluation failed:', e);
    listContainer.innerHTML = '<div class="empty-state">Could not evaluate the waiver wire.</div>';
    return;
  }

  const { phase, targets, bench, weakest, topMove } = report;

  const headerHtml = `
    <div style="padding:0.75rem 1rem; margin-bottom:1rem; border-radius:6px;
                background:var(--bg-surface-elevated); border:1px solid var(--border-color);">
      <div style="display:flex; gap:1.25rem; flex-wrap:wrap; align-items:center;">
        <span style="font-size:0.72rem; text-transform:uppercase; letter-spacing:0.6px;
                     color:var(--text-secondary); font-weight:700;">
          Week ${phase.week} · ${phase.label} · ${phase.weeksRemaining} weeks left
        </span>
        <span style="font-size:0.78rem; color:var(--text-secondary);">
          Upside weighting <strong>${phase.upsideWeight.toFixed(2)}</strong> ·
          startability <strong>${phase.startabilityWeight.toFixed(2)}</strong>
        </span>
      </div>
      <div style="font-size:0.78rem; color:var(--text-secondary); margin-top:0.35rem;">
        ${phase.weeksRemaining > 8
          ? 'Early enough that a breakout still has time to pay off — upside is weighted heavily.'
          : 'Late in the season — startability and playoff weeks now outweigh speculative upside.'}
      </div>
    </div>`;

  const moveHtml = topMove ? `
    <div style="padding:0.85rem 1rem; margin-bottom:1rem; border-radius:6px;
                background:linear-gradient(135deg,#0f172a,#1e293b);
                border:2px solid ${(ACTION_BADGE[topMove.action] || {}).tone || 'var(--accent-cyan)'};">
      <div style="font-size:0.7rem; text-transform:uppercase; letter-spacing:0.8px;
                  color:var(--accent-cyan); font-weight:700; margin-bottom:0.3rem;">
        Recommended transaction
      </div>
      <div style="font-size:1.05rem; font-weight:700;">
        Add ${topMove.addPlayer.name} · Drop ${topMove.dropPlayer ? topMove.dropPlayer.name : 'open spot'}
        · $${topMove.faab.recommended} FAAB
      </div>
      <div style="font-size:0.83rem; color:var(--text-secondary); margin-top:0.3rem;">
        ${topMove.reason}
      </div>
    </div>` : '';

  const benchHtml = bench && bench.length ? `
    <details open style="margin-bottom:1.25rem;">
      <summary style="cursor:pointer; font-size:0.78rem; text-transform:uppercase;
                      letter-spacing:0.6px; color:var(--text-secondary); font-weight:700;
                      margin-bottom:0.6rem;">
        Bench portfolio — ${bench.length} spots, ranked by hold value
      </summary>
      <div style="margin-top:0.6rem;">
        ${bench.map((b) => benchRowHtml(b, weakest && b.player.id === weakest.player.id)).join('')}
      </div>
    </details>` : '';

  const targetsHtml = targets.length
    ? targets.slice(0, 6).map((t, i) => waiverCardHtml(t, i)).join('')
    : '<div class="empty-state">Nothing on the wire beats what you already hold.</div>';

  const caveat = `
    <p style="font-size:0.72rem; color:var(--text-secondary); margin-top:1rem; line-height:1.5;">
      Derived from projections, usage metrics, injury status, bye weeks, ADP, rosters and FAAB
      balances. Not yet wired to a data source, so not used: ${report.missingInputs.join(', ')}.
      Calls that would depend on those are reported at lower confidence rather than guessed.
    </p>`;

  listContainer.innerHTML = newsBannerHtml(league) + headerHtml + moveHtml
    + benchHtml + targetsHtml + caveat;

  const retry = document.getElementById('btn-news-retry');
  if (retry) retry.onclick = () => refreshNewsAndRerender(league);

  // Pull news automatically the first time the page is opened.
  if (newsState.status === 'idle') refreshNewsAndRerender(league);

  targets.slice(0, 6).forEach((t, idx) => {
    const btn = document.getElementById(`claim-btn-${idx}`);
    if (!btn) return;
    btn.onclick = () => {
      const dropName = t.dropPlayer ? t.dropPlayer.name : 'nobody';
      if (confirm(`Add ${t.addPlayer.name}, drop ${dropName}, bid $${t.faab.recommended} FAAB?`)) {
        store.processTransaction(t.addPlayer.id, t.dropPlayer?.id, league.myTeamId);
        alert('Transaction processed.');
      }
    };
  });
}

// Render Trade Proposal Center
function renderTradesPage(league = store.getActiveLeague()) {
  if (!league) return;

  const listContainer = document.getElementById('trade-proposals-list');
  listContainer.innerHTML = '';

  const proposals = generateTradeProposals(league);

  if (proposals.length === 0) {
    listContainer.innerHTML = '<div class="empty-state">No realistic trade suggestions calculated. Your rosters are balanced or trade partners have empty slots.</div>';
    return;
  }

  proposals.forEach((p, idx) => {
    const item = document.createElement('div');
    item.className = 'recommendation-item medium-confidence';

    let probBadge = 'badge-gold';
    if (p.probability > 70) probBadge = 'badge-green';
    else if (p.probability < 40) probBadge = 'badge-red';

    item.innerHTML = `
      <div class="item-action-title">
        <span>Trade with <strong>${p.opponentName}</strong> (Manager: ${p.managerName})</span>
        <span class="badge-solid ${probBadge}">${p.probability}% Acceptance Probability</span>
      </div>
      
      <div class="form-row" style="margin:0.75rem 0;">
        <div style="background:var(--bg-surface-elevated); padding:0.75rem; border-radius:4px; border:1px solid var(--border-color);">
          <span style="font-size:0.75rem; text-transform:uppercase; color:var(--text-muted); display:block;">You Give</span>
          <strong>${p.givePlayer.name}</strong> (${p.givePlayer.position}-${p.givePlayer.team})
          <span style="font-size:0.8rem; display:block; color:var(--text-secondary); margin-top:0.25rem;">Proj: ${p.givePlayer.projectedPoints} pts</span>
        </div>
        <div style="background:var(--bg-surface-elevated); padding:0.75rem; border-radius:4px; border:1px solid var(--border-color);">
          <span style="font-size:0.75rem; text-transform:uppercase; color:var(--text-muted); display:block;">You Get</span>
          <strong>${p.getPlayer.name}</strong> (${p.getPlayer.position}-${p.getPlayer.team})
          <span style="font-size:0.8rem; display:block; color:var(--accent-cyan); margin-top:0.25rem;">Proj: ${p.getPlayer.projectedPoints} pts</span>
        </div>
      </div>

      <div style="font-size:0.85rem; color:var(--text-secondary); display:flex; flex-direction:column; gap:0.25rem; margin-bottom:0.75rem;">
        <span><strong>Championship Impact:</strong> ${p.myImpact}</span>
        <span><strong>Value to Partner:</strong> ${p.oppImpact}</span>
        <span><strong>Risk Factor:</strong> ${p.risk}</span>
      </div>

      <div style="background:rgba(255,255,255,0.02); padding:0.75rem; border-radius:4px; border:1px solid var(--border-color); margin-bottom:0.75rem;">
        <span style="font-size:0.75rem; font-weight:700; color:var(--text-secondary); display:block; margin-bottom:0.25rem;">Negotiation Ranges:</span>
        <span style="display:block; font-size:0.8rem;">Open Offer: ${p.negotiation.open}</span>
        <span style="display:block; font-size:0.8rem;">Counter Limit: ${p.negotiation.counter}</span>
        <span style="display:block; font-size:0.8rem; color:var(--accent-red);">Walk-Away: ${p.negotiation.walkAway}</span>
      </div>

      <div class="form-group" style="margin-bottom:0.75rem;">
        <label class="form-label" style="font-size:0.75rem;">Send Friendly DM Proposal:</label>
        <textarea class="input-control" rows="3" readonly style="font-size:0.8rem; height:auto; resize:none;">${p.dmText}</textarea>
      </div>

      <div style="text-align:right;">
        <button class="btn-primary" style="padding:0.35rem 0.75rem; font-size:0.8rem;" onclick="navigator.clipboard.writeText('${p.dmText.replace(/'/g, "\\'")}'); alert('Proposal DM message copied to clipboard!');">
          Copy Message
        </button>
        <button class="btn-success" style="padding:0.35rem 0.75rem; font-size:0.8rem;" id="trade-btn-${idx}">
          Confirm Trade Completed
        </button>
      </div>
    `;
    listContainer.appendChild(item);

    document.getElementById(`trade-btn-${idx}`).onclick = () => {
      if (confirm(`Confirm: Execute trade swapping ${p.givePlayer.name} for ${p.getPlayer.name}?`)) {
        store.processTransaction(p.getPlayer.id, p.givePlayer.id, league.myTeamId);
        store.processTransaction(p.givePlayer.id, p.getPlayer.id, p.opponentId);
        alert('Trade roster transaction executed local store!');
      }
    };
  });
}

// Render League Teams intelligence
function renderLeaguePage(league = store.getActiveLeague()) {
  if (!league) return;

  const selector = document.getElementById('league-team-selector');
  selector.innerHTML = '';

  league.teams.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.teamId;
    opt.innerHTML = `${t.teamName} (Wins: ${t.record.wins})`;
    selector.appendChild(opt);
  });

  // Re-draw panel on switch
  selector.onchange = () => {
    const tid = parseInt(selector.value);
    drawOpponentProfile(tid, league);
  };

  // Draw default team
  if (league.teams[0]) {
    drawOpponentProfile(league.teams[0].teamId, league);
  }
}

function drawOpponentProfile(teamId, league) {
  const container = document.getElementById('league-team-profile-container');
  container.innerHTML = '';
  container.style.display = 'grid';

  const team = league.teams.find(t => t.teamId === teamId);
  if (!team) return;

  const db = league.playerDatabase;
  const rosterIds = team.roster || [];
  const players = rosterIds.map(id => db[id]).filter(Boolean);

  // Group by WRs, RBs, etc.
  const wrCount = players.filter(p => p.position === 'WR').length;
  const rbCount = players.filter(p => p.position === 'RB').length;
  const qbCount = players.filter(p => p.position === 'QB').length;
  const teCount = players.filter(p => p.position === 'TE').length;

  container.innerHTML = `
    <!-- Roster Details -->
    <div class="glass-card" style="box-shadow:none; border-color:var(--border-color); background:var(--bg-surface-elevated);">
      <h4 style="font-size:1rem; text-transform:uppercase; margin-bottom:0.75rem;">Roster Breakdown</h4>
      <div class="roster-grid">
        ${players.length > 0 ? players.map(p => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:0.4rem 0.75rem; background:var(--bg-surface); border-radius:4px; border:1px solid var(--border-color);">
            <span><strong>${p.name}</strong> (${p.position})</span>
            <span style="font-size:0.85rem; color:var(--accent-cyan);">${p.projectedPoints.toFixed(1)} Proj</span>
          </div>
        `).join('') : '<div class="empty-state">No players on roster.</div>'}
      </div>
    </div>

    <!-- Analytics Assessment -->
    <div class="glass-card" style="box-shadow:none; border-color:var(--border-color); background:var(--bg-surface-elevated);">
      <h4 style="font-size:1rem; text-transform:uppercase; margin-bottom:0.75rem;">Manager Profile</h4>
      <div style="display:flex; flex-direction:column; gap:1rem; font-size:0.9rem;">
        <div>
          <span style="color:var(--text-muted); display:block; font-size:0.75rem; text-transform:uppercase;">Remaining FAAB</span>
          <span style="font-size:1.5rem; font-weight:800; color:var(--accent-green);">$${team.faabRemaining}</span>
        </div>
        <div>
          <span style="color:var(--text-muted); display:block; font-size:0.75rem; text-transform:uppercase;">Roster Strengths</span>
          <span style="font-weight:700;">${wrCount >= 3 ? 'Wide Receiver abundance' : 'Consistent starters'}</span>
        </div>
        <div>
          <span style="color:var(--text-muted); display:block; font-size:0.75rem; text-transform:uppercase;">Likely Waiver Needs</span>
          <span style="font-weight:700; color:var(--accent-red);">${rbCount < 2 ? 'Running Back depth' : (qbCount === 0 ? 'Starting QB' : 'FLEX stashes')}</span>
        </div>
        <div style="border-top:1px solid var(--border-color); padding-top:0.75rem; font-size:0.8rem; color:var(--text-secondary);">
          <strong>Realistic Trading Strategy:</strong><br>
          Manager responds well to balanced swaps. Do not pitch one-sided proposals. Target their surplus WRs.
        </div>
      </div>
    </div>
  `;
}

// Render Championship Simulations
/**
 * The championship page before a season exists.
 *
 * There is no schedule to simulate against, but there is a full league of
 * rosters -- which is what decides a season anyway. Seasons are simulated over
 * a balanced round robin, so the odds answer the question that can actually be
 * answered now ("how good is this roster relative to this league") instead of
 * the placeholder that shipped, which forecast a fixture nobody had scheduled.
 */
function renderPreseasonOutlook(league, runs = 3000) {
  const o = preseasonOutlook(league, runs);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerHTML = v; };
  if (!o) {
    ['sim-playoff-pct', 'sim-champ-pct', 'sim-bye-pct'].forEach((id) => set(id, '—'));
    ['sim-playoff-note', 'sim-champ-note', 'sim-bye-note'].forEach((id) => set(id, ''));
    const note = document.getElementById('sim-action-plan');
    if (note) note.innerHTML = '<div class="empty-state">No rosters yet — connect a league.</div>';
    return;
  }

  set('sim-playoff-pct', o.playoffPct + '%');
  set('sim-champ-pct', o.titlePct + '%');
  set('sim-bye-pct', o.byePct + '%');

  const rosterSize = (league.rosterSettings?.startersCount || 9)
    + (league.rosterSettings?.benchCount || 7);
  const made = ((league.draftState || {}).selections || []).length;
  const total = (league.leagueSize || (league.teams || []).length) * rosterSize;
  const drafting = made < total;
  const par = (100 / o.leagueSize).toFixed(1);
  set('sim-playoff-note', `Average finish is seed ${o.averageSeed} of ${o.leagueSize}`
    + (drafting ? `, on a roster that is ${made} of ${total} picks into the draft.` : '.'));
  set('sim-champ-note', `An average roster in a ${o.leagueSize}-team league wins ${par}% of the time. `
    + `Yours projects ${o.myPoints} points a week against a league best of ${o.bestPoints}.`);
  set('sim-bye-note', `Requires a top-two seed. Simulated over a balanced round robin, `
    + `since the real schedule is published after the draft.`);

  // Highest impact moves: where this roster loses the most points a week
  // against the league, measured rather than asserted.
  const drafted = new Set((league.draftState?.selections || []).map(s => s.playerId));
  (league.teams || []).forEach(t => (t.roster || []).forEach(id => drafted.add(id)));
  const freeAgents = Object.values(league.playerDatabase || {}).filter(p => !drafted.has(p.id));
  const moves = highestImpactMoves(league, freeAgents);

  const plan = document.getElementById('sim-action-plan');
  if (plan) {
    const par = (100 / o.leagueSize).toFixed(1);
    const rows = moves.slice(0, 5).map((m) => {
      const what = m.empty
        ? `<strong>${m.slot} is empty</strong> — scores zero every week.`
        : `<strong>${m.slot}: ${m.current}</strong> projects ${m.currentPoints}/wk, `
          + `${m.gap > 0 ? `${m.gap} behind` : `${Math.abs(m.gap)} ahead of`} the league median of ${m.leagueMedian}.`;
      const fix = m.candidate
        ? ` Best available: <strong>${m.candidate.name}</strong> (+${m.upgrade}/wk).`
        : '';
      return `<div style="padding:0.75rem; background:var(--bg-surface); border:1px solid var(--border-color); border-radius:4px;">${what}${fix}</div>`;
    }).join('');
    plan.innerHTML = `
      <div style="font-size:0.82rem; color:var(--text-secondary); margin-bottom:0.5rem;">
        Preseason outlook — the schedule is published after the draft, so until then
        seasons are simulated over a balanced round robin. These odds re-read your
        real fixtures automatically once they exist. Your roster ranks
        <strong>#${o.rank} of ${o.leagueSize}</strong>
        at ${o.myPoints} projected points a week, against a league best of ${o.bestPoints}
        and a median of ${o.medianPoints}. A title is worth ${par}% to an average team here.
      </div>
      ${rows || '<div class="empty-state">No starting slot is measurably behind the league.</div>'}`;
  }

  // Threat assessment: the rivals actually in front of you, and by how much.
  const threat = document.getElementById('sim-threat-assessment');
  if (threat) {
    threat.innerHTML = o.teams.slice(0, 6).map((t) => {
      const bar = Math.max(2, Math.round((t.points / Math.max(1, o.bestPoints)) * 100));
      const tone = t.isMe ? 'var(--accent-cyan)' : 'var(--text-muted)';
      return `
        <div style="display:flex; align-items:center; gap:0.6rem; margin-bottom:0.45rem;">
          <span style="width:1.4rem; color:var(--text-muted); font-size:0.8rem;">${t.rank}</span>
          <span style="flex:0 0 40%; font-weight:${t.isMe ? 700 : 400}; color:${tone};">
            ${t.teamName}${t.isMe ? ' (you)' : ''}</span>
          <span style="flex:1; height:8px; background:var(--bg-surface); border-radius:4px; overflow:hidden;">
            <span style="display:block; height:100%; width:${bar}%; background:${tone};"></span></span>
          <span style="width:4rem; text-align:right; font-size:0.82rem;">${t.points.toFixed(1)}</span>
        </div>`;
    }).join('');
  }
}

function renderChampionshipPage(league = store.getActiveLeague()) {
  if (!league) return;

  // The three headline percentages ship as literal numbers in the markup, and
  // nothing overwrites them until the simulation is run. On a league imported
  // from a draft room the simulation has no schedule to run against, so those
  // invented figures sat on screen looking like a real forecast.
  const sched = Array.isArray(league.schedule) ? league.schedule : [];
  if (!sched.length) renderPreseasonOutlook(league);

  const btnRun = document.getElementById('btn-run-simulations');
  
  const triggerSimulation = (runsCount) => {
    showLoading('Running 1,000 Monte Carlo calculations...');
    setTimeout(() => {
      const sim = runSeasonSimulation(league, runsCount);
      
      document.getElementById('sim-playoff-pct').innerHTML = `${sim.playoffPct}%`;
      document.getElementById('sim-champ-pct').innerHTML = `${sim.champPct}%`;
      document.getElementById('sim-bye-pct').innerHTML = `${sim.byePct}%`;

      // Sim Action plan checklist
      const actionBox = document.getElementById('sim-action-plan');
      actionBox.innerHTML = '';
      sim.actionPlan.forEach(action => {
        const item = document.createElement('div');
        item.style.padding = '0.75rem';
        item.style.background = 'var(--bg-surface)';
        item.style.border = '1px solid var(--border-color)';
        item.style.borderRadius = '4px';
        item.innerHTML = `
          <strong>${action.title}</strong>
          <span style="font-size:0.8rem; display:block; color:var(--text-secondary); margin-top:0.25rem;">${action.desc}</span>
        `;
        actionBox.appendChild(item);
      });

      // Threat assessment rivals list
      const threatBox = document.getElementById('sim-threat-assessment');
      threatBox.innerHTML = '';
      
      const threatContainer = document.createElement('div');
      threatContainer.style.display = 'flex';
      threatContainer.style.flexDirection = 'column';
      threatContainer.style.gap = '0.5rem';

      if (sim.competitors && sim.competitors.length > 0) {
        sim.competitors.forEach((rival, index) => {
          const item = document.createElement('div');
          item.style.padding = '0.75rem';
          item.style.borderRadius = '4px';
          
          if (index === 0) {
            // Top rival gets high threat styling
            item.style.background = 'var(--accent-red-glow)';
            item.style.border = '1px solid rgba(255, 23, 68, 0.2)';
            item.innerHTML = `
              <strong>Competitor: ${rival.teamName}</strong>
              <span style="font-size:0.8rem; display:block; color:var(--text-secondary); margin-top:0.25rem;">
                Simulation champion in <strong>${rival.pct}%</strong> of remaining runs. Strongest rival threat.
              </span>
            `;
          } else {
            // Secondary rivals get standard surface styling
            item.style.background = 'var(--bg-surface)';
            item.style.border = '1px solid var(--border-color)';
            item.innerHTML = `
              <strong>Competitor: ${rival.teamName}</strong>
              <span style="font-size:0.8rem; display:block; color:var(--text-secondary); margin-top:0.25rem;">
                Simulation champion in <strong>${rival.pct}%</strong> of remaining runs.
              </span>
            `;
          }
          threatContainer.appendChild(item);
        });
      } else {
        threatContainer.innerHTML = '<div class="empty-state">No major competitors identified.</div>';
      }
      threatBox.appendChild(threatContainer);

      hideLoading();
    }, 600);
  };

  // Without a schedule runSeasonSimulation has nothing to simulate and returns
  // zero for every figure -- and this ran it on every render, overwriting the
  // preseason numbers a few lines above with zeros the moment they were drawn.
  // Route both the button and the initial run to whichever engine can actually
  // answer.
  const runIt = () => {
    if (!sched.length) {
      showLoading('Simulating seasons over a balanced schedule...');
      setTimeout(() => { renderPreseasonOutlook(league, 6000); hideLoading(); }, 50);
    } else {
      triggerSimulation(1000);
    }
  };
  if (btnRun) {
    btnRun.textContent = sched.length ? 'Re-run 1,000 Simulations' : 'Re-run preseason outlook';
    btnRun.onclick = runIt;
  }
  runIt();
}

// Render Alerts View
function renderAlertsPage(league = store.getActiveLeague()) {
  const container = document.getElementById('alerts-list-container');
  container.innerHTML = '';

  const myRoster = store.getMyTeam()?.roster || [];
  const db = league.playerDatabase;
  const injured = myRoster.map(id => db[id]).filter(p => p && p.injuryStatus !== 'Healthy');
  const rosterNames = myRoster.map(id => db[id]?.name).filter(Boolean);

  let alertsHtml = '';

  // 1. Injuries
  if (injured.length > 0) {
    injured.forEach(p => {
      alertsHtml += `
        <div class="recommendation-item low-confidence">
          <div class="item-action-title">Starter Injured: ${p.name} (${p.position}) <span class="badge-solid badge-red">Critical</span></div>
          <div class="item-details">${p.name} is ${p.injuryStatus.toLowerCase()}. Configure a backup starter in the Matchups view.</div>
        </div>
      `;
    });
  }

  // 2. Waiver priorities
  const waiverRec = getWaiverRecommendations(league)[0];
  if (waiverRec) {
    alertsHtml += `
      <div class="recommendation-item high-confidence">
        <div class="item-action-title">Waiver Target: ${waiverRec.addPlayer.name} (${waiverRec.addPlayer.position}) <span class="badge-solid badge-green">Priority</span></div>
        <div class="item-details">Drop ${waiverRec.dropPlayer ? waiverRec.dropPlayer.name : 'bench'}. Bid $${waiverRec.bid} FAAB. ${waiverRec.reason}</div>
      </div>
    `;
  }

  // 3. Trade
  const tradeRec = generateTradeProposals(league)[0];
  if (tradeRec) {
    alertsHtml += `
      <div class="recommendation-item medium-confidence">
        <div class="item-action-title">Trade Target: ${tradeRec.getPlayer.name} (${tradeRec.getPlayer.position}) <span class="badge-solid badge-gold">Proposal</span></div>
        <div class="item-details">Offer ${tradeRec.givePlayer.name} to ${tradeRec.opponentName}. Estimated ${tradeRec.probability}% acceptance rate.</div>
      </div>
    `;
  }

  if (!alertsHtml) {
    alertsHtml = '<div class="empty-state">No current strategy alerts. Roster is fully optimized.</div>';
  }

  container.innerHTML = alertsHtml;

  // Trigger live breaking news fetch
  fetchLiveBreakingNews(rosterNames);
}

/**
 * Reddit is a community forum, not a wire. It carries rumour, jokes and
 * speculation alongside real reporting, it rate-limits anonymous callers, and
 * nothing in it is structured -- which is why it feeds the display panel only
 * and never reaches the recommendation engine.
 *
 * The engine reads ESPN's news API and Sleeper's add/drop volume instead
 * (js/engine/news-monitor.js), where items carry player and team tags that can
 * be classified into injuries, trades and depth-chart moves. This function is
 * the human-readable supplement to that, and it fails quietly.
 */
/**
 * Draw a fetched feed. Split out so a cached result renders by exactly the same
 * path as a fresh one -- otherwise the two drift and the cached view quietly
 * becomes a second, worse implementation.
 */
function renderNewsItems(items, newsContainer, indicator) {
  // Roster objects, not just names: relevance also matches on a player's NFL
  // club, because a preseason feed is written about teams rather than
  // individuals and name-matching alone finds almost nothing.
  const myTeamNow = store.getMyTeam();
  const dbNow = (store.getActiveLeague() || {}).playerDatabase || {};
  const roster = (myTeamNow?.roster || [])
    .map((id) => dbNow[id]).filter(Boolean)
    .map((p) => ({ name: p.name, team: p.team }));

  // "Nothing to report" and "could not reach the feed" are completely
  // different facts and must never share a message. One means relax, the
  // other means your recommendations are missing this morning's injuries.
  if (!items.length) {
    newsContainer.innerHTML = `
      <div class="empty-state">
        <div style="color:var(--text-primary); font-weight:600; margin-bottom:0.3rem;">
          No news right now</div>
        <div style="font-size:0.82rem;">
          The feed is working — ESPN has published nothing new. Recommendations
          are current.
        </div>
      </div>`;
    indicator.innerHTML = 'No news';
    indicator.style.background = '';
    return;
  }

  // Anything touching a player you own goes first. A chronological feed makes
  // you hunt for the one line that matters.
  const RANK = { player: 2, team: 1 };
  const scored = items.map((it) => {
    const rel = relevanceTo(it, roster);
    return { item: it, rel, mine: !!rel };
  });
  // Named players first, then their clubs, then anything that moves a
  // valuation, then everything else.
  scored.sort((a, b) =>
    (RANK[b.rel?.strength] || 0) - (RANK[a.rel?.strength] || 0)
    || ((b.item.type ? 1 : 0) - (a.item.type ? 1 : 0)));

  const tone = {
    injury_out: '#ff5252', suspension: '#ff5252', demotion: '#ffb020',
    injury_risk: '#ffb020', trade: '#38bdf8', promotion: '#16c784',
    returning: '#16c784',
  };

  newsContainer.innerHTML = scored.slice(0, 20).map(({ item, rel }) => {
    const mine = !!rel;
    const label = (EVENT_IMPACT[item.type] || {}).label || item.type || 'news';
    const when = item.published
      ? new Date(item.published).toLocaleString([], { month: 'short', day: 'numeric',
                                                     hour: 'numeric', minute: '2-digit' })
      : '';
    return `
      <div class="recommendation-item" style="border-left:3px solid ${tone[item.type] || '#8a94a6'};
           ${mine ? 'background:rgba(255,82,82,0.07);' : ''}">
        <div style="display:flex; gap:0.6rem; align-items:baseline; flex-wrap:wrap;">
          <span style="font-size:0.68rem; font-weight:800; letter-spacing:0.5px;
                       text-transform:uppercase; color:${tone[item.type] || '#8a94a6'};">
            ${label}</span>
          ${rel ? `<span style="font-size:0.68rem; font-weight:800;
               color:${rel.strength === 'player' ? '#ff5252' : '#ffb020'};">
               ${rel.strength === 'player' ? 'YOUR PLAYER' : 'YOUR TEAM'}: ${rel.why}</span>` : ''}
          <span style="margin-left:auto; font-size:0.7rem; color:var(--text-secondary);">${when}</span>
        </div>
        <div style="font-size:0.9rem; margin-top:0.25rem;">${item.headline}</div>
        ${item.players && item.players.length ? `
          <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:0.2rem;">
            ${item.players.slice(0, 3).join(' · ')}</div>` : ''}
      </div>`;
  }).join('');

  const actionable = items.filter((i) => i.type).length;
  const mineCount = scored.filter((x) => x.rel).length;
  indicator.innerHTML = mineCount ? `${mineCount} affect you` : 'Live Feed';
  indicator.style.background = '';

  // Say plainly when a full feed contains nothing that changes a decision --
  // otherwise a wall of camp reports reads as though something is wrong.
  if (!actionable && !mineCount) {
    newsContainer.insertAdjacentHTML('afterbegin', `
      <div style="padding:0.6rem 0.9rem; margin-bottom:0.6rem; border-radius:6px;
                  background:rgba(255,255,255,0.04); font-size:0.82rem;
                  color:var(--text-secondary);">
        <strong style="color:var(--text-primary);">Nothing actionable.</strong>
        ${items.length} headlines checked — nothing mentions your players or
        their teams, and no injuries, trades or depth-chart changes affect the
        players you could claim.
      </div>`);
  }
}

// The news feed is fetched on render, and during a live draft the sync poll
// re-renders every three seconds -- roughly twenty ESPN requests a minute, which
// gets throttled and then fails. It reads as "the news broke again" because the
// panel worked a moment earlier. Headlines do not change that fast: hold the
// last result and reuse it.
const NEWS_TTL_MS = 5 * 60 * 1000;
let newsCache = { at: 0, items: null };
let newsInFlight = null;

async function fetchLiveBreakingNews(rosterNames = [], force = false) {
  const newsContainer = document.getElementById('news-list-container');
  const indicator = document.getElementById('news-refresh-indicator');
  if (!newsContainer) return;

  const fresh = newsCache.items && (Date.now() - newsCache.at) < NEWS_TTL_MS;
  if (fresh && !force) {
    renderNewsItems(newsCache.items, newsContainer, indicator);
    return;
  }

  indicator.innerHTML = 'Syncing...';
  indicator.style.background = 'var(--accent-cyan-glow)';

  try {
    // Everything, not just transactional events -- a panel that says
    // "no news" while fifty articles exist is worse than useless.
    // Share one request between overlapping renders rather than stacking them.
    if (!newsInFlight) {
      newsInFlight = fetchLeagueNews({ classifiedOnly: false })
        .finally(() => { newsInFlight = null; });
    }
    const items = await newsInFlight;
    newsCache = { at: Date.now(), items };
    renderNewsItems(items, newsContainer, indicator);
  } catch (err) {
    console.error('News feed failed:', err);
    newsContainer.innerHTML = `
      <div class="empty-state">
        <div style="color:#ff1744; font-weight:600; margin-bottom:0.3rem;">
          Could not reach the news feed</div>
        <div style="font-size:0.82rem; color:var(--text-secondary);">
          This is a connection failure, not quiet news — an injury from this
          morning would not be reflected in your recommendations.
          <br><span style="opacity:0.7;">${err.message}</span>
        </div>
        <button id="btn-news-retry-feed" class="btn-secondary"
          style="margin-top:0.6rem; padding:0.25rem 0.7rem; font-size:0.8rem;">Retry</button>
      </div>`;
    const retry = document.getElementById('btn-news-retry-feed');
    if (retry) retry.onclick = () => fetchLiveBreakingNews(rosterNames, true);
    indicator.innerHTML = 'Offline';
  }
}

// Render Settings Form inputs
function renderSettingsPage(league = store.getActiveLeague()) {
  if (!league) return;

  document.getElementById('settings-league-name').innerHTML = league.leagueName;
  
  // Load my team options list
  const selector = document.getElementById('settings-my-team-id');
  selector.innerHTML = '';
  
  league.teams.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.teamId;
    opt.innerHTML = t.teamName;
    if (t.teamId === league.myTeamId) opt.selected = true;
    selector.appendChild(opt);
  });

  // Reconcile format settings
  document.getElementById('settings-scoring').value = league.scoringFormat;
  document.getElementById('settings-draft-type').value = league.draftState.draftType;
}

// Helper methods to show loading overlays
function showLoading(text) {
  loadingText.innerHTML = text;
  loadingOverlay.classList.add('active');
}

function hideLoading() {
  loadingOverlay.classList.remove('active');
}

// Helper to generate an inline SVG sparkline for a player's weekly projection trends
function generateSparkline(matchProjs) {
  if (!matchProjs) return '';
  const values = [matchProjs.w1, matchProjs.w2, matchProjs.w3, matchProjs.w4, matchProjs.w5].filter(v => v !== undefined);
  if (values.length < 2) return '';

  const width = 45;
  const height = 14;
  const padding = 1;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min === 0 ? 1 : max - min;

  const points = values.map((val, index) => {
    const x = padding + (index / (values.length - 1)) * (width - 2 * padding);
    const y = height - padding - ((val - min) / range) * (height - 2 * padding);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const path = points.join(' ');
  const color = values[values.length - 1] >= values[0] ? '#00e676' : '#ff1744';

  return `
    <svg width="${width}" height="${height}" style="vertical-align: middle; margin-left: 0.35rem; display: inline-block;" title="Trend: ${values.join(' ➔ ')}">
      <polyline fill="none" stroke="${color}" stroke-width="1.5" points="${path}" />
      <circle cx="${points[points.length - 1].split(',')[0]}" cy="${points[points.length - 1].split(',')[1]}" r="1.5" fill="${color}" />
    </svg>
  `;
}
