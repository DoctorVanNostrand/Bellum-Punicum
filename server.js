const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = 3000;

const STATE_FILE        = path.join(__dirname, 'game-state.json');
const INITIAL_STATE_FILE = path.join(__dirname, 'data', 'initial-state.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

// Initiative cost table — shared by validation and resolution
const INITIATIVE_COSTS = { hold: 0, move: 0, scout: 1, deep_scout: 2, establish_depot: 1, siege: 1, feint: 1 };

// Home bases — permanent supply sources, always active
const HOME_BASES = { rome: 'latium', carthage: 'africa_proper' };

// Island regions — only reachable via sea lanes; armies stranded here at winter are evacuated
const ISLAND_REGIONS = new Set(['sicily', 'sardinia']);

// Capital regions — cannot be politically controlled by the opposing side.
// Opposing army presence counts for supply/movement only; no VP accrues to them here.
// Political flip only occurs on sudden death (capturing the rating-3 capital SP).
const CAPITAL_REGIONS = new Set(['latium', 'africa_proper']);

// Sea route pairs — movement across these requires the moving side to hold naval control.
// Stored as "from:to" strings (both directions for O(1) lookup).
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

// Italian allied regions subject to the loyalty/defection system.
// defection_threshold: roll 1d6 ≤ (threshold + modifiers) → defect.
const LOYALTY_REGIONS = {
  etruria:           { defection_threshold: 1 },
  umbria_picenum:    { defection_threshold: 1 },
  campania:          { defection_threshold: 3 },
  samnium_lucania:   { defection_threshold: 4 },
  bruttium_calabria: { defection_threshold: 4 },
  cisalpine_gaul:    { defection_threshold: 3 },
};

// Recalculate in_supply for every army.
// An army is in supply if any supply source (home base or friendly depot) is within 2 region hops.
// Pure distance — no controller checks, no sea-link gating.
function calculateSupply(state) {
  const sources = {
    rome:     new Set([HOME_BASES.rome]),
    carthage: new Set([HOME_BASES.carthage]),
  };
  (state.depots || []).forEach(d => sources[d.side].add(d.region_id));

  state.armies.forEach(army => {
    const mySources = sources[army.side];

    // BFS from army's position — search up to 2 hops for any supply source
    const dist  = new Map([[army.true_region, 0]]);
    const queue = [army.true_region];
    let   inSupply = false;

    bfsLoop: while (queue.length > 0) {
      const current = queue.shift();
      const d       = dist.get(current);

      if (mySources.has(current)) { inSupply = true; break bfsLoop; }
      if (d >= 2) continue; // no need to search further than range-2

      for (const next of (state.adjacency[current] || [])) {
        if (!dist.has(next)) {
          dist.set(next, d + 1);
          queue.push(next);
        }
      }
    }

    army.in_supply = inSupply;
  });
}

// Drop army condition one step toward broken (good→worn→depleted→broken)
function dropCondition(condition) {
  const order = ['good', 'worn', 'depleted', 'broken'];
  const idx   = order.indexOf(condition);
  return idx < order.length - 1 ? order[idx + 1] : 'broken';
}

// Advance army experience one step toward elite (levy→trained→seasoned→veteran→elite)
const EXPERIENCE_STEPS = ['levy', 'seasoned', 'veteran', 'elite'];
function stepUpExperience(exp) {
  const idx = EXPERIENCE_STEPS.indexOf(exp);
  if (idx < 0) return exp;                          // unknown value — leave unchanged
  return idx < EXPERIENCE_STEPS.length - 1 ? EXPERIENCE_STEPS[idx + 1] : 'elite';
}

// Returns how many condition steps 'pts' attrition points should cause
function attritionDrops(pts) {
  if (pts >= 3) return 2;
  if (pts >= 2) return 1;
  return 0;
}

// Apply per-turn attrition based on supply status and territory controller.
// Points: in-supply+enemy=1, out-of-supply+friendly=1, out-of-supply+enemy=2.
// 1 pt alone causes no drop (needs battle +1 to reach threshold).
// 2 pts → drop 1 step; 3+ pts → drop 2 steps.
// Stores attrition_pts_this_turn on each army so battle resolve can add battle pts on top.
// Called after calculateSupply; stamps log with the turn the orders were issued (current_season_turn - 1).
function calculateAttrition(state) {
  const opponent = { rome: 'carthage', carthage: 'rome' };
  state.armies.forEach(army => {
    army.attrition_pts_this_turn = 0; // always initialise
    if (army.condition === 'broken') return;
    const region  = state.regions.find(r => r.region_id === army.true_region);
    const inEnemy = region?.controller === opponent[army.side];

    let points = 0;
    if ( army.in_supply && inEnemy)  points = 1;
    if (!army.in_supply && !inEnemy) points = 1;
    if (!army.in_supply && inEnemy)  points = 2;
    // in_supply && friendly/neutral = 0

    army.attrition_pts_this_turn = points;
    if (points === 0) return;

    const condBefore = army.condition;
    const drops = attritionDrops(points);
    for (let i = 0; i < drops; i++) army.condition = dropCondition(army.condition);
    // 1 pt: logged but no drop yet

    state.log.push({
      turn:             state.campaign.current_season_turn - 1,
      year:             state.campaign.current_year,
      type:             'attrition',
      side:             army.side,
      army_id:          army.army_id,
      points,
      condition_before: condBefore,
      condition_after:  army.condition,
      in_supply:        army.in_supply,
      region_controller: region?.controller,
      visible_to:       'both',
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ── In-memory state store ─────────────────────────────────────────
// Primary state lives in memory so the server works even on read-only
// filesystems (common on cloud hosting). File I/O is best-effort persistence.
let _memState = null;

function loadState() {
  if (_memState) return _memState;
  // Cold start — try to load from disk
  try {
    if (fs.existsSync(STATE_FILE)) {
      _memState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return _memState;
    }
  } catch (e) {
    console.error('loadState: could not read file, using memory only:', e.message);
  }
  return null;
}

function saveState(state) {
  _memState = state;
  // Best-effort file persistence — failures are logged but do not crash the server
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('saveState: could not write file (read-only fs?), state kept in memory:', e.message);
  }
}

function requireState(res) {
  const state = loadState();
  if (!state) {
    res.status(404).json({ error: 'No active campaign. POST /game/new to start.' });
    return null;
  }
  return state;
}

// Resolve which side the request belongs to (returns 'rome', 'carthage', or null)
function playerFromToken(state, req) {
  const token = req.headers['x-player-token'];
  if (!token || !state.sessions) return null;
  if (state.sessions.rome     === token) return 'rome';
  if (state.sessions.carthage === token) return 'carthage';
  return null;
}

// ─── State filtering (fog of war) ────────────────────────────────────────────

function filterStateForPlayer(state, player) {
  const out = JSON.parse(JSON.stringify(state)); // deep copy

  // Replace enemy army true positions with intelligence picture
  const currentTurn = state.campaign.current_season_turn;
  out.armies = state.armies.map(army => {
    if (army.side === player) return { ...army };

    const intel = (state.intelligence[player]?.enemy_armies || [])
      .find(e => e.army_id === army.army_id);

    // Use feint_region as the apparent position only if:
    // (a) the feint is still active, AND
    // (b) the observing player has at least one army adjacent to the feinted region
    // (consistent with normal visibility — you must be nearby to see it)
    const feintActive = army.feint_region && army.feint_expires_turn > currentTurn;
    const feintVisible = feintActive && state.armies.some(a =>
      a.side === player &&
      (state.adjacency[a.true_region] || []).includes(army.feint_region)
    );
    const apparentRegion = feintVisible ? army.feint_region : (intel?.last_known_region ?? null);

    return {
      army_id:          army.army_id,
      side:             army.side,
      name:             army.name,
      is_intelligence:  true,
      true_region:      null,
      last_known_region: apparentRegion,
      last_known_turn:   feintVisible ? currentTurn : (intel?.last_known_turn ?? null),
      condition:        intel?.condition_known ? intel.known_condition : 'unknown',
      // feint_region and feint_expires_turn are intentionally stripped (not included)
    };
  });

  // Expose player context and order state; strip session tokens
  const opponent = player === 'rome' ? 'carthage' : 'rome';
  out.my_side          = player;
  out.orders_submitted = state.orders_submitted;
  out.my_orders        = state.orders?.[player] ?? null;
  out.pending_battles  = state.pending_battles ?? [];
  out.shared_occupations = state.shared_occupations ?? [];

  // Filter pending_encounters: strip phantom metadata from the deceived player's view
  // (they should see it as a real encounter); remove phantom encounters entirely from
  // the feinting player's view (they have nothing to decide), but flag it for the UI.
  out.phantom_encounter_pending = false;
  out.pending_encounters = (state.pending_encounters ?? []).reduce((acc, enc) => {
    if (!enc.is_phantom) { acc.push(enc); return acc; }
    if (enc.feinting_side === player) {
      // Feinting player: hide the encounter, just signal that their feint is active
      out.phantom_encounter_pending = true;
      return acc;
    }
    // Deceived player: show as a real encounter — strip phantom markers, add
    // a placeholder for the feinting side so the enemy army appears in the UI.
    const { is_phantom, feinting_army_id, feinting_side, ...visibleEnc } = enc;
    visibleEnc[feinting_side] = { army_ids: [feinting_army_id], entered_from: null };
    acc.push(visibleEnc);
    return acc;
  }, []);
  // Own declarations visible; opponent's sealed until both have declared
  out.my_force_refuse     = state.force_refuse_declarations?.[player] ?? null;
  out.opponent_force_refuse_declared = !!(
    state.force_refuse_declarations?.[opponent] !== null &&
    state.force_refuse_declarations?.[opponent] !== undefined
  );
  delete out.sessions;
  delete out.orders;
  delete out.force_refuse_declarations;

  // Filter log: private entries (e.g. scout results) only visible to their side
  out.log = (state.log || []).filter(e =>
    !e.visible_to || e.visible_to === 'both' || e.visible_to === player
  );

  // Filter depots: own depots always visible; enemy depots only if discovered
  const discoveredIds = new Set((state.intelligence[player]?.enemy_depots || []).map(d => d.depot_id));
  out.depots = (state.depots || []).filter(d => d.side === player || discoveredIds.has(d.depot_id));

  // Expose winter data — seal opponent's unsubmitted bid/orders
  if (state.winter) {
    const opponent = player === 'rome' ? 'carthage' : 'rome';
    const w = JSON.parse(JSON.stringify(state.winter));
    if (!w.naval_bids_submitted[opponent])  w.naval_bids[opponent]          = null;
    if (!w.recruit_submitted[opponent])     w.recruit_orders[opponent]      = null;
    out.winter = w;
  }

  return out;
}

// ─── Turn resolution ─────────────────────────────────────────────────────────

function updateIntelligence(state) {
  ['rome', 'carthage'].forEach(side => {
    const myArmies = state.armies.filter(a => a.side === side);
    const visible  = new Set();

    // 1. Regions your armies occupy and their immediate neighbours
    myArmies.forEach(a => {
      visible.add(a.true_region);
      (state.adjacency[a.true_region] || []).forEach(r => visible.add(r));
    });

    // 2. Regions you control — you have local knowledge of your own territory
    state.regions.forEach(r => {
      if (r.controller === side) visible.add(r.region_id);
    });

    state.intelligence[side].enemy_armies.forEach(intel => {
      const enemy = state.armies.find(a => a.army_id === intel.army_id);
      if (!enemy) return;
      if (visible.has(enemy.true_region)) {
        intel.last_known_region = enemy.true_region;
        intel.last_known_turn   = state.campaign.current_season_turn;
      }
    });

    // Discover enemy depots in visible regions (permanent once known)
    if (!state.intelligence[side].enemy_depots) state.intelligence[side].enemy_depots = [];
    (state.depots || []).filter(d => d.side !== side).forEach(depot => {
      const alreadyKnown = state.intelligence[side].enemy_depots.find(d => d.depot_id === depot.depot_id);
      if (!alreadyKnown && visible.has(depot.region_id)) {
        state.intelligence[side].enemy_depots.push({
          depot_id:        depot.depot_id,
          region_id:       depot.region_id,
          discovered_turn: state.campaign.current_season_turn,
        });
      }
    });
  });
}

// Resolve scout / deep_scout orders — called after turn increment so stamps match new turn number
function processScouting(state) {
  ['rome', 'carthage'].forEach(side => {
    (state.orders[side] || [])
      .filter(o => o.type === 'scout' || o.type === 'deep_scout')
      .forEach(order => {
        const isDeep  = order.type === 'deep_scout';
        const roll    = isDeep ? null : Math.floor(Math.random() * 6) + 1;
        const success = isDeep || roll >= 4;

        let revealed_region    = null;
        let revealed_condition = null;
        let deceived_by_feint  = false;
        if (success) {
          const intel      = (state.intelligence[side]?.enemy_armies || [])
                               .find(e => e.army_id === order.target_army);
          const targetArmy = state.armies.find(a => a.army_id === order.target_army);
          if (intel && targetArmy) {
            const feintActive = targetArmy.feint_region && targetArmy.feint_expires_turn > state.campaign.current_season_turn;

            if (!isDeep && feintActive) {
              // Regular scout is fooled — returns the feinted position, not the true position
              deceived_by_feint           = true;
              intel.last_known_region     = targetArmy.feint_region;
              intel.last_known_turn       = state.campaign.current_season_turn;
              revealed_region             = targetArmy.feint_region;
              // Condition remains unknown (can't assess what isn't really there)
            } else {
              // Deep scout always pierces feint; regular scout succeeds when no feint active
              intel.last_known_region = targetArmy.true_region;
              intel.last_known_turn   = state.campaign.current_season_turn;
              revealed_region         = targetArmy.true_region;
              intel.condition_known   = true;
              intel.known_condition   = targetArmy.condition;
              revealed_condition      = targetArmy.condition;
              // Deep scout clears the feint entirely — true position now known
              if (feintActive) {
                targetArmy.feint_region      = null;
                targetArmy.feint_expires_turn = null;
              }
            }

            // Also reveal any enemy depot co-located with the scouted army
            // Only when not deceived — a fooled scout can't reveal depots at the true position
            if (!state.intelligence[side].enemy_depots) state.intelligence[side].enemy_depots = [];
            const depotThere = deceived_by_feint ? null
              : (state.depots || []).find(d => d.side !== side && d.region_id === targetArmy.true_region);
            if (depotThere && !state.intelligence[side].enemy_depots.find(d => d.depot_id === depotThere.depot_id)) {
              state.intelligence[side].enemy_depots.push({
                depot_id:        depotThere.depot_id,
                region_id:       depotThere.region_id,
                discovered_turn: state.campaign.current_season_turn,
              });
            }
          }
        }

        state.log.push({
          turn:               state.campaign.current_season_turn - 1, // log on the turn it was ordered, not the new turn
          year:               state.campaign.current_year,
          type:               order.type,
          side,
          army_id:            order.army_id,
          target_army:        order.target_army,
          roll,
          success,
          revealed_region,
          revealed_condition,
          deceived_by_feint,
          visible_to:         side,   // scout results are private to the scouting side
        });
      });
  });
}

// Returns the best retreat region for an army that must leave `currentRegion`.
// Prefers entered_from; falls back to any adjacent friendly/neutral region not held by enemy.
// Returns null if encircled (no safe retreat).
function findRetreatRegion(state, army, enteredFrom, opponentSide) {
  const enemyRegions = new Set(state.armies.filter(a => a.side === opponentSide).map(a => a.true_region));
  const isSafe = rid => {
    const r = state.regions.find(x => x.region_id === rid);
    return r && r.controller !== opponentSide && !enemyRegions.has(rid);
  };
  if (enteredFrom && isSafe(enteredFrom)) return enteredFrom;
  return (state.adjacency[army.true_region] || []).find(isSafe) ?? null;
}

// Detects encounters after movement: both movement-triggered and persistent shared occupations.
// Returns array of encounter objects.
function detectEncounters(state, enteredFrom) {
  if (!state.shared_occupations) state.shared_occupations = [];

  // Prune shared_occupations where either army has moved away
  state.shared_occupations = state.shared_occupations.filter(so => {
    const ra = state.armies.find(a => a.army_id === so.rome.army_id);
    const ca = state.armies.find(a => a.army_id === so.carthage.army_id);
    return ra?.true_region === so.region && ca?.true_region === so.region;
  });

  const byRegion = {};
  state.armies.forEach(a => {
    if (!byRegion[a.true_region]) byRegion[a.true_region] = [];
    byRegion[a.true_region].push(a);
  });

  const encounters = [];
  Object.entries(byRegion).forEach(([region, armies]) => {
    const sides = [...new Set(armies.map(a => a.side))];
    if (sides.length < 2) return;

    const existingSO = state.shared_occupations.find(so => so.region === region);
    const consecutiveRefusals = existingSO ? existingSO.consecutive_refusals : 0;

    const enc = {
      encounter_id:        `enc_${Date.now()}_${region}`,
      region,
      consecutive_refusals: consecutiveRefusals,
    };

    ['rome', 'carthage'].forEach(side => {
      const sideArmies = armies.filter(a => a.side === side);
      const primary    = sideArmies[0];
      // entered_from: from this turn's move, or carry over from existing shared_occupation
      const ef = enteredFrom[primary.army_id]
              ?? (existingSO ? existingSO[side]?.entered_from : null)
              ?? null;
      enc[side] = { army_ids: sideArmies.map(a => a.army_id), entered_from: ef };
    });

    encounters.push(enc);
  });

  return encounters;
}

// Transfer control of uncontested non-Italian regions to the occupying side.
// Called at the start of finalizeTurn so supply calculation uses updated controllers.
// Italian regions (theater === 'italia') use the loyalty/defection system instead.
function applyMilitaryOccupation(state) {
  const byRegion = {};
  state.armies.forEach(army => {
    if (!byRegion[army.true_region]) byRegion[army.true_region] = new Set();
    byRegion[army.true_region].add(army.side);
  });

  state.regions.forEach(region => {
    if (CAPITAL_REGIONS.has(region.region_id)) return; // Capital regions: never flip by occupation
    const sides = byRegion[region.region_id];
    if (!sides || sides.size === 0) return;   // no army here
    if (sides.size > 1) return;               // contested — force/refuse/battle handles this
    const [occupyingSide] = sides;
    if (region.controller === occupyingSide) return; // already friendly

    // Italian regions: loyalty/defection system governs for Rome — they cannot recapture
    // Italian territory through military occupation alone.
    // Exception: Carthage may occupy a neutral Italian region (it has no Roman loyalty bond).
    if (region.theater === 'italia') {
      if (!(occupyingSide === 'carthage' && region.controller === 'neutral')) return;
    }

    const opponent = occupyingSide === 'rome' ? 'carthage' : 'rome';
    const prevController = region.controller;
    region.controller = occupyingSide;
    // Unfortified SPs always flip; fortified SPs also flip if taken from neutral (no prior defender)
    region.strategic_points.forEach(sp => {
      if (sp.fortification_rating === 0 || prevController === 'neutral') sp.controller = occupyingSide;
    });
    state.log.push({
      turn:           state.campaign.current_season_turn,
      year:           state.campaign.current_year,
      type:           'occupation',
      region:         region.region_id,
      side:           occupyingSide,
      prev_controller: prevController,
      visible_to:     'both',
    });
  });
}

// Roll for defection in an Italian allied region after a Carthage battle victory.
// crushingVictory = loser army was destroyed OR ended the battle Broken.
// Returns the roll result object so the caller can include it in the HTTP response.
function checkDefection(state, regionId, crushingVictory) {
  const loyaltyDef = LOYALTY_REGIONS[regionId];
  if (!loyaltyDef) return;
  const region = state.regions.find(r => r.region_id === regionId);
  if (!region || region.defected || region.controller !== 'rome') return;

  const turn = state.campaign.current_season_turn;

  // Modifiers
  let modifiers = 0;
  if (crushingVictory) modifiers += 1;

  // +1 if Rome has no Good or Worn army in any Italian region
  const romeHasEffectiveArmyInItaly = state.armies.some(a =>
    a.side === 'rome' &&
    ['good', 'worn'].includes(a.condition) &&
    state.regions.find(r => r.region_id === a.true_region)?.theater === 'italia'
  );
  if (!romeHasEffectiveArmyInItaly) modifiers += 1;

  // +1 if a Carthage army has been present in this region for 2+ consecutive turns
  if ((region.carthage_turns_present ?? 0) >= 2) modifiers += 1;

  const roll = Math.ceil(Math.random() * 6);
  const effectiveThreshold = Math.min(6, loyaltyDef.defection_threshold + modifiers);
  const defects = roll <= effectiveThreshold;

  state.log.push({
    turn, year: state.campaign.current_year,
    type: 'defection_roll', region_id: regionId,
    roll, modifiers, threshold: effectiveThreshold, defects, visible_to: 'both',
  });

  if (defects) {
    region.controller = 'carthage';
    region.defected   = true;
    // Unfortified SPs flip automatically; fortified ones require a siege
    region.strategic_points.forEach(sp => {
      if (sp.fortification_rating === 0) sp.controller = 'carthage';
    });
    state.log.push({ turn, year: state.campaign.current_year, type: 'defection', region_id: regionId, visible_to: 'both' });
  }

  return { region_id: regionId, region_name: region.name, roll, modifiers, threshold: effectiveThreshold, defects };
}

// Apply destabilized flags to adjacent Italian allied regions after a decisive Carthage victory.
// Flagged regions trigger a loyalty roll when Hannibal subsequently enters them.
function applyDestabilizedFlags(state, battleRegionId) {
  const turn = state.campaign.current_season_turn;
  const adjacent = state.adjacency[battleRegionId] || [];
  adjacent.forEach(adjId => {
    if (!LOYALTY_REGIONS[adjId] || CAPITAL_REGIONS.has(adjId)) return;
    const adjRegion = state.regions.find(r => r.region_id === adjId);
    if (!adjRegion || adjRegion.controller !== 'rome' || adjRegion.defected) return;
    adjRegion.destabilized = true;
    state.log.push({
      turn, year: state.campaign.current_year,
      type: 'region_destabilized', region_id: adjId,
      cause_region: battleRegionId, visible_to: 'both',
    });
  });
}

// Attempt a loyalty roll triggered when Hannibal enters a destabilized region.
// Suppressed (flag preserved) if Rome has a Good/Worn army in that specific region.
// Otherwise rolls defection and clears the destabilized flag.
function checkDestabilizedEntry(state, regionId) {
  const region = state.regions.find(r => r.region_id === regionId);
  if (!region?.destabilized) return null;

  const turn = state.campaign.current_season_turn;

  // Rome army present in this region suppresses the roll — flag stays for next entry
  const romeArmyPresent = state.armies.some(
    a => a.side === 'rome' && a.true_region === regionId && ['good', 'worn'].includes(a.condition)
  );
  if (romeArmyPresent) {
    state.log.push({
      turn, year: state.campaign.current_year,
      type: 'destabilized_suppressed', region_id: regionId,
      reason: 'rome_army_present', visible_to: 'both',
    });
    return null;
  }

  // Clear the flag and roll defection (entry rolls are not crushing)
  region.destabilized = false;
  return checkDefection(state, regionId, false);
}

// Restore loyalty when Rome moves a Good or Worn army into a Carthage-held Italian region.
// Covers both defected regions (loyalty system) and regions taken by Carthage via occupation.
function checkLoyaltyRecovery(state) {
  const turn = state.campaign.current_season_turn;
  Object.keys(LOYALTY_REGIONS).forEach(regionId => {
    const region = state.regions.find(r => r.region_id === regionId);
    if (!region || region.controller !== 'carthage') return;
    const romeArmyHere = state.armies.some(
      a => a.side === 'rome' && a.true_region === regionId && ['good', 'worn'].includes(a.condition)
    );
    if (!romeArmyHere) return;
    region.controller = 'rome';
    region.defected   = false;
    // Restore all SPs to Rome
    region.strategic_points.forEach(sp => { sp.controller = 'rome'; });
    state.log.push({ turn, year: state.campaign.current_year, type: 'loyalty_restored', region_id: regionId, visible_to: 'both' });
  });
}

// Process all siege orders submitted this turn.
// Called from finalizeTurn after movement and military occupation are applied.
function processSieges(state) {
  // Clear siege status from all SPs — re-set below based on this turn's orders
  state.regions.forEach(r => {
    (r.strategic_points || []).forEach(sp => {
      sp.under_siege = false;
      sp.besieging_army_id = null;
    });
  });

  const allOrders = [
    ...(state._deferred_orders?.rome     || []),
    ...(state._deferred_orders?.carthage || []),
  ];

  allOrders.filter(o => o.type === 'siege').forEach(order => {
    const army = state.armies.find(a => a.army_id === order.army_id);
    if (!army || !army.siege_equipment) return;

    const region = state.regions.find(r => r.region_id === army.true_region);
    if (!region) return;

    const sp = (region.strategic_points || []).find(p => p.point_id === order.sp_id);
    if (!sp || sp.controller === army.side) return;

    const turn  = state.campaign.current_season_turn;
    const roll  = Math.floor(Math.random() * 6) + 1;
    const breach = roll > sp.fortification_rating;

    sp.under_siege      = true;
    sp.besieging_army_id = army.army_id;

    state.log.push({
      turn,
      year:                  state.campaign.current_year,
      type:                  'siege_roll',
      army_id:               army.army_id,
      side:                  army.side,
      region:                army.true_region,
      sp_id:                 sp.point_id,
      sp_name:               sp.name,
      roll,
      fortification_rating:  sp.fortification_rating,
      breach,
      breach_pts_before:     sp.breach_points_accumulated,
      visible_to:            'both',
    });

    if (breach) {
      sp.breach_points_accumulated += 1;
      if (sp.breach_points_accumulated >= sp.fortification_rating) {
        // SP falls to the besieger
        sp.controller            = army.side;
        sp.under_siege           = false;
        sp.besieging_army_id     = null;
        sp.breach_points_accumulated = 0;
        state.log.push({
          turn,
          year:       state.campaign.current_year,
          type:       'sp_captured',
          army_id:    army.army_id,
          side:       army.side,
          region:     army.true_region,
          sp_id:      sp.point_id,
          sp_name:    sp.name,
          visible_to: 'both',
        });
        // Sudden death: capturing the enemy capital city ends the game immediately
        if (sp.point_id === 'rome' || sp.point_id === 'carthage') {
          state.campaign.winner = army.side;
          state.campaign.phase  = 'game_over';
          state.log.push({
            turn,
            year:       state.campaign.current_year,
            type:       'game_over',
            winner:     army.side,
            reason:     'capital_captured',
            sp_name:    sp.name,
            visible_to: 'both',
          });
        }
      }
    }
  });
}

// Second half of turn resolution — runs after force/refuse is resolved (or immediately if no encounters).
// Uses state._deferred_orders for scout and depot processing.
function finalizeTurn(state) {
  // Clear expired feints before processing this turn's orders
  for (const army of state.armies) {
    if (army.feint_region && army.feint_expires_turn <= state.campaign.current_season_turn) {
      army.feint_region = null;
      army.feint_expires_turn = null;
    }
  }

  applyMilitaryOccupation(state);
  processSieges(state);
  const deferred = state._deferred_orders || state.orders;

  // Establish depots
  if (!state.depots) state.depots = [];
  ['rome', 'carthage'].forEach(side => {
    (deferred[side] || []).filter(o => o.type === 'establish_depot').forEach(order => {
      const army   = state.armies.find(a => a.army_id === order.army_id);
      if (!army) return;
      const region = state.regions.find(r => r.region_id === army.true_region);
      const enemyHere = state.armies.some(a => a.side !== side && a.true_region === army.true_region);
      if (!region || region.controller !== side || enemyHere) return;
      if (state.depots.find(d => d.side === side && d.region_id === army.true_region)) return;
      state.depots.push({ depot_id: `depot_${Date.now()}_${army.army_id}`, side, region_id: army.true_region });
      state.sides[side].resources = Math.max(0, state.sides[side].resources - 1);
      state.log.push({ turn: state.campaign.current_season_turn, year: state.campaign.current_year, type: 'depot_established', side, region_id: army.true_region, army_id: order.army_id, visible_to: side });
    });
  });

  // Execute feint orders
  ['rome', 'carthage'].forEach(side => {
    (deferred[side] || []).filter(o => o.type === 'feint').forEach(order => {
      const army = state.armies.find(a => a.army_id === order.army_id);
      if (!army) return;
      army.feint_region = order.to_region;
      // Feints are planted before current_season_turn increments in finalizeTurn.
      // +2 ensures the feint is visible for one full opponent turn after the increment.
      army.feint_expires_turn = state.campaign.current_season_turn + 2;
      state.log.push({
        turn:         state.campaign.current_season_turn,
        year:         state.campaign.current_year,
        type:         'feint_placed',
        side:         army.side,
        army_id:      army.army_id,
        true_region:  army.true_region,
        feint_region: order.to_region,
        visible_to:   army.side,   // only own side sees this in log
      });
    });
  });

  // Destroy depots that enemy armies uncontestedly occupy.
  // Defer destruction if a battle is still pending in that region — the depot is only
  // destroyed once the battle resolves and the loser retreats (handled in /battle/resolve).
  const pendingBattleRegions = new Set((state.pending_battles || []).map(b => b.region));
  state.depots = state.depots.filter(depot => {
    if (pendingBattleRegions.has(depot.region_id)) return true; // defer to battle resolve
    const captured = state.armies.some(a => a.side !== depot.side && a.true_region === depot.region_id);
    if (captured) {
      state.log.push({ turn: state.campaign.current_season_turn, year: state.campaign.current_year, type: 'depot_destroyed', side: depot.side, region_id: depot.region_id, visible_to: 'both' });
      ['rome', 'carthage'].forEach(s => {
        if (state.intelligence[s]?.enemy_depots) {
          state.intelligence[s].enemy_depots = state.intelligence[s].enemy_depots.filter(d => d.depot_id !== depot.depot_id);
        }
      });
      return false;
    }
    return true;
  });

  // Advance turn; stamp intelligence with new turn number
  state.campaign.current_season_turn += 1;

  // Scouting (use deferred orders so scout/deep_scout are processed correctly)
  const savedOrders = state.orders;
  state.orders = deferred;
  processScouting(state);
  state.orders = savedOrders;

  updateIntelligence(state);
  calculateSupply(state);
  calculateAttrition(state);

  // Field experience: track turns in field for Levy armies (Levy→Seasoned promotion at winter)
  state.armies.forEach(army => {
    if (army.experience !== 'levy') return;
    const homeBase = HOME_BASES[army.side];
    if (army.true_region !== homeBase && army.true_region !== (army.season_start_region || homeBase)) {
      army.turns_in_field = (army.turns_in_field || 0) + 1;
    }
  });

  // Loyalty: update Carthage presence counters, then check recovery
  Object.keys(LOYALTY_REGIONS).forEach(regionId => {
    const region = state.regions.find(r => r.region_id === regionId);
    if (!region) return;
    const hasCarth = state.armies.some(a => a.side === 'carthage' && a.true_region === regionId);
    region.carthage_turns_present = hasCarth ? (region.carthage_turns_present ?? 0) + 1 : 0;
  });
  checkLoyaltyRecovery(state);

  delete state._deferred_orders;

  state.orders           = { rome: null, carthage: null };
  state.orders_submitted = { rome: false, carthage: false };

  if (state.campaign.current_season_turn > (state.campaign.season_turns_per_year || 10)) {
    startWinter(state);
  } else {
    state.campaign.phase = 'orders';
  }
}

function resolveTurn(state) {
  // Track where each army moved from this turn
  const enteredFrom = {};

  const allOrders = [
    ...(state.orders.rome     || []),
    ...(state.orders.carthage || []),
  ];

  // Apply movement
  allOrders.forEach(order => {
    if (order.type !== 'move') return;
    const army = state.armies.find(a => a.army_id === order.army_id);
    if (!army) return;
    enteredFrom[order.army_id] = army.true_region;
    army.true_region = order.to_region;
    state.log.push({
      turn:    state.campaign.current_season_turn,
      year:    state.campaign.current_year,
      type:    'move',
      army_id: order.army_id,
      from:    enteredFrom[order.army_id],
      to:      order.to_region,
    });
  });

  // If Hannibal moved into a destabilized region, trigger loyalty roll on entry
  const hannibal = state.armies.find(a => a.army_id === 'hannibal');
  if (hannibal && enteredFrom[hannibal.army_id] !== undefined) {
    checkDestabilizedEntry(state, hannibal.true_region);
  }

  // Identify phantom-encounter regions: enemy moved into a feint_region but feinting army is absent.
  // These trigger the force/refuse screen (feint is NOT revealed yet — deferred until after decision).
  const phantomRegions = new Set();
  allOrders.forEach(order => {
    if (order.type !== 'move') return;
    const movingArmy = state.armies.find(a => a.army_id === order.army_id);
    if (!movingArmy) return;
    const opp = movingArmy.side === 'rome' ? 'carthage' : 'rome';
    state.armies.forEach(ea => {
      if (ea.side !== opp || !ea.feint_region) return;
      if (ea.feint_region !== movingArmy.true_region) return;
      if (ea.true_region  === movingArmy.true_region) return; // real army here — not a feint
      phantomRegions.add(movingArmy.true_region);
    });
  });

  // After all movement: check if any army moved into an enemy feinted region.
  // Phantom regions are deferred to the force/refuse screen; other feint reveals fire immediately.
  allOrders.forEach(order => {
    if (order.type !== 'move') return;
    const movingArmy = state.armies.find(a => a.army_id === order.army_id);
    if (!movingArmy) return;
    const movedToRegion = movingArmy.true_region; // already updated above
    if (phantomRegions.has(movedToRegion)) return; // will be revealed via force/refuse instead
    const movingSide = movingArmy.side;
    const opponentSide = movingSide === 'rome' ? 'carthage' : 'rome';

    // Check if any enemy army has a feint pointing at this region
    state.armies.forEach(enemyArmy => {
      if (enemyArmy.side !== opponentSide) return;
      if (!enemyArmy.feint_region) return;
      if (enemyArmy.feint_region !== movedToRegion) return;
      // Enemy had feinted toward movedToRegion — is the enemy actually there?
      if (enemyArmy.true_region === movedToRegion) return; // enemy is actually there — not a reveal
      // Feint revealed: the moving side found the region empty
      enemyArmy.feint_region = null;
      enemyArmy.feint_expires_turn = null;
      // Update the moving side's intel for this enemy army to their true position
      const intelEntry = (state.intelligence[movingSide]?.enemy_armies || [])
        .find(e => e.army_id === enemyArmy.army_id);
      if (intelEntry) {
        intelEntry.last_known_region = enemyArmy.true_region;
        intelEntry.last_known_turn   = state.campaign.current_season_turn;
      }
      state.log.push({
        turn:           state.campaign.current_season_turn,
        year:           state.campaign.current_year,
        type:           'feint_revealed',
        side:           opponentSide,
        army_id:        enemyArmy.army_id,
        feinted_region: movedToRegion,
        true_region:    enemyArmy.true_region,
        revealed_by:    movingArmy.army_id,
        visible_to:     'both',
      });
    });
  });

  // Deduct initiative costs for the orders just submitted
  ['rome', 'carthage'].forEach(side => {
    const cost = (state.orders[side] || [])
      .reduce((sum, o) => sum + (INITIATIVE_COSTS[o.type] || 0), 0);
    state.sides[side].initiative_pool = Math.max(0, state.sides[side].initiative_pool - cost);
  });

  // Detect encounters (new movement + persistent shared occupations)
  const encounters = detectEncounters(state, enteredFrom);

  // Inject phantom encounters for each feint region that triggered a contact
  phantomRegions.forEach(region => {
    if (encounters.find(e => e.region === region)) return; // real encounter takes priority
    const feintingArmy = state.armies.find(a => a.feint_region === region);
    if (!feintingArmy) return;
    const deceivedSide = feintingArmy.side === 'rome' ? 'carthage' : 'rome';
    const deceivedMovers = state.armies.filter(a =>
      a.side === deceivedSide && a.true_region === region && enteredFrom[a.army_id] !== undefined
    );
    if (deceivedMovers.length === 0) return;
    encounters.push({
      encounter_id:      `enc_phantom_${Date.now()}_${region}`,
      region,
      is_phantom:        true,
      feinting_side:     feintingArmy.side,
      feinting_army_id:  feintingArmy.army_id,
      consecutive_refusals: 0,
      [deceivedSide]:    { army_ids: deceivedMovers.map(a => a.army_id), entered_from: enteredFrom[deceivedMovers[0].army_id] ?? null },
    });
  });

  if (encounters.length > 0) {
    // Pause turn resolution — wait for force/refuse declarations before finalising
    state.pending_encounters          = encounters;
    state.force_refuse_declarations   = { rome: null, carthage: null };
    state.campaign.phase              = 'force_refuse';
    // Preserve orders so finalizeTurn can process scouts/depots after resolution
    state._deferred_orders = JSON.parse(JSON.stringify(state.orders));
    state.orders           = { rome: null, carthage: null };
    state.orders_submitted = { rome: false, carthage: false };

    // Auto-declare empty for any side that has no encounters they are party to.
    // This covers the feinting player in a phantom-only encounter: they need not act,
    // so their declaration is pre-filled as [] so resolution fires as soon as the
    // deceived player submits.
    ['rome', 'carthage'].forEach(side => {
      const hasEncounters = encounters.some(enc => !!enc[side]);
      if (!hasEncounters) state.force_refuse_declarations[side] = [];
    });

    return; // caller saves state
  }

  // No encounters — complete the turn immediately
  state._deferred_orders = JSON.parse(JSON.stringify(state.orders));
  state.orders           = { rome: null, carthage: null };
  state.orders_submitted = { rome: false, carthage: false };
  finalizeTurn(state);
}

// ─── Join ─────────────────────────────────────────────────────────────────────

// GET /join-status — which sides have joined (no tokens exposed)
app.get('/join-status', (req, res) => {
  const state = loadState();
  if (!state) return res.status(404).json({ error: 'No active campaign' });
  res.json({
    rome:     !!state.sessions?.rome,
    carthage: !!state.sessions?.carthage,
  });
});

// POST /join?side=rome|carthage
app.post('/join', (req, res) => {
  const state = requireState(res);
  if (!state) return;

  const { side } = req.query;
  if (!['rome', 'carthage'].includes(side)) {
    return res.status(400).json({ error: 'side must be rome or carthage' });
  }

  if (!state.sessions) state.sessions = { rome: null, carthage: null };

  if (state.sessions[side]) {
    return res.status(409).json({ error: `${side} has already joined` });
  }

  const token = crypto.randomUUID();
  state.sessions[side] = token;
  saveState(state);

  res.json({ token, side });
});

// ─── Game admin ───────────────────────────────────────────────────────────────

// POST /game/new
app.post('/game/new', (req, res) => {
  const initial = JSON.parse(fs.readFileSync(INITIAL_STATE_FILE, 'utf8'));

  // Cisalpine Gaul starting loyalty check: Rome rolls 1d6, must exceed threshold (3) to secure it.
  const cisRoll      = Math.ceil(Math.random() * 6);
  const cisSecured   = cisRoll > 3;
  const cisRegion    = initial.regions.find(r => r.region_id === 'cisalpine_gaul');
  if (cisRegion) {
    cisRegion.controller = cisSecured ? 'rome' : 'neutral';
    if (cisSecured) {
      // Mediolanum SP follows region control on initial securing
      const medSP = cisRegion.strategic_points?.find(sp => sp.point_id === 'mediolanum');
      if (medSP) medSP.controller = 'rome';
    }
  }
  initial.log.push({
    turn: 0, year: 1,
    type: 'cisalpine_gaul_loyalty_check',
    roll: cisRoll, threshold: 3, secured: cisSecured,
    visible_to: 'both',
  });

  saveState(initial);
  res.json({
    message:               'New campaign started: 218 BC',
    campaign:              initial.campaign,
    cisalpine_gaul_roll:   cisRoll,
    cisalpine_gaul_secured: cisSecured,
  });
});

// POST /game/reset — seeds a fresh 218 BC game and clears all sessions
// Use when a session gets stuck (e.g. after sim runs leave stale tokens)
// Always leaves a valid game-state.json so /join-status returns 200 with both sides free
app.post('/game/reset', (req, res) => {
  const initial = JSON.parse(fs.readFileSync(INITIAL_STATE_FILE, 'utf8'));
  // Ensure sessions are wiped
  initial.sessions = { rome: null, carthage: null };
  saveState(initial);
  res.json({ message: 'Game reset — fresh 218 BC campaign, both players must rejoin' });
});

// GET /game/status
app.get('/game/status', (req, res) => {
  const state = requireState(res);
  if (!state) return;
  res.json({
    campaign:         state.campaign,
    orders_submitted: state.orders_submitted,
    pending_battles:  state.pending_battles ?? [],
    sides: {
      rome:     { initiative_pool: state.sides.rome.initiative_pool,     resources: state.sides.rome.resources,     vp_total: state.sides.rome.vp_total,     naval_control: state.sides.rome.naval_control },
      carthage: { initiative_pool: state.sides.carthage.initiative_pool, resources: state.sides.carthage.resources, vp_total: state.sides.carthage.vp_total, naval_control: state.sides.carthage.naval_control },
    },
  });
});

// ─── Game state ───────────────────────────────────────────────────────────────

// GET /state — filtered by player token
app.get('/state', (req, res) => {
  const state = requireState(res);
  if (!state) return;

  const player = playerFromToken(state, req);
  if (!player) return res.status(401).json({ error: 'Missing or invalid player token' });

  res.json(filterStateForPlayer(state, player));
});

// GET /log
app.get('/log', (req, res) => {
  const state = requireState(res);
  if (!state) return;
  res.json({ log: state.log });
});

// ─── Orders ───────────────────────────────────────────────────────────────────

// POST /orders — submit movement orders for the turn
app.post('/orders', (req, res) => {
  const state = requireState(res);
  if (!state) return;

  const player = playerFromToken(state, req);
  if (!player) return res.status(401).json({ error: 'Missing or invalid player token' });

  if (state.campaign.phase !== 'orders') {
    return res.status(409).json({ error: `Cannot submit orders in phase: ${state.campaign.phase}` });
  }

  if (state.orders_submitted?.[player]) {
    return res.status(409).json({ error: 'Orders already submitted this turn' });
  }

  if (state.pending_battles && state.pending_battles.length > 0) {
    return res.status(409).json({ error: 'Pending battles must be resolved before submitting orders.' });
  }

  const { orders } = req.body;
  if (!Array.isArray(orders)) {
    return res.status(400).json({ error: 'orders must be an array' });
  }

  const myArmies    = state.armies.filter(a => a.side === player);
  const enemyArmies = state.armies.filter(a => a.side !== player);
  const errors      = [];

  orders.forEach(order => {
    if (!Object.keys(INITIATIVE_COSTS).includes(order.type)) {
      errors.push(`Unknown order type: ${order.type}`);
      return;
    }
    const army = myArmies.find(a => a.army_id === order.army_id);
    if (!army) {
      errors.push(`Unknown army: ${order.army_id}`);
      return;
    }
    if (order.type === 'move') {
      const adjacent = state.adjacency[army.true_region] || [];
      if (!adjacent.includes(order.to_region)) {
        errors.push(`${order.army_id}: ${order.to_region} is not adjacent to ${army.true_region}`);
      }
      // Naval control check: sea routes require the moving side to hold naval control
      const routeKey = `${army.true_region}:${order.to_region}`;
      if (SEA_CONNECTIONS.has(routeKey) && !state.sides[player].naval_control && !state.naval_contested) {
        errors.push(`${order.army_id}: sea route to ${order.to_region} requires naval control`);
      }
      // ZOC: armies in shared occupation cannot move to the opponent's entry region
      const opp = player === 'rome' ? 'carthage' : 'rome';
      const so = (state.shared_occupations || []).find(s =>
        s.region === army.true_region &&
        (s.rome.army_id === order.army_id || s.carthage.army_id === order.army_id)
      );
      if (so && so[opp]?.entered_from && order.to_region === so[opp].entered_from) {
        errors.push(`${order.army_id}: ZOC — cannot move to ${order.to_region} (enemy's entry route)`);
      }
    }
    if (order.type === 'scout' || order.type === 'deep_scout') {
      if (!enemyArmies.find(a => a.army_id === order.target_army)) {
        errors.push(`${order.army_id}: unknown target army ${order.target_army}`);
      }
    }
    if (order.type === 'establish_depot') {
      const region = state.regions.find(r => r.region_id === army.true_region);
      if (!region || region.controller !== player) {
        errors.push(`${order.army_id}: can only establish a depot in a friendly-controlled region`);
      }
      if ((state.depots || []).find(d => d.side === player && d.region_id === army.true_region)) {
        errors.push(`${order.army_id}: a depot already exists in ${army.true_region}`);
      }
    }
    if (order.type === 'feint') {
      const adjacent = state.adjacency[army.true_region] || [];
      if (!order.to_region) {
        errors.push(`${order.army_id}: feint requires to_region`);
      } else if (!adjacent.includes(order.to_region)) {
        errors.push(`${order.army_id}: feint to_region must be adjacent to true position`);
      }
    }
    if (order.type === 'siege') {
      if (!order.sp_id) {
        errors.push(`${order.army_id}: siege order requires sp_id`);
        return;
      }
      if (!army.siege_equipment) {
        errors.push(`${order.army_id}: no siege equipment — purchase during winter`);
        return;
      }
      const region = state.regions.find(r => r.region_id === army.true_region);
      const sp = (region?.strategic_points || []).find(p => p.point_id === order.sp_id);
      if (!sp) {
        errors.push(`${order.army_id}: no SP "${order.sp_id}" in ${army.true_region}`);
      } else if (sp.controller === player) {
        errors.push(`${order.army_id}: cannot besiege own SP`);
      }
    }
  });

  if (errors.length) return res.status(400).json({ errors });

  // Validate total initiative spend against available pool
  const totalCost = orders.reduce((sum, o) => sum + (INITIATIVE_COSTS[o.type] || 0), 0);
  if (totalCost > state.sides[player].initiative_pool) {
    return res.status(400).json({
      error: `Initiative cost ${totalCost} exceeds available pool (${state.sides[player].initiative_pool})`,
    });
  }

  // Validate resource cost for depot orders (1 resource each)
  const depotCount = orders.filter(o => o.type === 'establish_depot').length;
  if (depotCount > state.sides[player].resources) {
    return res.status(400).json({
      error: `Not enough resources to establish ${depotCount} depot(s) (have ${state.sides[player].resources})`,
    });
  }

  if (!state.orders)           state.orders           = { rome: null, carthage: null };
  if (!state.orders_submitted) state.orders_submitted = { rome: false, carthage: false };

  state.orders[player]           = orders;
  state.orders_submitted[player] = true;

  const opponent     = player === 'rome' ? 'carthage' : 'rome';
  const bothIn       = state.orders_submitted[opponent];

  if (bothIn) resolveTurn(state);

  saveState(state);

  res.json({
    ok:       true,
    resolved: bothIn,
    waiting_for_opponent: !bothIn,
  });
});

// ─── Force / Refuse ───────────────────────────────────────────────────────────

// POST /force-refuse/declare
// Body: { declarations: [{ encounter_id, choice: 'force'|'refuse' }] }
app.post('/force-refuse/declare', (req, res) => {
  const state = requireState(res);
  if (!state) return;

  const player = playerFromToken(state, req);
  if (!player) return res.status(401).json({ error: 'Missing or invalid player token' });

  if (state.campaign.phase !== 'force_refuse') {
    return res.status(409).json({ error: `Not in force/refuse phase (current: ${state.campaign.phase})` });
  }
  if (state.force_refuse_declarations?.[player] !== null && state.force_refuse_declarations?.[player] !== undefined) {
    return res.status(409).json({ error: 'Already declared for this phase' });
  }

  const { declarations } = req.body;
  if (!Array.isArray(declarations)) {
    return res.status(400).json({ error: 'declarations must be an array' });
  }

  const errors = [];

  // Validate each declaration
  let forceCost = 0;
  declarations.forEach(d => {
    if (!['force', 'accept', 'refuse'].includes(d.choice)) {
      errors.push(`Invalid choice "${d.choice}" — must be force, accept, or refuse`);
      return;
    }
    const enc = (state.pending_encounters || []).find(e => e.encounter_id === d.encounter_id);
    if (!enc) { errors.push(`Unknown encounter: ${d.encounter_id}`); return; }
    if (!enc[player]) { errors.push(`You are not a party to encounter ${d.encounter_id}`); return; }
    if (d.choice === 'force') {
      // Force is free after 2 consecutive mutual refusals, otherwise costs 1 IP
      forceCost += enc.consecutive_refusals >= 2 ? 0 : 1;
    }
  });

  if (errors.length) return res.status(400).json({ errors });

  if (forceCost > state.sides[player].initiative_pool) {
    return res.status(400).json({ error: `Not enough initiative to force (need ${forceCost}, have ${state.sides[player].initiative_pool})` });
  }

  // Deduct force costs
  state.sides[player].initiative_pool = Math.max(0, state.sides[player].initiative_pool - forceCost);

  // Store declarations
  if (!state.force_refuse_declarations) state.force_refuse_declarations = { rome: null, carthage: null };
  state.force_refuse_declarations[player] = declarations;

  const opponent = player === 'rome' ? 'carthage' : 'rome';
  const bothDeclared = state.force_refuse_declarations[opponent] !== null &&
                       state.force_refuse_declarations[opponent] !== undefined;

  if (!bothDeclared) {
    saveState(state);
    return res.json({ ok: true, waiting: true });
  }

  // ── Both declared — resolve each encounter ──────────────────────────────────
  const romeDecls = Object.fromEntries(
    (state.force_refuse_declarations.rome || []).map(d => [d.encounter_id, d.choice])
  );
  const carthDecls = Object.fromEntries(
    (state.force_refuse_declarations.carthage || []).map(d => [d.encounter_id, d.choice])
  );

  if (!state.shared_occupations) state.shared_occupations = [];
  state.pending_battles = state.pending_battles || [];

  (state.pending_encounters || []).forEach(enc => {
    const romeChoice = romeDecls[enc.encounter_id] || 'refuse';
    const carthChoice = carthDecls[enc.encounter_id] || 'refuse';
    const turn = state.campaign.current_season_turn;

    // ── Phantom encounter: feint contact resolution ───────────────────────────
    if (enc.is_phantom) {
      const deceivedSide  = enc.feinting_side === 'rome' ? 'carthage' : 'rome';
      const deceivedChoice = deceivedSide === 'rome' ? romeChoice : carthChoice;
      const feintingArmy  = state.armies.find(a => a.army_id === enc.feinting_army_id);

      // Reveal the feint: clear markers and update the deceived player's intel
      if (feintingArmy) {
        feintingArmy.feint_region      = null;
        feintingArmy.feint_expires_turn = null;
        const intelEntry = (state.intelligence[deceivedSide]?.enemy_armies || [])
          .find(e => e.army_id === feintingArmy.army_id);
        if (intelEntry) {
          intelEntry.last_known_region = feintingArmy.true_region;
          intelEntry.last_known_turn   = turn;
        }
      }

      state.log.push({
        turn, year: state.campaign.current_year,
        type:              'feint_revealed',
        feinting_army_id:  enc.feinting_army_id,
        feinting_side:     enc.feinting_side,
        deceived_side:     deceivedSide,
        region:            enc.region,
        deceived_choice:   deceivedChoice,
        force_wasted:      deceivedChoice === 'force',
        visible_to:        'both',
      });

      // If deceived player refused, they retreat back to where they came from
      if (deceivedChoice === 'refuse') {
        const deceivedArmy = state.armies.find(a => a.army_id === enc[deceivedSide]?.army_ids?.[0]);
        const retreatTo    = enc[deceivedSide]?.entered_from;
        if (deceivedArmy && retreatTo) {
          state.log.push({
            turn, year: state.campaign.current_year,
            type: 'retreat', army_id: deceivedArmy.army_id,
            from: enc.region, to: retreatTo, reason: 'feint_refused', visible_to: 'both',
          });
          deceivedArmy.true_region = retreatTo;
        }
      }
      // force / accept: army stays in the region — no battle
      return; // skip normal encounter resolution for this phantom
    }

    state.log.push({
      turn, year: state.campaign.current_year, type: 'force_refuse_resolved', region: enc.region,
      rome_choice: romeChoice, carthage_choice: carthChoice, visible_to: 'both',
    });

    // Resolution matrix:
    // Force beats everything → battle. Accept+Accept → battle. Accept+Refuse → refuser retreats. Refuse+Refuse → shared occupation.
    const someoneForced = romeChoice === 'force' || carthChoice === 'force';
    const bothAccept    = romeChoice === 'accept' && carthChoice === 'accept';
    const bothRefuse    = romeChoice === 'refuse' && carthChoice === 'refuse';

    if (someoneForced || bothAccept) {
      // Battle
      const armyIds = [...(enc.rome?.army_ids || []), ...(enc.carthage?.army_ids || [])];
      state.pending_battles.push({ turn, region: enc.region, armies: armyIds });
      state.log.push({ turn, year: state.campaign.current_year, type: 'battle_triggered', region: enc.region, armies: armyIds });
      state.shared_occupations = state.shared_occupations.filter(so => so.region !== enc.region);

    } else if (bothRefuse) {
      // Both refuse → shared occupation
      const existing = state.shared_occupations.find(so => so.region === enc.region);
      const newConsecutive = enc.consecutive_refusals + 1;
      const soEntry = {
        region:               enc.region,
        rome:                 { army_id: enc.rome?.army_ids[0], entered_from: enc.rome?.entered_from },
        carthage:             { army_id: enc.carthage?.army_ids[0], entered_from: enc.carthage?.entered_from },
        consecutive_refusals: newConsecutive,
      };
      if (existing) {
        Object.assign(existing, soEntry);
      } else {
        state.shared_occupations.push(soEntry);
      }
      state.log.push({
        turn, year: state.campaign.current_year, type: 'shared_occupation', region: enc.region,
        consecutive_refusals: newConsecutive, visible_to: 'both',
      });

    } else {
      // One accepts, one refuses → refuser retreats (Refuse trumps Accept)
      const refuserSide  = romeChoice === 'refuse' ? 'rome' : 'carthage';
      const forcerSide   = refuserSide === 'rome' ? 'carthage' : 'rome';
      const refuserEncData = enc[refuserSide];
      const refuserArmy  = state.armies.find(a => a.army_id === refuserEncData?.army_ids[0]);

      if (refuserArmy) {
        const retreatTo = findRetreatRegion(state, refuserArmy, refuserEncData.entered_from, forcerSide);
        if (retreatTo) {
          const from = refuserArmy.true_region;
          refuserArmy.true_region = retreatTo;
          state.log.push({ turn, year: state.campaign.current_year, type: 'retreat', army_id: refuserArmy.army_id, from, to: retreatTo, reason: 'refused_battle', visible_to: 'both' });
        } else {
          // Encirclement — army destroyed
          state.armies = state.armies.filter(a => a.army_id !== refuserArmy.army_id);
          state.log.push({ turn, year: state.campaign.current_year, type: 'encircled_destroyed', army_id: refuserArmy.army_id, region: enc.region, side: refuserSide, visible_to: 'both' });
        }
      }
      // Forcer takes region control.
      // Italian loyalty regions are excluded for Rome (loyalty/defection system only),
      // but Carthage may take neutral Italian territory this way.
      const regionObj = state.regions.find(r => r.region_id === enc.region);
      const italiaBocked = regionObj?.theater === 'italia' &&
                           !(forcerSide === 'carthage' && regionObj.controller === 'neutral');
      if (regionObj && !italiaBocked) {
        const prevCtrl = regionObj.controller;
        regionObj.controller = forcerSide;
        regionObj.strategic_points.forEach(sp => {
          if (sp.fortification_rating === 0 || prevCtrl === 'neutral') sp.controller = forcerSide;
        });
      }
      // Clear any shared occupation here
      state.shared_occupations = state.shared_occupations.filter(so => so.region !== enc.region);
    }
  });

  // Clear encounter state and finalise the turn
  state.pending_encounters        = [];
  state.force_refuse_declarations = { rome: null, carthage: null };
  finalizeTurn(state);

  saveState(state);
  res.json({ ok: true, waiting: false });
});

// ─── Emergency reinforcement ──────────────────────────────────────────────────

// POST /emergency-reinforce — spend resources mid-season to boost one army's points for the season
app.post('/emergency-reinforce', (req, res) => {
  const state = requireState(res);
  if (!state) return;

  const player = playerFromToken(state, req);
  if (!player) return res.status(401).json({ error: 'Missing or invalid player token' });

  if (!['orders', 'force_refuse'].includes(state.campaign.phase)) {
    return res.status(400).json({ error: 'Emergency reinforcement is only available during an active campaign season' });
  }

  const { army_id } = req.body;
  const army = state.armies.find(a => a.army_id === army_id && a.side === player);
  if (!army) return res.status(400).json({ error: 'Army not found or does not belong to you' });

  if (state.sides[player].emergency_reinforcement_used_this_season) {
    return res.status(400).json({ error: 'Emergency reinforcement already used this season' });
  }
  if (army.condition === 'good') {
    return res.status(400).json({ error: 'Army is already at full strength — reinforcement would exceed baseline' });
  }
  if (!army.in_supply) {
    return res.status(400).json({ error: 'Army must be in supply to receive emergency reinforcement' });
  }
  if (army.emergency_reinforcement) {
    return res.status(400).json({ error: 'Army has already received emergency reinforcement this season' });
  }

  const cost = (player === 'carthage' && state.sides.rome.naval_control) ? 3 : 2;
  if (state.sides[player].resources < cost) {
    return res.status(400).json({ error: `Insufficient resources (need ${cost}, have ${state.sides[player].resources})` });
  }

  army.emergency_reinforcement = true;
  state.sides[player].emergency_reinforcement_used_this_season = true;
  state.sides[player].resources -= cost;

  const bonus = Math.round(army.points_budget * 0.10);
  state.log.push({
    turn:       state.campaign.current_season_turn,
    year:       state.campaign.current_year,
    type:       'emergency_reinforcement',
    side:       player,
    army_id:    army.army_id,
    army_name:  army.name,
    bonus,
    cost,
    visible_to: player,
  });

  saveState(state);
  res.json({ ok: true, bonus, cost, resources_remaining: state.sides[player].resources });
});

// ─── Battle resolution ────────────────────────────────────────────────────────

// POST /battle/resolve
app.post('/battle/resolve', (req, res) => {
  const state = requireState(res);
  if (!state) return;

  const player = playerFromToken(state, req);
  if (!player) return res.status(401).json({ error: 'Missing or invalid player token' });

  const { region, winner, loss_type, loser_retreats_to } = req.body;

  if (!['rome', 'carthage'].includes(winner)) {
    return res.status(400).json({ error: 'winner must be rome or carthage' });
  }
  if (!['minor', 'decisive'].includes(loss_type)) {
    return res.status(400).json({ error: 'loss_type must be minor or decisive' });
  }

  const battle = state.pending_battles.find(b => b.region === region);
  if (!battle) return res.status(404).json({ error: 'No pending battle in that region' });

  const loser = winner === 'rome' ? 'carthage' : 'rome';

  // Update loser army condition (calculated from supply attrition + battle pts) and retreat
  const loserArmies = state.armies.filter(a => a.side === loser && battle.armies.includes(a.army_id));
  const winnerOccupied = new Set(state.armies.filter(a => a.side === winner).map(a => a.true_region));

  const destroyedIds = new Set();

  loserArmies.forEach(army => {
    const condBefore = army.condition;
    const turn = state.campaign.current_season_turn;

    // Trigger 1: army was already Broken entering this battle → destroyed on loss
    if (condBefore === 'broken') {
      destroyedIds.add(army.army_id);
      state.log.push({ turn, year: state.campaign.current_year, type: 'army_destroyed', army_id: army.army_id, army_name: army.name, side: loser, reason: 'broken_in_battle', region, visible_to: 'both' });
      return;
    }

    // Battle always adds +1 attrition pt on top of supply attrition already applied this turn.
    // Decisive loss also applies a direct condition drop (in addition to threshold drops).
    const baseAttrPts = army.attrition_pts_this_turn || 0;
    const newPts = baseAttrPts + 1;
    const additionalDrops = attritionDrops(newPts) - attritionDrops(baseAttrPts);

    for (let i = 0; i < additionalDrops; i++) army.condition = dropCondition(army.condition);
    if (loss_type === 'decisive') army.condition = dropCondition(army.condition);

    state.log.push({
      turn,
      year:            state.campaign.current_year,
      type:            'battle_attrition',
      side:            loser,
      army_id:         army.army_id,
      loss_type,
      condition_before: condBefore,
      condition_after:  army.condition,
      visible_to:      'both',
    });

    const from = army.true_region;

    let retreatTo = loser_retreats_to || null;
    if (!retreatTo) {
      // Auto: first adjacent region not currently occupied by winner armies
      const adjacent = state.adjacency[region] || [];
      retreatTo = adjacent.find(r => !winnerOccupied.has(r)) || null;
    }

    if (retreatTo && retreatTo !== region) {
      army.true_region = retreatTo;
      state.log.push({ turn, year: state.campaign.current_year, type: 'retreat', army_id: army.army_id, from, to: retreatTo });
    } else {
      // Trigger 2: no valid retreat → encircled and destroyed
      destroyedIds.add(army.army_id);
      state.log.push({ turn, year: state.campaign.current_year, type: 'army_destroyed', army_id: army.army_id, army_name: army.name, side: loser, reason: 'encircled', region, visible_to: 'both' });
    }
  });

  if (destroyedIds.size > 0) {
    state.armies = state.armies.filter(a => !destroyedIds.has(a.army_id));
  }

  // Winner takes region control — exceptions: Italian loyalty regions (defection system)
  // and capital regions (never politically controlled by the opposing side short of capital capture).
  const regionObj = state.regions.find(r => r.region_id === region);
  const isCapitalRegion = CAPITAL_REGIONS.has(region);
  // Italian loyalty regions: Rome cannot retake via battle victory (loyalty/defection system only).
  // Exception: Carthage may take a neutral Italian region through battle.
  const italiaBlocked = regionObj?.theater === 'italia' &&
                        !(winner === 'carthage' && regionObj.controller === 'neutral');
  if (regionObj && !italiaBlocked && !isCapitalRegion) {
    const prevCtrl = regionObj.controller;
    regionObj.controller = winner;
    // Unfortified SPs always flip; fortified SPs also flip if taken from neutral (no prior defender)
    regionObj.strategic_points.forEach(sp => {
      if (sp.fortification_rating === 0 || prevCtrl === 'neutral') sp.controller = winner;
    });
  }

  // Award +1 initiative to winner (per spec: "awarded immediately")
  state.sides[winner].initiative_pool += 1;
  state.sides[winner].season_battle_wins = (state.sides[winner].season_battle_wins ?? 0) + 1;

  // VP: +1 for battle victory, +2 per destroyed enemy army (immediate, one-time)
  const turn = state.campaign.current_season_turn;
  state.sides[winner].vp_total = (state.sides[winner].vp_total || 0) + 1;
  state.log.push({ turn, year: state.campaign.current_year, type: 'vp_earned', side: winner, amount: 1, reason: 'battle_victory', region, visible_to: 'both' });

  if (destroyedIds.size > 0) {
    const vpFromDestruction = destroyedIds.size * 2;
    state.sides[winner].vp_total += vpFromDestruction;
    state.log.push({ turn, year: state.campaign.current_year, type: 'vp_earned', side: winner, amount: vpFromDestruction, reason: 'army_destroyed', count: destroyedIds.size, region, visible_to: 'both' });
  }

  // Decisive victory → step up winner army experience (capped at elite)
  if (loss_type === 'decisive') {
    const winnerArmies = state.armies.filter(a => a.side === winner && battle.armies.includes(a.army_id));
    winnerArmies.forEach(army => {
      const expBefore = army.experience;
      army.experience = stepUpExperience(expBefore);
      if (army.experience !== expBefore) {
        state.log.push({ turn, year: state.campaign.current_year, type: 'experience_gained', army_id: army.army_id, side: winner,
          experience_before: expBefore, experience_after: army.experience, visible_to: 'both' });
      }
    });
  }

  // Log battle result
  const loserFinalCond = loserArmies[0]?.condition ?? 'unknown';
  state.log.push({
    turn:            state.campaign.current_season_turn,
    year:            state.campaign.current_year,
    type:            'battle_resolved',
    region,
    winner,
    loser,
    loss_type,
    loser_condition: loserFinalCond,
  });

  // Remove this battle from the queue
  state.pending_battles = state.pending_battles.filter(b => b.region !== region);

  // Destroy the losing side's depot in the battle region now that they have retreated.
  state.depots = state.depots.filter(d => {
    if (d.side !== loser || d.region_id !== region) return true;
    state.log.push({ turn, year: state.campaign.current_year, type: 'depot_destroyed', side: loser, region_id: region, visible_to: 'both' });
    ['rome', 'carthage'].forEach(s => {
      if (state.intelligence[s]?.enemy_depots) {
        state.intelligence[s].enemy_depots = state.intelligence[s].enemy_depots.filter(dep => dep.depot_id !== d.depot_id);
      }
    });
    return false;
  });

  // Loyalty: check for defection if Carthage won in an Italian allied region.
  // checkDefection handles any region control change internally.
  let defectionResult = null;
  let destabilizedRegions = [];
  if (winner === 'carthage') {
    const crushingVictory = destroyedIds.size > 0 ||
      loserArmies.some(a => a.condition === 'broken');
    defectionResult = checkDefection(state, region, crushingVictory);

    // Decisive victory → destabilize adjacent Italian allied regions
    if (loss_type === 'decisive') {
      applyDestabilizedFlags(state, region);
      destabilizedRegions = (state.adjacency[region] || []).filter(adjId => {
        const r = state.regions.find(r => r.region_id === adjId);
        return r?.destabilized;
      });
    }
  }

  // Rome wins in Italy → clear all destabilized flags across Italy
  if (winner === 'rome') {
    const regionObj = state.regions.find(r => r.region_id === region);
    if (regionObj?.theater === 'italia') {
      const turn = state.campaign.current_season_turn;
      state.regions.forEach(r => {
        if (r.destabilized) {
          r.destabilized = false;
          state.log.push({
            turn, year: state.campaign.current_year,
            type: 'destabilized_cleared', region_id: r.region_id,
            reason: 'carthage_loss_in_italy', visible_to: 'both',
          });
        }
      });
    }
  }

  updateIntelligence(state);
  calculateSupply(state);
  saveState(state);

  res.json({ ok: true, pending_battles_remaining: state.pending_battles.length, defection: defectionResult, destabilized_regions: destabilizedRegions });
});

// ─── Winter phase ────────────────────────────────────────────────────────────

function stepUpCondition(condition) {
  const steps = ['good', 'worn', 'depleted', 'broken'];
  const idx = steps.indexOf(condition);
  return idx > 0 ? steps[idx - 1] : 'good';
}

function calcIncome(state, side) {
  const controlled = state.regions.filter(r => r.controller === side);
  const regions    = Math.floor(controlled.length / 2);
  const naval      = state.sides[side].naval_control ? 1 : 0;
  const battles    = state.sides[side].season_battle_wins ?? 0;
  return { regions, naval, battles, total: regions + naval + battles };
}

function startWinter(state) {
  const romeBreakdown = calcIncome(state, 'rome');
  const cartBreakdown = calcIncome(state, 'carthage');

  state.sides.rome.resources     += romeBreakdown.total;
  state.sides.carthage.resources += cartBreakdown.total;

  state.naval_contested = false; // reset — new naval bid will set it again if needed

  // Clear per-season army flags from the previous season
  state.armies.forEach(a => {
    a.allied_contingent_attached    = false;
    a.mercenary_contingent_attached = false;
    a.emergency_reinforcement       = false;
  });

  state.winter = {
    income_breakdown:     { rome: romeBreakdown, carthage: cartBreakdown },
    naval_bids:           { rome: null, carthage: null },
    naval_bids_submitted: { rome: false, carthage: false },
    naval_result:         null,
    recruit_orders:       { rome: null, carthage: null },
    recruit_submitted:    { rome: false, carthage: false },
  };

  state.campaign.phase = 'winter_naval';

  state.log.push({
    turn:       state.campaign.current_season_turn,
    year:       state.campaign.current_year,
    type:       'winter_income',
    rome:       romeBreakdown.total,
    carthage:   cartBreakdown.total,
    breakdown:  { rome: romeBreakdown, carthage: cartBreakdown },
    visible_to: 'both',
  });
}

function resolveNaval(state) {
  const romeBid = state.winter.naval_bids.rome;
  const cartBid = state.winter.naval_bids.carthage;

  // Deduct naval investment from resources
  state.sides.rome.resources               -= romeBid;
  state.sides.carthage.resources           -= cartBid;
  state.sides.rome.naval_investment_this_winter     = romeBid;
  state.sides.carthage.naval_investment_this_winter = cartBid;

  const romeRoll = Math.floor(Math.random() * 6) + 1;
  const cartRoll = Math.floor(Math.random() * 6) + 1;

  // Modifiers
  let romeMod = Math.min(romeBid, 2);
  let cartMod = 1 + Math.min(cartBid, 2); // Carthage baseline +1

  const sicily = state.regions.find(r => r.region_id === 'sicily');
  if (sicily?.controller === 'rome')     romeMod += 1;
  if (sicily?.controller === 'carthage') cartMod += 1;

  const romeTotal = romeRoll + romeMod;
  const cartTotal = cartRoll + cartMod;

  let winner    = null;
  let contested = false;

  if      (romeTotal > cartTotal) { winner = 'rome';     state.sides.rome.naval_control = true;  state.sides.carthage.naval_control = false; state.naval_contested = false; }
  else if (cartTotal > romeTotal) { winner = 'carthage'; state.sides.carthage.naval_control = true; state.sides.rome.naval_control = false;  state.naval_contested = false; }
  else    { contested = true; state.sides.rome.naval_control = false; state.sides.carthage.naval_control = false; state.naval_contested = true; }

  const result = {
    rome:     { bid: romeBid, roll: romeRoll, modifier: romeMod, total: romeTotal },
    carthage: { bid: cartBid, roll: cartRoll, modifier: cartMod, total: cartTotal },
    winner, contested,
  };

  state.winter.naval_result = result;
  state.campaign.phase = 'winter_recruit';

  state.log.push({
    turn: state.campaign.current_season_turn, year: state.campaign.current_year,
    type: 'winter_naval', ...result, visible_to: 'both',
  });
}

function applyRecruitment(state) {
  ['rome', 'carthage'].forEach(side => {
    (state.winter.recruit_orders[side] || []).forEach(order => {
      if (order.type === 'reinforce') {
        const army = state.armies.find(a => a.army_id === order.army_id && a.side === side);
        if (!army || army.condition === 'good') return;
        army.condition = stepUpCondition(army.condition);
        state.sides[side].resources -= 1;
        state.log.push({ turn: state.campaign.current_season_turn, year: state.campaign.current_year, type: 'reinforce', side, army_id: order.army_id, new_condition: army.condition, visible_to: side });
      } else if (order.type === 'mercenary' && side === 'carthage') {
        if (state.sides.carthage.reinforcement_used_this_season) return;
        const army = state.armies.find(a => a.army_id === order.army_id && a.side === 'carthage');
        if (!army) return;
        const armyRegion = state.regions.find(r => r.region_id === army.true_region);
        if (!armyRegion || armyRegion.theater !== 'italia') return; // Italian theater only
        const cost = state.sides.rome.naval_control ? 2 : 1;
        state.sides.carthage.resources -= cost;
        army.mercenary_contingent_attached = true;
        state.sides.carthage.reinforcement_used_this_season = true;
        state.log.push({ turn: state.campaign.current_season_turn, year: state.campaign.current_year,
          type: 'mercenary_hired', army_id: order.army_id, army_name: army.name, cost, visible_to: 'carthage' });
      } else if (order.type === 'buy_siege_equipment') {
        const army = state.armies.find(a => a.army_id === order.army_id && a.side === side);
        if (!army) return;
        army.siege_equipment = true;
        state.sides[side].resources -= 1;
        state.log.push({ turn: state.campaign.current_season_turn, year: state.campaign.current_year, type: 'siege_equipment_purchased', side, army_id: order.army_id, army_name: army.name, visible_to: side });
      } else if (order.type === 'allied_contingent') {
        if (state.sides[side].reinforcement_used_this_season) return;
        const army = state.armies.find(a => a.army_id === order.army_id && a.side === side);
        if (!army) return;
        const armyRegion = state.regions.find(r => r.region_id === army.true_region);
        if (!armyRegion || armyRegion.theater !== 'italia') return; // Italian theater only
        if (side === 'rome') {
          // Requires at least one loyal Italian allied region still under Rome
          const hasLoyalAlly = Object.keys(LOYALTY_REGIONS).some(rid =>
            state.regions.find(r => r.region_id === rid)?.controller === 'rome'
          );
          if (!hasLoyalAlly) return;
        } else {
          // Carthage: requires at least one defected Italian region
          const hasDefected = state.regions.some(r => r.theater === 'italia' && r.controller === 'carthage');
          if (!hasDefected) return;
        }
        army.allied_contingent_attached = true;
        state.sides[side].reinforcement_used_this_season = true;
        state.log.push({ turn: state.campaign.current_season_turn, year: state.campaign.current_year,
          type: 'allied_contingent_attached', side, army_id: order.army_id, army_name: army.name,
          region: army.true_region, visible_to: side });
      } else if (order.type === 'raise_army') {
        // Max 2 armies per side — only valid when a previous army was destroyed
        if (state.armies.filter(a => a.side === side).length >= 2) return;
        const seq = (state.campaign.army_sequence = (state.campaign.army_sequence || 4) + 1);
        const army_id   = `${side}_raised_${seq}`;
        // Name inherited from the most recently destroyed army of this side
        const destroyedEntry = state.log.slice().reverse()
          .find(e => e.type === 'army_destroyed' && e.side === side && e.army_name);
        const name = destroyedEntry?.army_name || `${side === 'rome' ? 'Roman' : 'Carthaginian'} Army`;
        const homeRegion = side === 'rome' ? 'latium' : 'africa_proper';
        const newArmy = {
          army_id,
          name,
          side,
          composition_profile: 'heavy_infantry',
          points_budget:       1200,
          condition:           'good',
          experience:          'levy',
          true_region:         homeRegion,
          in_supply:           true,
          mercenary_contingent_attached: false,
          allied_contingent_attached:   false,
          emergency_reinforcement:      false,
          siege_equipment:              false,
          attrition_pts_this_turn:      0,
          season_start_region:          homeRegion,
          turns_in_field:               0,
          feint_region:                 null,
          feint_expires_turn:           null,
        };
        state.armies.push(newArmy);
        state.sides[side].resources -= 3;
        state.log.push({ turn: state.campaign.current_season_turn, year: state.campaign.current_year,
          type: 'army_raised', side, army_id, army_name: name, region: homeRegion, visible_to: 'both' });
      }
    });
  });
}

function runWinterAutomation(state) {
  const homeBases = { rome: 'latium', carthage: 'africa_proper' };

  // Reset breach points on all SPs and clear siege status (winter repairs fortifications)
  state.regions.forEach(r => {
    (r.strategic_points || []).forEach(sp => {
      sp.under_siege       = false;
      sp.besieging_army_id = null;
      if (sp.breach_points_accumulated > 0) {
        state.log.push({
          turn:       state.campaign.current_season_turn,
          year:       state.campaign.current_year,
          type:       'breach_points_reset',
          region_id:  r.region_id,
          sp_id:      sp.point_id,
          sp_name:    sp.name,
          breach_pts: sp.breach_points_accumulated,
          visible_to: 'both',
        });
        sp.breach_points_accumulated = 0;
      }
    });
  });

  // Field experience promotion: Levy → Seasoned for armies that spent ≥2 turns in the field
  state.armies.forEach(army => {
    if (army.experience !== 'levy') return;
    if ((army.turns_in_field || 0) < 2) return;
    army.experience = 'seasoned';
    state.log.push({
      turn:       state.campaign.current_season_turn,
      year:       state.campaign.current_year,
      type:       'experience_gained',
      side:       army.side,
      army_id:    army.army_id,
      army_name:  army.name,
      from:       'levy',
      to:         'seasoned',
      reason:     'field_experience',
      visible_to: 'both',
    });
  });

  // Winter attrition (applied before recovery)
  // In supply → no attrition. Out of supply → 2 condition drops (or destruction if already Broken).
  calculateSupply(state); // ensure supply is current heading into winter

  // Island supply override: without naval access, sea-supplied depots can't be resupplied —
  // island armies are always treated as out of supply regardless of depot presence.
  state.armies.forEach(army => {
    if (!ISLAND_REGIONS.has(army.true_region)) return;
    const hasNaval = state.sides[army.side].naval_control || state.naval_contested;
    if (!hasNaval) army.in_supply = false;
  });
  const winterDestroyedIds = new Set();
  state.armies.forEach(army => {
    if (army.in_supply) return;
    const turn = state.campaign.current_season_turn;
    const year = state.campaign.current_year;
    // Trigger 3: Broken + out of supply in winter → destroyed
    if (army.condition === 'broken') {
      winterDestroyedIds.add(army.army_id);
      state.log.push({ turn, year, type: 'army_destroyed', army_id: army.army_id, army_name: army.name, side: army.side, reason: 'winter_broken_oos', visible_to: 'both' });
      const opponent = army.side === 'rome' ? 'carthage' : 'rome';
      state.sides[opponent].vp_total = (state.sides[opponent].vp_total || 0) + 2;
      state.log.push({ turn, year, type: 'vp_earned', side: opponent, amount: 2, reason: 'army_destroyed', count: 1, visible_to: 'both' });
      return;
    }
    const condBefore = army.condition;
    army.condition = dropCondition(dropCondition(army.condition));
    state.log.push({
      turn, year,
      type:             'winter_attrition',
      side:             army.side,
      army_id:          army.army_id,
      condition_before: condBefore,
      condition_after:  army.condition,
      visible_to:       'both',
    });
  });
  if (winterDestroyedIds.size > 0) {
    state.armies = state.armies.filter(a => !winterDestroyedIds.has(a.army_id));
  }

  // Recovery
  state.armies.forEach(army => {
    if (army.condition === 'good') return;
    if (army.true_region === homeBases[army.side]) {
      army.condition = 'good';
    } else if (army.in_supply) {
      army.condition = stepUpCondition(army.condition);
    }
  });

  // Island evacuation — runs after recovery so the army gets no recovery benefit from being
  // at home base (recovery saw it as out of supply on the island). Prevents permanent lock-out only.
  const navalOpen = state.naval_contested;
  state.armies.forEach(army => {
    if (!ISLAND_REGIONS.has(army.true_region)) return;
    const hasNaval = state.sides[army.side].naval_control || navalOpen;
    if (hasNaval) return; // can leave normally next season
    const homeBase = HOME_BASES[army.side];
    state.log.push({
      turn:       state.campaign.current_season_turn,
      year:       state.campaign.current_year,
      type:       'island_evacuation',
      side:       army.side,
      army_id:    army.army_id,
      army_name:  army.name,
      from:       army.true_region,
      to:         homeBase,
      visible_to: 'both',
    });
    army.true_region = homeBase;
  });

  // Intelligence reset — start of new season, all positions revealed
  ['rome', 'carthage'].forEach(side => {
    state.intelligence[side].enemy_armies.forEach(intel => {
      const army = state.armies.find(a => a.army_id === intel.army_id);
      if (!army) return;
      intel.last_known_region = army.true_region;
      intel.last_known_turn   = 1; // new season starts at turn 1
      intel.condition_known   = false;
      intel.known_condition   = null;
    });
  });

  // VP snapshot — two independent sources:
  //   1. Region control: 1 VP per region (2 for Sicily). Capital regions always score for their home side.
  //   2. Major city SPs: 1 VP per fortified SP (rating ≥ 2) controlled — independent of region ownership.
  // Capital regions cannot be held by the opposing side, so no special exclusion needed here.
  ['rome', 'carthage'].forEach(side => {
    let regionVP = 0;

    // Source 1: region control
    state.regions.forEach(r => {
      if (r.controller !== side) return;
      regionVP += r.region_id === 'sicily' ? 2 : 1;  // Sicily replaces the standard 1 VP
    });

    // Source 2: major city SP control (independent of region ownership)
    let spVP = 0;
    state.regions.forEach(r => {
      (r.strategic_points || []).forEach(sp => {
        if (sp.controller === side && sp.fortification_rating >= 2) spVP += 1;
      });
    });

    const vp = regionVP + spVP;
    state.sides[side].vp_total = (state.sides[side].vp_total ?? 0) + vp;
    state.log.push({
      turn:           state.campaign.current_season_turn,
      year:           state.campaign.current_year,
      type:           'vp_snapshot',
      side,
      vp_this_season: vp,
      vp_total:       state.sides[side].vp_total,
      breakdown:      { regions: regionVP, cities: spVP },
      visible_to:     'both',
    });
  });

  // End-of-campaign check (year 5 = last year; Carthage wins a tie)
  if (state.campaign.current_year >= 5) {
    const rVP = state.sides.rome.vp_total;
    const cVP = state.sides.carthage.vp_total;
    const winner = rVP > cVP ? 'rome' : 'carthage';
    state.campaign.winner = winner;
    state.campaign.phase  = 'game_over';
    state.log.push({
      turn:         state.campaign.current_season_turn,
      year:         state.campaign.current_year,
      type:         'game_over',
      winner,
      reason:       'campaign_end',
      rome_vp:      rVP,
      carthage_vp:  cVP,
      visible_to:   'both',
    });
    delete state.winter;
    return;
  }

  // New season setup
  ['rome', 'carthage'].forEach(side => {
    const banked = Math.min(state.sides[side].resources, 3);
    state.sides[side].resources                           = banked;
    state.sides[side].banked_resources                    = banked;
    state.sides[side].initiative_pool                     = 4;
    state.sides[side].naval_investment_this_winter        = 0;
    state.sides[side].reinforcement_used_this_season            = false;
    state.sides[side].emergency_reinforcement_used_this_season  = false;
    state.sides[side].season_battle_wins                        = 0;
    // Note: allied_contingent_attached, mercenary_contingent_attached, emergency_reinforcement
    // are cleared at the START of the next winter (in startWinter) so they persist through the season.
    state.armies.filter(a => a.side === side).forEach(a => {
      a.season_start_region = a.true_region;
      a.turns_in_field      = 0;
    });
  });

  const oldYear = state.campaign.current_year;
  state.campaign.current_year       += 1;
  state.campaign.current_season_turn = 1;
  state.campaign.phase               = 'orders';
  state.orders           = { rome: null, carthage: null };
  state.orders_submitted = { rome: false, carthage: false };

  state.log.push({ turn: 1, year: state.campaign.current_year, type: 'new_season', previous_year: oldYear, visible_to: 'both' });

  delete state.winter;
}

// POST /winter/naval-bid
app.post('/winter/naval-bid', (req, res) => {
  const state = requireState(res);
  if (!state) return;
  const player = playerFromToken(state, req);
  if (!player) return res.status(401).json({ error: 'Missing or invalid player token' });

  if (state.campaign.phase !== 'winter_naval') {
    return res.status(409).json({ error: `Not in naval investment phase (current: ${state.campaign.phase})` });
  }
  if (state.winter.naval_bids_submitted[player]) {
    return res.status(409).json({ error: 'Naval bid already submitted' });
  }

  const { bid } = req.body;
  if (![0, 1, 2].includes(bid)) {
    return res.status(400).json({ error: 'bid must be 0, 1, or 2' });
  }
  if (bid > state.sides[player].resources) {
    return res.status(400).json({ error: `Not enough resources (have ${state.sides[player].resources})` });
  }

  state.winter.naval_bids[player]           = bid;
  state.winter.naval_bids_submitted[player] = true;

  const opponent = player === 'rome' ? 'carthage' : 'rome';
  if (state.winter.naval_bids_submitted[opponent]) resolveNaval(state);

  saveState(state);
  res.json({ ok: true, waiting_for_opponent: !state.winter.naval_bids_submitted[opponent] });
});

// POST /winter/recruit
app.post('/winter/recruit', (req, res) => {
  const state = requireState(res);
  if (!state) return;
  const player = playerFromToken(state, req);
  if (!player) return res.status(401).json({ error: 'Missing or invalid player token' });

  if (state.campaign.phase !== 'winter_recruit') {
    return res.status(409).json({ error: `Not in recruitment phase (current: ${state.campaign.phase})` });
  }
  if (state.winter.recruit_submitted[player]) {
    return res.status(409).json({ error: 'Recruitment already submitted' });
  }

  const { orders } = req.body;
  if (!Array.isArray(orders)) return res.status(400).json({ error: 'orders must be an array' });

  const errors = [];
  let totalCost = 0;

  orders.forEach(order => {
    if (order.type === 'reinforce') {
      const army = state.armies.find(a => a.army_id === order.army_id && a.side === player);
      if (!army)                       { errors.push(`Unknown army: ${order.army_id}`); return; }
      if (army.condition === 'good')   { errors.push(`${army.name} is already in good condition`); return; }
      totalCost += 1;
    } else if (order.type === 'mercenary') {
      if (player !== 'carthage') { errors.push('Only Carthage can hire mercenaries'); return; }
      const army = state.armies.find(a => a.army_id === order.army_id && a.side === 'carthage');
      if (!army)                  { errors.push(`Unknown army: ${order.army_id}`); return; }
      totalCost += state.sides.rome.naval_control ? 2 : 1;
    } else if (order.type === 'buy_siege_equipment') {
      const army = state.armies.find(a => a.army_id === order.army_id && a.side === player);
      if (!army) { errors.push(`Unknown army: ${order.army_id}`); return; }
      if (army.siege_equipment) { errors.push(`${army.name} already has siege equipment`); return; }
      totalCost += 1;
    } else if (order.type === 'raise_army') {
      totalCost += 3;
    } else if (order.type === 'allied_contingent') {
      // free — no cost
    } else {
      errors.push(`Unknown order type: ${order.type}`);
    }
  });

  if (errors.length) return res.status(400).json({ errors });
  if (totalCost > state.sides[player].resources) {
    return res.status(400).json({ error: `Cost ${totalCost} exceeds available resources (${state.sides[player].resources})` });
  }

  state.winter.recruit_orders[player]   = orders;
  state.winter.recruit_submitted[player] = true;

  const opponent = player === 'rome' ? 'carthage' : 'rome';
  if (state.winter.recruit_submitted[opponent]) {
    applyRecruitment(state);
    runWinterAutomation(state);
    if (state.campaign.phase !== 'game_over') {
      updateIntelligence(state);
      calculateSupply(state);
    }
  }

  saveState(state);
  res.json({ ok: true, waiting_for_opponent: state.winter ? !state.winter.recruit_submitted[opponent] : false });
});

// ─── Dev util ─────────────────────────────────────────────────────────────────

// POST /dev/trigger-winter — force winter phase for testing
app.post('/dev/trigger-winter', (req, res) => {
  const state = requireState(res);
  if (!state) return;
  if (state.campaign.phase !== 'orders') {
    return res.status(409).json({ error: `Can only trigger winter from orders phase (current: ${state.campaign.phase})` });
  }
  startWinter(state);
  saveState(state);
  res.json({ ok: true, phase: state.campaign.phase, income: state.winter?.income_breakdown });
});

// POST /dev/trigger-game-over — force game over for UI testing; optional ?winner=rome|carthage&reason=capital_captured|campaign_end
app.post('/dev/trigger-game-over', (req, res) => {
  const state = requireState(res);
  if (!state) return;
  const winner = req.query.winner === 'carthage' ? 'carthage' : 'rome';
  const reason = req.query.reason === 'capital_captured' ? 'capital_captured' : 'campaign_end';
  state.campaign.winner = winner;
  state.campaign.phase  = 'game_over';
  // Inflate VPs a bit so the breakdown table has interesting numbers
  if (reason === 'campaign_end') {
    state.sides.rome.vp_total     = state.sides.rome.vp_total     || 12;
    state.sides.carthage.vp_total = state.sides.carthage.vp_total || 9;
  }
  state.log.push({
    turn: state.campaign.current_season_turn, year: state.campaign.current_year,
    type: 'game_over', winner, reason,
    ...(reason === 'capital_captured' ? { sp_name: winner === 'rome' ? 'Carthage' : 'Rome' } : {}),
    rome_vp: state.sides.rome.vp_total, carthage_vp: state.sides.carthage.vp_total,
    visible_to: 'both',
  });
  saveState(state);
  res.json({ ok: true, winner, reason });
});

// PATCH /dev/resources — set resource counts directly for testing
app.patch('/dev/resources', (req, res) => {
  const state = requireState(res);
  if (!state) return;
  const { rome, carthage } = req.body;
  if (rome     !== undefined) state.sides.rome.resources     = rome;
  if (carthage !== undefined) state.sides.carthage.resources = carthage;
  saveState(state);
  res.json({ rome: state.sides.rome.resources, carthage: state.sides.carthage.resources });
});

// PATCH /dev/region/:id
app.patch('/dev/region/:id', (req, res) => {
  const state = requireState(res);
  if (!state) return;
  const { controller } = req.body;
  if (!['rome', 'carthage', 'neutral'].includes(controller)) {
    return res.status(400).json({ error: 'controller must be rome, carthage, or neutral' });
  }
  const region = state.regions.find(r => r.region_id === req.params.id);
  if (!region) return res.status(404).json({ error: 'Region not found' });
  region.controller = controller;
  saveState(state);
  res.json({ region_id: region.region_id, controller: region.controller });
});

// ─── Sim / Playtesting endpoints ─────────────────────────────────────────────
//
// These endpoints are gated by a simple admin key so normal game traffic can't
// hit them by accident.  The key is read from the SIM_KEY environment variable;
// if that variable isn't set the server falls back to the default "sim".
//
// Usage:
//   Include the header  x-sim-key: sim  (or whatever SIM_KEY is set to)
//   in every request to /admin/... endpoints.
//
// Quick start for playtesting:
//   1. POST /admin/sim/start   → resets to a fresh 218 BC game, returns both tokens
//   2. GET  /admin/sim/state   → full unfiltered state (no fog of war)
//   3. Use the returned tokens with all normal endpoints (POST /orders etc.)

const SIM_KEY = process.env.SIM_KEY || 'sim';

function requireSimKey(req, res) {
  const key = req.headers['x-sim-key'];
  if (key !== SIM_KEY) {
    res.status(401).json({ error: 'Missing or invalid x-sim-key header' });
    return false;
  }
  return true;
}

// POST /admin/sim/start
// Resets the campaign to 218 BC and auto-joins both sides.
// Returns { rome_token, carthage_token } ready for use in all normal endpoints.
app.post('/admin/sim/start', (req, res) => {
  if (!requireSimKey(req, res)) return;

  // Fresh game from initial state
  const initial = JSON.parse(fs.readFileSync(INITIAL_STATE_FILE, 'utf8'));
  initial.sessions = {};
  const romeToken     = crypto.randomBytes(16).toString('hex');
  const carthageToken = crypto.randomBytes(16).toString('hex');
  initial.sessions.rome     = romeToken;
  initial.sessions.carthage = carthageToken;
  saveState(initial);

  res.json({
    message:        'Sim campaign started: 218 BC',
    rome_token:     romeToken,
    carthage_token: carthageToken,
    tip:            'Use these tokens as the x-player-token header in all normal game endpoints.',
  });
});

// GET /admin/sim/state
// Returns the full, unfiltered game state — no fog of war applied.
// Use this so the AI can see all army positions, depots, and intel simultaneously.
app.get('/admin/sim/state', (req, res) => {
  if (!requireSimKey(req, res)) return;
  const state = requireState(res);
  if (!state) return;
  res.json(state);
});

// ─── Start ────────────────────────────────────────────────────────────────────

// Auto-seed a fresh campaign on startup if no state file exists.
// This ensures the server is always ready for players to join immediately,
// even on hosting platforms where game-state.json was not deployed.
if (!_memState && !fs.existsSync(STATE_FILE)) {
  try {
    const initial   = JSON.parse(fs.readFileSync(INITIAL_STATE_FILE, 'utf8'));
    const cisRoll   = Math.ceil(Math.random() * 6);
    const cisSecured = cisRoll > 3;
    const cisRegion = initial.regions.find(r => r.region_id === 'cisalpine_gaul');
    if (cisRegion) {
      cisRegion.controller = cisSecured ? 'rome' : 'neutral';
      const medSP = cisRegion.strategic_points?.find(sp => sp.point_id === 'mediolanum');
      if (medSP && cisSecured) medSP.controller = 'rome';
    }
    initial.log.push({ turn: 0, year: 1, type: 'cisalpine_gaul_loyalty_check',
      roll: cisRoll, threshold: 3, secured: cisSecured, visible_to: 'both' });
    saveState(initial);
    console.log(`Auto-seeded fresh 218 BC campaign (cisalpine_gaul ${cisSecured ? 'secured' : 'neutral'})`);
  } catch (e) {
    console.error('Warning: could not auto-seed campaign state:', e.message);
  }
}

app.listen(PORT, () => {
  console.log(`Bellum Punicum server running at http://localhost:${PORT}`);
  console.log('POST /game/new to start a campaign');
  console.log(`Sim endpoints available — default key: "${SIM_KEY}" (override with SIM_KEY env var)`);
});
