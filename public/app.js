// ─── Bellum Punicum — Phase 2 Frontend ──────────────────────────────────────

const TOKEN_KEY    = 'bp_token';
const SIDE_KEY     = 'bp_side';
const YEAR_SEEN_KEY = 'bp_year_seen';
const TURN_SEEN_KEY = 'bp_turn_seen';

// Region centroid coordinates — populated at runtime from the SVG centroid layer
const REGION_CENTROIDS = {};

const SIDE_COLORS = {
  rome:     { fill: '#c0392b', stroke: '#922b21', text: '#fff' },
  carthage: { fill: '#8e44ad', stroke: '#6c3483', text: '#fff' },
};

const ARMY_CODES = {
  hannibal:  'HAN',
  hasdrubal: 'HAS',
  consular:  'CON',
  reserve:   'RES',
};

// Sea route pairs — mirrors SEA_CONNECTIONS in server.js.
// Movement across these requires the moving side to hold naval control.
const SEA_CONNECTIONS = new Set([
  'hispania_ulterior:numidia_west',   'numidia_west:hispania_ulterior',
  'liguria:sardinia_corsica',         'sardinia_corsica:liguria',
  'etruria:sardinia_corsica',         'sardinia_corsica:etruria',
  'sardinia_corsica:numidia_west',    'numidia_west:sardinia_corsica',
  'bruttium_calabria:sicily',         'sicily:bruttium_calabria',
  'sicily:africa_proper',             'africa_proper:sicily',
  'sicily:numidia_east',              'numidia_east:sicily',
  'umbria_picenum:illyria',           'illyria:umbria_picenum',
]);

const COND_COLORS = {
  good:     '#2ecc71',  // green
  worn:     '#f39c12',  // orange
  depleted: '#e67e22',  // amber
  broken:   '#e74c3c',  // red
  unknown:  '#555',
};

let gameState      = null;
let selectedRegion = null;
let mySide         = null;       // 'rome' or 'carthage' — set after /state response
let pendingOrders  = {};         // army_id → { type, to_region? }
let ordersLocked   = false;      // true once submitted this turn

// ─── Token helpers ───────────────────────────────────────────────────────────

function getToken()        { return localStorage.getItem(TOKEN_KEY); }
function setToken(t)       { localStorage.setItem(TOKEN_KEY, t); }
function clearToken()      { localStorage.removeItem(TOKEN_KEY); }

// All seen-trackers are keyed by side so both players can share the same browser (hotseat)
function getYearSeen()     { return parseInt(localStorage.getItem(`${YEAR_SEEN_KEY}_${mySide}`) || '0', 10); }
function setYearSeen(year) { localStorage.setItem(`${YEAR_SEEN_KEY}_${mySide}`, year); }
function clearYearSeen()   { ['rome','carthage'].forEach(s => localStorage.removeItem(`${YEAR_SEEN_KEY}_${s}`)); }

function getTurnSeen()     { return parseInt(localStorage.getItem(`${TURN_SEEN_KEY}_${mySide}`) || '0', 10); }
function setTurnSeen(turn) { localStorage.setItem(`${TURN_SEEN_KEY}_${mySide}`, turn); }
function clearTurnSeen()   { ['rome','carthage'].forEach(s => localStorage.removeItem(`${TURN_SEEN_KEY}_${s}`)); }

function clearGameNotifications() {
  ['rome', 'carthage'].forEach(s => localStorage.removeItem(`bp_cis_roll_seen_${s}`));
}

function authHeaders() {
  const t = getToken();
  return t ? { 'Content-Type': 'application/json', 'X-Player-Token': t }
           : { 'Content-Type': 'application/json' };
}

// ─── Join screen ─────────────────────────────────────────────────────────────

function showJoinScreen() {
  document.getElementById('join-screen').classList.remove('hidden');
}

function hideJoinScreen() {
  document.getElementById('join-screen').classList.add('hidden');
}

async function initJoinScreen() {
  const btnRome        = document.getElementById('join-rome');
  const btnCarthage    = document.getElementById('join-carthage');
  const joinButtonsDiv = document.getElementById('join-buttons');
  const joinFullDiv    = document.getElementById('join-full');

  // Always start from a known state — hide "both taken" panel, show buttons
  joinButtonsDiv.classList.remove('hidden');
  joinFullDiv.classList.add('hidden');
  btnRome.disabled = false;
  btnRome.querySelector('.join-btn-sub').textContent = 'Play as Rome';
  btnCarthage.disabled = false;
  btnCarthage.querySelector('.join-btn-sub').textContent = 'Play as Carthage';

  // Fetch which sides are still available; auto-seed if no campaign exists
  let status = { rome: false, carthage: false };
  try {
    const r = await fetch('/join-status');
    if (r.ok) {
      status = await r.json();
    } else if (r.status === 404) {
      // No campaign on server — seed one silently so join buttons work immediately
      await fetch('/game/new', { method: 'POST' });
    }
  } catch (_) { /* server may not be up yet */ }

  const bothTaken = status.rome && status.carthage;

  if (bothTaken) {
    // Both sides occupied — hide side buttons, show "start new campaign" prompt
    joinButtonsDiv.classList.add('hidden');
    joinFullDiv.classList.remove('hidden');
    document.getElementById('btn-new-campaign').onclick = async () => {
      const confirmed = window.confirm(
        'This will end the current session and reset all progress.\n\nStart a new campaign?'
      );
      if (!confirmed) return;
      await fetch('/game/reset', { method: 'POST' });
      localStorage.removeItem('bp_token');
      location.reload();
    };
  } else {
    joinButtonsDiv.classList.remove('hidden');
    joinFullDiv.classList.add('hidden');
    if (status.rome) {
      btnRome.disabled = true;
      btnRome.querySelector('.join-btn-sub').textContent = 'Already taken';
    }
    if (status.carthage) {
      btnCarthage.disabled = true;
      btnCarthage.querySelector('.join-btn-sub').textContent = 'Already taken';
    }
  }

  async function doJoin(side) {
    const errEl = document.getElementById('join-error');
    errEl.classList.add('hidden');
    try {
      const r = await fetch(`/join?side=${side}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (r.status === 404) { errEl.textContent = 'No active campaign — ask the host to start one.'; errEl.classList.remove('hidden'); return; }
      if (r.status === 409) { errEl.textContent = `${capitalize(side)} is already taken. Choose the other side.`; errEl.classList.remove('hidden'); return; }
      if (!r.ok)            { errEl.textContent = 'Could not join — try refreshing.'; errEl.classList.remove('hidden'); return; }
      const { token } = await r.json();
      setToken(token);
      localStorage.setItem(SIDE_KEY, side);
      hideJoinScreen();
      await fetchState();
    } catch (e) {
      errEl.textContent = 'Server unreachable.';
      errEl.classList.remove('hidden');
    }
  }

  btnRome.onclick     = () => doJoin('rome');
  btnCarthage.onclick = () => doJoin('carthage');

  document.getElementById('btn-reset-game').onclick = async () => {
    const confirmed = window.confirm(
      'This will permanently delete all progress in the current campaign and return both players to the join screen.\n\nAre you sure you want to proceed?'
    );
    if (!confirmed) return;
    await fetch('/game/reset', { method: 'POST' });
    localStorage.removeItem('bp_token');
    location.reload();
  };
}

// ─── Fetch & Render ──────────────────────────────────────────────────────────

async function fetchState() {
  if (!getToken()) { showJoinScreen(); return; }

  try {
    const res = await fetch('/state', { headers: authHeaders() });

    if (res.status === 401) {
      clearToken();
      const savedSide = localStorage.getItem(SIDE_KEY);
      if (savedSide) {
        // Auto-rejoin: try to reclaim the same side (works if the session slot is still open or server restarted)
        const rejoin = await fetch(`/join?side=${savedSide}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }).catch(() => null);
        if (rejoin?.ok) {
          const { token } = await rejoin.json();
          setToken(token);
          return fetchState();
        }
      }
      showJoinScreen();
      return;
    }
    if (res.status === 404) { showNoGame(); return; }
    if (!res.ok) throw new Error(`Server error ${res.status}`);

    const incoming = await res.json();

    // Capture previous state markers before overwriting
    const prevTurn  = gameState?.campaign?.current_season_turn;
    const prevYear  = gameState?.campaign?.current_year;
    const prevPhase = gameState?.campaign?.phase;

    gameState = incoming;
    mySide    = incoming.my_side;

    // Seed/reset seen-trackers.
    // Re-seed if the key is missing OR if stored values are higher than current (indicates
    // a server-side game reset without the UI's New Game button being pressed).
    // Guard: a new campaign year also resets current_season_turn to 1, so only treat stored
    // values as stale when storedYearSeen >= currentYear too (otherwise let the year modal handle it).
    const storedTurnSeen = parseInt(localStorage.getItem(`${TURN_SEEN_KEY}_${mySide}`) || '0', 10);
    const storedYearSeen = parseInt(localStorage.getItem(`${YEAR_SEEN_KEY}_${mySide}`) || '0', 10);
    const staleDetected  = storedTurnSeen > incoming.campaign.current_season_turn &&
                           storedYearSeen >= incoming.campaign.current_year;

    if (!localStorage.getItem(`${TURN_SEEN_KEY}_${mySide}`) || staleDetected) {
      setTurnSeen(Math.max(0, incoming.campaign.current_season_turn - 1));
    }
    if (!localStorage.getItem(`${YEAR_SEEN_KEY}_${mySide}`) || staleDetected) {
      setYearSeen(incoming.campaign.current_year);
    }

    const phase        = incoming.campaign.phase;
    const turnResolved = prevTurn && incoming.campaign.current_season_turn !== prevTurn;
    const yearChanged  = prevYear && incoming.campaign.current_year > prevYear;

    // Reset order tracking when a new turn or new year starts
    if (turnResolved || yearChanged) {
      pendingOrders = {};
      ordersLocked  = false;
    }

    // Sync lock state with server
    if (incoming.orders_submitted?.[mySide]) {
      ordersLocked = true;
    }

    render();

    // Show game over modal when campaign has ended
    if (gameState.campaign.phase === 'game_over') {
      showGameOver();
      return;
    }

    // Show Cisalpine Gaul starting roll once per player per game
    const cisEvent  = gameState.log?.find(e => e.type === 'cisalpine_gaul_loyalty_check');
    const cisSeenKey = `bp_cis_roll_seen_${mySide}`;
    if (cisEvent && !localStorage.getItem(cisSeenKey)) {
      localStorage.setItem(cisSeenKey, '1');
      const outcome = cisEvent.secured
        ? `✓ Secured — Cisalpine Gaul falls under Roman control`
        : `✗ Failed — Cisalpine Gaul remains neutral`;
      showNotify('⚔ Cisalpine Gaul — Starting Loyalty Check', `Rolled ${cisEvent.roll} vs threshold ${cisEvent.threshold} (must exceed to secure)\n\n${outcome}`);
    }

    // Defection notifications — shown to both players
    (gameState.log || []).forEach((e, idx) => {
      if (e.type !== 'defection_roll' || !e.defects) return;
      const seenKey = `bp_defection_seen_${mySide}_${e.year}_${e.turn}_${e.region_id}`;
      if (localStorage.getItem(seenKey)) return;
      localStorage.setItem(seenKey, '1');
      const rname = gameState.regions?.find(r => r.region_id === e.region_id)?.name ?? e.region_id;
      const modsLabel = e.modifiers > 0 ? ` (+${e.modifiers} modifiers)` : '';
      const msg = mySide === 'carthage'
        ? `${rname} has defected to Carthage after your victory!\n\nRolled ${e.roll} vs threshold ${e.threshold}${modsLabel}`
        : `${rname} has risen against Rome!\n\nRolled ${e.roll} vs threshold ${e.threshold}${modsLabel}`;
      showNotify('🏛 Defection!', msg);
    });

    // Destabilized region notifications — shown to both players
    (gameState.log || []).forEach(e => {
      if (e.type !== 'region_destabilized') return;
      const seenKey = `bp_destabilized_seen_${mySide}_${e.year}_${e.turn}_${e.region_id}`;
      if (localStorage.getItem(seenKey)) return;
      localStorage.setItem(seenKey, '1');
      const rname = gameState.regions?.find(r => r.region_id === e.region_id)?.name ?? e.region_id;
      const causeName = gameState.regions?.find(r => r.region_id === e.cause_region)?.name ?? e.cause_region;
      const msg = mySide === 'carthage'
        ? `${rname} is now destabilized — a loyalty roll will trigger if Hannibal enters.\n\n(Caused by decisive victory in ${causeName})`
        : `${rname} is wavering — the decisive defeat in ${causeName} has shaken local loyalty.`;
      showNotify('⚡ Region Destabilized', msg);
    });

    // Island evacuation notifications — shown to both players
    (gameState.log || []).forEach(e => {
      if (e.type !== 'island_evacuation') return;
      const seenKey = `bp_evacuation_seen_${mySide}_${e.year}_${e.army_id}`;
      if (localStorage.getItem(seenKey)) return;
      localStorage.setItem(seenKey, '1');
      const fromName = gameState.regions?.find(r => r.region_id === e.from)?.name ?? e.from;
      const toName   = gameState.regions?.find(r => r.region_id === e.to)?.name ?? e.to;
      const enemy    = e.side === 'rome' ? 'Carthage' : 'Rome';
      if (e.side === mySide) {
        showNotify('⚓ Naval Withdrawal',
          `${e.army_name} has been forced to withdraw from ${fromName} to ${toName}.\n\n${enemy} controls the seas, cutting off all island access.\n\nThe army suffered full winter out-of-supply penalties before withdrawing.`);
      } else {
        showNotify('⚓ Naval Withdrawal',
          `Enemy ${e.army_name} has withdrawn from ${fromName} — your naval supremacy forced them back to their home base.`);
      }
    });

    // ── Modal routing — all modals now driven by render() via localStorage trackers ─

  } catch (err) {
    console.error('Failed to fetch state:', err);
  }
}

