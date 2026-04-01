// ─────────────────────────────────────────────────────────────────
// Bellum Punicum — Autonomous Playtesting Simulation
// Run: node bellum_sim.js  (from project root)
// ─────────────────────────────────────────────────────────────────

const BASE     = 'http://localhost:3000';
const SIM_KEY  = 'sim';
const MAX_TURNS = 60;
const DELAY_MS  = 200;

// ── HTTP helpers ──────────────────────────────────────────────────
async function get(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'x-sim-key': SIM_KEY }
  });
  return r.json();
}

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json', 'x-sim-key': SIM_KEY };
  if (token) headers['x-player-token'] = token;
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ── Batch mode ────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const runsIdx   = args.indexOf('--runs');
const BATCH_RUNS = runsIdx >= 0 ? parseInt(args[runsIdx + 1], 10) || 1 : 1;
const BATCH_MODE = BATCH_RUNS > 1;

// ── Logging ───────────────────────────────────────────────────────
// In batch mode, suppress per-turn noise; only print errors + final report
function L(msg)  { if (!BATCH_MODE) console.log(msg); }
function LH(msg) { if (!BATCH_MODE) console.log(`\n${'═'.repeat(60)}\n  ${msg}\n${'═'.repeat(60)}`); }
function LS(msg) { if (!BATCH_MODE) console.log(`    → ${msg}`); }
function LB(msg) { console.log(msg); }  // always prints (batch progress + final report)

// ── State accessors (using real schema field names) ───────────────
function getArmy(state, armyId) {
  return (state.armies || []).find(a => a.army_id === armyId);
}
function getRegion(state, regionId) {
  return (state.regions || []).find(r => r.region_id === regionId);
}
function getSide(state, side) {
  return state.sides?.[side] || {};
}
function getNavalControl(state) {
  // returns 'rome', 'carthage', or 'contested'
  if (state.naval_contested) return 'contested';
  if (state.sides?.carthage?.naval_control) return 'carthage';
  if (state.sides?.rome?.naval_control) return 'rome';
  return 'carthage'; // default
}
function getArmyRegion(state, armyId) {
  return getArmy(state, armyId)?.true_region || null;
}
function getCondition(state, armyId) {
  return getArmy(state, armyId)?.condition || 'good';
}
function conditionRank(c) {
  return { good: 4, worn: 3, depleted: 2, broken: 1 }[c?.toLowerCase()] ?? 3;
}
function getExperience(state, armyId) {
  return getArmy(state, armyId)?.experience || 'seasoned';
}
function expRank(e) {
  return { levy: 1, seasoned: 2, veteran: 3, elite: 4 }[e?.toLowerCase()] ?? 2;
}
function isInSupply(state, armyId) {
  return getArmy(state, armyId)?.in_supply ?? true;
}
function getRegionController(state, regionId) {
  return getRegion(state, regionId)?.controller || 'neutral';
}
function getInitiative(state, side) {
  return getSide(state, side).initiative_pool ?? 4;
}
function getResources(state, side) {
  return getSide(state, side).resources ?? 0;
}
function getVP(state, side) {
  return getSide(state, side).vp_total ?? 0;
}
function getAdj(state, regionId) {
  // Use adjacency map from state if available, else fallback
  return state.adjacency?.[regionId] || FALLBACK_ADJ[regionId] || [];
}
function armiesInRegion(state, regionId) {
  return (state.armies || []).filter(a => a.true_region === regionId);
}
function enemyArmiesInRegion(state, regionId, mySide) {
  return armiesInRegion(state, regionId).filter(a => a.side !== mySide);
}
function getEnemySPsInRegion(state, regionId, side) {
  const region = getRegion(state, regionId);
  return (region?.strategic_points || []).filter(sp => sp.controller !== side);
}
function getActiveSiege(state, armyId) {
  for (const region of (state.regions || [])) {
    for (const sp of (region.strategic_points || [])) {
      if (sp.besieging_army_id === armyId) return { sp, region };
    }
  }
  return null;
}

// Fallback adjacency (matches schema doc exactly)
const FALLBACK_ADJ = {
  hispania_ulterior:  ['hispania_citerior','numidia_west'],
  hispania_citerior:  ['hispania_ulterior','pyrenean_passes'],
  pyrenean_passes:    ['hispania_citerior','transalpine_gaul'],
  transalpine_gaul:   ['pyrenean_passes','alpine_passes','liguria'],
  alpine_passes:      ['transalpine_gaul','cisalpine_gaul'],
  cisalpine_gaul:     ['alpine_passes','venetia','liguria','etruria'],
  venetia:            ['cisalpine_gaul','illyria'],
  liguria:            ['transalpine_gaul','cisalpine_gaul','etruria','sardinia_corsica'],
  etruria:            ['liguria','cisalpine_gaul','umbria_picenum','latium','sardinia_corsica'],
  umbria_picenum:     ['etruria','latium','samnium_lucania','illyria'],
  latium:             ['etruria','umbria_picenum','campania','samnium_lucania'],
  campania:           ['latium','samnium_lucania','bruttium_calabria'],
  samnium_lucania:    ['umbria_picenum','latium','campania','bruttium_calabria'],
  bruttium_calabria:  ['campania','samnium_lucania','sicily'],
  illyria:            ['venetia','umbria_picenum'],
  sardinia_corsica:   ['liguria','etruria','numidia_west'],
  sicily:             ['bruttium_calabria','africa_proper','numidia_east'],
  numidia_west:       ['hispania_ulterior','numidia_east','sardinia_corsica'],
  numidia_east:       ['numidia_west','africa_proper','sicily'],
  africa_proper:      ['numidia_east','sicily'],
};

// Sea routes gated by naval control
const SEA_ROUTES = [
  ['hispania_ulterior','numidia_west'],
  ['liguria','sardinia_corsica'],
  ['etruria','sardinia_corsica'],
  ['sardinia_corsica','numidia_west'],
  ['bruttium_calabria','sicily'],
  ['sicily','africa_proper'],
  ['sicily','numidia_east'],
];

function isAdjacent(state, from, to, side) {
  const adj = getAdj(state, from);
  return adj.includes(to);
  // Note: sea routes are already in adjacency per schema doc
  // but only passable if naval control matches side
}

// ── Supply prediction ─────────────────────────────────────────────
// Mirrors server's calculateSupply BFS: an army is in supply if any
// friendly supply source (home base or own depot) is within 2 hops.
// No controller check — pure distance, matching server rules exactly.
const HOME_BASES_SIM = { rome: 'latium', carthage: 'africa_proper' };

