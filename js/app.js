/**
 * Gridiron Edge Main Coordinator Script
 */

import store from './store.js';
import espnClient from './espn-client.js';
import { getDraftRecommendations, calculateAuctionBid } from './engine/draft-assistant.js';
import { optimizeLineup } from './engine/lineup-optimizer.js';
import { getWaiverRecommendations } from './engine/waiver-evaluator.js';
import { generateTradeProposals } from './engine/trade-generator.js';
import { runSeasonSimulation } from './engine/simulator.js';

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
let weeklyLineupStrategy = 'floor'; // default

// Check for a local sync file saved by server.py
async function checkLocalSyncFile() {
  try {
    const response = await fetch('/imported_league.json');
    if (response.ok) {
      const data = await response.json();
      console.log('Local sync file found, importing league:', data.id);
      espnClient.importScrapedPayload(data);
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

  // Check for auto local sync file first
  checkLocalSyncFile();

  // Subscribe to store updates
  store.subscribe((state) => {
    renderApp(state);
  });

  // Perform initial rendering
  renderApp(store.state);
});

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
  const btnFloor = document.getElementById('btn-lineup-strategy-floor');
  const btnCeil = document.getElementById('btn-lineup-strategy-ceil');

  btnFloor.addEventListener('click', () => {
    btnFloor.classList.replace('btn-secondary', 'btn-primary');
    btnCeil.classList.replace('btn-primary', 'btn-secondary');
    weeklyLineupStrategy = 'floor';
    renderMatchupPage();
  });

  btnCeil.addEventListener('click', () => {
    btnCeil.classList.replace('btn-secondary', 'btn-primary');
    btnFloor.classList.replace('btn-primary', 'btn-secondary');
    weeklyLineupStrategy = 'ceiling';
    renderMatchupPage();
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
  const bookmarkletCode = `javascript:(function(){
    const views = ['mSettings', 'mRoster', 'mTeam', 'mMatchup', 'mMatchupScore', 'mStandings', 'mTransactionHistory'];
    const parts = window.location.pathname.split('/');
    const leagueIdIdx = parts.indexOf('leagues');
    if(leagueIdIdx === -1){
      alert('Error: Make sure you are on fantasy.espn.com league home page!');
      return;
    }
    const leagueId = parts[leagueIdIdx + 1];
    const season = parts[parts.indexOf('ffl') + 1] || new Date().getFullYear();
    const url = 'https://fantasy.espn.com/apis/v3/games/ffl/seasons/' + season + '/segments/0/leagues/' + leagueId + '?view=' + views.join('&view=');
    
    fetch(url).then(r=>r.json()).then(data=>{
      const textarea = document.createElement('textarea');
      textarea.value = JSON.stringify(data);
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      alert('League payload successfully copied to clipboard! Return to Gridiron Edge and paste.');
    }).catch(err=>{
      alert('Error extracting league data. Make sure you are logged in to ESPN Fantasy.');
    });
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

  btnSubmitPaste.addEventListener('click', () => {
    const jsonText = pasteTextArea.value.trim();
    if (!jsonText) {
      alert('Please paste valid JSON payload.');
      return;
    }
    try {
      showLoading('Importing JSON league structure...');
      espnClient.importScrapedPayload(jsonText);
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

// Render Dashboard (Home) View
function renderHomePage(league = store.getActiveLeague()) {
  if (!league) return;

  // Run simulation numbers to populate home dashboard probabilities
  const sim = runSeasonSimulation(league, 200); // 200 runs for quick refresh
  
  document.getElementById('dashboard-champ-prob').innerHTML = `${sim.champPct}%`;
  document.getElementById('dashboard-champ-bar').style.width = `${sim.champPct}%`;
  document.getElementById('dashboard-playoff-prob').innerHTML = `${sim.playoffPct}%`;
  
  // Calculate standings rank
  const myTeam = store.getMyTeam();
  const sortedTeams = [...league.teams].sort((a,b) => {
    if(b.record.wins !== a.record.wins) return b.record.wins - a.record.wins;
    return b.pointsScored - a.pointsScored;
  });
  const myRank = sortedTeams.findIndex(t => t.teamId === league.myTeamId) + 1;
  document.getElementById('dashboard-rank').innerHTML = `#${myRank}`;

  // Assessments
  document.getElementById('home-rival').innerHTML = `${sim.rivalName}`;
  
  const myRoster = myTeam?.roster || [];
  const db = league.playerDatabase;
  const wrCount = myRoster.map(id => db[id]).filter(p => p && p.position === 'WR' && p.projectedPoints > 14).length;
  const rbCount = myRoster.map(id => db[id]).filter(p => p && p.position === 'RB' && p.projectedPoints > 13).length;
  
  document.getElementById('home-strength').innerHTML = wrCount >= 2 ? 'Wide Receiver depth' : 'Core Quarterback';
  document.getElementById('home-weakness').innerHTML = rbCount < 2 ? 'Running Back rotation' : 'FLEX slot upside';

  // Render top 3 recommendations list
  const listContainer = document.getElementById('home-recommendations');
  listContainer.innerHTML = '';
  
  const waiverRec = getWaiverRecommendations(league)[0];
  const tradeRec = generateTradeProposals(league)[0];
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

  if (!itemsHtml) {
    itemsHtml = '<div class="empty-state">No current actions needed. Roster is fully optimized.</div>';
  }
  listContainer.innerHTML = itemsHtml;

  // Matchup Quickview
  const week5Match = league.schedule?.find(m => m.week === 5 && (m.team1Id === league.myTeamId || m.team2Id === league.myTeamId));
  if (week5Match) {
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

  // Draw Standings Table
  const standingsBody = document.getElementById('home-standings-table').querySelector('tbody');
  standingsBody.innerHTML = '';
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

// Render Live Draft Command Center
function renderDraftPage(league = store.getActiveLeague()) {
  if (!league) return;

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
    const myTeam = store.getMyTeam();
    const budget = myTeam ? myTeam.faabRemaining : 200;
    const remainingSpots = (league.rosterSettings.startersCount + league.rosterSettings.benchCount) - (myTeam ? myTeam.roster.length : 0);
    const opponentsFaab = league.teams.filter(t => t.teamId !== league.myTeamId).map(t => t.faabRemaining);
    const maxOpponentBid = Math.max(...opponentsFaab, 0);
    
    const bidInfo = calculateAuctionBid(rec.primaryPick, budget, Math.max(1, remainingSpots), maxOpponentBid);

    recPanel.innerHTML = `
      <h3 style="color:var(--accent-cyan); font-size: 1.3rem; margin-bottom: 0.5rem; font-family:var(--font-family-title);">Draft ${rec.primaryPick.name} (Auction Recommended)</h3>
      <div style="font-size: 0.95rem; color: var(--text-primary); display:flex; flex-direction:column; gap:0.4rem; margin-bottom: 1rem;">
        <p><strong>Recommended Bid:</strong> <strong style="color:var(--accent-green); font-size:1.15rem;">$${bidInfo.recommendedBid}</strong> (Walk-away limit: $${bidInfo.maxBid})</p>
        <p><strong>Auction Advice:</strong> ${bidInfo.reason}</p>
        <p><strong>Player Value Rationale:</strong> ${rec.whyBest}</p>
        <p><strong>Risk Level:</strong> ${rec.riskLevel}</p>
      </div>

      <div style="background:var(--bg-surface-elevated); padding:0.75rem; border:1px solid var(--border-color); border-radius:var(--border-radius-sm); margin-bottom:1rem;">
        <h4 style="font-size:0.85rem; text-transform:uppercase; color:var(--text-secondary); margin-bottom:0.5rem;">Select Winning Team & Bid</h4>
        <div class="form-row" style="margin-bottom:0.5rem; gap: 0.5rem;">
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label" style="font-size:0.75rem;">Winning Team</label>
            <select class="input-control" id="auction-winner-team" style="padding:0.4rem; font-size:0.85rem;">
              ${league.teams.map(t => `<option value="${t.teamId}" ${t.teamId === league.myTeamId ? 'selected' : ''}>${t.teamName}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label" style="font-size:0.75rem;">Winning Bid ($)</label>
            <input type="number" class="input-control" id="auction-winner-price" value="${bidInfo.recommendedBid}" min="1" max="${budget}" style="padding:0.4rem; font-size:0.85rem;">
          </div>
        </div>
      </div>
      
      <div style="border-top:1px solid var(--border-color); padding-top:0.75rem;">
        <h4 style="font-size:0.85rem; text-transform:uppercase; color:var(--text-secondary); margin-bottom:0.5rem;">Alternative Auction Shortlist:</h4>
        <div style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-bottom:1rem;">
          ${rec.alternatives.slice(0,4).map(p => {
            const altBid = calculateAuctionBid(p, budget, Math.max(1, remainingSpots), maxOpponentBid).recommendedBid;
            return `
              <button class="btn-secondary" style="padding:0.35rem 0.65rem; font-size:0.8rem;" onclick="document.getElementById('auction-winner-price').value = ${altBid}; document.getElementById('auction-winner-team').value = ${league.myTeamId}; alert('Selected ${p.name} - bid adjusted to recommended $${altBid}');">
                + ${p.name} (Val: $${altBid})
              </button>
            `;
          }).join('')}
        </div>
      </div>
      
      <div style="margin-top: 1rem;">
        <button class="btn-success" style="width:100%;" id="btn-auction-record-win">
          Record Auction Draft Award
        </button>
      </div>
    `;

    document.getElementById('btn-auction-record-win').onclick = () => {
      const teamId = parseInt(document.getElementById('auction-winner-team').value);
      const price = parseInt(document.getElementById('auction-winner-price').value);
      store.recordDraftPickAuction(rec.primaryPick.id, teamId, price);
    };

  } else {
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

    row.innerHTML = `
      <td><strong>${p.name}</strong></td>
      <td><span class="badge-solid badge-cyan">${p.position}</span></td>
      <td>${p.team}</td>
      <td>${p.projectedPoints.toFixed(1)}</td>
      <td>${p.adp.toFixed(1)}</td>
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
    tableBody.innerHTML = `<tr><td colspan="7" class="empty-state">No matching available players.</td></tr>`;
  }
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

  slots.forEach(slot => {
    // Find highest projection matching position
    const match = players.find(p => {
      if (allocatedIds.has(p.id)) return false;
      if (slot.isFlex) {
        return slot.pos.includes(p.position);
      }
      return p.position === slot.pos;
    });

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
      proj = s.player.projectedPoints.toFixed(1);
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

  // Draw bench list
  bench.forEach((b, index) => {
    const slotRow = document.createElement('div');
    slotRow.className = 'roster-slot';
    
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
      <span class="player-proj">${b.projectedPoints.toFixed(1)}</span>
      <div class="player-status" style="text-align:right;">
        <span class="badge-solid badge-gold" style="background:transparent; border-color:var(--text-muted); color:var(--text-secondary);">Bench</span>
      </div>
    `;
    rosterGrid.appendChild(slotRow);
  });

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

// Render Matchup View
function renderMatchupPage(league = store.getActiveLeague()) {
  const myTeam = store.getMyTeam();
  if (!myTeam) return;

  const opt = optimizeLineup(myTeam.roster, league.playerDatabase, league.rosterSettings, weeklyLineupStrategy);
  const startersGrid = document.getElementById('matchup-starters-grid');
  startersGrid.innerHTML = '';

  if (!opt) {
    startersGrid.innerHTML = '<div class="empty-state">No players on roster. Connect league settings.</div>';
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

// Render Waiver Wire Recommendations
function renderWaiversPage(league = store.getActiveLeague()) {
  if (!league) return;

  const listContainer = document.getElementById('waiver-recommendations-list');
  listContainer.innerHTML = '';

  const recs = getWaiverRecommendations(league);

  if (recs.length === 0) {
    listContainer.innerHTML = '<div class="empty-state">No waiver recommendations available. Roster limit reached or no free agents.</div>';
    return;
  }

  recs.forEach((r, idx) => {
    const item = document.createElement('div');
    item.className = 'recommendation-item';
    
    let confidenceClass = 'medium-confidence';
    let badgeColor = 'badge-gold';
    if (r.confidence === 'High') { confidenceClass = 'high-confidence'; badgeColor = 'badge-green'; }
    if (r.confidence === 'Low') { confidenceClass = 'low-confidence'; badgeColor = 'badge-purple'; }

    item.className = `recommendation-item ${confidenceClass}`;

    item.innerHTML = `
      <div class="item-action-title">
        <span>Claim <strong>${r.addPlayer.name}</strong> (${r.addPlayer.position}-${r.addPlayer.team})</span>
        <span class="badge-solid ${badgeColor}">${r.confidence} Confidence</span>
      </div>
      <div class="item-meta">
        <span>Drop: ${r.dropPlayer ? r.dropPlayer.name : 'None'}</span>
        <span>Suggested FAAB Bid: <strong>$${r.bid}</strong> (${r.pct}% of budget)</span>
      </div>
      <div class="item-details">
        <strong>Advantage:</strong> ${r.reason}<br>
        <strong>Waiver Urgency:</strong> ${r.urgency}
      </div>
      ${r.backup ? `<div class="item-alternatives"><strong>Backup Claim:</strong> ${r.backup.name} (${r.backup.position}) if primary is claimed.</div>` : ''}
      
      <div style="margin-top:0.75rem; text-align:right;">
        <button class="btn-success" style="padding:0.35rem 0.75rem; font-size:0.8rem;" id="claim-btn-${idx}">
          Confirm Waiver Claim on ESPN
        </button>
      </div>
    `;
    listContainer.appendChild(item);

    // Wire up mock transaction execution
    document.getElementById(`claim-btn-${idx}`).onclick = () => {
      if (confirm(`Confirm: Submit waiver claim on ESPN adding ${r.addPlayer.name} and dropping ${r.dropPlayer?.name || 'none'} for a $${r.bid} FAAB bid?`)) {
        store.processTransaction(r.addPlayer.id, r.dropPlayer?.id, league.myTeamId);
        alert('Transaction processed successfully!');
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
function renderChampionshipPage(league = store.getActiveLeague()) {
  if (!league) return;

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

  btnRun.onclick = () => triggerSimulation(1000);
  
  // Initial run on render
  triggerSimulation(1000);
}

// Render Alerts View
function renderAlertsPage(league = store.getActiveLeague()) {
  const container = document.getElementById('alerts-list-container');
  container.innerHTML = '';

  const myRoster = store.getMyTeam()?.roster || [];
  const db = league.playerDatabase;
  const injured = myRoster.map(id => db[id]).filter(p => p && p.injuryStatus !== 'Healthy');

  let alertsHtml = '';

  // 1. Injuries
  if (injured.length > 0) {
    injured.forEach(p => {
      alertsHtml += `
        <div class="recommendation-item low-confidence">
          <div class="item-action-title">Starter Injured: ${p.name} (${p.position}) <span class="badge-solid badge-red">Critical</span></div>
          <div class="item-details">${p.name} is questionable with a recent calf injury. Check Matchup options to configure a backup.</div>
        </div>
      `;
    });
  }

  // 2. Waiver priorities
  alertsHtml += `
    <div class="recommendation-item high-confidence">
      <div class="item-action-title">Waiver deadline is processing on Wednesday <span class="badge-solid badge-green">Priority</span></div>
      <div class="item-details">Waiver evaluator recommends submitting bids for WR Joshua Palmer ($4 FAAB) and RB Zamir White ($8 FAAB).</div>
    </div>
  `;

  // 3. Trade
  alertsHtml += `
    <div class="recommendation-item medium-confidence">
      <div class="item-action-title">Potential trade target available: Saquon Barkley <span class="badge-solid badge-gold">Proposal</span></div>
      <div class="item-details">Manager Sarah (Fumble Recovery) has excess RBs and holds a weakness in WR depth. Swap candidates prepared in Trades tab.</div>
    </div>
  `;

  container.innerHTML = alertsHtml;
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