function showNoGame() {
  document.getElementById('hdr-year').textContent  = '—';
  document.getElementById('hdr-turn').textContent  = '—';
  document.getElementById('hdr-phase').textContent = 'No campaign';
}

function render() {
  if (!gameState) return;
  renderHeader();
  renderSidebars();
  renderMap();
  renderOrderFooter();
  if (selectedRegion) renderDetailPanel(selectedRegion);

  // ── All modals driven by localStorage trackers — works after any page reload ──
  const phase       = gameState.campaign.phase;
  const currentTurn = gameState.campaign.current_season_turn;
  const currentYear = gameState.campaign.current_year;

  // Safety valve: if trackers are somehow ahead of the game state, reset them now.
  if (getTurnSeen() > currentTurn) setTurnSeen(Math.max(0, currentTurn - 1));
  if (getYearSeen() > currentYear)  setYearSeen(currentYear);

  // Game over — show permanent overlay, nothing else matters
  if (phase === 'game_over' || gameState.campaign.winner) {
    showGameOver();
    return;
  }

  if (phase === 'force_refuse') {
    document.getElementById('winter-modal').classList.add('hidden');
    renderForceRefuse();
    return;
  }

  document.getElementById('fr-modal').classList.add('hidden');

  if (phase === 'winter_naval' || phase === 'winter_recruit') {
    // Winter bidding / recruitment modal
    renderWinterPhase();
  } else {
    document.getElementById('winter-modal').classList.add('hidden');

    if (phase === 'orders' && currentYear > getYearSeen()) {
      // New campaign year — only show if the modal isn't already open
      const modal = document.getElementById('resolution-modal');
      if (modal.classList.contains('hidden')) {
        setTurnSeen(1);  // turn 1 of the new year needs no summary of its own
        setYearSeen(currentYear);
        showNewYearSummary(currentYear - 1, gameState);
      }

    } else if (phase === 'orders' && currentTurn > getTurnSeen() && currentTurn > 1) {
      // A turn has resolved — only show if modal isn't already open
      // NOTE: setTurnSeen is called by the close handler, not here, so a failed
      // show doesn't silently consume the flag.
      const modal = document.getElementById('resolution-modal');
      if (modal.classList.contains('hidden')) {
        showResolutionSummary(currentTurn - 1, gameState);
      }

    } else if (phase === 'orders' && (gameState.pending_battles?.length ?? 0) > 0) {
      // Battles still pending (page reload mid-battle phase, no new summary needed)
      const resModal    = document.getElementById('resolution-modal');
      const battleModal = document.getElementById('battle-modal');
      if (resModal.classList.contains('hidden') && battleModal.classList.contains('hidden')) {
        openNextBattle();
      }
    }
  }
}

// ─── Header ──────────────────────────────────────────────────────────────────

function renderHeader() {
  const c         = gameState.campaign;
  const yearLabel = ['I','II','III','IV','V'][c.current_year - 1] || c.current_year;
  const isWinter  = c.phase.startsWith('winter');
  document.getElementById('hdr-year').textContent  = `${218 - (c.current_year - 1)} BC (Yr ${yearLabel})`;
  document.getElementById('hdr-turn').textContent  = isWinter ? '❄' : c.current_season_turn;
  const phaseLabels = { orders: 'Orders', winter_naval: 'Winter — Naval', winter_recruit: 'Winter — Recruitment' };
  document.getElementById('hdr-phase').textContent = phaseLabels[c.phase] || capitalize(c.phase);
}

// ─── Sidebars ─────────────────────────────────────────────────────────────────

function renderSidebars() {
  const rome = gameState.sides.rome;
  const cart = gameState.sides.carthage;

  document.getElementById('rome-res').textContent   = rome.resources;
  document.getElementById('rome-vp').textContent    = rome.vp_total;
  document.getElementById('rome-naval').textContent = rome.naval_control ? '★ Yes' : 'No';

  document.getElementById('cart-res').textContent   = cart.resources;
  document.getElementById('cart-vp').textContent    = cart.vp_total;
  document.getElementById('cart-naval').textContent = cart.naval_control ? '★ Yes' : 'No';

  updateInitiativeDisplay();

  renderArmyList('rome-armies',     'rome');
  renderArmyList('carthage-armies', 'carthage');
}

function renderArmyList(containerId, side) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const isMySide = (side === mySide);

  gameState.armies.filter(a => a.side === side).forEach(army => {
    const div = document.createElement('div');
    div.className = `army-card side-${side}`;
    div.dataset.armyId = army.army_id;

    if (army.is_intelligence) {
      // Enemy army — show intelligence picture only
      const fresh = army.last_known_turn === gameState.campaign.current_season_turn;
      div.classList.add('intel-card');
      if (fresh) div.classList.add('intel-fresh');
      const condHtml = army.condition && army.condition !== 'unknown'
        ? `<span class="cond-${army.condition}">${capitalize(army.condition)}</span>`
        : `<span class="cond-unknown">Unknown</span>`;
      div.innerHTML = `
        <div class="army-name">${army.name} <span class="intel-tag">Intel</span></div>
        <div class="army-detail"><span class="label">Last seen</span> ${regionName(army.last_known_region)}</div>
        <div class="army-detail"><span class="label">Turn</span> ${army.last_known_turn ?? '?'}</div>
        <div class="army-detail"><span class="label">Condition</span> ${condHtml}</div>`;
    } else {
      // Friendly army — full info + order selector
      div.innerHTML = `
        <div class="army-name">${army.name}</div>
        <div class="army-detail"><span class="label">Region</span> ${regionName(army.true_region)}</div>
        <div class="army-detail"><span class="label">Condition</span>
          <span class="cond-${army.condition}">${capitalize(army.condition)}</span></div>
        <div class="army-detail"><span class="label">Experience</span> ${capitalize(army.experience)}</div>
        ${army.experience === 'levy' ? `
        <div class="army-detail"><span class="label">Field exp.</span>
          <span class="${(army.turns_in_field || 0) >= 2 ? 'ok' : 'warn'}">${army.turns_in_field || 0}/2 turns</span></div>` : ''}
        <div class="army-detail"><span class="label">Points</span>
          ${(army.allied_contingent_attached || army.mercenary_contingent_attached)
            ? `<span class="ok">${effectivePoints(army)}</span>`
            : effectivePoints(army)}</div>
        <div class="army-detail"><span class="label">Supply</span>
          <span class="${army.in_supply ? 'ok' : 'warn'}">${army.in_supply ? 'In Supply' : 'Out of Supply'}</span></div>
        <div class="army-detail"><span class="label">Siege Equip.</span>
          <span class="${army.siege_equipment ? 'ok' : ''}">${army.siege_equipment ? 'Yes' : 'No'}</span></div>
        ${army.allied_contingent_attached ? `
        <div class="army-detail"><span class="label">Allies</span>
          <span class="ok">+100 pts</span></div>` : ''}
        ${army.mercenary_contingent_attached ? `
        <div class="army-detail"><span class="label">Mercs</span>
          <span class="ok">+100 pts</span></div>` : ''}
        ${army.emergency_reinforcement ? `
        <div class="army-detail"><span class="label">Emerg. Reinf.</span>
          <span class="ok">Active</span></div>` : ''}
        ${army.feint_region ? `
        <div class="army-detail"><span class="label">Feinting</span>
          <span class="ok">→ ${regionName(army.feint_region)}</span></div>` : ''}
        ${isMySide ? renderOrderSelector(army) : ''}`;

      if (isMySide) {
        // Sync select to current pending order
        const sel = div.querySelector('.order-select');
        if (sel) {
          const existing = pendingOrders[army.army_id];
          // Encode existing order back to select value
          if (!existing || existing.type === 'hold') {
            sel.value = 'hold';
          } else if (existing.type === 'move') {
            sel.value = `move:${existing.to_region}`;
          } else if (existing.type === 'scout') {
            sel.value = `scout:${existing.target_army}`;
          } else if (existing.type === 'deep_scout') {
            sel.value = `deep_scout:${existing.target_army}`;
          } else if (existing.type === 'establish_depot') {
            sel.value = 'establish_depot';
          } else if (existing.type === 'siege') {
            sel.value = `siege:${existing.sp_id}`;
          } else if (existing.type === 'feint') {
            sel.value = `feint:${existing.to_region}`;
          }
          sel.disabled = ordersLocked;
          sel.addEventListener('change', () => {
            const val = sel.value;
            if (val === 'hold') {
              pendingOrders[army.army_id] = { army_id: army.army_id, type: 'hold' };
            } else if (val.startsWith('move:')) {
              pendingOrders[army.army_id] = { army_id: army.army_id, type: 'move', to_region: val.slice(5) };
            } else if (val.startsWith('scout:')) {
              pendingOrders[army.army_id] = { army_id: army.army_id, type: 'scout', target_army: val.slice(6) };
            } else if (val.startsWith('deep_scout:')) {
              pendingOrders[army.army_id] = { army_id: army.army_id, type: 'deep_scout', target_army: val.slice(11) };
            } else if (val === 'establish_depot') {
              pendingOrders[army.army_id] = { army_id: army.army_id, type: 'establish_depot' };
            } else if (val.startsWith('siege:')) {
              pendingOrders[army.army_id] = { army_id: army.army_id, type: 'siege', sp_id: val.slice(6) };
            } else if (val.startsWith('feint:')) {
              pendingOrders[army.army_id] = { army_id: army.army_id, type: 'feint', to_region: val.slice(6) };
            }
            updateInitiativeDisplay(); // live update of committed IP count
          });
        }

        // Emergency reinforce button — independent of order selector, appended directly to army card
        const canReinforce = ['orders', 'force_refuse'].includes(gameState.campaign.phase)
          && !army.emergency_reinforcement
          && army.condition !== 'good'
          && !gameState.sides[mySide]?.emergency_reinforcement_used_this_season;
        if (canReinforce) {
          const reinforceCost = (mySide === 'carthage' && gameState.sides.rome.naval_control) ? 3 : 2;
          const btn = document.createElement('button');
          btn.innerHTML = `Emergency Reinforce<br><span style="color:var(--text-dim)">(${reinforceCost} res)</span>`;
          btn.style.cssText = 'margin-top:6px;width:100%;font-size:0.8em;line-height:1.4';
          btn.addEventListener('click', async e => {
            e.stopPropagation();
            showConfirm('Emergency Reinforce', `Spend ${reinforceCost} resources to emergency reinforce ${army.name}?`, async () => {
              try {
                const r = await fetch('/emergency-reinforce', {
                  method: 'POST', headers: authHeaders(),
                  body: JSON.stringify({ army_id: army.army_id }),
                });
                const d = await r.json();
                if (!r.ok) { showNotify('Error', d.error || 'Failed'); return; }
                await fetchState();
              } catch { showNotify('Error', 'Server unreachable.'); }
            });
          });
          div.appendChild(btn);
        }
      }
    }

    div.addEventListener('click', () => {
      const region = army.is_intelligence ? army.last_known_region : army.true_region;
      if (region) selectRegion(region);
    });

    container.appendChild(div);
  });
}

function renderOrderSelector(army) {
  const adjacent   = gameState.adjacency?.[army.true_region] || [];
  const hasNaval   = gameState.sides[mySide]?.naval_control;
  const moveOpts   = adjacent
    .filter(r => !SEA_CONNECTIONS.has(`${army.true_region}:${r}`) || hasNaval)
    .map(r => {
      const isSea = SEA_CONNECTIONS.has(`${army.true_region}:${r}`);
      return `<option value="move:${r}">${regionName(r)}${isSea ? ' ⚓' : ''}</option>`;
    }).join('');

  // Enemy armies available to scout — identified by is_intelligence flag
  const enemies = gameState.armies.filter(a => a.is_intelligence);
  const scoutOpts = enemies.map(a =>
    `<option value="scout:${a.army_id}">${a.name} (1 IP)</option>`
  ).join('');
  const deepOpts = enemies.map(a =>
    `<option value="deep_scout:${a.army_id}">${a.name} (2 IP)</option>`
  ).join('');

  // Depot option — only if in a friendly region, enough resources, no depot already there
  const myRegion    = gameState.regions.find(r => r.region_id === army.true_region);
  const inFriendly  = myRegion?.controller === mySide;
  const hasResources = (gameState.sides[mySide]?.resources ?? 0) >= 1;
  const depotExists = (gameState.depots || []).some(d => d.side === mySide && d.region_id === army.true_region);
  const depotOpt    = inFriendly && hasResources && !depotExists
    ? `<option value="establish_depot">Establish Depot (1 res, 1 IP)</option>`
    : '';

  // Siege options — enemy-controlled fortified SPs in same region, requires siege equipment
  const opponent  = mySide === 'rome' ? 'carthage' : 'rome';
  const siegeOpts = army.siege_equipment
    ? (myRegion?.strategic_points || [])
        .filter(sp => sp.controller !== mySide && sp.fortification_rating > 0)
        .map(sp => {
          const bpLabel = sp.breach_points_accumulated > 0 ? ` [${sp.breach_points_accumulated} breach]` : '';
          return `<option value="siege:${sp.point_id}">${sp.name}${bpLabel} (1 IP)</option>`;
        }).join('')
    : '';

  // Feint options — adjacent regions (1 IP), only if not already feinting
  const feintOpts = !army.feint_region
    ? adjacent
        .filter(r => !SEA_CONNECTIONS.has(`${army.true_region}:${r}`) || hasNaval)
        .map(r => `<option value="feint:${r}">${regionName(r)} (1 IP)</option>`)
        .join('')
    : '';

  return `
    <div class="order-row">
      <span class="label">Order</span>
      <select class="order-select" data-army="${army.army_id}">
        <option value="hold">Hold</option>
        ${moveOpts    ? `<optgroup label="── Move to">${moveOpts}</optgroup>`       : ''}
        ${scoutOpts   ? `<optgroup label="── Scout">${scoutOpts}</optgroup>`        : ''}
        ${deepOpts    ? `<optgroup label="── Deep Scout">${deepOpts}</optgroup>`    : ''}
        ${depotOpt    ? `<optgroup label="── Supply">${depotOpt}</optgroup>`        : ''}
        ${siegeOpts   ? `<optgroup label="── Siege">${siegeOpts}</optgroup>`        : ''}
        ${feintOpts   ? `<optgroup label="── Feint">${feintOpts}</optgroup>`        : ''}
      </select>
    </div>`;
}