function wouldBeInSupply(state, regionId, side) {
  const sources = new Set([HOME_BASES_SIM[side]]);
  (state.depots || []).forEach(d => { if (d.side === side) sources.add(d.region_id); });

  // BFS from regionId, up to 2 hops
  const dist  = new Map([[regionId, 0]]);
  const queue = [regionId];

  while (queue.length > 0) {
    const current = queue.shift();
    const d = dist.get(current);
    if (sources.has(current)) return true;
    if (d >= 2) continue;
    for (const next of getAdj(state, current)) {
      if (!dist.has(next)) {
        dist.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  return false;
}

// How many turns remain in the current season (8-turn seasons)
function turnsUntilWinter(state) {
  const seasonLen = state.campaign?.season_turns_per_year || 8;
  const cur = state.campaign?.current_season_turn ?? 1;
  return Math.max(0, seasonLen - cur);
}

// ── Role resolution ───────────────────────────────────────────────
// Returns { primary, secondary } — each is a full army object or null.
// Called at the start of each decideOrders call so raised armies
// (e.g. carthage_raised_5) are automatically assigned a role.
function resolveRoles(state, side) {
  const armies = (state.armies || []).filter(a => a.side === side);

  if (side === 'carthage') {
    const preferred = ['hannibal', 'hasdrubal'];
    const primary = armies.find(a => a.army_id === 'hannibal')
      || armies.find(a => !preferred.includes(a.army_id))
      || armies[0]
      || null;
    const secondary = armies.find(a => a.army_id === 'hasdrubal' && a !== primary)
      || armies.find(a => a !== primary && !preferred.includes(a.army_id))
      || armies.find(a => a !== primary)
      || null;
    return { primary, secondary };
  } else {
    // rome
    const preferred = ['consular', 'reserve'];
    const primary = armies.find(a => a.army_id === 'consular')
      || armies.find(a => !preferred.includes(a.army_id))
      || armies[0]
      || null;
    const secondary = armies.find(a => a.army_id === 'reserve' && a !== primary)
      || armies.find(a => a !== primary && !preferred.includes(a.army_id))
      || armies.find(a => a !== primary)
      || null;
    return { primary, secondary };
  }
}

// Hannibal's intended march route
const HANNIBAL_ROUTE = [
  'hispania_citerior','pyrenean_passes','transalpine_gaul',
  'alpine_passes','cisalpine_gaul','etruria','latium'
];

// ── Scout count tracker (persists within a game, reset in main()) ─
// { army_id: count } — incremented each time that army scouts
const scoutCount = {};

// ── Urgency bonus (0-3) added to ALL move scores ──────────────────
function urgency(state) {
  const year  = state.campaign?.current_year ?? 1;
  const turn  = state.campaign?.current_season_turn ?? 1;
  const totalTurns = (year - 1) * 8 + turn;
  return Math.min(3, Math.floor(totalTurns / 13));
}

// ── Candidate-log printer (single-run only) ───────────────────────
function logCandidates(label, candidates, selected) {
  if (BATCH_MODE) return;
  L(`  [${label}]`);
  L(`    CANDIDATES:`);
  for (const c of candidates) {
    const sel = c === selected ? ' ◄ SELECTED' : '';
    L(`      ${c.label.padEnd(40)} score=${String(c.score).padStart(3)}  (${c.reason})${sel}`);
  }
  L(`    SELECTED: ${selected.label}`);
}

// ── Battle resolution ─────────────────────────────────────────────
function resolveBattle(state, battle) {
  const { region } = battle;
  const cartArmyId = (battle.armies || []).find(id =>
    (getArmy(state,id)?.side === 'carthage'));
  const romeArmyId = (battle.armies || []).find(id =>
    (getArmy(state,id)?.side === 'rome'));

  const cartCond = conditionRank(getCondition(state, cartArmyId));
  const romeCond = conditionRank(getCondition(state, romeArmyId));
  const cartExp  = expRank(getExperience(state, cartArmyId));
  const romeExp  = expRank(getExperience(state, romeArmyId));
  const cartSup  = isInSupply(state, cartArmyId) ? 0 : -1;
  const romeSup  = isInSupply(state, romeArmyId) ? 0 : -1;

  const cartRoll = Math.floor(Math.random()*6)+1 + cartCond + cartExp + cartSup;
  const romeRoll = Math.floor(Math.random()*6)+1 + romeCond + romeExp + romeSup;
  const diff     = Math.abs(cartRoll - romeRoll);
  const winner   = cartRoll >= romeRoll ? 'carthage' : 'rome';
  const lossType = diff >= 4 ? 'decisive' : 'minor';
  const loserSide = winner === 'carthage' ? 'rome' : 'carthage';
  const loserArmyId = winner === 'carthage' ? romeArmyId : cartArmyId;

  // Find safe retreat for loser
  const adj = getAdj(state, region);
  const retreatTo = adj.find(r => enemyArmiesInRegion(state, r, loserSide).length === 0)
                 || adj[0] || null;

  return {
    region, winner, loss_type: lossType,
    loser_retreats_to: retreatTo,
    _debug: { cartRoll, romeRoll, diff, cartArmyId, romeArmyId }
  };
}

// Hasdrubal's route when he becomes the main army (Hannibal destroyed)
const HASDRUBAL_ROUTE = [
  'hispania_ulterior','hispania_citerior','pyrenean_passes','transalpine_gaul',
  'alpine_passes','cisalpine_gaul','etruria','latium'
];

// Hasdrubal's island route — sea bridge to Italy via Sicily
const HASDRUBAL_ISLAND_ROUTE = [
  'hispania_ulterior','numidia_west','numidia_east',
  'sicily','bruttium_calabria'
];

// Priority depot target regions for Carthage — proactive supply chain
const CARTHAGE_DEPOT_TARGETS = [
  'transalpine_gaul',   // Alpine approach
  'cisalpine_gaul',     // Northern Italy gateway
  'sicily',             // Island bridge to Italy
  'sardinia_corsica',   // Northern Italy via sea
  'etruria',            // Central Italy
  'bruttium_calabria',  // Southern Italy
];

// Italian regions Carthage can threaten / pillage after reaching Italy
const ITALY_THREAT_REGIONS = [
  'campania','samnium_lucania','umbria_picenum','bruttium_calabria','etruria'
];

// ── Carthage strategy ─────────────────────────────────────────────
function decideCarthageOrders(state, tokens) {
  const orders    = [];
  let initLeft    = getInitiative(state, 'carthage');
  const resources = getResources(state, 'carthage');
  const urg       = urgency(state);
  const turnsLeft = turnsUntilWinter(state);

  // Resolve roles dynamically
  const { primary: carthPrimary, secondary: carthSecondary } = resolveRoles(state, 'carthage');
  const { primary: romePrimary, secondary: romeSecondary }   = resolveRoles(state, 'rome');

  const primaryExists   = !!carthPrimary;
  const secondaryExists = !!carthSecondary;

  const year  = state.campaign?.current_year  ?? 1;
  const turn  = state.campaign?.current_season_turn ?? 1;
  const label = `CARTHAGE primary Y${year}T${turn}`;
  const label2= `CARTHAGE secondary Y${year}T${turn}`;

  // ── PRIMARY (attacker / Hannibal role) ────────────────────────────
  const hanRegion = carthPrimary?.true_region ?? null;
  const hanCond   = conditionRank(carthPrimary?.condition);
  const hanSup    = carthPrimary?.in_supply ?? true;
  const primaryLabel = carthPrimary?.army_id ?? 'primary';

  if (!primaryExists) {
    LS('Carthage primary destroyed — no order');
  } else if (hanCond <= 1) {
    // Broken: retreat toward safety
    const adj = getAdj(state, hanRegion);
    const safeRetreat = adj.find(r => {
      const ctrl = getRegionController(state, r);
      return (ctrl === 'carthage' || ctrl === 'neutral') &&
             enemyArmiesInRegion(state, r, 'carthage').length === 0;
    });
    const hanCtrl = getRegionController(state, hanRegion);
    if (safeRetreat && hanCtrl !== 'carthage') {
      orders.push({ type: 'move', army_id: carthPrimary.army_id, to_region: safeRetreat });
      LS(`${primaryLabel} RETREATS to ${safeRetreat} [broken, seeking safety]`);
    } else {
      orders.push({ type: 'hold', army_id: carthPrimary.army_id });
      LS(`${primaryLabel} HOLDS in ${hanRegion} [broken]`);
    }
  } else {
    // Build scored candidate list
    const candidates = [];
    const routeIdx   = HANNIBAL_ROUTE.indexOf(hanRegion);
    const adj        = getAdj(state, hanRegion);
    const hanCtrl    = getRegionController(state, hanRegion);
    const pId        = carthPrimary.army_id;

    // --- SIEGE: stickiness — if actively besieging, add top-priority continuation ---
    const activeSiegeCarthage = getActiveSiege(state, pId);
    if (activeSiegeCarthage && activeSiegeCarthage.region.region_id === hanRegion && initLeft >= 1) {
      const aSP = activeSiegeCarthage.sp;
      candidates.push({ label: `siege(continue)→${aSP.point_id}`, score: 15,
        reason: 'active siege continuation: priority 15',
        action: () => {
          orders.push({ type: 'siege', army_id: pId, sp_id: aSP.point_id });
          initLeft--;
          LS(`${primaryLabel} CONTINUES SIEGE of ${aSP.name} in ${hanRegion}`);
        }
      });
    }

    // --- HOLD (always present as fallback) ---
    candidates.push({ label: 'hold', score: 1, reason: 'fallback', action: () => {
      orders.push({ type: 'hold', army_id: pId });
      LS(`${primaryLabel} HOLDS in ${hanRegion}`);
    }});

    // --- SCOUT (diminishing returns) ---
    const scoutBase = Math.max(0, 3 - (scoutCount[pId] || 0));
    const scoutTgt  = romePrimary ?? romeSecondary;
    if (initLeft >= 1 && scoutTgt && scoutBase > 0) {
      candidates.push({ label: `scout ${scoutTgt.army_id}`, score: scoutBase,
        reason: `base 3 minus ${scoutCount[pId]||0} prior scouts`,
        action: () => {
          orders.push({ type: 'scout', army_id: pId, target_army: scoutTgt.army_id });
          scoutCount[pId] = (scoutCount[pId] || 0) + 1;
          initLeft--;
          LS(`${primaryLabel} SCOUTS ${scoutTgt.army_id}`);
        }
      });
    }

    // --- ESTABLISH DEPOT ---
    const canDepotPrimary = resources >= 1 && initLeft >= 1
      && hanCtrl === 'carthage'
      && !(state.depots||[]).find(d => d.side==='carthage' && d.region_id===hanRegion);
    if (canDepotPrimary) {
      // Check if on-route and next step is blocked by enemy — depot here is very valuable
      const nextRouteStep = (routeIdx >= 0 && routeIdx < HANNIBAL_ROUTE.length - 1)
        ? HANNIBAL_ROUTE[routeIdx + 1] : null;
      const nextStepBlocked = nextRouteStep
        && enemyArmiesInRegion(state, nextRouteStep, 'carthage').length > 0;
      // Also valuable if this region is on-route and depot extends supply forward
      const onRouteDepot = routeIdx >= 0;
      // Fix 4: if current region is on-route AND has no depot AND Carthage controls it
      // AND it's an unsupplied gap — strongly prefer depot over advancing
      const isSupplyGap = onRouteDepot && !hanSup
        && !(state.depots||[]).find(d => d.side==='carthage' && d.region_id===hanRegion);
      // Fix 3: waypoint on route always gets depot score 8 (proactive chain-building)
      const depotScore = isSupplyGap    ? 9   // Fix 4: OOS on-route gap — depot NOW
        : !hanSup       ? 6              // OOS but not on-route
        : nextStepBlocked ? 8            // route blocked — set up supply base here
        : onRouteDepot  ? 8              // Fix 3: on-route waypoint proactive depot
        : 2;
      const depotReason = isSupplyGap ? 'OOS on-route gap — depot NOW +9'
        : !hanSup ? 'OOS — depot fixes supply +6'
        : nextStepBlocked ? 'next step blocked — supply base +8'
        : onRouteDepot ? 'on-route waypoint depot +8'
        : 'proactive depot +2';
      candidates.push({ label: 'establish_depot', score: depotScore,
        reason: depotReason,
        action: () => {
          orders.push({ type: 'establish_depot', army_id: pId });
          initLeft--;
          LS(`${primaryLabel} ESTABLISHES DEPOT in ${hanRegion}`);
        }
      });
    }

    // --- MOVE toward strategic objective (HANNIBAL_ROUTE) ---
    if (!hanSup) {
      // OOS: score retreat-to-supply moves highly, but ALSO score forward route advances
      // so that urgency + good condition can push Hannibal through OOS territory
      for (const r of adj) {
        if (enemyArmiesInRegion(state, r, 'carthage').length > 0) continue;
        const rInSup = wouldBeInSupply(state, r, 'carthage');
        const rRouteIdx = HANNIBAL_ROUTE.indexOf(r);
        const isNextRouteStep = (routeIdx >= 0 && routeIdx < HANNIBAL_ROUTE.length - 1)
          ? (HANNIBAL_ROUTE[routeIdx + 1] === r) : false;

        if (rInSup) {
          // Supply retreat — high priority
          let sc = 8 + urg;
          // But reduce retreat priority if condition is good AND we're late in season
          // (urgency makes forward push worthwhile late-game)
          const reason = `OOS retreat to supply; urgency+${urg}`;
          candidates.push({ label: `move→${r}`, score: sc, reason, action: () => {
            orders.push({ type: 'move', army_id: pId, to_region: r });
            LS(`${primaryLabel} RETREATS to ${r} [OOS — seeking supply]`);
          }});
        } else if (isNextRouteStep) {
          // Forward route advance even when OOS — score based on condition + urgency
          // Only worthwhile if army is in good-enough shape to absorb attrition
          let sc = 6 + urg;
          // Penalise if condition is already low (can't afford more attrition)
          if (hanCond <= 2) sc -= 4;
          if (turnsLeft <= 2) sc -= 3; // very late in season — don't compound OOS
          const reason = `forward OOS push (on-route, cond=${carthPrimary?.condition}); urgency+${urg}`;
          if (sc > 0) {
            const r2 = r;
            candidates.push({ label: `move→${r2}`, score: sc, reason, action: () => {
              orders.push({ type: 'move', army_id: pId, to_region: r2 });
              LS(`${primaryLabel} PUSHES FORWARD to ${r2} [OOS — pressing on]`);
            }});
          }
        }
      }
      // Fix 2: Hannibal island awareness — retreat south to Sicily supply chain
      // When OOS in Italy and a Carthage depot exists on Sicily, consider moving toward bruttium
      const sicillyDepotExists = (state.depots||[]).some(d => d.side==='carthage' && d.region_id==='sicily');
      const hanInNorthItaly = ['etruria','latium','campania','samnium_lucania'].includes(hanRegion);
      if (!hanSup && sicillyDepotExists && hanInNorthItaly) {
        // Consider moving toward bruttium_calabria (which is within 2 hops of Sicily depot)
        const adjContainingBruttium = adj.filter(r => r === 'bruttium_calabria');
        // Also consider moves that are 1 step toward bruttium (via campania or samnium_lucania)
        const stepTowardBruttium = adj.filter(r =>
          ['bruttium_calabria','campania','samnium_lucania'].includes(r)
          && enemyArmiesInRegion(state, r, 'carthage').length === 0
        );
        for (const r of stepTowardBruttium) {
          const rInSup = wouldBeInSupply(state, r, 'carthage');
          const sc = rInSup ? 10 : 8; // high priority — Sicily supply chain
          candidates.push({ label: `move→${r}`, score: sc,
            reason: `retreat south to Sicily supply chain; dest=${r} inSup=${rInSup}`,
            action: () => {
              orders.push({ type: 'move', army_id: pId, to_region: r });
              LS(`${primaryLabel} RETREATS SOUTH to ${r} [OOS — seeking Sicily supply chain]`);
            }
          });
        }
      }
      // If no supply retreat exists at all, also consider hold (already in list as score=1)
    } else {
      // In supply: score each adjacent region as a potential move
      for (const r of adj) {
        const hasEnemies = enemyArmiesInRegion(state, r, 'carthage').length > 0;
        // Only skip enemy regions if we're too weak to fight (depleted or broken)
        if (hasEnemies && hanCond <= 2) continue;
        let sc = 0;
        const reasons = [];

        // Small penalty for moving into enemy-occupied region (battle risk)
        if (hasEnemies) {
          sc -= 2;
          reasons.push('enter battle -2');
        }

        // Check if this is the next step on the route
        const isNextRouteStep = (routeIdx >= 0 && routeIdx < HANNIBAL_ROUTE.length - 1)
          ? (HANNIBAL_ROUTE[routeIdx + 1] === r)
          : false;
        // Check if this is an Italy threat region from end-of-route
        const isItalyThreaten = (routeIdx === HANNIBAL_ROUTE.length - 1)
          && ITALY_THREAT_REGIONS.includes(r);
        // Check if this moves us onto the route (off-route recovery)
        const isRouteRecovery = routeIdx === -1 && HANNIBAL_ROUTE.includes(r);
        // Check if any move brings us forward on the route vs staying
        const rRouteIdx = HANNIBAL_ROUTE.indexOf(r);
        const isForwardMove = rRouteIdx > routeIdx;
        // Backward move on the route — penalise heavily (only retreat if forced)
        const isBackwardRouteMove = rRouteIdx >= 0 && rRouteIdx < routeIdx;

        if (isNextRouteStep || isItalyThreaten) {
          sc += 10;
          reasons.push('on-route +10');
        } else if (isRouteRecovery) {
          sc += 8;
          reasons.push('route-recovery +8');
        } else if (isForwardMove) {
          sc += 6;
          reasons.push('forward +6');
        } else if (isBackwardRouteMove) {
          sc += 1;  // almost never chosen over hold; only beats hold if heavily supply-boosted
          reasons.push('backward-route +1 (retreat only)');
        } else {
          sc += 5;
          reasons.push('off-route explore +5');
        }

        // Supply modifier
        const destInSup = wouldBeInSupply(state, r, 'carthage');
        if (destInSup) {
          sc += 3;
          reasons.push('dest in-supply +3');
        } else {
          // OOS penalty scales with season pressure
          if (turnsLeft <= 2) {
            sc -= 6;
            reasons.push(`season-end OOS -6`);
          } else if (turnsLeft <= 4 && hanCond <= 2) {
            sc -= 4;
            reasons.push('late-season low-cond OOS -4');
          } else {
            // Allow advance into OOS but with small penalty — urgency can overcome it
            sc -= 1;
            reasons.push('dest OOS -1');
          }
        }

        // Territory value
        const rCtrl = getRegionController(state, r);
        if (rCtrl !== 'carthage') {
          sc += 2;
          reasons.push('capturing +2');
        }

        // Condition penalty
        if (hanCond <= 2) {
          sc -= 2;
          reasons.push('depleted/worse -2');
        }

        // Urgency bonus
        sc += urg;
        if (urg > 0) reasons.push(`urgency +${urg}`);

        if (sc > 0) {
          const r2 = r; // closure capture
          candidates.push({ label: `move→${r2}`, score: sc, reason: reasons.join(', '),
            action: () => {
              orders.push({ type: 'move', army_id: pId, to_region: r2 });
              LS(`${primaryLabel} MOVES ${hanRegion} → ${r2}`);
            }
          });
        }
      }
    }

    // --- SIEGE: new siege against enemy SP in current region ---
    if (carthPrimary.siege_equipment && initLeft >= 1) {
      const enemySPs = getEnemySPsInRegion(state, hanRegion, 'carthage');
      if (enemySPs.length > 0) {
        // Pick SP with most breach progress (highest accumulated) for best chance of capture
        const targetSP = enemySPs.slice().sort((a, b) =>
          (b.breach_points_accumulated || 0) - (a.breach_points_accumulated || 0)
        )[0];
        let siegeScore = 12 + urg;
        const reasons3 = ['siege base 12'];
        if (urg > 0) reasons3.push(`urgency +${urg}`);
        // Stickiness already handled above (score 15), but if no active siege yet, score +2 if this is the current siege target
        if (targetSP.under_siege && targetSP.besieging_army_id === pId) {
          siegeScore += 2; reasons3.push('already besieging +2');
        }
        if (hanCond <= 2) { siegeScore -= 3; reasons3.push('depleted penalty -3'); }
        candidates.push({ label: `siege→${targetSP.point_id}`, score: siegeScore,
          reason: reasons3.join(', '),
          action: () => {
            orders.push({ type: 'siege', army_id: pId, sp_id: targetSP.point_id });
            initLeft--;
            LS(`${primaryLabel} BESIEGES ${targetSP.name} (fort:${targetSP.fortification_rating}, breach:${targetSP.breach_points_accumulated}) in ${hanRegion}`);
          }
        });
      } else if (getEnemySPsInRegion(state, hanRegion, 'carthage').length === 0) {
        // No SPs but no equipment message needed — already handled by siege_equipment check
      }
    } else if (!carthPrimary.siege_equipment) {
      const enemySPsNoEq = getEnemySPsInRegion(state, hanRegion, 'carthage');
      if (enemySPsNoEq.length > 0) {
        // Reduce move scores by 1 — don't rush past objective
        for (const c of candidates) {
          if (c.label.startsWith('move→')) {
            c.score -= 1;
            c.reason += ', no-siege-equip-nearby -1';
          }
        }
        LS(`${primaryLabel}: no siege equipment — ${enemySPsNoEq.length} enemy SP(s) present in ${hanRegion}, move scores reduced`);
      }
    }

    // --- FEINT: plant a false position on Rome's intel map ---
    const canFeintPrimary = initLeft >= 1
      && !carthPrimary.feint_region   // not already feinting
      && hanCond >= 3                 // good or worn only (depleted/broken: skip)
      && hanCtrl !== 'carthage';      // in enemy or neutral territory
    if (canFeintPrimary && adj.length > 0) {
      // Prefer a region BEHIND current position on the route (makes Rome think we retreated)
      const behindOnRoute = adj.filter(r => {
        const rIdx = HANNIBAL_ROUTE.indexOf(r);
        return rIdx >= 0 && rIdx < routeIdx;
      });
      const feintTarget = behindOnRoute.length > 0
        ? behindOnRoute[behindOnRoute.length - 1]   // pick closest behind step
        : adj[0];                                    // fallback: any adjacent region
      const feintScore = 6 + Math.floor(urg / 2);
      candidates.push({ label: `feint→${feintTarget}`, score: feintScore,
        reason: `feint base 6 + urgency/2=${Math.floor(urg/2)}; mislead Rome`,
        action: () => {
          orders.push({ type: 'feint', army_id: pId, to_region: feintTarget });
          initLeft--;
          LS(`${primaryLabel} FEINTS toward ${feintTarget} [true position: ${hanRegion}]`);
        }
      });
    }

    // Select highest-scoring candidate (ties broken by order of insertion)
    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates[0];
    logCandidates(label, candidates, selected);
    selected.action();
  }

  // ── SECONDARY (defender / Hasdrubal role) ─────────────────────────
  const hasRegion = carthSecondary?.true_region ?? null;
  const hasCond   = conditionRank(carthSecondary?.condition);
  const hasSup    = carthSecondary?.in_supply ?? true;
  const secondaryLabel = carthSecondary?.army_id ?? 'secondary';
  const hasRegionController = secondaryExists ? getRegionController(state, hasRegion) : null;
  const sId = carthSecondary?.army_id;

  if (!secondaryExists) {
    LS('Carthage secondary destroyed — no order');
  } else if (hasCond <= 1) {
    // Broken: retreat
    const adj = getAdj(state, hasRegion);
    const safeRetreat = adj.find(r => {
      const ctrl = getRegionController(state, r);
      return (ctrl === 'carthage' || ctrl === 'neutral') &&
             enemyArmiesInRegion(state, r, 'carthage').length === 0;
    });
    if (safeRetreat && hasRegionController !== 'carthage') {
      orders.push({ type: 'move', army_id: sId, to_region: safeRetreat });
      LS(`${secondaryLabel} RETREATS to ${safeRetreat} [broken]`);
    } else {
      orders.push({ type: 'hold', army_id: sId });
      LS(`${secondaryLabel} HOLDS in ${hasRegion} [broken]`);
    }
  } else {
    // Build scored candidate list for secondary
    const sCandidates = [];
    const sAdj = getAdj(state, hasRegion);
    const hasRouteIdx = primaryExists ? -99 : HASDRUBAL_ROUTE.indexOf(hasRegion);
    // (if primary is alive, Hasdrubal holds Hispania — scored separately below)

    // HOLD — base score depends on situation
    // When primary is alive, holding Hispania is lower priority than depot+advance
    const holdScoreBase = primaryExists ? 2 : 1;
    sCandidates.push({ label: 'hold', score: holdScoreBase,
      reason: primaryExists ? 'guarding Hispania +2' : 'fallback +1',
      action: () => {
        orders.push({ type: 'hold', army_id: sId });
        LS(`${secondaryLabel} HOLDS in ${hasRegion} [${primaryExists ? 'defending Hispania' : 'waiting'}]`);
      }
    });

    // SCOUT (diminishing returns)
    const sScoutBase = Math.max(0, 3 - (scoutCount[sId] || 0));
    const sScoutTgt  = romePrimary ?? romeSecondary;
    if (initLeft >= 1 && sScoutTgt && sScoutBase > 0) {
      sCandidates.push({ label: `scout ${sScoutTgt.army_id}`, score: sScoutBase,
        reason: `base 3 minus ${scoutCount[sId]||0} prior scouts`,
        action: () => {
          orders.push({ type: 'scout', army_id: sId, target_army: sScoutTgt.army_id });
          scoutCount[sId] = (scoutCount[sId] || 0) + 1;
          initLeft--;
          LS(`${secondaryLabel} SCOUTS ${sScoutTgt.army_id}`);
        }
      });
    }

    // ESTABLISH DEPOT (support primary's supply chain)
    // Score highly when primary is beyond where Hasdrubal is — a depot here extends supply forward
    const canDepotSec = resources >= 1 && initLeft >= 1
      && hasRegionController === 'carthage'
      && !(state.depots||[]).find(d => d.side==='carthage' && d.region_id===hasRegion);
    if (canDepotSec) {
      // Higher value if primary is past this region on the route (supply chain extension)
      const priRouteIdx = primaryExists ? HANNIBAL_ROUTE.indexOf(hanRegion) : -1;
      const secRouteIdx = HANNIBAL_ROUTE.indexOf(hasRegion);
      const depotIsUseful = priRouteIdx > secRouteIdx || priRouteIdx === -1;
      // Fix 1: Mandatory depot when Hannibal is ahead on route AND OOS
      const hanIsAheadOnRoute = priRouteIdx > secRouteIdx;
      const hanIsOOS = primaryExists && !hanSup;
      const depotIsCritical = hanIsAheadOnRoute && hanIsOOS;
      // Fix 1: Also score 7 if current region is a waypoint on HASDRUBAL_ROUTE with no depot
      const onHasdrubalsRoute = HASDRUBAL_ROUTE.includes(hasRegion) || HASDRUBAL_ISLAND_ROUTE.includes(hasRegion);
      const depotSc = depotIsCritical ? 20   // Fix 1 CRITICAL — Hannibal is OOS, depot NOW
        : !hasSup ? 8                        // Hasdrubal himself OOS
        : depotIsUseful ? 6                  // depot extends chain toward primary
        : onHasdrubalsRoute ? 7              // Fix 1: waypoint on route — proactive chain
        : 3;                                 // proactive
      const depotReason = depotIsCritical ? `CRITICAL: Hannibal OOS ahead on route — depot NOW +20`
        : !hasSup ? 'OOS depot +8'
        : depotIsUseful ? 'depot extends supply toward primary +6'
        : onHasdrubalsRoute ? 'route waypoint proactive depot +7'
        : 'proactive depot +3';
      sCandidates.push({ label: 'establish_depot', score: depotSc,
        reason: depotReason,
        action: () => {
          orders.push({ type: 'establish_depot', army_id: sId });
          initLeft--;
          LS(`${secondaryLabel} ESTABLISHES DEPOT in ${hasRegion} [${depotReason}]`);
        }
      });
    }

    // ADVANCE toward front (when primary is alive) — move to extend depot chain
    // Hasdrubal should advance from hispania_ulterior → hispania_citerior to place depot closer
    // Fix 2: Determine whether Hasdrubal should use island route or alpine route
    if (primaryExists) {
      const navalCtrl = getNavalControl(state);
      const carthageHasNaval = navalCtrl === 'carthage' || navalCtrl === 'contested';
      const sicillyHasDepot = (state.depots||[]).some(d => d.side==='carthage' && d.region_id==='sicily');
      const hannibalInItaly = ['cisalpine_gaul','etruria','umbria_picenum','latium',
        'campania','samnium_lucania','bruttium_calabria'].includes(hanRegion);
      // Use island route when: Carthage has naval AND no Sicily depot yet AND Hannibal in Italy
      const useIslandRoute = carthageHasNaval && !sicillyHasDepot && hannibalInItaly;
      const activeRoute = useIslandRoute ? HASDRUBAL_ISLAND_ROUTE : HASDRUBAL_ROUTE;
      const activeRouteName = useIslandRoute ? 'island' : 'alpine';

      const priRouteIdx = HANNIBAL_ROUTE.indexOf(hanRegion);
      const secRouteIdx = activeRoute.indexOf(hasRegion);

      for (const r of sAdj) {
        if (enemyArmiesInRegion(state, r, 'carthage').length > 0) continue;
        if (getRegionController(state, r) === 'rome') continue;
        const rOnActiveRoute = activeRoute.indexOf(r);
        const rOnHanRoute = HANNIBAL_ROUTE.includes(r);

        // Special case: Sicily depot is the whole point of island route
        const islandSicillyMove = useIslandRoute && r === 'sicily'
          && !(state.depots||[]).some(d => d.side==='carthage' && d.region_id==='sicily');

        // Determine if this move is forward progress on the active route
        // For island route: only score moves on the island route (don't wander to alpine route)
        // For alpine route: also allow moves onto Hannibal's route when off-route
        const isForwardOnRoute = useIslandRoute
          ? (rOnActiveRoute >= 0 && rOnActiveRoute > secRouteIdx)
          : (rOnActiveRoute > secRouteIdx || (rOnHanRoute && !activeRoute.includes(r)));

        // Score forward moves on active route toward primary/Italy
        if (isForwardOnRoute || islandSicillyMove) {
          const destSup = wouldBeInSupply(state, r, 'carthage');
          // Island route Sicily move is highest priority among advances
          let sc = islandSicillyMove ? 12 + urg
            : 5 + (destSup ? 2 : -1) + urg;
          // Extra bonus: if primary is OOS and this move places Hasdrubal closer to primary's path
          if (!hanSup && rOnHanRoute) sc += 3;
          const reason2 = islandSicillyMove
            ? `island route: advance to Sicily for depot; urgency+${urg}`
            : `advance toward front (${activeRouteName} route); destSup=${destSup}; urgency+${urg}`;
          if (sc > 0) {
            const r2 = r;
            sCandidates.push({ label: `move→${r2}`, score: sc, reason: reason2,
              action: () => {
                orders.push({ type: 'move', army_id: sId, to_region: r2 });
                LS(`${secondaryLabel} ADVANCES to ${r2} [${activeRouteName} route, extending supply chain]`);
              }
            });
          }
        }
      }

      // Fix 2: Also add special depot candidate for Sicily if Hasdrubal is ON Sicily
      if (hasRegion === 'sicily' && hasRegionController === 'carthage' && resources >= 1
          && initLeft >= 1
          && !(state.depots||[]).find(d => d.side==='carthage' && d.region_id==='sicily')) {
        sCandidates.push({ label: 'establish_depot', score: 20,
          reason: 'Fix2: Hasdrubal on Sicily — island depot CRITICAL +20',
          action: () => {
            orders.push({ type: 'establish_depot', army_id: sId });
            initLeft--;
            LS(`${secondaryLabel} ESTABLISHES DEPOT in Sicily [island route critical!]`);
          }
        });
      }
    }

    // MOVE candidates
    if (!hasSup) {
      // OOS: priority is getting back to supply
      for (const r of sAdj) {
        if (enemyArmiesInRegion(state, r, 'carthage').length > 0) continue;
        if (!wouldBeInSupply(state, r, 'carthage')) continue;
        sCandidates.push({ label: `move→${r}`, score: 8 + urg,
          reason: 'OOS retreat to supply',
          action: () => {
            orders.push({ type: 'move', army_id: sId, to_region: r });
            LS(`${secondaryLabel} RETREATS to ${r} [OOS — seeking supply]`);
          }
        });
      }
    } else if (!primaryExists) {
      // Primary gone — secondary becomes main attack army, march toward Italy
      for (const r of sAdj) {
        if (enemyArmiesInRegion(state, r, 'carthage').length > 0) continue;
        let sc = 0;
        const reasons2 = [];

        const rHasIdx = HASDRUBAL_ROUTE.indexOf(r);
        const isNextStep = (hasRouteIdx >= 0 && hasRouteIdx < HASDRUBAL_ROUTE.length - 1)
          ? (HASDRUBAL_ROUTE[hasRouteIdx + 1] === r) : false;
        const isRecovery = hasRouteIdx < 0 && HASDRUBAL_ROUTE.includes(r);
        const isForward  = rHasIdx > hasRouteIdx && hasRouteIdx >= 0;

        if (isNextStep)   { sc += 8; reasons2.push('on-route +8'); }
        else if (isRecovery) { sc += 7; reasons2.push('route-recovery +7'); }
        else if (isForward)  { sc += 5; reasons2.push('forward +5'); }

        const destSup = wouldBeInSupply(state, r, 'carthage');
        if (destSup) { sc += 3; reasons2.push('dest in-supply +3'); }
        else if (turnsLeft <= 2) { sc -= 6; reasons2.push('season-end OOS -6'); }
        else { sc -= 1; reasons2.push('dest OOS -1'); }

        sc += urg;
        if (urg > 0) reasons2.push(`urgency +${urg}`);

        if (sc > 0) {
          const r2 = r;
          sCandidates.push({ label: `move→${r2}`, score: sc, reason: reasons2.join(', '),
            action: () => {
              orders.push({ type: 'move', army_id: sId, to_region: r2 });
              LS(`${secondaryLabel} MARCHES ${hasRegion} → ${r2} [main army, primary gone]`);
            }
          });
        }
      }
    } else {
      // Primary alive — secondary holds Hispania but can probe forward when primary is in Italy
      const primaryInItaly = ['cisalpine_gaul','etruria','umbria_picenum','latium',
                              'campania','samnium_lucania','bruttium_calabria'].includes(hanRegion);
      if (primaryInItaly && hasCond >= 3) {
        for (const r of sAdj) {
          if (getRegionController(state, r) === 'rome') continue;
          if (enemyArmiesInRegion(state, r, 'carthage').length > 0) continue;
          if (r === hasRegion) continue;
          const destSup = wouldBeInSupply(state, r, 'carthage');
          const sc = 5 + urg + (destSup ? 2 : (turnsLeft <= 2 ? -99 : -1));
          if (sc > 0) {
            const r2 = r;
            sCandidates.push({ label: `move→${r2}`, score: sc,
              reason: `probe forward (primary in Italy); destSup=${destSup}; urgency+${urg}`,
              action: () => {
                orders.push({ type: 'move', army_id: sId, to_region: r2 });
                LS(`${secondaryLabel} PROBES toward ${r2} [primary in Italy]`);
              }
            });
          }
        }
      }
    }

    sCandidates.sort((a, b) => b.score - a.score);
    const sSelected = sCandidates[0];
    logCandidates(label2, sCandidates, sSelected);
    sSelected.action();
  }

  return orders;
}

// Rome counter-offensive route into Hispania (when no threat in Italy)
const ROME_OFFENSIVE_ROUTE = [
  'cisalpine_gaul','liguria','transalpine_gaul','pyrenean_passes','hispania_citerior'
];

// ── Rome strategy ─────────────────────────────────────────────────
function decideRomeOrders(state, tokens) {
  const orders    = [];
  let initLeft    = getInitiative(state, 'rome');
  const urg       = urgency(state);
  const turnsLeft = turnsUntilWinter(state);

  // Resolve roles dynamically
  const { primary: romePrimary, secondary: romeSecondary }   = resolveRoles(state, 'rome');
  const { primary: carthPrimary, secondary: carthSecondary } = resolveRoles(state, 'carthage');

  const primaryExists   = !!romePrimary;
  const secondaryExists = !!romeSecondary;

  // Carthage threat tracking
  const ITALY_REGIONS = ['cisalpine_gaul','etruria','umbria_picenum','latium',
                          'campania','samnium_lucania','bruttium_calabria'];
  const cartPrimRegion = carthPrimary?.true_region  ?? null;
  const cartSecRegion  = carthSecondary?.true_region ?? null;
  const primInItaly    = carthPrimary   && ITALY_REGIONS.includes(cartPrimRegion);
  const secInItaly     = carthSecondary && ITALY_REGIONS.includes(cartSecRegion);
  const threatInItaly  = primInItaly || secInItaly;
  const threatRegion   = primInItaly ? cartPrimRegion : (secInItaly ? cartSecRegion : null);
  const hanRegion      = carthPrimary?.true_region ?? null;

  const year  = state.campaign?.current_year ?? 1;
  const turn  = state.campaign?.current_season_turn ?? 1;

  // ── PRIMARY (interceptor / Consular role) ─────────────────────────
  const conRegion    = romePrimary?.true_region ?? null;
  const conCond      = conditionRank(romePrimary?.condition);
  const conSup       = romePrimary?.in_supply ?? true;
  const primaryLabel = romePrimary?.army_id ?? 'primary';
  const pLabel       = `ROME primary Y${year}T${turn}`;
  const pId          = romePrimary?.army_id;

  if (!primaryExists) {
    LS('Rome primary destroyed — no order');
  } else if (conCond <= 1) {
    // Broken — retreat toward Latium
    const adj = getAdj(state, conRegion);
    if (adj.includes('latium') && conRegion !== 'latium') {
      orders.push({ type: 'move', army_id: pId, to_region: 'latium' });
      LS(`${primaryLabel} RETREATS to Latium [broken]`);
    } else {
      orders.push({ type: 'hold', army_id: pId });
      LS(`${primaryLabel} HOLDS in ${conRegion} [broken]`);
    }
  } else {
    // Build scored candidate list
    const pCandidates = [];
    const pAdj = getAdj(state, conRegion);

    // --- SIEGE: stickiness — if actively besieging, add top-priority continuation ---
    const activeSiegeRome = getActiveSiege(state, pId);
    if (activeSiegeRome && activeSiegeRome.region.region_id === conRegion && initLeft >= 1) {
      const aSP = activeSiegeRome.sp;
      pCandidates.push({ label: `siege(continue)→${aSP.point_id}`, score: 15,
        reason: 'active siege continuation: priority 15',
        action: () => {
          orders.push({ type: 'siege', army_id: pId, sp_id: aSP.point_id });
          initLeft--;
          LS(`${primaryLabel} CONTINUES SIEGE of ${aSP.name} in ${conRegion}`);
        }
      });
    }

    // HOLD
    pCandidates.push({ label: 'hold', score: 2, reason: 'fallback +2',
      action: () => {
        orders.push({ type: 'hold', army_id: pId });
        LS(`${primaryLabel} HOLDS in ${conRegion}`);
      }
    });

    // SCOUT (diminishing returns)
    const pScoutBase = Math.max(0, 3 - (scoutCount[pId] || 0));
    const pScoutTgt  = carthPrimary ?? carthSecondary;
    if (initLeft >= 1 && pScoutTgt && pScoutBase > 0) {
      pCandidates.push({ label: `scout ${pScoutTgt.army_id}`, score: pScoutBase,
        reason: `base 3 minus ${scoutCount[pId]||0} prior scouts`,
        action: () => {
          orders.push({ type: 'scout', army_id: pId, target_army: pScoutTgt.army_id });
          scoutCount[pId] = (scoutCount[pId] || 0) + 1;
          initLeft--;
          LS(`${primaryLabel} SCOUTS ${pScoutTgt.army_id}`);
        }
      });
    }

    // MOVE candidates
    if (!conSup) {
      // OOS: priority is supply retreat
      for (const r of pAdj) {
        if (enemyArmiesInRegion(state, r, 'rome').length > 0) continue;
        if (!wouldBeInSupply(state, r, 'rome')) continue;
        pCandidates.push({ label: `move→${r}`, score: 9 + urg,
          reason: 'OOS retreat to supply',
          action: () => {
            orders.push({ type: 'move', army_id: pId, to_region: r });
            LS(`${primaryLabel} RETREATS to ${r} [OOS — seeking supply]`);
          }
        });
      }
    } else {
      // In supply — generate scored moves
      for (const r of pAdj) {
        const hasEnemiesR = enemyArmiesInRegion(state, r, 'rome').length > 0;
        // Only avoid enemy regions when Rome is too weak to fight
        if (hasEnemiesR && conCond <= 2) continue;
        let sc = 0;
        const reasons = [];

        if (hasEnemiesR) {
          sc -= 2;
          reasons.push('enter battle -2');
        }

        if (!carthPrimary && !carthSecondary) {
          // All Carthage armies destroyed — push toward Africa
          const offTargets = ['bruttium_calabria','sicily','numidia_east','africa_proper',
                               'hispania_citerior','hispania_ulterior'];
          if (offTargets.includes(r)) {
            sc += 10; reasons.push('offensive to Africa +10');
          } else {
            sc += 4; reasons.push('advance +4');
          }
        } else if (threatInItaly) {
          // Enemy in Italy — intercept/approach
          if (r === threatRegion) {
            sc += 10; reasons.push('direct intercept +10');
          } else {
            // Does r bring us closer to threat?
            const adjR = getAdj(state, r);
            if (adjR.includes(threatRegion)) {
              sc += 8; reasons.push('step toward threat +8');
            } else {
              sc += 3; reasons.push('general move +3');
            }
          }
        } else if (carthPrimary) {
          // Enemy approaching — try to intercept or block route
          const hanIdx = hanRegion ? HANNIBAL_ROUTE.indexOf(hanRegion) : -1;
          if (r === cartPrimRegion) {
            // Direct intercept
            sc += 10; reasons.push('direct intercept +10');
          } else if (hanIdx >= 0 && hanIdx < HANNIBAL_ROUTE.length - 1
                     && r === HANNIBAL_ROUTE[hanIdx + 1]) {
            // Blocking next route step
            sc += 8; reasons.push("blocks Hannibal's next step +8");
          } else {
            // General advance toward Hispania (offense)
            const offIdx = ROME_OFFENSIVE_ROUTE.indexOf(conRegion);
            const rOffIdx = ROME_OFFENSIVE_ROUTE.indexOf(r);
            if (rOffIdx > offIdx) {
              sc += 6; reasons.push('advance into Hispania +6');
            } else {
              sc += 3; reasons.push('general move +3');
            }
          }
        } else if (!carthPrimary && carthSecondary) {
          // Primary dead, secondary marching — intercept or push into Hispania
          if (r === cartSecRegion) {
            sc += 10; reasons.push('intercept Hasdrubal +10');
          } else {
            const offIdx = ROME_OFFENSIVE_ROUTE.indexOf(conRegion);
            const rOffIdx = ROME_OFFENSIVE_ROUTE.indexOf(r);
            if (rOffIdx > offIdx) {
              sc += 6; reasons.push('advance into Hispania +6');
            } else {
              sc += 3; reasons.push('general advance +3');
            }
          }
        }

        // Supply modifiers
        const destInSup = wouldBeInSupply(state, r, 'rome');
        if (destInSup) {
          sc += 2; reasons.push('dest in-supply +2');
        } else if (turnsLeft <= 2) {
          sc -= 5; reasons.push('season-end OOS -5');
        } else {
          sc -= 1; reasons.push('dest OOS -1');
        }

        // Condition modifier
        if (conCond <= 2) {
          sc -= 2; reasons.push('depleted -2');
        }

        // Urgency
        sc += urg;
        if (urg > 0) reasons.push(`urgency +${urg}`);

        if (sc > 0) {
          const r2 = r;
          pCandidates.push({ label: `move→${r2}`, score: sc, reason: reasons.join(', '),
            action: () => {
              orders.push({ type: 'move', army_id: pId, to_region: r2 });
              LS(`${primaryLabel} MOVES ${conRegion} → ${r2}`);
            }
          });
        }
      }
    }

    // --- SIEGE: new siege against enemy SP in current region ---
    if (romePrimary.siege_equipment && initLeft >= 1) {
      const enemySPsR = getEnemySPsInRegion(state, conRegion, 'rome');
      if (enemySPsR.length > 0) {
        const targetSPR = enemySPsR.slice().sort((a, b) =>
          (b.breach_points_accumulated || 0) - (a.breach_points_accumulated || 0)
        )[0];
        let siegeScoreR = 12 + urg;
        const reasonsR = ['siege base 12'];
        if (urg > 0) reasonsR.push(`urgency +${urg}`);
        if (targetSPR.under_siege && targetSPR.besieging_army_id === pId) {
          siegeScoreR += 2; reasonsR.push('already besieging +2');
        }
        if (conCond <= 2) { siegeScoreR -= 3; reasonsR.push('depleted penalty -3'); }
        pCandidates.push({ label: `siege→${targetSPR.point_id}`, score: siegeScoreR,
          reason: reasonsR.join(', '),
          action: () => {
            orders.push({ type: 'siege', army_id: pId, sp_id: targetSPR.point_id });
            initLeft--;
            LS(`${primaryLabel} BESIEGES ${targetSPR.name} (fort:${targetSPR.fortification_rating}, breach:${targetSPR.breach_points_accumulated}) in ${conRegion}`);
          }
        });
      }
    } else if (!romePrimary.siege_equipment) {
      const enemySPsNoEqR = getEnemySPsInRegion(state, conRegion, 'rome');
      if (enemySPsNoEqR.length > 0) {
        for (const c of pCandidates) {
          if (c.label.startsWith('move→')) {
            c.score -= 1;
            c.reason += ', no-siege-equip-nearby -1';
          }
        }
        LS(`${primaryLabel}: no siege equipment — ${enemySPsNoEqR.length} enemy SP(s) in ${conRegion}, move scores reduced`);
      }
    }

    // --- FEINT: plant a false position on Carthage's intel map ---
    const pAdj2 = getAdj(state, conRegion);
    const pRegionController = getRegionController(state, conRegion);
    const canFeintRome = initLeft >= 1
      && !romePrimary.feint_region    // not already feinting
      && conCond >= 3                 // good or worn only
      && pRegionController !== 'rome'; // in enemy or neutral territory
    if (canFeintRome && pAdj2.length > 0) {
      // Prefer a region BEHIND current position on Rome's offensive route
      const conOffIdx = ROME_OFFENSIVE_ROUTE.indexOf(conRegion);
      const behindRome = pAdj2.filter(r => {
        const rIdx = ROME_OFFENSIVE_ROUTE.indexOf(r);
        return rIdx >= 0 && rIdx < conOffIdx;
      });
      const feintTargetRome = behindRome.length > 0
        ? behindRome[behindRome.length - 1]
        : pAdj2[0];
      const feintScoreRome = 6 + Math.floor(urg / 2);
      pCandidates.push({ label: `feint→${feintTargetRome}`, score: feintScoreRome,
        reason: `feint base 6 + urgency/2=${Math.floor(urg/2)}; mislead Carthage`,
        action: () => {
          orders.push({ type: 'feint', army_id: pId, to_region: feintTargetRome });
          initLeft--;
          LS(`${primaryLabel} FEINTS toward ${feintTargetRome} [true position: ${conRegion}]`);
        }
      });
    }

    pCandidates.sort((a, b) => b.score - a.score);
    const pSelected = pCandidates[0];
    logCandidates(pLabel, pCandidates, pSelected);
    pSelected.action();
  }

  // ── SECONDARY (reserve / defender role) ───────────────────────────
  const resRegion    = romeSecondary?.true_region ?? null;
  const resCond      = conditionRank(romeSecondary?.condition);
  const resSup       = romeSecondary?.in_supply ?? true;
  const secondaryLabel = romeSecondary?.army_id ?? 'secondary';
  const sLabel       = `ROME secondary Y${year}T${turn}`;
  const sId          = romeSecondary?.army_id;

  if (!secondaryExists) {
    LS('Rome secondary destroyed — no order');
  } else if (resCond <= 1) {
    // Broken — retreat to Latium
    const adj = getAdj(state, resRegion);
    if (resRegion !== 'latium' && adj.includes('latium')) {
      orders.push({ type: 'move', army_id: sId, to_region: 'latium' });
      LS(`${secondaryLabel} RETREATS to Latium [broken]`);
    } else {
      orders.push({ type: 'hold', army_id: sId });
      LS(`${secondaryLabel} HOLDS in ${resRegion} [broken]`);
    }
  } else if (resCond <= 2 && resRegion !== 'latium') {
    // Depleted — fall back to Rome
    const adj = getAdj(state, resRegion);
    if (adj.includes('latium')) {
      orders.push({ type: 'move', army_id: sId, to_region: 'latium' });
      LS(`${secondaryLabel} RETREATS to Latium [depleted]`);
    } else {
      orders.push({ type: 'hold', army_id: sId });
      LS(`${secondaryLabel} HOLDS in ${resRegion} [depleted, can't reach Rome]`);
    }
  } else {
    // Build scored candidate list
    const sCandidates = [];
    const sAdj = getAdj(state, resRegion);
    const conRegionForSec = romePrimary?.true_region ?? null;
    const conCondForSec   = conditionRank(romePrimary?.condition);

    // HOLD
    sCandidates.push({ label: 'hold', score: 2, reason: 'fallback +2',
      action: () => {
        orders.push({ type: 'hold', army_id: sId });
        LS(`${secondaryLabel} HOLDS in ${resRegion}`);
      }
    });

    // SCOUT (diminishing returns)
    const sScoutBase = Math.max(0, 3 - (scoutCount[sId] || 0));
    const sScoutTgt  = carthPrimary ?? carthSecondary;
    if (initLeft >= 1 && sScoutTgt && sScoutBase > 0) {
      sCandidates.push({ label: `scout ${sScoutTgt.army_id}`, score: sScoutBase,
        reason: `base 3 minus ${scoutCount[sId]||0} prior scouts`,
        action: () => {
          orders.push({ type: 'scout', army_id: sId, target_army: sScoutTgt.army_id });
          scoutCount[sId] = (scoutCount[sId] || 0) + 1;
          initLeft--;
          LS(`${secondaryLabel} SCOUTS ${sScoutTgt.army_id}`);
        }
      });
    }

    // MOVE candidates
    if (!resSup) {
      // OOS: supply retreat priority
      for (const r of sAdj) {
        if (enemyArmiesInRegion(state, r, 'rome').length > 0) continue;
        if (!wouldBeInSupply(state, r, 'rome')) continue;
        sCandidates.push({ label: `move→${r}`, score: 9 + urg,
          reason: 'OOS retreat to supply',
          action: () => {
            orders.push({ type: 'move', army_id: sId, to_region: r });
            LS(`${secondaryLabel} RETREATS to ${r} [OOS — seeking supply]`);
          }
        });
      }
    } else {
      for (const r of sAdj) {
        const hasEnemiesS = enemyArmiesInRegion(state, r, 'rome').length > 0;
        if (hasEnemiesS && resCond <= 2) continue;
        let sc = 0;
        const reasons = [];

        if (hasEnemiesS) {
          sc -= 2;
          reasons.push('enter battle -2');
        }

        // Support weak primary (highest priority)
        if (primaryExists && conCondForSec <= 2 && r === conRegionForSec) {
          sc += 9; reasons.push('support weak primary +9');
        } else if (threatInItaly) {
          if (r === threatRegion) {
            sc += 8; reasons.push('confront Italy threat +8');
          } else if (r === 'campania' || r === 'latium' || r === 'etruria' || r === 'umbria_picenum') {
            sc += 6; reasons.push('cover Italy approach +6');
          } else {
            const adjR = getAdj(state, r);
            if (adjR.includes(threatRegion)) {
              sc += 5; reasons.push('step toward threat +5');
            }
          }
        } else if (!carthPrimary && !carthSecondary) {
          // Offensive — push toward Sicily/Africa
          const offT = ['bruttium_calabria','sicily','campania','samnium_lucania'];
          if (offT.includes(r) && getRegionController(state, r) !== 'rome') {
            sc += 6; reasons.push('offensive push +6');
          } else {
            sc += 3; reasons.push('advance +3');
          }
        } else {
          // Carthage approaching Italy — position defensively
          const defPos = ['latium','campania','etruria','umbria_picenum'];
          if (defPos.includes(r)) {
            sc += 6; reasons.push('move to defensive position +6');
          } else {
            sc += 3; reasons.push('general move +3');
          }
        }

        // Supply modifiers
        const destInSup = wouldBeInSupply(state, r, 'rome');
        if (destInSup) {
          sc += 2; reasons.push('dest in-supply +2');
        } else if (turnsLeft <= 2) {
          sc -= 5; reasons.push('season-end OOS -5');
        } else {
          sc -= 1; reasons.push('dest OOS -1');
        }

        // Urgency
        sc += urg;
        if (urg > 0) reasons.push(`urgency +${urg}`);

        if (sc > 0) {
          const r2 = r;
          sCandidates.push({ label: `move→${r2}`, score: sc, reason: reasons.join(', '),
            action: () => {
              orders.push({ type: 'move', army_id: sId, to_region: r2 });
              LS(`${secondaryLabel} MOVES ${resRegion} → ${r2}`);
            }
          });
        }
      }
    }

    sCandidates.sort((a, b) => b.score - a.score);
    const sSelected = sCandidates[0];
    logCandidates(sLabel, sCandidates, sSelected);
    sSelected.action();
  }

  return orders;
}

// ── Force/Refuse declarations ─────────────────────────────────────
async function handleForceRefuse(state, tokens) {
  const pending = state.pending_encounters || [];
  if (pending.length === 0) return;

  // Build declaration arrays per side
  const cartDeclarations = [];
  const romeDeclarations = [];

  for (const enc of pending) {
    const { encounter_id, region, consecutive_refusals } = enc;
    const forceIsFree = (consecutive_refusals || 0) >= 2;

    // Find armies in this region
    const cartArmy = (state.armies||[]).find(a =>
      a.true_region === region && a.side === 'carthage');
    const romeArmy = (state.armies||[]).find(a =>
      a.true_region === region && a.side === 'rome');

    // ── Carthage decision ──
    if (enc.carthage) {
      const cartCond = conditionRank(cartArmy?.condition || 'worn');
      const cartSup  = cartArmy?.in_supply ?? true;
      const cartInit = getSide(state, 'carthage').initiative_pool ?? 0;
      // Force if: strong condition, in supply, and either free or has initiative
      const canForce = forceIsFree || cartInit >= 1;
      const cartChoice = (cartCond >= 3 && cartSup && canForce) ? 'force' : 'accept';
      cartDeclarations.push({ encounter_id, choice: cartChoice });
      LS(`Enc ${encounter_id} in ${region} — Carthage: ${cartChoice}`);
    }

    // ── Rome decision ──
    if (enc.rome) {
      const romeCond = conditionRank(romeArmy?.condition || 'worn');
      const romeInit = getSide(state, 'rome').initiative_pool ?? 0;
      // Rome: accept if strong, refuse if worn or worse (Fabian)
      let romeChoice;
      if (romeCond <= 2) {
        romeChoice = 'refuse'; // depleted/broken — always refuse
      } else if (romeCond === 3) {
        romeChoice = Math.random() > 0.5 ? 'accept' : 'refuse'; // worn — coin flip
      } else {
        romeChoice = 'accept'; // good condition — accept
      }
      romeDeclarations.push({ encounter_id, choice: romeChoice });
      LS(`Enc ${encounter_id} in ${region} — Rome: ${romeChoice}`);
    }
  }

  // Submit declarations for each side that has encounters
  if (cartDeclarations.length > 0) {
    const res = await post('/force-refuse/declare',
      { declarations: cartDeclarations }, tokens.carthage);
    if (res?.error) L(`  Carthage force/refuse error: ${JSON.stringify(res)}`);
  }
  if (romeDeclarations.length > 0) {
    const res = await post('/force-refuse/declare',
      { declarations: romeDeclarations }, tokens.rome);
    if (res?.error) L(`  Rome force/refuse error: ${JSON.stringify(res)}`);
  }
}

// ── Turn summary ──────────────────────────────────────────────────
function printTurnSummary(state) {
  const t = state.campaign?.current_season_turn ?? '?';
  const y = state.campaign?.current_year ?? '?';
  const p = state.campaign?.phase ?? '?';
  L(`\n── Year ${y} Turn ${t} [${p}] ──`);

  for (const a of (state.armies || [])) {
    const id  = a.army_id;
    const sup = a.in_supply ? '✓' : '✗';
    L(`  ${id.padEnd(16)} ${(a.true_region||'?').padEnd(22)} `+
      `${(a.condition||'?').padEnd(10)} ${(a.experience||'?').padEnd(10)} supply:${sup}`);
  }
  for (const side of ['rome','carthage']) {
    const s = getSide(state, side);
    L(`  ${side.padEnd(12)} res:${s.resources??'?'} init:${s.initiative_pool??'?'} VP:${s.vp_total??0}`);
  }
  L(`  Naval: ${getNavalControl(state)}`);

  const battles = state.pending_battles || [];
  if (battles.length) L(`  Pending battles: ${battles.map(b=>b.region).join(', ')}`);
}

// ── Analytics ─────────────────────────────────────────────────────
class Analytics {
  constructor() {
    this.turns         = 0;
    this.vp            = { rome: [], carthage: [] };
    this.resources     = { rome: [], carthage: [] };
    this.initiative    = { rome: [], carthage: [] };
    // Track initiative pool at START of each turn (before orders deduct it)
    // so we can measure "available" vs "spent"
    this.initAvailable = { rome: [], carthage: [] };
    this.conditions    = { hannibal:[], hasdrubal:[], consular:[], reserve:[] };
    this.supply        = { hannibal:[], hasdrubal:[], consular:[], reserve:[] };
    this.experience    = { hannibal:[], hasdrubal:[], consular:[], reserve:[] };
    this.positions     = { hannibal:[], hasdrubal:[], consular:[], reserve:[] };
    this.naval         = [];
    this.battles       = [];
    this.condDrops     = [];
    this.controlChanges= [];
    this.spCaptures    = { rome: 0, carthage: 0 };
    this.maxDepotsCartage = 0;  // peak depot count for Carthage
    this.prev          = null;
    this.winner        = null;
    this.finalYear     = 1;
  }

  snap(state) {
    this.turns++;
    const t = state.campaign?.current_season_turn ?? this.turns;
    const y = state.campaign?.current_year ?? 1;
    this.finalYear = y;
    if (state.campaign?.winner) this.winner = state.campaign.winner;

    this.vp.rome.push(getVP(state,'rome'));
    this.vp.carthage.push(getVP(state,'carthage'));
    this.resources.rome.push(getResources(state,'rome'));
    this.resources.carthage.push(getResources(state,'carthage'));

    // initiative_pool at snap time is REMAINING after orders — useful for "waste" metric
    const rInit = getInitiative(state,'rome');
    const cInit = getInitiative(state,'carthage');
    this.initiative.rome.push(rInit);
    this.initiative.carthage.push(cInit);
    // initAvailable: pool before orders = remaining + what was spent this turn
    // We can't directly know spend, but we track remaining for waste analysis
    this.naval.push(getNavalControl(state));

    for (const a of (state.armies || [])) {
      const id = a.army_id;
      // Initialise tracking arrays on first encounter (handles raised armies like carthage_raised_5)
      if (!this.conditions[id])  this.conditions[id]  = [];
      if (!this.supply[id])      this.supply[id]      = [];
      if (!this.experience[id])  this.experience[id]  = [];
      if (!this.positions[id])   this.positions[id]   = [];

      this.conditions[id].push(a.condition);
      this.supply[id].push(a.in_supply);
      this.experience[id].push(a.experience);
      this.positions[id].push(a.true_region);

      if (this.prev) {
        const pa = (this.prev.armies||[]).find(x => x.army_id === id);
        if (pa && conditionRank(a.condition) < conditionRank(pa.condition)) {
          this.condDrops.push({
            turn: t, year: y, army: id,
            from: pa.condition, to: a.condition,
            region: a.true_region, supply: a.in_supply ? 'in' : 'out'
          });
        }
      }
    }

    // Region control changes
    if (this.prev) {
      for (const r of (state.regions||[])) {
        const pr = (this.prev.regions||[]).find(x => x.region_id === r.region_id);
        if (pr && pr.controller !== r.controller) {
          this.controlChanges.push({
            turn: t, year: y, region: r.region_id,
            from: pr.controller, to: r.controller
          });
        }
      }
    }

    // SP captures: scan log entries added since previous snap
    const prevLogLen = this.prev ? (this.prev.log || []).length : 0;
    const newLogEntries = (state.log || []).slice(prevLogLen);
    for (const entry of newLogEntries) {
      if (entry.type === 'sp_captured' && entry.side) {
        this.spCaptures[entry.side] = (this.spCaptures[entry.side] || 0) + 1;
      }
    }

    // Track peak Carthage depot count
    const cartDepotsNow = (state.depots||[]).filter(d => d.side==='carthage').length;
    if (cartDepotsNow > this.maxDepotsCartage) this.maxDepotsCartage = cartDepotsNow;

    this.prev = JSON.parse(JSON.stringify(state));
  }

  recordBattle(battle, res) {
    this.battles.push({
      turn: this.turns,
      region: battle.region,
      winner: res.winner,
      loss_type: res.loss_type,
      cartRoll: res._debug?.cartRoll,
      romeRoll: res._debug?.romeRoll,
    });
  }

  avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
  pct(arr, fn) { return arr.length ? (arr.filter(fn).length / arr.length * 100) : 0; }
  max(arr) { return arr.length ? Math.max(...arr) : 0; }
  min(arr) { return arr.length ? Math.min(...arr) : 0; }

  // Returns a compact summary object for cross-run aggregation
  summary() {
    const rVP = this.vp.rome.at(-1) ?? 0;
    const cVP = this.vp.carthage.at(-1) ?? 0;
    const winner = this.winner ?? (rVP >= cVP ? 'rome' : 'carthage');

    const hanPositions = [...new Set((this.positions.hannibal || []).filter(Boolean))];
    const italyRegions = ['cisalpine_gaul','etruria','umbria_picenum','latium',
                          'campania','samnium_lucania','bruttium_calabria'];
    const defections = this.controlChanges.filter(c => c.from==='rome' && c.to==='carthage');

    return {
      winner,
      finalVP:    { rome: rVP, carthage: cVP },
      vpGap:      Math.abs(rVP - cVP),
      turns:      this.turns,
      finalYear:  this.finalYear,

      // Economy
      avgResources: {
        rome:     +this.avg(this.resources.rome).toFixed(2),
        carthage: +this.avg(this.resources.carthage).toFixed(2),
      },
      pctTurnsRes0: {
        rome:     +this.pct(this.resources.rome,    x => x === 0).toFixed(1),
        carthage: +this.pct(this.resources.carthage, x => x === 0).toFixed(1),
      },
      maxResources: {
        rome:     this.max(this.resources.rome),
        carthage: this.max(this.resources.carthage),
      },
      avgInitRemaining: {
        rome:     +this.avg(this.initiative.rome).toFixed(2),
        carthage: +this.avg(this.initiative.carthage).toFixed(2),
      },
      pctTurnsInit0: {
        rome:     +this.pct(this.initiative.rome,    x => x === 0).toFixed(1),
        carthage: +this.pct(this.initiative.carthage, x => x === 0).toFixed(1),
      },
      pctTurnsInit3plus: {
        // "wasted" turns — ended turn with ≥3 initiative unspent (pool is 4)
        rome:     +this.pct(this.initiative.rome,    x => x >= 3).toFixed(1),
        carthage: +this.pct(this.initiative.carthage, x => x >= 3).toFixed(1),
      },

      // Battles
      battles:        this.battles.length,
      carthageWins:   this.battles.filter(b => b.winner === 'carthage').length,
      romeWins:       this.battles.filter(b => b.winner === 'rome').length,
      decisiveBattles:this.battles.filter(b => b.loss_type === 'decisive').length,

      // Supply (named armies — may be empty arrays if army was replaced; safe via || [])
      hannibalOOSpct: +this.pct(this.supply.hannibal  || [], x => !x).toFixed(1),
      hasdrubalOOSpct:+this.pct(this.supply.hasdrubal || [], x => !x).toFixed(1),
      consularOOSpct: +this.pct(this.supply.consular  || [], x => !x).toFixed(1),
      reserveOOSpct:  +this.pct(this.supply.reserve   || [], x => !x).toFixed(1),

      // Attrition
      condDropsTotal: this.condDrops.length,
      condDropsByArmy: (() => {
        const m = {};
        for (const d of this.condDrops) m[d.army] = (m[d.army]||0) + 1;
        return m;
      })(),

      // Geography
      hannibalReachedItaly:  hanPositions.some(r => italyRegions.includes(r)),
      hannibalReachedLatium: hanPositions.includes('latium'),

      // Defections
      defections: defections.length,
      defectedRegions: defections.map(d => d.region),

      // Naval (% of turns each side held control)
      navalPct: {
        rome:      +this.pct(this.naval, x => x === 'rome').toFixed(1),
        carthage:  +this.pct(this.naval, x => x === 'carthage').toFixed(1),
        contested: +this.pct(this.naval, x => x === 'contested').toFixed(1),
      },

      // SP captures
      spCaptures: { rome: this.spCaptures.rome, carthage: this.spCaptures.carthage },

      // Depot tracking
      maxDepotsCartage: this.maxDepotsCartage,

      // Experience (named armies — safe fallback to empty array if army was replaced)
      finalExperience: {
        hannibal:  (this.experience.hannibal  || []).at(-1) || null,
        hasdrubal: (this.experience.hasdrubal || []).at(-1) || null,
        consular:  (this.experience.consular  || []).at(-1) || null,
        reserve:   (this.experience.reserve   || []).at(-1) || null,
      },
    };
  }

  report() {
    const DIV = '═'.repeat(60);
    L(`\n${DIV}`);
    L(`  POST-HOC BALANCE REPORT`);
    L(DIV);

    // 1. VP BALANCE
    L('\n[1] VP BALANCE');
    const rVP = this.vp.rome.at(-1) ?? 0;
    const cVP = this.vp.carthage.at(-1) ?? 0;
    L(`  Final — Rome: ${rVP}  Carthage: ${cVP}`);
    L(`  Winner: ${rVP > cVP ? 'ROME' : cVP > rVP ? 'CARTHAGE' : 'TIE'}  Gap: ${Math.abs(rVP-cVP)}`);
    L(`  VP trajectory (every 4 turns):`);
    for (let i = 0; i < this.vp.rome.length; i += 4) {
      L(`    T${String(i+1).padStart(2)}: Rome ${String(this.vp.rome[i]).padStart(3)}  Carthage ${String(this.vp.carthage[i]).padStart(3)}`);
    }

    // 2. RESOURCE & INITIATIVE ECONOMY
    L('\n[2] RESOURCE & INITIATIVE ECONOMY');
    const rRes0  = this.resources.rome.filter(x=>x===0).length;
    const cRes0  = this.resources.carthage.filter(x=>x===0).length;
    const rInit0 = this.initiative.rome.filter(x=>x===0).length;
    const cInit0 = this.initiative.carthage.filter(x=>x===0).length;
    const rInitWaste = this.initiative.rome.filter(x=>x>=3).length;
    const cInitWaste = this.initiative.carthage.filter(x=>x>=3).length;
    const n = Math.max(1, this.turns);
    L(`  Resources — avg/turn:  Rome ${this.avg(this.resources.rome).toFixed(1)}  Carthage ${this.avg(this.resources.carthage).toFixed(1)}`);
    L(`  Resources — peak:      Rome ${this.max(this.resources.rome)}  Carthage ${this.max(this.resources.carthage)}`);
    L(`  Resources — turns @ 0: Rome ${rRes0}/${n} (${(rRes0/n*100).toFixed(0)}%)  Carthage ${cRes0}/${n} (${(cRes0/n*100).toFixed(0)}%)`);
    L(`  Initiative — avg remaining/turn: Rome ${this.avg(this.initiative.rome).toFixed(1)}  Carthage ${this.avg(this.initiative.carthage).toFixed(1)}`);
    L(`  Initiative — turns @ 0:          Rome ${rInit0}/${n} (${(rInit0/n*100).toFixed(0)}%)  Carthage ${cInit0}/${n} (${(cInit0/n*100).toFixed(0)}%)`);
    L(`  Initiative — turns ≥3 remaining: Rome ${rInitWaste}/${n} (${(rInitWaste/n*100).toFixed(0)}%)  Carthage ${cInitWaste}/${n} (${(cInitWaste/n*100).toFixed(0)}%)  [≥3 = almost all IP unspent]`);
    if (rInit0 > 4 || cInit0 > 4)
      L(`  ⚠ INITIATIVE ECONOMY TIGHT — consider raising pool from 4`);
    if (rInitWaste/n > 0.4 || cInitWaste/n > 0.4)
      L(`  ⚠ INITIATIVE FREQUENTLY UNSPENT — pool may be too large or order costs too low`);
    if (rRes0 > 5 || cRes0 > 5)
      L(`  ⚠ RESOURCE ECONOMY TIGHT — consider raising starting resources`);

    // 3. SUPPLY
    L('\n[3] SUPPLY SYSTEM');
    const allArmyIdsSupply = Object.keys(this.supply);
    for (const id of allArmyIdsSupply) {
      const data = this.supply[id];
      if (!data || !data.length) continue;
      const oos  = data.filter(x=>!x).length;
      const pct  = (oos/data.length*100).toFixed(0);
      L(`  ${id.padEnd(16)}: out of supply ${oos}/${data.length} turns (${pct}%)`);
    }
    const hanSupplyData = this.supply.hannibal || [];
    const hanOOS = hanSupplyData.filter(x=>!x).length / Math.max(1, hanSupplyData.length);
    if (hanSupplyData.length && hanOOS < 0.15) L(`  ⚠ HANNIBAL RARELY OUT OF SUPPLY — radius may be too generous`);
    if (hanSupplyData.length && hanOOS > 0.65) L(`  ⚠ HANNIBAL FREQUENTLY OUT OF SUPPLY — may be too punishing`);

    // 4. CONDITION & ATTRITION
    L('\n[4] CONDITION & ATTRITION');
    L(`  Total condition drops: ${this.condDrops.length}`);
    for (const d of this.condDrops) {
      L(`    Y${d.year}T${d.turn} ${d.army}: ${d.from}→${d.to} in ${d.region} [supply:${d.supply}]`);
    }
    const dropsByArmy = {};
    for (const d of this.condDrops) dropsByArmy[d.army] = (dropsByArmy[d.army]||0)+1;
    for (const [army,n] of Object.entries(dropsByArmy)) {
      if (n >= 3) L(`  ⚠ ${army} dropped condition ${n} times — potential death spiral`);
    }
    L(`  Final conditions:`);
    for (const id of Object.keys(this.conditions)) {
      const cArr = this.conditions[id];
      if (!cArr || !cArr.length) continue;
      L(`    ${id.padEnd(16)}: ${cArr.at(-1)||'?'}`);
    }

    // 5. BATTLES
    L('\n[5] BATTLE OUTCOMES');
    L(`  Total battles: ${this.battles.length}`);
    const cWins = this.battles.filter(b=>b.winner==='carthage').length;
    const rWins = this.battles.filter(b=>b.winner==='rome').length;
    const dec   = this.battles.filter(b=>b.loss_type==='decisive').length;
    L(`  Carthage wins: ${cWins}  Rome wins: ${rWins}`);
    L(`  Decisive: ${dec}/${this.battles.length}`);
    if (this.battles.length < 3 && this.turns > 15)
      L(`  ⚠ FEW BATTLES — force/accept mechanic may be preventing engagement`);
    for (const b of this.battles) {
      L(`    T${b.turn} ${b.region}: ${b.winner} (${b.loss_type}) cart:${b.cartRoll} rome:${b.romeRoll}`);
    }

    // 6. REGION CONTROL & DEFECTIONS
    L('\n[6] REGION CONTROL CHANGES & SP CAPTURES');
    L(`  SP Captures — Rome: ${this.spCaptures.rome}  Carthage: ${this.spCaptures.carthage}`);
    const defections = this.controlChanges.filter(c=>c.from==='rome'&&c.to==='carthage');
    const captures   = this.controlChanges.filter(c=>c.from==='neutral'||c.to==='carthage');
    const recoveries = this.controlChanges.filter(c=>c.from==='carthage'&&c.to==='rome');
    L(`  Defections (Rome→Carthage): ${defections.length}`);
    for (const d of defections) L(`    Y${d.year}T${d.turn}: ${d.region}`);
    L(`  Recoveries (Carthage→Rome): ${recoveries.length}`);
    L(`  All control changes:`);
    for (const c of this.controlChanges) {
      L(`    Y${c.year}T${c.turn}: ${c.region} ${c.from}→${c.to}`);
    }
    if (defections.length === 0 && this.turns > 20)
      L(`  ⚠ NO DEFECTIONS — Hannibal may not be reaching Italy`);
    if (defections.length > 4)
      L(`  ⚠ MANY DEFECTIONS — Rome may be unable to defend allies`);

    // 7. NAVAL
    L('\n[7] NAVAL CONTROL');
    const cNav = this.naval.filter(x=>x==='carthage').length;
    const rNav = this.naval.filter(x=>x==='rome').length;
    const con  = this.naval.filter(x=>x==='contested').length;
    L(`  Carthage: ${cNav} turns  Rome: ${rNav} turns  Contested: ${con} turns`);
    if (rNav === 0) L(`  ⚠ ROME NEVER WON NAVAL — modifiers may be too skewed`);

    // 8. HANNIBAL'S MARCH
    L('\n[8] HANNIBAL MARCH PROGRESS');
    const visited = [...new Set((this.positions.hannibal || []).filter(Boolean))];
    L(`  Regions visited: ${visited.join(' → ')}`);
    const italyRegions = ['cisalpine_gaul','etruria','umbria_picenum','latium',
                          'campania','samnium_lucania','bruttium_calabria'];
    const reachedItaly  = visited.some(r => italyRegions.includes(r));
    const reachedLatium = visited.includes('latium');
    L(`  Reached Italy: ${reachedItaly?'YES':'NO'}`);
    L(`  Reached Latium: ${reachedLatium?'YES':'NO'}`);
    if (!reachedItaly && this.turns > 15)
      L(`  ⚠ HANNIBAL STALLED — Alpine crossing or supply may be too costly`);

    // 9. GAME LENGTH
    L('\n[9] GAME LENGTH');
    L(`  Total turns: ${this.turns} (expected ~40-50 for full 5-year campaign)`);
    if (this.turns < 12) L(`  ⚠ VERY SHORT — possible crash or instant game-over condition`);

    // 10. EXPERIENCE
    L('\n[10] EXPERIENCE PROGRESSION');
    for (const id of Object.keys(this.experience)) {
      const exps = (this.experience[id] || []).filter(Boolean);
      if (!exps.length) continue;
      const start = exps[0] || '?';
      const end   = exps.at(-1) || '?';
      L(`  ${id.padEnd(16)}: ${start} → ${end}`);
    }

    L(`\n${DIV}\n  END OF REPORT\n${DIV}\n`);
  }
}

// ── Main (single run) ─────────────────────────────────────────────
async function main(runIndex) {
  if (BATCH_MODE) {
    LB(`  Run ${runIndex + 1}/${BATCH_RUNS} starting…`);
  } else {
    LH('BELLUM PUNICUM — SIMULATION START');
  }

  const session = await post('/admin/sim/start', {});
  if (!session?.rome_token) {
    LB(`ERROR starting session (run ${runIndex+1}): ${JSON.stringify(session)}`);
    return null;
  }
  const tokens = { rome: session.rome_token, carthage: session.carthage_token };
  LS(`Tokens acquired`);

  // Reset per-game scout counters
  for (const k of Object.keys(scoutCount)) delete scoutCount[k];

  const analytics = new Analytics();
  let turn = 0;

  while (turn < MAX_TURNS) {
    turn++; // safety cap counter only — use state for real turn number
    await new Promise(r => setTimeout(r, DELAY_MS));

    const state = await get('/admin/sim/state');
    if (!state || state.error) { L(`State error: ${JSON.stringify(state)}`); break; }

    // Always use server's turn number for display
    const serverYear = state.campaign?.current_year ?? '?';
    const serverTurn = state.campaign?.current_season_turn ?? '?';

    analytics.snap(state);

    if (state.campaign?.winner) {
      printTurnSummary(state);
      LH(`GAME OVER — ${state.campaign.winner.toUpperCase()} WINS`);
      break;
    }

    const phase = (state.campaign?.phase || '').toLowerCase();

    // ── ALWAYS resolve pending battles first ─────────────────
    const pendingBattles = state.pending_battles || [];
    if (pendingBattles.length > 0 && phase !== 'battle') {
      L(`  ⚡ Resolving ${pendingBattles.length} pending battle(s) before orders`);
      for (const battle of pendingBattles) {
        const res = resolveBattle(state, battle);
        analytics.recordBattle(battle, res);
        L(`    ${battle.region}: ${res.winner} wins (${res.loss_type})`);
        const br = await post('/battle/resolve', {
          region: res.region,
          winner: res.winner,
          loss_type: res.loss_type,
          loser_retreats_to: res.loser_retreats_to
        }, tokens.carthage);
        if (br?.error) L(`    Resolve error: ${JSON.stringify(br)}`);
      }
      continue; // re-read state on next iteration — don't print summary yet
    }

    // Print summary only after battle cleanup, using fresh server state
    printTurnSummary(state);

    // ── ORDERS ──────────────────────────────────────────────
    if (phase === 'orders') {
      LH(`Y${serverYear}T${serverTurn} — ORDERS`);

      // ── SEASON BOUNDARY LOGGING ──────────────────────────
      // Print detailed supply/condition snapshot at season start (turn 1) and late season (turn 7+)
      const seasonLen = state.campaign?.season_turns_per_year || 8;
      const isSeasonStart = serverTurn === 1;
      const isSeasonEnd   = serverTurn >= seasonLen - 1; // turn 7 or 8 of 8
      if (isSeasonStart || isSeasonEnd) {
        const bdLabel = isSeasonStart ? 'SEASON START' : `LATE SEASON (T${serverTurn}/${seasonLen})`;
        L(`\n  ┌─── SEASON BOUNDARY: ${bdLabel} ───`);
        L(`  │  Year ${serverYear}, Turn ${serverTurn} of ${seasonLen}`);
        for (const a of (state.armies || [])) {
          const id     = a.army_id;
          const sup    = a.in_supply ? 'IN SUPPLY' : 'OOS';
          const supPred = wouldBeInSupply(state, a.true_region, a.side) ? 'confirmed-in' : 'confirmed-OOS';
          const condStr = a.condition.toUpperCase();
          L(`  │  ${id.padEnd(16)}: ${condStr.padEnd(9)} ${sup.padEnd(10)} @ ${a.true_region} [check=${supPred}]`);
        }
        // Depots
        const depots = state.depots || [];
        if (depots.length > 0) {
          L(`  │  Depots: ${depots.map(d => `${d.side}@${d.region_id}`).join(', ')}`);
        }
        for (const side of ['rome','carthage']) {
          const s = getSide(state, side);
          L(`  │  ${side.padEnd(12)}: res=${s.resources} init=${s.initiative_pool} VP=${s.vp_total??0}`);
        }
        if (isSeasonEnd) {
          L(`  │  ACTION: armies will prioritise supply over advance this turn`);
        }
        L(`  └${'─'.repeat(50)}\n`);
      }

      // Use state read at top of this iteration (not freshState)
      const submitted = state.orders_submitted || {};
      L(`  orders_submitted at turn start: ${JSON.stringify(submitted)}`);

      // Guard: if either side appears already-submitted but the state turn number
      // matches a previous iteration's turn (stale read), treat as not submitted.
      // We track the last turn we processed to detect stale carry-over.
      const thisTurnKey = `${serverYear}-${serverTurn}`;
      const submittedCarthage = submitted.carthage && (main._lastTurnKey === thisTurnKey);
      const submittedRome     = submitted.rome     && (main._lastTurnKey === thisTurnKey);
      main._lastTurnKey = thisTurnKey;

      if (!submittedCarthage) {
        L('\n  [CARTHAGE]');
        const cOrders = decideCarthageOrders(state, tokens);
        let cRes = await post('/orders', { orders: cOrders }, tokens.carthage);
        if (cRes?.error || cRes?.errors) {
          if (cRes?.error === 'Orders already submitted this turn') {
            LS('Carthage orders already confirmed on server');
          } else {
            // Strategy orders failed — fall back to hold-only so the turn can advance
            L(`  Carthage error (retrying with hold): ${JSON.stringify(cRes)}`);
            const carthArmies = (state.armies||[]).filter(a => a.side === 'carthage');
            const holdOrders  = carthArmies.map(a => ({ type: 'hold', army_id: a.army_id }));
            cRes = await post('/orders', { orders: holdOrders }, tokens.carthage);
            if (cRes?.error || cRes?.errors) L(`  Carthage hold fallback error: ${JSON.stringify(cRes)}`);
            else LS('Carthage submitted hold fallback');
          }
        }
      } else {
        LS('Carthage orders already submitted this turn (confirmed same turn)');
      }

      // Re-read state after Carthage submission
      await new Promise(r => setTimeout(r, 150));
      const freshState = await get('/admin/sim/state');
      const freshPhase = (freshState?.campaign?.phase || '').toLowerCase();
      const freshYear  = freshState?.campaign?.current_year ?? serverYear;
      const freshTurn  = freshState?.campaign?.current_season_turn ?? serverTurn;
      const freshSubmitted = freshState?.orders_submitted || {};
      L(`  post-Carthage state: phase=${freshPhase} Y${freshYear}T${freshTurn} orders_submitted=${JSON.stringify(freshSubmitted)}`);

      if (freshPhase !== 'orders') {
        // Server advanced phase after Carthage submitted — Rome submission no longer needed
        LS(`Phase advanced to "${freshPhase}" after Carthage orders — skipping Rome submission`);
      } else if (freshYear !== serverYear || freshTurn !== serverTurn) {
        // Turn advanced to a new turn entirely — Rome will submit next iteration
        LS(`Turn advanced Y${freshYear}T${freshTurn} after Carthage orders — Rome submits next iteration`);
      } else if (!freshSubmitted.rome) {
        // Same turn, Rome has not yet submitted — submit now using freshState
        L('\n  [ROME]');
        const rOrders = decideRomeOrders(freshState || state, tokens);
        let rRes = await post('/orders', { orders: rOrders }, tokens.rome);
        if (rRes?.error || rRes?.errors) {
          if (rRes?.error === 'Orders already submitted this turn') {
            LS('Rome orders already confirmed on server');
          } else {
            // Strategy orders failed — fall back to hold-only so the turn can advance
            L(`  Rome error (retrying with hold): ${JSON.stringify(rRes)}`);
            const romeArmies = (freshState?.armies||state.armies||[]).filter(a => a.side === 'rome');
            const holdOrders = romeArmies.map(a => ({ type: 'hold', army_id: a.army_id }));
            rRes = await post('/orders', { orders: holdOrders }, tokens.rome);
            if (rRes?.error || rRes?.errors) L(`  Rome hold fallback error: ${JSON.stringify(rRes)}`);
            else LS('Rome submitted hold fallback');
          }
        }
      } else {
        LS('Rome orders already submitted this turn');
      }
    }

    // ── FORCE/REFUSE ─────────────────────────────────────────
    else if (phase === 'force_refuse' || phase === 'force-refuse') {
      LH(`Y${serverYear}T${serverTurn} — FORCE/REFUSE`);
      await handleForceRefuse(state, tokens);
    }

    // ── BATTLE ───────────────────────────────────────────────
    else if (phase === 'battle' || phase === 'battles') {
      LH(`Y${serverYear}T${serverTurn} — BATTLE`);
      const battles = state.pending_battles || [];
      if (!battles.length) { LS('No pending battles'); }
      for (const battle of battles) {
        L(`\n  Battle: ${battle.region}`);
        const res = resolveBattle(state, battle);
        analytics.recordBattle(battle, res);
        L(`    Rolls — Carthage:${res._debug.cartRoll} Rome:${res._debug.romeRoll}`);
        L(`    ${res.winner.toUpperCase()} wins (${res.loss_type}), loser→${res.loser_retreats_to||'auto'}`);
        const br = await post('/battle/resolve', {
          region: res.region,
          winner: res.winner,
          loss_type: res.loss_type,
          loser_retreats_to: res.loser_retreats_to
        }, tokens.carthage);
        if (br?.error) L(`    Resolve error: ${JSON.stringify(br)}`);
      }
    }

    // ── WINTER ───────────────────────────────────────────────
    else if (phase === 'winter' || phase === 'winter_naval' || phase === 'winter_recruit') {
      LH(`Y${serverYear}T${serverTurn} — WINTER PHASE`);

      // Log army states entering winter
      L('  Entering winter:');
      for (const a of (state.armies || [])) {
        const id = a.army_id;
        L(`    ${id.padEnd(16)}: ${a.condition} / ${a.experience} `+
          `in ${a.true_region} supply:${a.in_supply?'IN':'OUT'}`);
      }
      for (const side of ['rome','carthage']) {
        const s = getSide(state, side);
        L(`    ${side.padEnd(12)}: resources=${s.resources} VP=${s.vp_total??0}`);
      }

      // Phase string itself tells us the sub-phase: "winter_naval" or "winter_recruit"
      const winterSubPhase = phase; // e.g. "winter_naval", "winter_recruit"
      // Use the correct winter-specific submission flags, not orders_submitted
      const navalSubmitted   = state.winter?.naval_bids_submitted   || {};
      const recruitSubmitted = state.winter?.recruit_submitted       || {};

      // ── SUB-PHASE 1: Naval bid ──────────────────────────────
      if (winterSubPhase === 'winter_naval') {
        L('\n  [NAVAL BID]');

        // Carthage naval investment strategy:
        // Invest 1 if resources allow — naval superiority is valuable
        const cartRes = getResources(state, 'carthage');
        const cartNavalBid = cartRes >= 2 ? 1 : 0;

        // Rome naval investment:
        // Invest 2 if resources allow (trying to contest Carthage)
        const romeRes = getResources(state, 'rome');
        const romeNavalBid = romeRes >= 2 ? 2 : (romeRes >= 1 ? 1 : 0);

        if (!navalSubmitted.carthage) {
          const cr = await post('/winter/naval-bid',
            { bid: cartNavalBid }, tokens.carthage);
          if (cr?.error) L(`  Carthage naval bid error: ${JSON.stringify(cr)}`);
          else LS(`Carthage bids ${cartNavalBid} on naval`);
        }

        if (!navalSubmitted.rome) {
          const rr = await post('/winter/naval-bid',
            { bid: romeNavalBid }, tokens.rome);
          if (rr?.error) L(`  Rome naval bid error: ${JSON.stringify(rr)}`);
          else LS(`Rome bids ${romeNavalBid} on naval`);
        }
      }

      // ── SUB-PHASE 2: Recruitment ────────────────────────────
      else if (winterSubPhase === 'winter_recruit') {
        L('\n  [RECRUITMENT]');

        // ── Carthage recruitment ──
        if (!recruitSubmitted.carthage) {
          const cartOrders = [];
          const cartRes    = getResources(state, 'carthage');
          let   cartBudget = cartRes;

          const cartArmyCount = (state.armies||[]).filter(a => a.side === 'carthage').length;

          // ── RAISE ARMY: if both armies destroyed and we have 3+ resources ──
          // Server enforces max-2 silently; no need to double-check here beyond resource cost
          if (cartArmyCount < 2 && cartBudget >= 3) {
            cartOrders.push({ type: 'raise_army' });
            // raised army will be picked up as primary/secondary on next turn via resolveRoles
            cartBudget -= 3;
            LS(`Carthage RAISES A NEW ARMY [${cartArmyCount} armies present, budget=${cartRes}]`);
          }

          // Determine which army to target for other orders (only existing armies)
          const { primary: cartWinterPrimary } = resolveRoles(state, 'carthage');
          const cartPrimaryArmy = cartWinterPrimary;

          // Siege equipment if primary is in or within 1 move of a region with enemy SPs
          if (cartPrimaryArmy) {
            const primRegion   = cartPrimaryArmy.true_region;
            const primHasSiege = cartPrimaryArmy.siege_equipment || false;
            // Italian regions with Roman fortified SPs
            const cartSiegeTargetRegions = new Set(['cisalpine_gaul','etruria','latium',
              'campania','samnium_lucania','bruttium_calabria','umbria_picenum']);
            const inOrAdjacentToSiegeTarget =
              cartSiegeTargetRegions.has(primRegion) ||
              getAdj(state, primRegion).some(r => cartSiegeTargetRegions.has(r));
            if (!primHasSiege && inOrAdjacentToSiegeTarget && cartBudget >= 1) {
              cartOrders.push({ type: 'buy_siege_equipment', army_id: cartPrimaryArmy.army_id });
              cartBudget--;
              LS(`Carthage purchases siege equipment for ${cartPrimaryArmy.army_id} [near Italian fortifications]`);
            }
          }

          // Reinforce damaged armies
          if (cartPrimaryArmy && cartPrimaryArmy.condition !== 'good' && cartBudget >= 1) {
            cartOrders.push({ type: 'reinforce', army_id: cartPrimaryArmy.army_id });
            cartBudget--;
            LS(`Carthage reinforces ${cartPrimaryArmy.army_id} [condition: ${cartPrimaryArmy.condition}]`);
          }

          // Mercenary/allied contingent — only for armies that exist
          const hasDefected = (state.regions||[]).some(r =>
            r.defected && r.theater === 'italia');
          const reinforcementUsed = getSide(state,'carthage').reinforcement_used_this_season;
          if (cartPrimaryArmy && !reinforcementUsed && cartBudget >= 1 && !hasDefected) {
            cartOrders.push({ type: 'mercenary', army_id: cartPrimaryArmy.army_id });
            cartBudget--;
            LS(`Carthage recruits mercenary contingent for ${cartPrimaryArmy.army_id}`);
          } else if (cartPrimaryArmy && !reinforcementUsed && hasDefected) {
            cartOrders.push({ type: 'allied_contingent', army_id: cartPrimaryArmy.army_id });
            LS(`Carthage raises allied contingent from defected region for ${cartPrimaryArmy.army_id}`);
          }

          const cr = await post('/winter/recruit',
            { orders: cartOrders }, tokens.carthage);
          if (cr?.error || cr?.errors) L(`  Carthage recruit error: ${JSON.stringify(cr)}`);
          else LS(`Carthage recruitment submitted (${cartOrders.length} orders)`);
        }

        // ── Rome recruitment ──
        if (!recruitSubmitted.rome) {
          const romeOrders = [];
          const romeRes    = getResources(state, 'rome');
          let   romeBudget = romeRes;

          const romeArmyCount = (state.armies||[]).filter(a => a.side === 'rome').length;

          // ── RAISE ARMY: if Rome has fewer than 2 armies and enough resources ──
          if (romeArmyCount < 2 && romeBudget >= 3) {
            romeOrders.push({ type: 'raise_army' });
            // raised army will be picked up as primary/secondary on next turn via resolveRoles
            romeBudget -= 3;
            LS(`Rome RAISES A NEW ARMY [${romeArmyCount} armies present, budget=${romeRes}]`);
          }

          // Reinforce damaged armies — use role resolution for primary
          const { primary: romeWinterPrimary } = resolveRoles(state, 'rome');
          const romePrimaryArmy = romeWinterPrimary;
          if (romePrimaryArmy && romePrimaryArmy.condition !== 'good' && romeBudget >= 1) {
            romeOrders.push({ type: 'reinforce', army_id: romePrimaryArmy.army_id });
            romeBudget--;
            LS(`Rome reinforces ${romePrimaryArmy.army_id} [condition: ${romePrimaryArmy.condition}]`);
          }

          // Allied contingent if Italian allies are loyal
          const hasLoyalAlly = (state.regions||[]).some(r =>
            r.theater === 'italia' && r.controller === 'rome' &&
            r.loyalty_rating && !r.defected);
          const reinforcementUsed = getSide(state,'rome').reinforcement_used_this_season;

          // Allied contingent — only works if army is in Italia theater
          if (romePrimaryArmy && !reinforcementUsed && hasLoyalAlly) {
            const armyRegion = state.regions?.find(r => r.region_id === romePrimaryArmy.true_region);
            if (armyRegion?.theater === 'italia') {
              romeOrders.push({ type: 'allied_contingent', army_id: romePrimaryArmy.army_id });
              LS(`Rome raises allied contingent for ${romePrimaryArmy.army_id}`);
            }
          }

          // Siege equipment if primary is in or within 1 move of Carthaginian fortified regions
          if (romePrimaryArmy) {
            const rConRegion = romePrimaryArmy.true_region;
            const rConHasSiege = romePrimaryArmy.siege_equipment || false;
            // Carthaginian regions with fortified SPs
            const romeSiegeTargetRegions = new Set(['hispania_citerior','hispania_ulterior',
              'numidia_west','numidia_east','africa_proper']);
            const inOrAdjacentToCartFort =
              romeSiegeTargetRegions.has(rConRegion) ||
              getAdj(state, rConRegion).some(r => romeSiegeTargetRegions.has(r));
            if (!rConHasSiege && inOrAdjacentToCartFort && romeBudget >= 1) {
              romeOrders.push({ type: 'buy_siege_equipment', army_id: romePrimaryArmy.army_id });
              romeBudget--;
              LS(`Rome purchases siege equipment for ${romePrimaryArmy.army_id} [near Carthaginian fortifications]`);
            }
          }

          const rr = await post('/winter/recruit',
            { orders: romeOrders }, tokens.rome);
          if (rr?.error || rr?.errors) L(`  Rome recruit error: ${JSON.stringify(rr)}`);
          else LS(`Rome recruitment submitted (${romeOrders.length} orders)`);
        }

        // Log post-winter state after recruit phase
        await new Promise(r => setTimeout(r, 400));
        const postWinter = await get('/admin/sim/state');
        if (postWinter && !postWinter.error) {
          L('\n  Post-winter army states:');
          for (const a of (postWinter.armies || [])) {
            const id = a.army_id;
            L(`    ${id.padEnd(16)}: ${a.condition} / ${a.experience} in ${a.true_region}`);
          }
          for (const side of ['rome','carthage']) {
            const s = getSide(postWinter, side);
            L(`    ${side.padEnd(12)}: resources=${s.resources} naval=${getNavalControl(postWinter)}`);
          }
        }
      }

      else {
        LS(`Unknown winter sub-phase: "${winterSubPhase}"`);
      }
    }

    else {
      LS(`Unhandled phase: "${phase}" — skipping`);
    }
  }

  analytics.report();
  return analytics.summary();
}

// ── Batch runner ──────────────────────────────────────────────────
async function runBatch() {
  const allResults = [];
  for (let i = 0; i < BATCH_RUNS; i++) {
    const result = await main(i);
    if (result) {
      allResults.push(result);
      if (BATCH_MODE) {
        const w = result.winner?.toUpperCase() ?? '?';
        LB(`  ✓ Run ${i+1}: ${w} wins (VP Rome ${result.finalVP.rome} / Carthage ${result.finalVP.carthage}) — ${result.turns} turns`);
      }
    }
    // Short pause between runs so server can flush state
    if (i < BATCH_RUNS - 1) await new Promise(r => setTimeout(r, 300));
  }

  if (BATCH_MODE && allResults.length > 0) {
    printBatchReport(allResults);
  }
}

function avg(arr)    { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function pct(arr,fn) { return arr.length ? arr.filter(fn).length/arr.length*100 : 0; }
function sd(arr) {
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s,x)=>s+(x-m)**2,0)/Math.max(1,arr.length));
}
function fmt(n,d=1) { return typeof n === 'number' ? n.toFixed(d) : String(n); }

function printBatchReport(results) {
  const N   = results.length;
  const DIV = '═'.repeat(70);
  LB(`\n${DIV}`);
  LB(`  BELLUM PUNICUM — BATCH REPORT  (${N} runs)`);
  LB(DIV);

  // ── 1. OUTCOMES ────────────────────────────────────────────────
  const rWins  = results.filter(r => r.winner === 'rome').length;
  const cWins  = results.filter(r => r.winner === 'carthage').length;
  const turns  = results.map(r => r.turns);
  const vpGaps = results.map(r => r.vpGap);
  const rVPs   = results.map(r => r.finalVP.rome);
  const cVPs   = results.map(r => r.finalVP.carthage);
  LB('\n[1] OUTCOMES');
  LB(`  Rome wins:     ${rWins}/${N} (${(rWins/N*100).toFixed(0)}%)`);
  LB(`  Carthage wins: ${cWins}/${N} (${(cWins/N*100).toFixed(0)}%)`);
  LB(`  Avg turns:     ${fmt(avg(turns))}  (σ=${fmt(sd(turns))}  min=${Math.min(...turns)}  max=${Math.max(...turns)})`);
  LB(`  Avg VP gap:    ${fmt(avg(vpGaps))}  (σ=${fmt(sd(vpGaps))})`);
  LB(`  Avg final VP — Rome: ${fmt(avg(rVPs))}  Carthage: ${fmt(avg(cVPs))}`);
  if (Math.abs(rWins - cWins) / N > 0.2)
    LB(`  ⚠ WIN RATE IMBALANCED — gap >20% between sides`);

  // ── 2. RESOURCE ECONOMY ────────────────────────────────────────
  LB('\n[2] RESOURCE ECONOMY');
  const rResAvg  = results.map(r => r.avgResources.rome);
  const cResAvg  = results.map(r => r.avgResources.carthage);
  const rRes0pct = results.map(r => r.pctTurnsRes0.rome);
  const cRes0pct = results.map(r => r.pctTurnsRes0.carthage);
  const rResPeak = results.map(r => r.maxResources.rome);
  const cResPeak = results.map(r => r.maxResources.carthage);
  LB(`  Avg resources held/turn:`);
  LB(`    Rome:     ${fmt(avg(rResAvg))}  (σ=${fmt(sd(rResAvg))})`);
  LB(`    Carthage: ${fmt(avg(cResAvg))}  (σ=${fmt(sd(cResAvg))})`);
  LB(`  % turns at 0 resources (broke/starved):`);
  LB(`    Rome:     ${fmt(avg(rRes0pct))}%  (σ=${fmt(sd(rRes0pct))}%)`);
  LB(`    Carthage: ${fmt(avg(cRes0pct))}%  (σ=${fmt(sd(cRes0pct))}%)`);
  LB(`  Peak resources in a single turn:`);
  LB(`    Rome:     avg ${fmt(avg(rResPeak))}  max-ever ${Math.max(...rResPeak)}`);
  LB(`    Carthage: avg ${fmt(avg(cResPeak))}  max-ever ${Math.max(...cResPeak)}`);
  const rBroke = results.filter(r => r.pctTurnsRes0.rome    > 30).length;
  const cBroke = results.filter(r => r.pctTurnsRes0.carthage > 30).length;
  if (rBroke > N*0.3) LB(`  ⚠ ROME RESOURCE-STARVED in ${rBroke}/${N} runs (>30% turns at 0)`);
  if (cBroke > N*0.3) LB(`  ⚠ CARTHAGE RESOURCE-STARVED in ${cBroke}/${N} runs (>30% turns at 0)`);
  if (avg(rResAvg) > avg(cResAvg) + 1.5) LB(`  ⚠ ROME SIGNIFICANTLY WEALTHIER on average`);
  if (avg(cResAvg) > avg(rResAvg) + 1.5) LB(`  ⚠ CARTHAGE SIGNIFICANTLY WEALTHIER on average`);

  // ── 3. INITIATIVE ECONOMY ──────────────────────────────────────
  LB('\n[3] INITIATIVE ECONOMY');
  const rInitAvg   = results.map(r => r.avgInitRemaining.rome);
  const cInitAvg   = results.map(r => r.avgInitRemaining.carthage);
  const rInit0pct  = results.map(r => r.pctTurnsInit0.rome);
  const cInit0pct  = results.map(r => r.pctTurnsInit0.carthage);
  const rInitWaste = results.map(r => r.pctTurnsInit3plus.rome);
  const cInitWaste = results.map(r => r.pctTurnsInit3plus.carthage);
  LB(`  Avg initiative REMAINING after orders (lower = more active):`);
  LB(`    Rome:     ${fmt(avg(rInitAvg))}  (σ=${fmt(sd(rInitAvg))})`);
  LB(`    Carthage: ${fmt(avg(cInitAvg))}  (σ=${fmt(sd(cInitAvg))})`);
  LB(`  % turns initiative fully spent (remaining = 0):`);
  LB(`    Rome:     ${fmt(avg(rInit0pct))}%`);
  LB(`    Carthage: ${fmt(avg(cInit0pct))}%`);
  LB(`  % turns with ≥3 initiative unspent (almost idle):`);
  LB(`    Rome:     ${fmt(avg(rInitWaste))}%`);
  LB(`    Carthage: ${fmt(avg(cInitWaste))}%`);
  if (avg(rInitWaste) > 35) LB(`  ⚠ ROME FREQUENTLY IDLE — IP pool may be too large or orders too cheap`);
  if (avg(cInitWaste) > 35) LB(`  ⚠ CARTHAGE FREQUENTLY IDLE — IP pool may be too large or orders too cheap`);
  if (avg(rInit0pct) > 50)  LB(`  ⚠ ROME INITIATIVE-CONSTRAINED more than half the time`);
  if (avg(cInit0pct) > 50)  LB(`  ⚠ CARTHAGE INITIATIVE-CONSTRAINED more than half the time`);

  // ── 4. SUPPLY ──────────────────────────────────────────────────
  LB('\n[4] SUPPLY SYSTEM');
  const hanOOS = results.map(r => r.hannibalOOSpct);
  const hasOOS = results.map(r => r.hasdrubalOOSpct);
  const conOOS = results.map(r => r.consularOOSpct);
  const resOOS = results.map(r => r.reserveOOSpct);
  LB(`  Avg % turns out of supply:`);
  LB(`    Hannibal:  ${fmt(avg(hanOOS))}%  (σ=${fmt(sd(hanOOS))}%)`);
  LB(`    Hasdrubal: ${fmt(avg(hasOOS))}%  (σ=${fmt(sd(hasOOS))}%)`);
  LB(`    Consular:  ${fmt(avg(conOOS))}%  (σ=${fmt(sd(conOOS))}%)`);
  LB(`    Reserve:   ${fmt(avg(resOOS))}%  (σ=${fmt(sd(resOOS))}%)`);
  if (avg(hanOOS) < 15) LB(`  ⚠ HANNIBAL RARELY OOS — supply radius may be too generous`);
  if (avg(hanOOS) > 60) LB(`  ⚠ HANNIBAL CHRONICALLY OOS — may be unplayably punishing`);
  // Depot tracking
  const depotCounts = results.map(r => r.maxDepotsCartage || 0);
  LB(`  Carthage peak depots/game: avg=${fmt(avg(depotCounts))}  min=${Math.min(...depotCounts)}  max=${Math.max(...depotCounts)}`);
  if (avg(depotCounts) < 3) LB(`  ⚠ CARTHAGE BUILDING FEW DEPOTS — supply chain underbuilt`);

  // ── 5. BATTLES ─────────────────────────────────────────────────
  LB('\n[5] BATTLES');
  const bTotal = results.map(r => r.battles);
  const bDec   = results.map(r => r.decisiveBattles);
  const bCW    = results.map(r => r.carthageWins);
  const bRW    = results.map(r => r.romeWins);
  LB(`  Avg battles/game: ${fmt(avg(bTotal))}  (min=${Math.min(...bTotal)}  max=${Math.max(...bTotal)})`);
  LB(`  Avg decisive:     ${fmt(avg(bDec))} (${fmt(pct(results.flatMap(r=>Array(r.decisiveBattles).fill(1)), _=>true) / Math.max(1,avg(bTotal)))}%)`);
  LB(`  Avg Carthage wins/game: ${fmt(avg(bCW))}`);
  LB(`  Avg Rome wins/game:     ${fmt(avg(bRW))}`);
  const totalBattles = bTotal.reduce((a,b)=>a+b,0);
  const totalCW = bCW.reduce((a,b)=>a+b,0);
  LB(`  Overall battle win rate — Carthage: ${totalBattles ? (totalCW/totalBattles*100).toFixed(0) : '?'}%  Rome: ${totalBattles ? ((totalBattles-totalCW)/totalBattles*100).toFixed(0) : '?'}%`);
  if (avg(bTotal) < 2) LB(`  ⚠ VERY FEW BATTLES — force/refuse may be too avoidance-friendly`);

  // ── 6. DEFECTIONS & GEOGRAPHY ─────────────────────────────────
  LB('\n[6] DEFECTIONS, GEOGRAPHY & SP CAPTURES');
  const spCaptR = results.map(r => r.spCaptures?.rome     ?? 0);
  const spCaptC = results.map(r => r.spCaptures?.carthage ?? 0);
  LB(`  Avg SP captures/game — Rome: ${fmt(avg(spCaptR))}  Carthage: ${fmt(avg(spCaptC))}`);
  const defTotal   = results.map(r => r.defections);
  const italyCount = results.filter(r => r.hannibalReachedItaly).length;
  const latiumCount= results.filter(r => r.hannibalReachedLatium).length;
  LB(`  Avg defections/game: ${fmt(avg(defTotal))}  (max=${Math.max(...defTotal)})`);
  LB(`  Hannibal reached Italy:  ${italyCount}/${N} (${(italyCount/N*100).toFixed(0)}%)`);
  LB(`  Hannibal reached Latium: ${latiumCount}/${N} (${(latiumCount/N*100).toFixed(0)}%)`);
  const allDefRegions = results.flatMap(r => r.defectedRegions);
  const defFreq = {};
  for (const r of allDefRegions) defFreq[r] = (defFreq[r]||0)+1;
  if (Object.keys(defFreq).length) {
    LB(`  Most defected regions:`);
    Object.entries(defFreq).sort((a,b)=>b[1]-a[1]).slice(0,5)
      .forEach(([r,n]) => LB(`    ${r.padEnd(22)} ${n}/${N} games (${(n/N*100).toFixed(0)}%)`));
  }
  if (italyCount < N*0.5) LB(`  ⚠ HANNIBAL STALLED — reached Italy in <50% of games`);
  if (avg(defTotal) === 0) LB(`  ⚠ NO DEFECTIONS EVER — defection system may not be triggering`);

  // ── 7. ATTRITION ──────────────────────────────────────────────
  LB('\n[7] ATTRITION');
  const dropTot = results.map(r => r.condDropsTotal);
  LB(`  Avg condition drops/game: ${fmt(avg(dropTot))}  (σ=${fmt(sd(dropTot))})`);
  // Collect all army IDs seen across all runs (includes raised armies)
  const allSeenIds = [...new Set(results.flatMap(r => Object.keys(r.condDropsByArmy || {})))];
  // Always show named armies first, then any additional raised armies
  const namedIds = ['hannibal','hasdrubal','consular','reserve'];
  const sortedIds = [...namedIds, ...allSeenIds.filter(id => !namedIds.includes(id))];
  for (const id of sortedIds) {
    const drops = results.map(r => r.condDropsByArmy?.[id] ?? 0);
    if (drops.every(d => d === 0)) continue; // skip armies that never took drops
    LB(`    ${id.padEnd(16)}: avg ${fmt(avg(drops))} drops/game`);
  }

  // ── 8. NAVAL ──────────────────────────────────────────────────
  LB('\n[8] NAVAL CONTROL');
  const navR = results.map(r => r.navalPct.rome);
  const navC = results.map(r => r.navalPct.carthage);
  const navX = results.map(r => r.navalPct.contested);
  LB(`  Avg % turns naval held:`);
  LB(`    Carthage:  ${fmt(avg(navC))}%`);
  LB(`    Rome:      ${fmt(avg(navR))}%`);
  LB(`    Contested: ${fmt(avg(navX))}%`);
  if (avg(navR) < 5) LB(`  ⚠ ROME ALMOST NEVER WINS NAVAL`);

  // ── 9. EXPERIENCE ─────────────────────────────────────────────
  LB('\n[9] EXPERIENCE PROGRESSION');
  for (const id of ['hannibal','hasdrubal','consular','reserve']) {
    const finals = results.map(r => r.finalExperience[id]).filter(Boolean);
    const counts = {};
    for (const e of finals) counts[e] = (counts[e]||0)+1;
    const breakdown = Object.entries(counts).map(([e,n])=>`${e}:${n}`).join('  ');
    LB(`    ${id.padEnd(12)}: ${breakdown || '(destroyed all games)'}`);
  }

  LB(`\n${DIV}\n  END OF BATCH REPORT\n${DIV}\n`);
}

runBatch().catch(err => console.error('Fatal error:', err));