// Returns total initiative points committed by pending orders this turn
function getCommittedInitiative() {
  const costs = { hold: 0, move: 0, scout: 1, deep_scout: 2, establish_depot: 1, siege: 1, feint: 1 };
  return Object.values(pendingOrders)
    .reduce((sum, o) => sum + (costs[o.type] || 0), 0);
}

// Updates only the initiative pool spans — called on render and live on order changes
function updateInitiativeDisplay() {
  if (!gameState || !mySide) return;
  const rome = gameState.sides.rome;
  const cart = gameState.sides.carthage;
  const committed = getCommittedInitiative();
  const myPool  = mySide === 'rome' ? rome.initiative_pool : cart.initiative_pool;
  const oppPool = mySide === 'rome' ? cart.initiative_pool : rome.initiative_pool;
  const myEl  = document.getElementById(mySide === 'rome' ? 'rome-init' : 'cart-init');
  const oppEl = document.getElementById(mySide === 'rome' ? 'cart-init' : 'rome-init');
  if (myEl)  myEl.textContent  = committed > 0 ? `${myPool} (${committed} committed)` : `${myPool}`;
  if (oppEl) oppEl.textContent = oppPool;
}

// ─── Order footer (submit button + waiting banner) ───────────────────────────

function renderOrderFooter() {
  const banner  = document.getElementById('waiting-banner');
  const phase   = gameState.campaign.phase;

  // Winter phases — no order submission; remove the submit button entirely
  if (phase !== 'orders') {
    banner.classList.add('hidden');
    const existingBtn = document.getElementById('btn-submit-orders');
    if (existingBtn) existingBtn.remove();
    return;
  }

  const submitted  = gameState.orders_submitted?.[mySide];
  const hasBattles = (gameState.pending_battles?.length ?? 0) > 0;

  if (submitted) {
    ordersLocked = true;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  const sidebarId = mySide === 'rome' ? 'sidebar-rome' : 'sidebar-carthage';
  const sidebar   = document.getElementById(sidebarId);
  if (!sidebar) return;

  let btn = document.getElementById('btn-submit-orders');
  if (!btn) {
    btn = document.createElement('button');
    btn.id        = 'btn-submit-orders';
    btn.className = 'submit-orders-btn';
    sidebar.appendChild(btn);
  }

  if (hasBattles) {
    btn.textContent = '⚔ Resolve Battle';
    btn.disabled    = false;
    btn.onclick     = openNextBattle;
  } else if (submitted) {
    btn.textContent = 'Orders Locked';
    btn.disabled    = true;
    btn.onclick     = null;
  } else {
    btn.textContent = 'Submit Orders';
    btn.disabled    = false;
    btn.onclick     = submitOrders;
  }
}

async function submitOrders() {
  // Default unset armies to Hold
  gameState.armies.filter(a => a.side === mySide && !a.is_intelligence).forEach(army => {
    if (!pendingOrders[army.army_id]) {
      pendingOrders[army.army_id] = { army_id: army.army_id, type: 'hold' };
    }
  });

  const orders = Object.values(pendingOrders);

  try {
    const res = await fetch('/orders', {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify({ orders }),
    });

    if (!res.ok) {
      const body = await res.json();
      showNotify('Order Error', body.errors?.join('\n') || body.error || 'Unknown error');
      return;
    }

    ordersLocked = true;
    // Re-fetch to get updated state (possibly resolved turn)
    await fetchState();
  } catch (e) {
    console.error('Failed to submit orders:', e);
  }
}

// ─── Battle resolution modal ──────────────────────────────────────────────────

let currentBattleRegion = null; // which battle is currently displayed

function openNextBattle() {
  const battles = gameState?.pending_battles ?? [];
  if (battles.length === 0) return;
  showBattleModal(battles[0], battles.length);
}

function showBattleModal(battle, total) {
  currentBattleRegion = battle.region;
  const modal = document.getElementById('battle-modal');
  const title = document.getElementById('battle-title');
  const body  = document.getElementById('battle-body');

  const suffix = total > 1 ? ` (1 of ${total})` : '';
  title.textContent = `⚔ Battle Resolution${suffix}`;

  const region  = gameState.regions.find(r => r.region_id === battle.region);
  const armies  = battle.armies
    .map(id => gameState.armies.find(a => a.army_id === id))
    .filter(Boolean);

  // Show both army names — both sides know who they fought
  const armyHtml = armies.map(a =>
    `<span class="side-${a.side}">${a.name}</span>`
  ).join(' <span style="color:var(--text-dim)">vs</span> ');

  body.innerHTML = `
    <div class="battle-region">${region?.name ?? battle.region}</div>
    <div class="battle-armies">${armyHtml}</div>
    <div class="battle-note">Fight this battle in Field of Glory 2, then record the result below.</div>`;

  // Retreat options — adjacent regions the loser could fall back to, excluding enemy-occupied ones.
  // Rebuilt whenever the winner selection changes since occupied regions depend on who won.
  function buildRetreatOptions() {
    const winner = document.getElementById('battle-winner').value;
    const winnerOccupied = new Set(
      (gameState.armies || [])
        .filter(a => a.side === winner && a.true_region)
        .map(a => a.true_region)
    );
    const retreatSel = document.getElementById('battle-retreat');
    const prev = retreatSel.value;
    retreatSel.innerHTML = '<option value="">Auto (nearest safe region)</option>';
    (gameState.adjacency[battle.region] || []).forEach(r => {
      if (!winnerOccupied.has(r)) {
        retreatSel.innerHTML += `<option value="${r}">${regionName(r)}</option>`;
      }
    });
    // Restore selection if still valid
    if (prev && retreatSel.querySelector(`option[value="${prev}"]`)) retreatSel.value = prev;
  }
  document.getElementById('battle-winner').addEventListener('change', buildRetreatOptions);
  buildRetreatOptions();

  document.getElementById('battle-error').classList.add('hidden');
  modal.classList.remove('hidden');
}

async function submitBattleResult() {
  const winner    = document.getElementById('battle-winner').value;
  const loss_type = document.getElementById('battle-loss-type').value;
  const retreatVal = document.getElementById('battle-retreat').value;
  const errEl     = document.getElementById('battle-error');
  errEl.classList.add('hidden');

  const body = { region: currentBattleRegion, winner, loss_type };
  if (retreatVal) body.loser_retreats_to = retreatVal;

  try {
    const res = await fetch('/battle/resolve', {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 404) {
        // Battle already resolved by opponent — close modal and refresh
        document.getElementById('battle-modal').classList.add('hidden');
        currentBattleRegion = null;
        await fetchState();
        return;
      }
      errEl.textContent = data.error || 'Could not record result.';
      errEl.classList.remove('hidden');
      return;
    }

    document.getElementById('battle-modal').classList.add('hidden');
    currentBattleRegion = null;

    // Defection notifications are now log-driven (both players see them via fetchState)

    await fetchState();

    // If more battles remain, open the next one
    if ((gameState?.pending_battles?.length ?? 0) > 0) {
      openNextBattle();
    }
  } catch (e) {
    errEl.textContent = 'Server unreachable.';
    errEl.classList.remove('hidden');
  }
}

// ─── Force / Refuse ───────────────────────────────────────────────────────────

function renderForceRefuse() {
  const modal    = document.getElementById('fr-modal');
  const body     = document.getElementById('fr-body');
  const submitBtn = document.getElementById('fr-submit');
  const waiting  = document.getElementById('fr-waiting');
  const errEl    = document.getElementById('fr-error');

  modal.classList.remove('hidden');
  errEl.classList.add('hidden');

  const alreadyDeclared = gameState.my_force_refuse !== null && gameState.my_force_refuse !== undefined;
  submitBtn.style.display  = alreadyDeclared ? 'none' : '';
  waiting.classList.toggle('hidden', !alreadyDeclared);

  if (alreadyDeclared) {
    body.innerHTML = gameState.phantom_encounter_pending
      ? `<div style="color:#f39c12;padding:8px 0">⚔ Your feint has been detected — the enemy is deciding whether to engage. Awaiting their decision.</div>`
      : '';
    return;
  }

  const ip = gameState.sides[mySide]?.initiative_pool ?? 0;

  body.innerHTML = (gameState.pending_encounters || []).map(enc => {
    const r = gameState.regions.find(x => x.region_id === enc.region);
    const rname = r?.name ?? enc.region;
    const freeForce = enc.consecutive_refusals >= 2;
    const forceCost = freeForce ? 0 : 1;
    const consecutiveNote = enc.consecutive_refusals > 0
      ? `<span style="color:var(--text-dim);font-size:12px">${enc.consecutive_refusals} mutual refusal${enc.consecutive_refusals > 1 ? 's' : ''} — ${freeForce ? 'force now free' : 'force costs 1 IP'}</span>`
      : `<span style="color:var(--text-dim);font-size:12px">force costs 1 IP</span>`;

    // Build per-side army lines with entry direction
    const armyLine = side => {
      const data = enc[side];
      if (!data) return '';
      const names = (data.army_ids || []).map(id => {
        const a = gameState.armies.find(x => x.army_id === id);
        return a?.name ?? id;
      }).join(', ');
      const from = data.entered_from
        ? ` <span style="color:var(--text-dim)">from ${gameState.regions.find(x => x.region_id === data.entered_from)?.name ?? data.entered_from}</span>`
        : '';
      const sideClass = `side-${side}`;
      return `<div class="fr-army-line"><span class="${sideClass}">${capitalize(side)}:</span> ${names}${from}</div>`;
    };

    return `<div class="fr-encounter" data-id="${enc.encounter_id}">
      <div class="fr-region">⚔ Encounter in <strong>${rname}</strong> &nbsp;·&nbsp; ${consecutiveNote}</div>
      <div class="fr-armies">${armyLine('rome')}${armyLine('carthage')}</div>
      <div class="fr-choices">
        <label class="fr-choice">
          <input type="radio" name="fr_${enc.encounter_id}" value="accept" checked>
          <span class="fr-choice-body">
            <span class="fr-choice-name">Accept</span>
            <span class="fr-choice-desc">Willing to fight — battle occurs if opponent also accepts or forces. Opponent may still refuse and retreat.</span>
          </span>
        </label>
        <label class="fr-choice">
          <input type="radio" name="fr_${enc.encounter_id}" value="refuse">
          <span class="fr-choice-body">
            <span class="fr-choice-name">Refuse</span>
            <span class="fr-choice-desc">Retreat one region — succeeds unless opponent forces. Refuse trumps Accept.</span>
          </span>
        </label>
        <label class="fr-choice">
          <input type="radio" name="fr_${enc.encounter_id}" value="force"
            ${forceCost > ip ? 'disabled title="Not enough initiative"' : ''}>
          <span class="fr-choice-body">
            <span class="fr-choice-name" ${forceCost > ip ? 'style="color:var(--text-dim)"' : ''}>Force ${forceCost > 0 ? '<span style="color:#f39c12">(1 IP)</span>' : '<span style="color:#2ecc71">(free)</span>'}</span>
            <span class="fr-choice-desc">Battle guaranteed — opponent cannot refuse. ${forceCost > ip ? '<span style="color:#e74c3c">Not enough initiative.</span>' : ''}</span>
          </span>
        </label>
      </div>
    </div>`;
  }).join('');
}

async function submitForceRefuse() {
  const errEl = document.getElementById('fr-error');
  errEl.classList.add('hidden');

  const declarations = (gameState.pending_encounters || []).map(enc => {
    const radios = document.querySelectorAll(`input[name="fr_${enc.encounter_id}"]`);
    const chosen = [...radios].find(r => r.checked)?.value ?? 'accept';
    return { encounter_id: enc.encounter_id, choice: chosen };
  });

  try {
    const res = await fetch('/force-refuse/declare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Player-Token': getToken() },
      body: JSON.stringify({ declarations }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || (data.errors || []).join('; ') || 'Error submitting declarations.';
      errEl.classList.remove('hidden');
      return;
    }
    await fetchState();
  } catch (e) {
    errEl.textContent = 'Server unreachable.';
    errEl.classList.remove('hidden');
  }
}

// ─── Resolution summary (executive briefing) ─────────────────────────────────

function showResolutionSummary(resolvedTurn, state) {
  const modal = document.getElementById('resolution-modal');
  const title = document.getElementById('resolution-title');
  const body  = document.getElementById('resolution-body');

  title.textContent = `Turn ${resolvedTurn} — Situation Report`;

  // Log entries written during this resolution — filter by both turn AND year to prevent
  // bleed from same-numbered turns in previous campaign years.
  const currentYear = state.campaign.current_year;
  const logEvents = (state.log || []).filter(e => e.turn === resolvedTurn && e.year === currentYear);

  // ── Own movements ──
  // Log stores army_id; look up side from the armies list (friendly = full data)
  const myMoves = logEvents.filter(e => {
    if (e.type !== 'move') return false;
    const army = state.armies.find(a => a.army_id === e.army_id);
    return army && army.side === mySide;
  });

  // ── Enemy spotted via adjacency/territory visibility ──
  // Exclude armies already covered by a scout action report (avoid duplication)
  const scoutRevealedIds = new Set(
    (state.log || [])
      .filter(e => e.turn === resolvedTurn && (e.type === 'scout' || e.type === 'deep_scout') && e.success)
      .map(e => e.target_army)
  );
  const enemySpotted = state.armies.filter(a =>
    a.is_intelligence &&
    a.last_known_turn === state.campaign.current_season_turn &&
    !scoutRevealedIds.has(a.army_id)
  );

  // ── Battles involving own armies ──
  const myBattles = (state.pending_battles || []).filter(b =>
    b.armies.some(id => {
      const a = state.armies.find(x => x.army_id === id);
      return a && a.side === mySide;
    })
  );

  let html = '';

  // Section: Your Orders
  html += '<div class="res-section-title">Your Orders</div>';
  if (myMoves.length) {
    html += myMoves.map(e => {
      const army = state.armies.find(a => a.army_id === e.army_id);
      return `<div class="res-item">${army?.name ?? e.army_id}: ${regionName(e.from)} → ${regionName(e.to)}</div>`;
    }).join('');
  } else {
    html += '<div class="res-item res-dim">All armies held position.</div>';
  }

  // Section: Scout action results (private — server already filtered log to only include own)
  const scoutResults = logEvents.filter(e => e.type === 'scout' || e.type === 'deep_scout');
  if (scoutResults.length) {
    html += '<div class="res-section-title">Intelligence Reports</div>';
    html += scoutResults.map(e => {
      const scoutingArmy = state.armies.find(a => a.army_id === e.army_id);
      const targetArmy   = state.armies.find(a => a.army_id === e.target_army);
      const actionLabel  = e.type === 'deep_scout' ? 'Deep Scout' : `Scout — rolled ${e.roll}`;
      if (e.success) {
        const condLabel = e.revealed_condition
          ? ` — <span class="cond-${e.revealed_condition}">${capitalize(e.revealed_condition)}</span>`
          : '';
        return `<div class="res-item res-intel">
          ${scoutingArmy?.name ?? e.army_id} (${actionLabel}):
          ${targetArmy?.name ?? e.target_army} located in ${regionName(e.revealed_region)}${condLabel}
        </div>`;
      } else {
        return `<div class="res-item res-dim">
          ${scoutingArmy?.name ?? e.army_id} (${actionLabel}):
          No confirmed sighting of ${targetArmy?.name ?? e.target_army}
        </div>`;
      }
    }).join('');
  }

  // Section: Intelligence (enemy spotted via adjacency/territory visibility)
  if (enemySpotted.length) {
    html += '<div class="res-section-title">Enemy Sightings</div>';
    html += enemySpotted.map(a =>
      `<div class="res-item res-intel">Enemy spotted — ${a.name} in ${regionName(a.last_known_region)}</div>`
    ).join('');
  }

  // Section: Attrition (supply/territory wear — own armies only)
  const attritionEvents = logEvents.filter(e => e.type === 'attrition' && e.side === mySide);
  if (attritionEvents.length) {
    html += '<div class="res-section-title">⚠ Attrition</div>';
    html += attritionEvents.map(e => {
      const army    = state.armies.find(a => a.army_id === e.army_id);
      const supplyLabel = e.in_supply ? 'in supply' : 'out of supply';
      const terrLabel   = e.region_controller === mySide ? 'friendly' :
                          e.region_controller === (mySide === 'rome' ? 'carthage' : 'rome') ? 'enemy' : 'neutral';
      const drop = e.condition_before !== e.condition_after
        ? ` → <span class="cond-${e.condition_after}">${capitalize(e.condition_after)}</span>`
        : ' (no drop yet)';
      return `<div class="res-item res-warn">
        ${army?.name ?? e.army_id}: ${e.points} pt${e.points !== 1 ? 's' : ''} (${supplyLabel}, ${terrLabel} territory)${drop}
      </div>`;
    }).join('');
  }

  // Section: Emergency reinforcement (own side only)
  const emergEvents = logEvents.filter(e => e.type === 'emergency_reinforcement' && e.side === mySide);
  if (emergEvents.length) {
    html += '<div class="res-section-title">Emergency Reinforcement</div>';
    html += emergEvents.map(e =>
      `<div class="res-item"><span class="ok">${e.army_name}</span> reinforced (+${e.bonus} pts, cost ${e.cost} resources)</div>`
    ).join('');
  }

  // Section: Battle attrition (condition changes from battle results — own armies only)
  const battleAttrEvents = logEvents.filter(e => e.type === 'battle_attrition' && e.side === mySide);
  if (battleAttrEvents.length) {
    html += '<div class="res-section-title">⚔ Battle Attrition</div>';
    html += battleAttrEvents.map(e => {
      const army = state.armies.find(a => a.army_id === e.army_id);
      const lossLabel = e.loss_type === 'decisive' ? 'Decisive defeat' : 'Minor reverse';
      const drop = e.condition_before !== e.condition_after
        ? ` → <span class="cond-${e.condition_after}">${capitalize(e.condition_after)}</span>`
        : ' (no change)';
      return `<div class="res-item res-warn">${army?.name ?? e.army_id}: ${lossLabel}${drop}</div>`;
    }).join('');
  }

  // Section: Experience gains (decisive victories — own armies only)
  const expEvents = logEvents.filter(e => e.type === 'experience_gained' && e.side === mySide);
  if (expEvents.length) {
    html += '<div class="res-section-title" style="color:#3498db">★ Experience Gained</div>';
    html += expEvents.map(e => {
      const army = state.armies.find(a => a.army_id === e.army_id);
      return `<div class="res-item" style="color:#3498db">${army?.name ?? e.army_id}: ${capitalize(e.experience_before)} → ${capitalize(e.experience_after)}</div>`;
    }).join('');
  }

  // Section: Allied contingent (Rome only — not shown to Carthage)
  if (mySide === 'rome') {
    const alliedEvents = logEvents.filter(e => e.type === 'allied_contingent_attached');
    if (alliedEvents.length) {
      html += '<div class="res-section-title">Allied Contingent</div>';
      html += alliedEvents.map(e =>
        `<div class="res-item">Allied contingent attached to ${e.army_name} (+100 pts)</div>`
      ).join('');
    }
  }

  // Section: Army destructions
  const destroyedEvents = logEvents.filter(e => e.type === 'army_destroyed');
  if (destroyedEvents.length) {
    html += '<div class="res-section-title" style="color:#e74c3c">☠ Army Destroyed</div>';
    html += destroyedEvents.map(e => {
      const isOurs = e.side === mySide;
      const name = e.army_id; // army may already be removed from state
      const reasonLabels = {
        broken_in_battle: 'lost a battle while already Broken',
        encircled:        'encircled with no retreat',
        winter_broken_oos:'out of supply and Broken over winter',
      };
      const label = reasonLabels[e.reason] ?? e.reason;
      const regionName_ = state.regions.find(r => r.region_id === e.region)?.name ?? e.region ?? '';
      const loc = regionName_ ? ` in ${regionName_}` : '';
      return `<div class="res-item" style="color:#e74c3c;font-weight:600">${isOurs ? '▼ Our' : '▲ Enemy'} army (${name})${loc}: ${label}</div>`;
    }).join('');
  }

  // Section: Loyalty rolls and defections
  const defRollEvents = logEvents.filter(e => e.type === 'defection_roll');
  if (defRollEvents.length) {
    html += '<div class="res-section-title">🏛 Loyalty</div>';
    html += defRollEvents.map(e => {
      const rname = state.regions.find(r => r.region_id === e.region_id)?.name ?? e.region_id;
      const modsLabel = e.modifiers > 0 ? ` (+${e.modifiers} modifiers)` : '';
      if (e.defects) {
        return `<div class="res-item" style="color:#e67e22;font-weight:600">⚠ ${rname} has defected to Carthage! (rolled ${e.roll} vs threshold ${e.threshold}${modsLabel})</div>`;
      }
      return `<div class="res-item res-intel">${rname} holds firm (rolled ${e.roll} vs threshold ${e.threshold}${modsLabel})</div>`;
    }).join('');
  }

  // Section: Destabilized flags applied
  const destabilizeEvents = logEvents.filter(e => e.type === 'region_destabilized');
  if (destabilizeEvents.length) {
    html += '<div class="res-section-title">⚡ Destabilized</div>';
    html += destabilizeEvents.map(e => {
      const rname = state.regions.find(r => r.region_id === e.region_id)?.name ?? e.region_id;
      return `<div class="res-item" style="color:#e67e22">⚡ ${rname} is now destabilized — loyalty roll if Hannibal enters</div>`;
    }).join('');
  }

  // Section: Destabilized flags cleared
  const destClearedEvents = logEvents.filter(e => e.type === 'destabilized_cleared');
  if (destClearedEvents.length) {
    html += destClearedEvents.map(e => {
      const rname = state.regions.find(r => r.region_id === e.region_id)?.name ?? e.region_id;
      return `<div class="res-item res-intel">✓ ${rname} destabilized flag cleared (Carthage lost in Italy)</div>`;
    }).join('');
  }

  // Section: Loyalty restored
  const recoveryEvents = logEvents.filter(e => e.type === 'loyalty_restored');
  if (recoveryEvents.length) {
    html += recoveryEvents.map(e => {
      const rname = state.regions.find(r => r.region_id === e.region_id)?.name ?? e.region_id;
      return `<div class="res-item res-intel">🏛 ${rname} restored to Roman loyalty</div>`;
    }).join('');
  }

  // Section: Winter attrition (shown in year-end summary)
  const winterAttrEvents = logEvents.filter(e => e.type === 'winter_attrition' && e.side === mySide);
  if (winterAttrEvents.length) {
    html += '<div class="res-section-title">❄ Winter Attrition</div>';
    html += winterAttrEvents.map(e => {
      const army = state.armies.find(a => a.army_id === e.army_id);
      const drop = e.condition_before !== e.condition_after
        ? ` → <span class="cond-${e.condition_after}">${capitalize(e.condition_after)}</span>`
        : ' (no change)';
      return `<div class="res-item res-warn">${army?.name ?? e.army_id}: out of supply in winter${drop}</div>`;
    }).join('');
  }

  // Section: VP earned this turn
  const vpEvents = logEvents.filter(e => e.type === 'vp_earned');
  if (vpEvents.length) {
    html += '<div class="res-section-title">VP Earned</div>';
    html += vpEvents.map(e => {
      const isOurs = e.side === mySide;
      const reasonLabels = {
        battle_victory: 'battle victory',
        army_destroyed: `army${e.count > 1 ? 's' : ''} destroyed`,
      };
      const label = reasonLabels[e.reason] ?? e.reason;
      return `<div class="res-item" style="color:${isOurs ? '#2ecc71' : '#e74c3c'};font-weight:600">
        ${isOurs ? '★' : '▲'} ${capitalize(e.side)}: +${e.amount} VP (${label}) — total ${gameState.sides[e.side]?.vp_total ?? '?'}
      </div>`;
    }).join('');
  }

  // Section: Siege operations this turn
  const siegeRollEvents  = logEvents.filter(e => e.type === 'siege_roll');
  const spCapturedEvents = logEvents.filter(e => e.type === 'sp_captured');
  if (siegeRollEvents.length || spCapturedEvents.length) {
    html += '<div class="res-section-title">Siege Operations</div>';
    html += siegeRollEvents.map(e => {
      const army   = state.armies.find(a => a.army_id === e.army_id);
      const bpAfter = e.breach_pts_before + (e.breach ? 1 : 0);
      const rollLabel = e.breach
        ? `rolled ${e.roll} — breach point! (${bpAfter}/${e.fortification_rating})`
        : `rolled ${e.roll} — no breach (${e.breach_pts_before}/${e.fortification_rating})`;
      return `<div class="res-item res-intel">${army?.name ?? e.army_id} besieges ${e.sp_name}: ${rollLabel}</div>`;
    }).join('');
    html += spCapturedEvents.map(e => {
      const isOurs = e.side === mySide;
      return `<div class="res-item" style="color:${isOurs ? '#2ecc71' : '#e74c3c'};font-weight:600">
        ${isOurs ? '★' : '▼'} ${e.sp_name} ${isOurs ? 'captured!' : 'falls to the enemy!'}
      </div>`;
    }).join('');
  }

  // Section: Depot events this turn
  const depotEvents = logEvents.filter(e => e.type === 'depot_established' || e.type === 'depot_destroyed');
  if (depotEvents.length) {
    html += '<div class="res-section-title">Supply Depots</div>';
    html += depotEvents.map(e => {
      const rname = regionName(e.region_id);
      if (e.type === 'depot_established') return `<div class="res-item res-intel">Depot established in ${rname} (${capitalize(e.side)})</div>`;
      return `<div class="res-item res-warn">Depot destroyed in ${rname} (${capitalize(e.side)})</div>`;
    }).join('');
  }

  // Section: Force/refuse outcomes
  const frEvents = logEvents.filter(e => e.type === 'force_refuse_resolved');
  if (frEvents.length) {
    html += '<div class="res-section-title">Engagement Decisions</div>';
    html += frEvents.map(e => {
      const r = state.regions.find(x => x.region_id === e.region);
      const rname = r?.name ?? e.region;
      const myChoice   = e[`${mySide}_choice`];
      const oppChoice  = e[`${mySide === 'rome' ? 'carthage' : 'rome'}_choice`];
      const choiceLabel = c => c === 'force' ? 'Forced' : c === 'accept' ? 'Accepted' : 'Refused';
      const myLabel  = choiceLabel(myChoice);
      const oppLabel = choiceLabel(oppChoice);
      const someoneForced = myChoice === 'force' || oppChoice === 'force';
      const bothAccept    = myChoice === 'accept'  && oppChoice === 'accept';
      const bothRefuse    = myChoice === 'refuse'  && oppChoice === 'refuse';
      let outcome = '';
      if (someoneForced || bothAccept)        outcome = 'Battle!';
      else if (bothRefuse)                    outcome = 'Shared occupation';
      else if (myChoice === 'refuse')         outcome = 'You retreated';
      else                                    outcome = 'Enemy retreated';
      return `<div class="res-item">${rname}: You <strong>${myLabel}</strong>, enemy <strong>${oppLabel}</strong> — ${outcome}</div>`;
    }).join('');
  }

  // Section: Feint reveals
  const feintRevealEvents = logEvents.filter(e => e.type === 'feint_revealed' && (e.feinting_side || e.side));
  if (feintRevealEvents.length) {
    html += '<div class="res-section-title">🎭 Feint Revealed</div>';
    html += feintRevealEvents.map(e => {
      const rname = state.regions.find(r => r.region_id === e.region)?.name ?? e.region;
      // New-style phantom feint (has feinting_side / deceived_side)
      if (e.feinting_side) {
        const feintingSide = e.feinting_side;
        const deceivedSide = e.deceived_side;
        const choiceLabel  = { force: 'Forced', accept: 'Accepted', refuse: 'Refused' }[e.deceived_choice] ?? capitalize(e.deceived_choice ?? 'accepted');
        if (feintingSide === mySide) {
          const outcome = e.deceived_choice === 'force'
            ? 'Enemy forced — and wasted an initiative point on empty ground!'
            : e.deceived_choice === 'refuse'
            ? 'Enemy refused and retreated from your decoy.'
            : 'Enemy advanced into the feinted region.';
          return `<div class="res-item res-intel">🎭 Your feint in <strong>${rname}</strong> was contacted — enemy chose <strong>${choiceLabel}</strong>. ${outcome}</div>`;
        } else {
          const outcome = e.force_wasted
            ? `You forced — and spent 1 IP engaging a ghost army.`
            : e.deceived_choice === 'refuse'
            ? `You retreated from a decoy.`
            : `You advanced; the region was empty.`;
          return `<div class="res-item res-warn">🎭 Feint revealed in <strong>${rname}</strong> — the enemy army was a decoy! You chose <strong>${choiceLabel}</strong>. ${outcome}</div>`;
        }
      }
      // Legacy immediate-reveal style (has side / army_id)
      const feintSide = e.side;
      const revealedArmy = state.armies.find(a => a.army_id === e.army_id);
      const trueLoc = state.regions.find(r => r.region_id === e.true_region)?.name ?? e.true_region;
      if (feintSide === mySide) {
        return `<div class="res-item res-warn">🎭 Your feint towards ${rname} was uncovered — enemy found the decoy.</div>`;
      }
      return `<div class="res-item res-intel">🎭 Feint uncovered in ${rname} — ${revealedArmy?.name ?? 'enemy army'} is actually in ${trueLoc}.</div>`;
    }).join('');
  }

  const retreatEvents = logEvents.filter(e => e.type === 'retreat' && (e.reason === 'refused_battle' || e.reason === 'feint_refused'));
  if (retreatEvents.length) {
    html += '<div class="res-section-title">Retreats</div>';
    html += retreatEvents.map(e => {
      const army = state.armies.find(a => a.army_id === e.army_id);
      const from = state.regions.find(r => r.region_id === e.from)?.name ?? e.from;
      const to   = state.regions.find(r => r.region_id === e.to)?.name ?? e.to;
      return `<div class="res-item res-warn">${army?.name ?? e.army_id} retreated: ${from} → ${to}</div>`;
    }).join('');
  }

  // Section: Military occupation (uncontested non-Italian region control transfers)
  const occupationEvents = logEvents.filter(e => e.type === 'occupation');
  if (occupationEvents.length) {
    html += '<div class="res-section-title">Territory Seized</div>';
    html += occupationEvents.map(e => {
      const rname = state.regions.find(r => r.region_id === e.region)?.name ?? e.region;
      const isOurs = e.side === mySide;
      const prev = e.prev_controller === 'neutral' ? 'neutral' : capitalize(e.prev_controller);
      return isOurs
        ? `<div class="res-item res-intel">${rname} occupied (was ${prev})</div>`
        : `<div class="res-item res-warn">${rname} seized by enemy (was ${prev})</div>`;
    }).join('');
  }

  // Section: Battle outcomes from this turn (resolved battles logged this turn)
  const battleResults = logEvents.filter(e => e.type === 'battle_resolved');
  if (battleResults.length) {
    html += '<div class="res-section-title">Battle Results</div>';
    html += battleResults.map(e => {
      const regionObj  = state.regions.find(r => r.region_id === e.region);
      const winnerName = e.winner === 'rome' ? 'Rome' : 'Carthage';
      const loserName  = e.loser  === 'rome' ? 'Rome' : 'Carthage';
      const lossLabel = e.loss_type === 'decisive' ? 'Decisive defeat' : 'Minor reverse';
      const condAfter = e.loser_condition
        ? ` — now <span class="cond-${e.loser_condition}">${capitalize(e.loser_condition)}</span>`
        : '';
      return `<div class="res-item res-battle-result">
        ${regionObj?.name ?? e.region}:
        <span class="side-${e.winner}">${winnerName} victorious</span>
        — ${loserName}: ${lossLabel}${condAfter}
      </div>`;
    }).join('');
  }

  // Section: Battles still pending (need resolution before orders)
  if (myBattles.length) {
    html += '<div class="res-section-title res-battle-title">⚔ Battle Required</div>';
    html += myBattles.map(b => {
      const region = state.regions.find(r => r.region_id === b.region);
      const names  = b.armies.map(id => state.armies.find(a => a.army_id === id)?.name ?? id).join(' vs ');
      return `<div class="res-item res-battle">${region?.name ?? b.region}: ${names}</div>`;
    }).join('');
  }

  body.innerHTML = html;
  modal.classList.remove('hidden');
}

// ─── Game Over ───────────────────────────────────────────────────────────────

function showGameOver() {
  const winner  = gameState.campaign.winner;
  const rVP     = gameState.sides.rome.vp_total;
  const cVP     = gameState.sides.carthage.vp_total;
  const isOurs  = winner === mySide;

  // Find game_over log entry for the reason
  const goEvent = (gameState.log || []).slice().reverse().find(e => e.type === 'game_over');
  const reason  = goEvent?.reason;

  const winnerName = winner === 'rome' ? 'Rome' : 'Carthage';
  const reasonText = reason === 'capital_captured'
    ? `${goEvent.sp_name} has fallen — the campaign is over.`
    : `The five-year campaign has ended.`;

  const modal = document.getElementById('game-over-modal');
  document.getElementById('game-over-title').textContent =
    isOurs ? `Victory — ${winnerName}!` : `Defeat — ${winnerName} prevails`;

  document.getElementById('game-over-body').innerHTML = `
    <div style="margin-bottom:16px;color:var(--text-dim)">${reasonText}</div>
    <div class="vp-row"><span>Rome</span><span>${rVP} VP</span></div>
    <div class="vp-row"><span>Carthage</span><span>${cVP} VP</span></div>
    <div class="winner-name" style="color:${winner === 'rome' ? '#c0392b' : '#8e44ad'}">${winnerName} wins${rVP === cVP ? ' (tiebreak)' : ''}</div>
  `;

  modal.classList.remove('hidden');
}

// ─── Winter Phase UI ─────────────────────────────────────────────────────────

function renderWinterPhase() {
  const phase = gameState.campaign.phase;
  if (phase === 'winter_naval')   showWinterNavalModal();
  else if (phase === 'winter_recruit') showWinterRecruitModal();
}

function showWinterNavalModal() {
  const winter = gameState.winter;
  if (!winter) return;

  const income    = winter.income_breakdown?.[mySide];
  const myRes     = gameState.sides[mySide].resources;
  const submitted = winter.naval_bids_submitted[mySide];

  const romeVP = gameState.sides.rome.vp_total;
  const cartVP = gameState.sides.carthage.vp_total;
  const yearsLeft = Math.max(0, 5 - gameState.campaign.current_year);

  let html = '';

  // VP standing
  html += `<div class="winter-section-title">Victory Points</div>`;
  html += `<div class="winter-row"><span>Rome</span><span><strong>${romeVP}</strong></span></div>`;
  html += `<div class="winter-row"><span>Carthage</span><span><strong>${cartVP}</strong></span></div>`;
  html += `<div class="winter-row"><span>Years remaining</span><span>${yearsLeft}</span></div>`;

  // Income breakdown
  if (income) {
    html += `<div class="winter-section-title">Income Received</div>`;
    html += `<div class="winter-row"><span>Regions controlled</span><span>+${income.regions}</span></div>`;
    html += `<div class="winter-row"><span>Naval supremacy</span><span>+${income.naval}</span></div>`;
    html += `<div class="winter-row"><span>Battle victories</span><span>+${income.battles}</span></div>`;
    html += `<div class="winter-row winter-total"><span>Total income</span><span>+${income.total}</span></div>`;
    html += `<div class="winter-row"><span>Resources now available</span><span>${myRes}</span></div>`;
  }

  // Naval bid
  html += `<div class="winter-section-title">Naval Investment</div>`;
  if (submitted) {
    html += `<div class="winter-waiting">✓ Your bid is submitted. This screen does not update automatically — click <em>Check for Update</em> once your opponent has submitted their bid.</div>`;
  } else {
    html += `<p class="winter-note">Invest resources to contest naval supremacy. Bid 0–2 (max +2 modifier). Carthage has a baseline +1.</p>`;
    let opts = `<option value="0">0 — Hold current fleet</option>`;
    if (myRes >= 1) opts += `<option value="1">1 — Reinforce fleet (+1 mod)</option>`;
    if (myRes >= 2) opts += `<option value="2">2 — Major investment (+2 mod)</option>`;
    html += `<div class="winter-row"><span>Naval bid</span><select id="naval-bid-select">${opts}</select></div>`;
  }

  document.getElementById('winter-title').textContent = `❄ Winter ${218 - (gameState.campaign.current_year - 1)} BC — Naval Investment`;
  document.getElementById('winter-body').innerHTML = html;

  const submitBtn   = document.getElementById('winter-submit');
  const continueBtn = document.getElementById('winter-continue');
  document.getElementById('winter-error').classList.add('hidden');

  if (submitted) {
    submitBtn.classList.add('hidden');
    continueBtn.textContent = '↻ Check for Update';
    continueBtn.classList.remove('hidden');
    continueBtn.onclick = fetchState;
  } else {
    submitBtn.textContent = 'Submit Naval Bid';
    submitBtn.classList.remove('hidden');
    submitBtn.onclick = submitNavalBid;
    continueBtn.classList.add('hidden');
  }

  document.getElementById('winter-modal').classList.remove('hidden');
}

async function submitNavalBid() {
  const bidSel = document.getElementById('naval-bid-select');
  const bid    = parseInt(bidSel?.value ?? '0', 10);
  const errEl  = document.getElementById('winter-error');
  errEl.classList.add('hidden');

  try {
    const res = await fetch('/winter/naval-bid', {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify({ bid }),
    });
    if (!res.ok) {
      const d = await res.json();
      errEl.textContent = d.error || 'Could not submit naval bid.';
      errEl.classList.remove('hidden');
      return;
    }
    await fetchState();
  } catch (e) {
    errEl.textContent = 'Server unreachable.';
    errEl.classList.remove('hidden');
  }
}

function showWinterRecruitModal() {
  const winter = gameState.winter;
  if (!winter) return;

  const navalResult = winter.naval_result;
  const myRes       = gameState.sides[mySide].resources;
  const myArmies    = gameState.armies.filter(a => a.side === mySide && !a.is_intelligence);
  const submitted   = winter.recruit_submitted[mySide];
  const mercCost    = gameState.sides.rome.naval_control ? 2 : 1;

  // ── Winter attrition prediction helpers ─────────────────────────────────────
  const HOME_BASES_CLIENT = { rome: 'latium', carthage: 'africa_proper' };
  const COND_STEPS = ['good', 'worn', 'depleted', 'broken'];
  const dropCond_  = c => { const i = COND_STEPS.indexOf(c); return i < COND_STEPS.length - 1 ? COND_STEPS[i + 1] : 'broken'; };
  const stepUp_    = c => { const i = COND_STEPS.indexOf(c); return i > 0 ? COND_STEPS[i - 1] : 'good'; };

  // Predict final condition after optional reinforce → winter attrition → recovery.
  // withReinforce: true = assume player reinforces this army (+1 step before attrition).
  // Returns { cond: string|null, destroyed: bool }
  function predictWinterEnd(army, withReinforce) {
    const isHome   = army.true_region === HOME_BASES_CLIENT[army.side];
    const inSupply = army.in_supply;
    let cond = army.condition;

    // Step 1: reinforcement (applied before attrition on server)
    if (withReinforce && cond !== 'good') cond = stepUp_(cond);

    // Step 2: winter attrition
    if (!inSupply) {
      if (cond === 'broken') return { cond: null, destroyed: true };
      cond = dropCond_(dropCond_(cond));
    }

    // Step 3: recovery
    if (cond !== 'good') {
      if (isHome)        cond = 'good';
      else if (inSupply) cond = stepUp_(cond);
      // OOS non-home: no recovery
    }
    return { cond, destroyed: false };
  }

  let html = '';

  // Naval result summary
  if (navalResult) {
    const myR   = navalResult[mySide];
    const oppR  = navalResult[mySide === 'rome' ? 'carthage' : 'rome'];
    const holder = navalResult.winner ? capitalize(navalResult.winner) : 'Contested';
    const youWin = navalResult.winner === mySide;
    html += `<div class="winter-section-title">Naval Control Result</div>`;
    html += `<div class="winter-row"><span>Your fleet (roll ${myR.roll} + ${myR.modifier} mod)</span><span><strong>${myR.total}</strong></span></div>`;
    html += `<div class="winter-row"><span>Enemy fleet (roll ${oppR.roll} + ${oppR.modifier} mod)</span><span><strong>${oppR.total}</strong></span></div>`;
    html += `<div class="winter-row"><span>Naval supremacy</span>
      <span class="${navalResult.contested ? 'warn' : youWin ? 'ok' : ''}">${youWin ? '★ ' : ''}${holder}</span></div>`;
  }

  // ── Winter attrition outlook ──────────────────────────────────────────────
  // Show before recruitment options so players can make informed reinforce decisions
  const oosArmies = myArmies.filter(a => !a.in_supply);
  const supplyArmiesNotHome = myArmies.filter(a => a.in_supply && a.true_region !== HOME_BASES_CLIENT[mySide] && a.condition !== 'good');
  const homeArmies = myArmies.filter(a => a.true_region === HOME_BASES_CLIENT[mySide] && a.condition !== 'good');

  if (oosArmies.length > 0 || supplyArmiesNotHome.length > 0 || homeArmies.length > 0) {
    html += `<div class="winter-section-title">Winter Outlook</div>`;
    // OOS armies — attrition warning
    oosArmies.forEach(army => {
      const noR = predictWinterEnd(army, false);
      const withR = army.condition !== 'good' ? predictWinterEnd(army, true) : null;
      const noRLabel = noR.destroyed
        ? `<span style="color:#e74c3c;font-weight:700">☠ Destroyed</span>`
        : `<span class="cond-${noR.cond}">${capitalize(noR.cond)}</span>`;
      let reinforceHint = '';
      if (withR) {
        const withRLabel = withR.destroyed
          ? `<span style="color:#e74c3c;font-weight:700">☠ Destroyed</span>`
          : `<span class="cond-${withR.cond}">${capitalize(withR.cond)}</span>`;
        reinforceHint = ` &nbsp;<span style="color:var(--text-dim)">(if reinforced: ${withRLabel})</span>`;
      }
      html += `<div class="winter-row" style="color:#e67e22">
        <span>⚠ ${army.name} <span style="color:var(--text-dim);font-size:11px">out of supply</span></span>
        <span><span class="cond-${army.condition}">${capitalize(army.condition)}</span> → ${noRLabel}${reinforceHint}</span>
      </div>`;
    });
    // In-supply armies recovering (positive info, muted)
    supplyArmiesNotHome.forEach(army => {
      const outcome = predictWinterEnd(army, false);
      html += `<div class="winter-row" style="color:var(--text-dim)">
        <span>${army.name} <span style="font-size:11px">in supply</span></span>
        <span><span class="cond-${army.condition}">${capitalize(army.condition)}</span> → <span class="cond-${outcome.cond}">${capitalize(outcome.cond)}</span> <span style="font-size:11px">(recovery)</span></span>
      </div>`;
    });
    homeArmies.forEach(army => {
      html += `<div class="winter-row" style="color:var(--text-dim)">
        <span>${army.name} <span style="font-size:11px">at home base</span></span>
        <span><span class="cond-${army.condition}">${capitalize(army.condition)}</span> → <span class="cond-good">Good</span> <span style="font-size:11px">(full recovery)</span></span>
      </div>`;
    });
  }

  // Resources
  html += `<div class="winter-section-title">Recruitment</div>`;
  html += `<div class="winter-row"><span>Resources available</span><span>${myRes}</span></div>`;

  if (submitted) {
    html += `<div class="winter-waiting">✓ Your recruitment is submitted. This screen does not update automatically — click <em>Check for Update</em> once your opponent has submitted their orders.</div>`;
  } else {
    let anyOptions = false;

    myArmies.forEach(army => {
      if (army.condition !== 'good') {
        anyOptions = true;
        const afterReinforce = stepUp_(army.condition);
        const winterWithR    = predictWinterEnd(army, true);
        const winterNoR      = predictWinterEnd(army, false);
        const oos            = !army.in_supply;

        // End-of-winter label (with reinforce)
        const endLabel = winterWithR.destroyed
          ? `<span style="color:#e74c3c;font-weight:600">☠ Destroyed</span>`
          : `<span class="cond-${winterWithR.cond}">${capitalize(winterWithR.cond)}</span>`;

        // Show the winter end result only if different from the post-reinforce step (i.e., attrition/recovery changes it)
        const winterNote = (oos || winterWithR.cond !== afterReinforce)
          ? `&nbsp;<span style="color:var(--text-dim);font-size:11px">→ ends winter at ${endLabel}</span>`
          : '';

        // Destroyed-without-reinforce warning
        const destroyedWarning = (oos && winterNoR.destroyed)
          ? `<br><span style="color:#e74c3c;font-size:11px;margin-left:18px">⚠ Will be destroyed this winter without reinforcement</span>`
          : '';

        html += `<div class="winter-recruit-row">
          <label>
            <input type="checkbox" class="recruit-reinforce" data-army="${army.army_id}">
            Reinforce ${army.name}
            <span class="cond-${army.condition}">${capitalize(army.condition)}</span>
            → <span class="cond-${afterReinforce}">${capitalize(afterReinforce)}</span>
            &nbsp;<span style="color:var(--text-dim)">(cost: 1)</span>${winterNote}${destroyedWarning}
          </label>
        </div>`;
      }
    });

    // ── Reinforcement (one per side per season, Italian theater only) ──
    if (!gameState.sides[mySide].reinforcement_used_this_season) {
      const italianArmies = myArmies.filter(army => {
        const r = gameState.regions.find(reg => reg.region_id === army.true_region);
        return r && r.theater === 'italia';
      });
      if (italianArmies.length > 0) {
        // Determine which options are available
        const hasLoyalItaly   = gameState.regions.some(r => r.theater === 'italia' && r.controller === 'rome' && r.region_id !== 'latium');
        const hasDefectedItaly = gameState.regions.some(r => r.theater === 'italia' && r.controller === 'carthage');
        const showAllied = mySide === 'rome' ? hasLoyalItaly : hasDefectedItaly;
        const showMerc   = mySide === 'carthage';

        if (showAllied || showMerc) {
          anyOptions = true;
          html += `<div class="winter-section-title">Reinforcement <span style="color:var(--text-dim);font-size:0.85em">(choose one — Italian theater only)</span></div>`;
          italianArmies.forEach(army => {
            if (showAllied) {
              const condLabel = mySide === 'rome' ? 'loyal Italian ally' : 'Italian defector';
              html += `<div class="winter-recruit-row"><label>
                <input type="radio" name="recruit-reinforcement" class="recruit-reinforcement" data-army="${army.army_id}" data-rtype="allied_contingent">
                Allied contingent → ${army.name}
                <span style="color:var(--text-dim)">(free — +100 pts, draws from ${condLabel})</span>
              </label></div>`;
            }
            if (showMerc) {
              html += `<div class="winter-recruit-row"><label>
                <input type="radio" name="recruit-reinforcement" class="recruit-reinforcement" data-army="${army.army_id}" data-rtype="mercenary">
                Mercenary contingent → ${army.name}
                <span style="color:var(--text-dim)">(cost: ${mercCost} — +100 pts)</span>
              </label></div>`;
            }
          });
        }
      }
    }

    // Siege equipment purchase
    myArmies.forEach(army => {
      if (!army.siege_equipment) {
        anyOptions = true;
        html += `<div class="winter-recruit-row">
          <label>
            <input type="checkbox" class="recruit-siege-equip" data-army="${army.army_id}">
            Purchase siege equipment for ${army.name}
            <span style="color:var(--text-dim)">(cost: 1)</span>
          </label>
        </div>`;
      }
    });

    // Raise new army — only available when fewer than 2 armies remain (one must have been destroyed)
    if (myArmies.length < 2) {
      const destroyedEntry = (gameState.log || []).slice().reverse()
        .find(e => e.type === 'army_destroyed' && e.side === mySide && e.army_name);
      const raiseName = destroyedEntry?.army_name || 'Army';
      anyOptions = true;
      html += `<div class="winter-recruit-row">
        <label>
          <input type="checkbox" id="recruit-raise-cb">
          Raise <em>${raiseName}</em>
          <span style="color:var(--text-dim)">(cost: 3) — spawns at home base, Good / Levy</span>
        </label>
      </div>`;
    }

    html += `<div class="winter-row winter-total"><span>Estimated cost</span><span id="recruit-cost-val">0</span></div>`;
  }

  document.getElementById('winter-title').textContent = `❄ Winter ${218 - (gameState.campaign.current_year - 1)} BC — Recruitment`;
  document.getElementById('winter-body').innerHTML = html;

  const submitBtn   = document.getElementById('winter-submit');
  const continueBtn = document.getElementById('winter-continue');
  document.getElementById('winter-error').classList.add('hidden');

  if (submitted) {
    submitBtn.classList.add('hidden');
    continueBtn.textContent = '↻ Check for Update';
    continueBtn.classList.remove('hidden');
    continueBtn.onclick = fetchState;
  } else {
    submitBtn.textContent = 'Submit Recruitment';
    submitBtn.classList.remove('hidden');
    submitBtn.onclick = submitRecruitment;
    continueBtn.classList.add('hidden');

    // Live cost updates
    const updateRecruitCost = () => {
      let cost = 0;
      document.querySelectorAll('.recruit-reinforce:checked').forEach(() => cost += 1);
      document.querySelectorAll('.recruit-siege-equip:checked').forEach(() => cost += 1);
      if (document.getElementById('recruit-raise-cb')?.checked) cost += 3;
      const reinforceRadio = document.querySelector('.recruit-reinforcement:checked');
      if (reinforceRadio?.dataset.rtype === 'mercenary') cost += mercCost;
      const el = document.getElementById('recruit-cost-val');
      if (el) el.textContent = cost;
    };
    document.querySelectorAll('.recruit-reinforce, .recruit-siege-equip').forEach(cb => {
      cb.addEventListener('change', updateRecruitCost);
    });
    document.querySelectorAll('.recruit-reinforcement').forEach(cb => cb.addEventListener('change', updateRecruitCost));
    document.getElementById('recruit-raise-cb')?.addEventListener('change', updateRecruitCost);
  }

  document.getElementById('winter-modal').classList.remove('hidden');
}

async function submitRecruitment() {
  const orders  = [];
  document.querySelectorAll('.recruit-reinforce:checked').forEach(cb =>
    orders.push({ type: 'reinforce', army_id: cb.dataset.army })
  );
  document.querySelectorAll('.recruit-siege-equip:checked').forEach(cb =>
    orders.push({ type: 'buy_siege_equipment', army_id: cb.dataset.army })
  );
  const reinforceRadio = document.querySelector('.recruit-reinforcement:checked');
  if (reinforceRadio) orders.push({ type: reinforceRadio.dataset.rtype, army_id: reinforceRadio.dataset.army });
  if (document.getElementById('recruit-raise-cb')?.checked) {
    orders.push({ type: 'raise_army' });
  }

  const errEl = document.getElementById('winter-error');
  errEl.classList.add('hidden');

  try {
    const res = await fetch('/winter/recruit', {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify({ orders }),
    });
    if (!res.ok) {
      const d = await res.json();
      errEl.textContent = (d.errors?.join('\n') || d.error) || 'Could not submit recruitment.';
      errEl.classList.remove('hidden');
      return;
    }
    await fetchState();
  } catch (e) {
    errEl.textContent = 'Server unreachable.';
    errEl.classList.remove('hidden');
  }
}

function showNewYearSummary(oldYear, state) {
  const modal = document.getElementById('resolution-modal');
  const title = document.getElementById('resolution-title');
  const body  = document.getElementById('resolution-body');

  const oldBC = 218 - (oldYear - 1);
  const newBC = 218 - (state.campaign.current_year - 1);
  title.textContent = `${oldBC} BC → ${newBC} BC — New Campaign Year`;

  // VP snapshots logged during winter (year = oldYear)
  const vpLogs = (state.log || []).filter(e => e.type === 'vp_snapshot' && e.year === oldYear);

  let html = '';

  // Naval control
  html += '<div class="res-section-title">Naval Supremacy</div>';
  const navalHolder = state.sides.rome.naval_control     ? 'Rome'
                    : state.sides.carthage.naval_control ? 'Carthage'
                    : 'Contested (neither side)';
  html += `<div class="res-item">${navalHolder}</div>`;

  // VP earned this season
  if (vpLogs.length) {
    html += '<div class="res-section-title">Victory Points — End of Year</div>';
    vpLogs.forEach(e => {
      const side = capitalize(e.side);
      const bk = e.breakdown;
      const breakdownText = bk
        ? ` <span style="color:var(--text-dim);font-size:12px">(regions +${bk.regions}, cities +${bk.cities})</span>`
        : '';
      html += `<div class="res-item">
        <span class="side-${e.side}">${side}</span>: +${e.vp_this_season} VP this year${breakdownText}
        &nbsp;<span style="color:var(--text-dim)">(running total: <strong>${e.vp_total}</strong>)</span>
      </div>`;
    });
  }

  // Armies raised this winter
  const raisedLogs = (state.log || []).filter(e => e.type === 'army_raised' && e.year === oldYear);
  if (raisedLogs.length) {
    html += '<div class="res-section-title" style="color:#2ecc71">New Armies Raised</div>';
    raisedLogs.forEach(e => {
      html += `<div class="res-item" style="color:#2ecc71">${capitalize(e.side)}: ${e.army_name} mustered at home base — Good / Levy</div>`;
    });
  }

  // Army readiness for own side
  const myArmies = state.armies.filter(a => a.side === mySide && !a.is_intelligence);
  html += '<div class="res-section-title">Your Army Readiness</div>';
  myArmies.forEach(army => {
    html += `<div class="res-item">${army.name}: <span class="cond-${army.condition}">${capitalize(army.condition)}</span></div>`;
  });

  // Season summary
  const pool = state.sides[mySide].initiative_pool;
  const res  = state.sides[mySide].resources;
  html += '<div class="res-section-title">New Season</div>';
  html += `<div class="res-item">Year ${newBC} BC — Turn 1. Initiative reset to ${pool}. Resources: ${res} (surplus banked, max 1 carried).</div>`;

  body.innerHTML = html;
  modal.classList.remove('hidden');
}

// ─── Map Rendering ────────────────────────────────────────────────────────────

function renderMap() {
  gameState.regions.forEach(region => {
    const el = document.getElementById(`region-${region.region_id}`);
    if (!el) return;
    el.dataset.controller = region.controller;
    el.setAttribute('class', `region controller-${region.controller}${region.defected ? ' defected' : ''}${region.destabilized ? ' destabilized' : ''}`);
  });

  // Sea lane visibility — dim lanes if the viewing player doesn't hold naval control
  const seaRoutesGroup = document.getElementById('sea-routes');
  if (seaRoutesGroup) {
    const hasNaval = gameState.sides[mySide]?.naval_control;
    if (hasNaval) {
      seaRoutesGroup.setAttribute('stroke', '#7ABBDA');
      seaRoutesGroup.setAttribute('opacity', '0.9');
      seaRoutesGroup.setAttribute('stroke-dasharray', '7,4');
    } else {
      seaRoutesGroup.setAttribute('stroke', '#a08060');
      seaRoutesGroup.setAttribute('opacity', '0.35');
      seaRoutesGroup.setAttribute('stroke-dasharray', '4,6');
    }
  }

  renderDepotMarkers();
  renderArmyMarkers();
  renderStrategicPointMarkers();
}

function renderDepotMarkers() {
  const g = document.getElementById('depot-markers');
  g.innerHTML = '';

  (gameState.depots || []).forEach(depot => {
    const centroid = REGION_CENTROIDS[depot.region_id];
    if (!centroid) return;
    const [cx, cy] = centroid;
    const col = SIDE_COLORS[depot.side];

    // Small square tent symbol, offset slightly up-left from centroid
    const size = 7;
    const x = cx - 20;
    const y = cy - 20;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x',            x - size);
    rect.setAttribute('y',            y - size);
    rect.setAttribute('width',        size * 2);
    rect.setAttribute('height',       size * 2);
    rect.setAttribute('fill',         col.fill);
    rect.setAttribute('fill-opacity', '0.8');
    rect.setAttribute('stroke',       '#fff');
    rect.setAttribute('stroke-width', '1.5');
    rect.setAttribute('rx',           '2');
    rect.style.cursor = 'pointer';

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x',           x);
    label.setAttribute('y',           y + 4);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill',        '#fff');
    label.setAttribute('font-size',   '8');
    label.setAttribute('font-weight', 'bold');
    label.setAttribute('font-family', 'monospace');
    label.textContent = 'D';

    rect.addEventListener('click', () => selectRegion(depot.region_id));
    label.addEventListener('click', () => selectRegion(depot.region_id));

    g.appendChild(rect);
    g.appendChild(label);
  });
}

function renderArmyMarkers() {
  const g = document.getElementById('army-markers');
  g.innerHTML = '';

  // Group all armies (friendly + intel) by display region
  const byRegion = {};
  gameState.armies.forEach(army => {
    const displayRegion = army.is_intelligence ? army.last_known_region : army.true_region;
    if (!displayRegion) return;
    if (!byRegion[displayRegion]) byRegion[displayRegion] = [];
    byRegion[displayRegion].push(army);
  });

  Object.entries(byRegion).forEach(([regionId, armies]) => {
    const centroid = REGION_CENTROIDS[regionId];
    if (!centroid) return;
    const [cx, cy] = centroid;

    const region = gameState.regions.find(r => r.region_id === regionId);
    const hasSP  = region && region.strategic_points.length > 0;
    const baseX  = hasSP ? cx + 16 : cx;

    armies.forEach((army, i) => {
      const col     = SIDE_COLORS[army.side];
      const offsetX = armies.length > 1 ? (i === 0 ? -13 : 13) : 0;
      const x = baseX + offsetX;
      const y = cy;
      const isIntel = army.is_intelligence;
      // Fresh intel = updated this turn; stale = older. Fresh uses side colour, stale uses gray.
      const intelFresh = isIntel && army.last_known_turn === gameState.campaign.current_season_turn;

      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      marker.setAttribute('class', 'army-marker');
      marker.setAttribute('data-army', army.army_id);
      marker.style.cursor = 'pointer';

      // Circle body
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', x);
      circle.setAttribute('cy', y);
      circle.setAttribute('r',  13);

      if (isIntel) {
        // Intel token: hollow ghost circle — dashed outline only, so the colour is clearly visible.
        // Fresh (spotted this turn) = side colour; stale = gray.
        circle.setAttribute('fill',          intelFresh ? col.fill : '#333');
        circle.setAttribute('fill-opacity',  '0.15');
        circle.setAttribute('stroke',        intelFresh ? col.fill : '#777');
        circle.setAttribute('stroke-width',  '2.5');
        circle.setAttribute('stroke-dasharray', '5,3');
      } else {
        circle.setAttribute('fill',         col.fill);
        circle.setAttribute('stroke',       col.stroke);
        circle.setAttribute('stroke-width', '2');
      }

      // Label — for intel tokens use the stroke colour so it's legible over the hollow fill
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', x);
      label.setAttribute('y', y + 4);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill',        isIntel ? (intelFresh ? col.fill : '#777') : col.text);
      label.setAttribute('font-size',   9);
      label.setAttribute('font-weight', 'bold');
      label.setAttribute('font-family', 'monospace');
      label.textContent = ARMY_CODES[army.army_id] || army.army_id.slice(0,3).toUpperCase();

      marker.appendChild(circle);
      marker.appendChild(label);

      // Condition pip — friendly only
      if (!isIntel) {
        const pip = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        pip.setAttribute('cx', x + 10);
        pip.setAttribute('cy', y - 10);
        pip.setAttribute('r',  3.5);
        pip.setAttribute('fill',         COND_COLORS[army.condition] || '#888');
        pip.setAttribute('stroke',       '#fff');
        pip.setAttribute('stroke-width', 0.8);
        marker.appendChild(pip);
      }

      // Movement order arrow — show pending move for own armies
      const order = pendingOrders[army.army_id];
      if (!isIntel && order?.type === 'move') {
        const dest = REGION_CENTROIDS[order.to_region];
        if (dest) {
          const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          arrow.setAttribute('x1', x);
          arrow.setAttribute('y1', y);
          arrow.setAttribute('x2', dest[0]);
          arrow.setAttribute('y2', dest[1]);
          arrow.setAttribute('stroke',           col.fill);
          arrow.setAttribute('stroke-width',     1.5);
          arrow.setAttribute('stroke-dasharray', '4,3');
          arrow.setAttribute('marker-end',       'url(#arrowhead)');
          arrow.setAttribute('opacity',          '0.75');
          arrow.style.pointerEvents = 'none';
          g.appendChild(arrow);
        }
      }

      marker.addEventListener('click', () => {
        highlightArmyCard(army.army_id);
        const region = army.is_intelligence ? army.last_known_region : army.true_region;
        if (region) selectRegion(region);
      });

      g.appendChild(marker);
    });
  });
}

function renderStrategicPointMarkers() {
  const g = document.getElementById('sp-markers');
  g.innerHTML = '';

  gameState.regions.forEach(region => {
    region.strategic_points.forEach(sp => {
      const centroid = REGION_CENTROIDS[region.region_id];
      if (!centroid) return;
      const [cx, cy] = centroid;
      const size = 5 + sp.fortification_rating * 2;

      const diamond = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      diamond.setAttribute('points', [
        `${cx},${cy - size}`,
        `${cx + size},${cy}`,
        `${cx},${cy + size}`,
        `${cx - size},${cy}`,
      ].join(' '));
      diamond.setAttribute('fill',         sp.controller === 'rome' ? '#c0392b' : sp.controller === 'carthage' ? '#8e44ad' : '#95a5a6');
      diamond.setAttribute('stroke',       '#fff');
      diamond.setAttribute('stroke-width', 1);
      diamond.setAttribute('opacity',      '0.9');
      diamond.style.cursor = 'pointer';
      diamond.addEventListener('click', () => selectRegion(region.region_id));
      g.appendChild(diamond);
    });
  });
}

// ─── Region Selection & Detail Panel ─────────────────────────────────────────

function selectRegion(regionId) {
  selectedRegion = regionId;
  document.querySelectorAll('.region').forEach(el => el.classList.remove('selected'));
  const el = document.getElementById(`region-${regionId}`);
  if (el) el.classList.add('selected');
  renderDetailPanel(regionId);
}

function renderDetailPanel(regionId) {
  const region = gameState.regions.find(r => r.region_id === regionId);
  if (!region) return;

  document.getElementById('detail-name').textContent       = region.name;
  document.getElementById('detail-theater').textContent    = capitalize(region.theater);
  document.getElementById('detail-controller').textContent = capitalize(region.controller);
  document.getElementById('detail-loyalty').textContent    = region.loyalty_rating !== null ? `${region.loyalty_rating}/5` : 'N/A';
  document.getElementById('detail-defected').textContent   = region.defected ? 'Yes' : 'No';
  const destEl = document.getElementById('detail-destabilized');
  if (destEl) {
    destEl.textContent = region.destabilized ? 'Yes' : (region.loyalty_rating !== null ? 'No' : 'N/A');
    destEl.style.color = region.destabilized ? '#e67e22' : '';
    destEl.style.fontWeight = region.destabilized ? '600' : '';
  }

  const spList = document.getElementById('detail-sp-list');
  spList.innerHTML = '';
  if (region.strategic_points.length === 0) {
    spList.innerHTML = '<div class="detail-empty">None</div>';
  } else {
    region.strategic_points.forEach(sp => {
      const div = document.createElement('div');
      div.className = 'sp-item';
      const bpLabel  = sp.breach_points_accumulated > 0
        ? `<span class="sp-breach">${sp.breach_points_accumulated}/${sp.fortification_rating} breach</span>`
        : '';
      const siegeArmy = sp.besieging_army_id
        ? (gameState.armies.find(a => a.army_id === sp.besieging_army_id)?.name ?? sp.besieging_army_id)
        : null;
      const siegeLabel = sp.under_siege
        ? `<span class="sp-siege">SIEGE${siegeArmy ? ` — ${siegeArmy}` : ''}</span>`
        : '';
      div.innerHTML = `
        <span class="sp-name">${sp.name}</span>
        <span class="sp-fort">Fort ${sp.fortification_rating}</span>
        <span class="sp-ctrl side-${sp.controller}">${capitalize(sp.controller)}</span>
        ${bpLabel}${siegeLabel}`;
      spList.appendChild(div);
    });
  }

  const armiesList = document.getElementById('detail-armies-list');
  armiesList.innerHTML = '';
  const here = gameState.armies.filter(a =>
    (a.is_intelligence ? a.last_known_region : a.true_region) === regionId
  );
  if (here.length === 0) {
    armiesList.innerHTML = '<div class="detail-empty">None</div>';
  } else {
    here.forEach(army => {
      const div = document.createElement('div');
      div.className = `army-card-mini side-${army.side}${army.is_intelligence ? ' intel-mini' : ''}`;
      div.innerHTML = `
        <span class="army-name">${army.name}</span>
        ${army.is_intelligence
          ? '<span class="intel-tag">Intel</span>'
          : `<span class="cond-${army.condition}">${capitalize(army.condition)}</span>
             <span>${capitalize(army.experience)}</span>`}`;
      armiesList.appendChild(div);
    });
  }

  let adjRow = document.getElementById('detail-adj');
  if (!adjRow) {
    adjRow = document.createElement('div');
    adjRow.id        = 'detail-adj';
    adjRow.className = 'detail-row';
    document.getElementById('detail-body').insertBefore(adjRow, document.querySelector('#detail-body h4'));
  }
  adjRow.innerHTML = `<span class="label">Adjacent to</span><span>${
    (gameState.adjacency[regionId] || []).map(id => regionName(id)).join(', ') || 'None'
  }</span>`;

  document.getElementById('detail-panel').classList.remove('hidden');
}

// ─── Army Card Highlight ──────────────────────────────────────────────────────

function highlightArmyCard(armyId) {
  document.querySelectorAll('.army-card').forEach(el => el.classList.remove('highlighted'));
  const card = document.querySelector(`.army-card[data-army-id="${armyId}"]`);
  if (card) {
    card.classList.add('highlighted');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ─── SVG Tooltip ─────────────────────────────────────────────────────────────

function initTooltip() {
  const svg      = document.getElementById('campaign-map');
  const tooltip  = document.getElementById('tooltip');
  const ttBg     = document.getElementById('tt-bg');
  const ttName   = document.getElementById('tt-name');
  const ttTheater= document.getElementById('tt-theater');
  const ttCtrl   = document.getElementById('tt-controller');
  const ttLoyalty= document.getElementById('tt-loyalty');

  svg.addEventListener('mousemove', e => {
    if (!gameState) { tooltip.setAttribute('visibility', 'hidden'); return; }

    const pt  = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());
    const tx = svgPt.x + 10;
    const ty = svgPt.y - 90;

    function ttLine(el, text, fill, yOffset) {
      el.textContent = text;
      el.setAttribute('fill', fill);
      el.setAttribute('x', tx + 8);
      el.setAttribute('y', ty + yOffset);
    }

    // Army marker hover
    const armyEl = e.target.closest('.army-marker');
    if (armyEl) {
      const army = gameState.armies.find(a => a.army_id === armyEl.dataset.army);
      if (army) {
        if (army.is_intelligence) {
          ttLine(ttName,    army.name,                                    '#fff',  18);
          ttLine(ttTheater, `${capitalize(army.side)} — Intel report`,    '#aaa',  34);
          ttLine(ttCtrl,    `Last seen: ${regionName(army.last_known_region)}`, '#ccc', 50);
          ttLine(ttLoyalty, `Turn ${army.last_known_turn ?? '?'}`,         '#888',  66);
        } else {
          ttLine(ttName,    army.name,                                                            '#fff',  18);
          ttLine(ttTheater, `${capitalize(army.side)} — ${capitalize(army.composition_profile)}`, '#aaa',  34);
          ttLine(ttCtrl,    `${capitalize(army.experience)} | ${capitalize(army.condition)}`,     COND_COLORS[army.condition] || '#ccc', 50);
          ttLine(ttLoyalty, `${army.in_supply ? 'In Supply' : '⚠ Out of Supply'}  |  ${effectivePoints(army)} pts`,
                 army.in_supply ? '#2ecc71' : '#e74c3c', 66);
        }
        ttBg.setAttribute('x', tx); ttBg.setAttribute('y', ty);
        ttBg.setAttribute('width', 220); ttBg.setAttribute('height', 80);
        tooltip.setAttribute('visibility', 'visible');
        return;
      }
    }

    // Region hover
    const regionEl = e.target.closest('.region');
    if (!regionEl) { tooltip.setAttribute('visibility', 'hidden'); return; }
    const regionId = regionEl.dataset.region;
    const region   = gameState.regions.find(r => r.region_id === regionId);
    if (!region) return;

    ttLine(ttName,    region.name,                              '#fff', 18);
    ttLine(ttTheater, capitalize(region.theater) + ' theater',  '#aaa', 34);
    ttLine(ttCtrl,    'Controller: ' + capitalize(region.controller), '#fff', 50);
    const destText = region.destabilized ? 'DESTABILIZED' : '';
    const loyText = region.loyalty_rating !== null ? `Loyalty: ${region.loyalty_rating}/5${destText ? '  ⚡' : ''}` : '';
    ttLine(ttLoyalty, loyText || destText, destText ? '#e67e22' : '#ccc', 66);

    ttBg.setAttribute('x', tx); ttBg.setAttribute('y', ty);
    ttBg.setAttribute('width', 185); ttBg.setAttribute('height', (loyText || destText) ? 80 : 62);
    tooltip.setAttribute('visibility', 'visible');
  });

  svg.addEventListener('mouseleave', () => tooltip.setAttribute('visibility', 'hidden'));
}

// ─── Map Loading ──────────────────────────────────────────────────────────────

// ─── Notification modal (replaces browser alert) ─────────────────────────────
function showNotify(title, message) {
  document.getElementById('notify-title').textContent = title;
  document.getElementById('notify-body').textContent  = message;
  document.getElementById('notify-modal').classList.remove('hidden');
}

// ─── Confirm modal (replaces browser confirm) ────────────────────────────────
function showConfirm(title, message, onConfirm) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-body').textContent  = message;
  document.getElementById('confirm-modal').classList.remove('hidden');
  document.getElementById('confirm-ok').onclick = () => {
    document.getElementById('confirm-modal').classList.add('hidden');
    onConfirm();
  };
  document.getElementById('confirm-cancel').onclick = () => {
    document.getElementById('confirm-modal').classList.add('hidden');
  };
}

// ─── Game Over modal ──────────────────────────────────────────────────────────
function showGameOver() {
  const winner   = gameState.campaign.winner;
  const log      = gameState.log || [];
  const gameOverEvent = log.find(e => e.type === 'game_over');
  const reason   = gameOverEvent?.reason;

  // Compute VP breakdown for each side from log
  function vpBreakdown(side) {
    const snapshots  = log.filter(e => e.type === 'vp_snapshot' && e.side === side);
    const regions    = snapshots.reduce((s, e) => s + (e.breakdown?.regions || 0), 0);
    const cities     = snapshots.reduce((s, e) => s + (e.breakdown?.cities  || 0), 0);
    const battles    = log.filter(e => e.type === 'vp_earned' && e.side === side && e.reason === 'battle_victory')
                         .reduce((s, e) => s + (e.amount || 0), 0);
    const destroyed  = log.filter(e => e.type === 'vp_earned' && e.side === side && e.reason === 'army_destroyed')
                         .reduce((s, e) => s + (e.amount || 0), 0);
    const total      = gameState.sides[side].vp_total;
    return { regions, cities, battles, destroyed, total };
  }

  const rVP = vpBreakdown('rome');
  const cVP = vpBreakdown('carthage');

  const winnerLabel = winner === 'rome' ? 'ROME VICTORIOUS' : 'CARTHAGE VICTORIOUS';
  const winnerColor = winner === 'rome' ? '#e74c3c' : '#9b59b6';
  const reasonLabel = reason === 'capital_captured'
    ? `Capital seized — ${gameOverEvent.sp_name} has fallen`
    : `Campaign concluded — Year 5 final tallies`;

  function sideCol(side, vp) {
    const isWinner = side === winner;
    const tag = isWinner ? '<span class="gameover-winner-tag">★ Winner</span>' : '';
    return `<th style="color:${side === 'rome' ? '#e74c3c' : '#9b59b6'}">${side === 'rome' ? 'Rome' : 'Carthage'}${tag}</th>`;
  }

  document.getElementById('gameover-title').innerHTML =
    `<span style="color:${winnerColor}">${winnerLabel}</span>`;
  document.getElementById('gameover-subtitle').textContent = reasonLabel;
  document.getElementById('gameover-body').innerHTML = `
    <table class="gameover-vp-table">
      <thead><tr>
        <th>Victory Point Source</th>
        ${sideCol('rome',     rVP)}
        ${sideCol('carthage', cVP)}
      </tr></thead>
      <tbody>
        <tr><td>Regions controlled (seasonal)</td><td class="num">${rVP.regions}</td><td class="num">${cVP.regions}</td></tr>
        <tr><td>Major cities controlled (seasonal)</td><td class="num">${rVP.cities}</td><td class="num">${cVP.cities}</td></tr>
        <tr><td>Battle victories</td><td class="num">${rVP.battles}</td><td class="num">${cVP.battles}</td></tr>
        <tr><td>Armies destroyed</td><td class="num">${rVP.destroyed}</td><td class="num">${cVP.destroyed}</td></tr>
        <tr class="total-row"><td>Total</td><td class="num">${rVP.total}</td><td class="num">${cVP.total}</td></tr>
      </tbody>
    </table>`;

  document.getElementById('gameover-modal').classList.remove('hidden');
}

async function loadMap() {
  const res     = await fetch('/campaign-map.svg');
  const svgText = await res.text();
  document.getElementById('svg-host').innerHTML = svgText;

  const svg = document.getElementById('campaign-map');

  // Arrowhead marker for movement order display
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#fff" opacity="0.7"/>
    </marker>`;
  svg.insertBefore(defs, svg.firstChild);

  ['depot-markers', 'army-markers', 'sp-markers'].forEach(id => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('id', id);
    svg.appendChild(g);
  });

  const ttg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  ttg.setAttribute('id', 'tooltip');
  ttg.setAttribute('visibility', 'hidden');
  ttg.innerHTML = `
    <rect id="tt-bg" rx="4" ry="4" fill="#1a1a2e" stroke="#888" stroke-width="1"/>
    <text id="tt-name"       fill="#fff" font-size="15" font-weight="bold"></text>
    <text id="tt-theater"    fill="#aaa" font-size="13"></text>
    <text id="tt-controller" fill="#fff" font-size="13"></text>
    <text id="tt-loyalty"    fill="#ccc" font-size="13"></text>`;
  svg.appendChild(ttg);

  // Populate REGION_CENTROIDS from the SVG's hidden centroid layer
  document.querySelectorAll('[id^="centroid-"]').forEach(circle => {
    const regionId = circle.id.replace('centroid-', '');
    REGION_CENTROIDS[regionId] = [
      parseFloat(circle.getAttribute('cx')),
      parseFloat(circle.getAttribute('cy')),
    ];
  });

  // Region click
  document.querySelectorAll('.region').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.region) selectRegion(el.dataset.region);
    });
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function regionName(regionId) {
  if (!gameState || !regionId) return regionId || '?';
  const r = gameState.regions.find(r => r.region_id === regionId);
  return r ? r.name : regionId;
}

function capitalize(str) {
  if (!str) return '—';
  return str.charAt(0).toUpperCase() + str.slice(1).replace(/_/g, ' ');
}

function effectivePoints(army) {
  let pts = army.points_budget;
  if (army.allied_contingent_attached)    pts += 100;
  if (army.mercenary_contingent_attached) pts += 100;
  const condSteps = ['good', 'worn', 'depleted', 'broken'];
  const condMult  = { good: 1.0, worn: 0.95, depleted: 0.90, broken: 0.80 };
  let condIdx = condSteps.indexOf(army.condition);
  if (army.emergency_reinforcement && condIdx > 0) condIdx -= 1; // step up one level
  pts = Math.round(pts * condMult[condSteps[condIdx]]);
  return pts;
}

// ─── Event Bindings ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadMap();

  // Detail panel close
  document.getElementById('detail-close').addEventListener('click', () => {
    document.getElementById('detail-panel').classList.add('hidden');
    document.querySelectorAll('.region').forEach(el => el.classList.remove('selected'));
    selectedRegion = null;
  });

  // Notification modal close
  document.getElementById('notify-close').addEventListener('click', () => {
    document.getElementById('notify-modal').classList.add('hidden');
  });

  // Game over modal close
  document.getElementById('gameover-close').addEventListener('click', () => {
    document.getElementById('gameover-modal').classList.add('hidden');
  });

  // Waiting modal refresh
  document.getElementById('waiting-refresh').addEventListener('click', fetchState);

  // Resolution modal close — mark turn as seen, then open battle modal if pending
  document.getElementById('resolution-close').addEventListener('click', () => {
    document.getElementById('resolution-modal').classList.add('hidden');
    // Mark this turn as seen only when the player actually dismisses the modal
    if (gameState) setTurnSeen(gameState.campaign.current_season_turn);
    if ((gameState?.pending_battles?.length ?? 0) > 0) {
      openNextBattle();
    }
  });

  // New game button
  document.getElementById('btn-new-game').addEventListener('click', () => {
    showConfirm(
      'New Campaign',
      'Start a new 218 BC campaign?\nThis will reset all sessions, orders, and game state.',
      async () => {
        clearToken();
        clearYearSeen();
        clearTurnSeen();
        clearGameNotifications();
        mySide        = null;
        pendingOrders = {};
        ordersLocked  = false;
        await fetch('/game/new', { method: 'POST' });
        await initJoinScreen();
        showJoinScreen();
      }
    );
  });

  // Force/Refuse submit and refresh
  document.getElementById('fr-submit').addEventListener('click', submitForceRefuse);
  document.getElementById('fr-refresh').addEventListener('click', fetchState);

  // Battle result submit
  document.getElementById('battle-submit').addEventListener('click', submitBattleResult);

  // Battle dismiss (opponent already resolved it)
  document.getElementById('battle-dismiss').addEventListener('click', async () => {
    document.getElementById('battle-modal').classList.add('hidden');
    currentBattleRegion = null;
    await fetchState();
  });

  // Refresh button
  document.getElementById('btn-refresh').addEventListener('click', fetchState);

  // Join screen setup
  try { await initJoinScreen(); } catch (e) { console.error('initJoinScreen error:', e); }

  initTooltip();

  // If we already have a token, go straight to the map
  if (getToken()) {
    await fetchState();
  } else {
    showJoinScreen();
  }
});
