# Bellum Punicum — Claude Code Project Brief

## Overview

I want to build a two-player web application for managing a historical wargame campaign set during the Second Punic War (Hannibal vs Rome, 218–214 BC). The app manages the strategic campaign layer; individual battles are fought separately in a PC game called Field of Glory 2, with results entered back into the app manually.

The app needs:
- A Node.js/Express backend with persistent game state
- Two separate player views with genuinely hidden information
- Simultaneous order submission (orders held until both players submit)
- Automated game logic (supply, attrition, VP tracking, etc.)
- Local development setup initially (both players on same machine, two browser windows)

**Please start with Phase 1 only** (map rendering and basic game state). Do not attempt to build everything at once. Use plain JavaScript on the frontend for now, not React.

---

## Build Phases

### Phase 1 — Map and State Foundation
- Interactive map with 20 regions, clickable, showing control status
- Basic game state: whose turn, what season, initiative pools, resources
- No hidden information yet — get the map working first

### Phase 2 — Two Player Views
- Player identification (rome / carthage)
- Hidden information layer — each player sees only their own intelligence picture
- Simultaneous order submission — system holds until both submitted

### Phase 3 — Core Mechanics
- Supply calculation automated
- Attrition applied automatically each turn
- Intelligence actions — positional drift, scout actions
- Communication delay logic

### Phase 4 — Battle Integration
- Battle trigger detection and collision resolution
- Pre-battle intelligence summary shown to each player
- Manual result entry — player enters Field of Glory 2 outcome, system updates state

### Phase 5 — Polish and Full Campaign
- Winter phase automation
- VP tracking and display
- Defection rolls
- Naval resolution
- Full turn log

---

## Recommended Tech Stack

- **Backend:** Node.js with Express
- **Database:** SQLite or JSON files to start
- **Frontend:** Plain HTML/CSS/JavaScript (no React initially)
- **Multiplayer sync:** Simple polling initially, WebSockets later if needed
- **Hosting:** Local development first

---

## Game State Data Model

This is the single source of truth on the server. Never shown to either player in full.

### Campaign
```
Campaign
- campaign_id
- current_year (1–5)
- current_season_turn (1–10)
- phase (orders / resolution / battle / winter)
- active_player (both / rome / carthage)
- winner (null until game ends)
```

### Regions (20 total)
```
Region
- region_id
- name
- theater (iberia / gaul / italy / island / africa)
- controller (rome / carthage / neutral)
- loyalty_rating (Italian regions only, 1–5)
- defected (boolean)
- strategic_points: array of:
    - point_id
    - name
    - fortification_rating (0–3)
    - controller
    - under_siege (boolean)
    - breach_points_accumulated
    - siege_equipment_present (boolean)
```

### The 20 Regions

**Iberia:** Hispania Ulterior, Hispania Citerior

**Gaul & Passes:** Pyrenean Passes, Transalpine Gaul, Alpine Passes

**Italia:** Cisalpine Gaul, Venetia, Liguria, Etruria, Umbria & Picenum,
Latium, Campania, Samnium & Lucania, Bruttium & Calabria, Illyria

**Islands:** Sardinia & Corsica, Sicily

**Africa:** Numidia West, Numidia East, Africa Proper

### Armies (2 per side, 4 total)
```
Army
- army_id
- side (rome / carthage)
- name
- true_region (actual location — server only, never sent to opponent)
- composition_profile (heavy_infantry / combined_arms / cavalry_heavy / warband)
- condition (fresh / worn / depleted / broken)
- experience (levy / seasoned / veteran / elite)
- points_budget (baseline battle points)
- in_supply (boolean, calculated automatically each turn)
- communication_delayed (boolean)
- pending_order (hidden until resolution)
- mercenary_contingent_attached (boolean, resets each winter)
```

### Intelligence Picture (one per side — key hidden info structure)
```
IntelligencePicture
- side
- enemy_army entries:
    - army_id
    - last_known_region
    - last_known_turn (staleness tracker)
    - condition_known (boolean)
    - known_condition (null if not recently scouted)
```

### Side State (one per side)
```
SideState
- side
- resources
- banked_resources (max 1)
- initiative_pool (resets to 4 each season)
- naval_control (boolean)
- naval_investment_this_winter (0–2)
- vp_total
- allied_contingent_used_this_season (boolean — Rome only)
```

### Orders
```
Order
- order_id
- side
- army_id
- order_type (move / hold / siege / establish_depot / feint /
              scout / deep_scout / refuse_battle / force_battle)
- target_region
- initiative_cost
- submitted (boolean)
- resolved (boolean)
```

### Turn Log
```
LogEntry
- turn
- year
- side (rome / carthage / system)
- event_type
- description
- visible_to (rome / carthage / both)
```

---

## Player View Logic

### Both players always see:
- All region controllers
- All strategic point controllers
- Their own army's true position, condition, experience, points budget
- Their own resources, initiative pool, VP total
- Their own intelligence picture (last known enemy positions)
- Public turn log entries
- Current phase and whose orders are pending
- Naval control status
- VP scores for both sides
- **Presence of enemy army in adjacent regions** (presence only — no condition or strength)

### Each player sees only their own:
- Submitted orders before resolution
- Private intelligence results
- Private turn log entries
- Pending orders status

### Neither player ever sees:
- Enemy army true position (only last known)
- Enemy army condition unless scouted this season
- Enemy submitted orders before resolution
- Enemy initiative spend breakdown
- Enemy resource total

---

## Turn Flow

### Active Season Turn

**1. Orders Phase**
- Both players simultaneously submit orders for each army
- Orders can include: move, hold, siege, establish depot, scout, deep scout, feint, force battle, refuse battle
- Initiative spend validated against pool (max 4 per season)
- System holds all orders until both players have submitted
- UI shows "waiting for opponent" until both ready

**2. Resolution Phase (automated)**
- Communication delay applied — armies 3+ regions from capital or crossing a sea route have orders held one additional turn
- Movement resolved simultaneously
- Collision detection run — do armies end in same region?
- Feints applied to opponent's intelligence picture
- True positions updated
- Supply check run for all armies:
  - Distance from nearest friendly depot or home base calculated
  - In supply = within 2 regions; out of supply = 3+ regions
  - Supply line requires unbroken chain unless using radius-only mode
- Attrition points calculated and applied:
  - In supply, friendly territory: 0 points
  - In supply, enemy territory: 1 point
  - Out of supply, friendly territory: 1 point
  - Out of supply, enemy territory: 2 points
  - Winter, in supply at depot: 1 point
  - Winter, out of supply: 3 points
  - Post-battle loss: 1 point
  - 2 points in one turn = drop one condition step
  - 3+ points in one turn = drop two condition steps
- Intelligence drift applied:
  - Last known positions age by one turn
  - Scouted positions updated if scout action taken
  - Adjacent region presence always current

**3. Collision Resolution (if armies meet)**
- Both players notified of contact in named region
- Both simultaneously declare: Force Battle or Refuse Battle
- Resolution:
  - Both Force → Battle occurs
  - Attacker Forces, Defender Refuses → Defender retreats one region, attacker takes region
  - Both Refuse → Shared occupation, ZOC applied, no battle
  - Attacker Refuses, Defender Forces → Attacker retreats one region
- Shared occupation ZOC rule:
  - Neither army can move to the region the other entered from that turn
  - Both armies can move to any other adjacent region freely
  - After 2 consecutive turns of mutual refusal in same region, forcing battle costs 0 initiative
  - Moving out of shared region toward new region triggers normal collision detection

**4. Battle Phase (if battle triggered)**
- Both players shown pre-battle intelligence summary:
  - Own army: true condition, experience, calculated points budget
  - Enemy army: last known condition (or unknown), estimated strength
- Players fight battle in Field of Glory 2
- Winner enters result:
  - Who won
  - Was it decisive (enemy condition dropped)?
  - Was enemy army destroyed?
- System applies results:
  - Region control updated
  - Condition steps applied
  - Experience updated if decisive victory
  - VPs awarded
  - Defection roll triggered if conditions met

**5. End of Turn**
- Initiative pools updated
- +1 initiative awarded to winner of major battle
- Turn log updated
- Season turn counter incremented
- If season turn 10 reached → trigger winter phase

### Winter Phase

1. **Income calculation (automated)**
   - 1 resource per 2 regions controlled (rounded down)
   - +1 per major city strategic point controlled
   - +1 for naval control
   - +1 per major battle victory during season
   - Display income summary to both players

2. **Naval resolution**
   - Both players secretly allocate naval investment (0–2 resources)
   - Simultaneous reveal
   - Roll 1d6 per side, apply modifiers:
     - Naval investment: +1 per resource spent (max +2)
     - Controls Sicily: +1
     - Carthage baseline: +1
     - Won naval control last year: +1
   - Higher total wins naval control for coming year
   - Tied roll = contested (both can use sea routes, neither gets bonus)
   - Mid-year challenge: spend 2 initiative for re-roll

3. **Recruitment phase**
   - Both players spend resources:
     - Raise new army: 3 resources (year start only)
     - Rebuild destroyed army: 4 resources (starts Worn)
     - Reinforce depleted army to baseline: 1 resource
     - Establish depot: 1 resource + 1 initiative + 1 stationary turn
     - Mercenary contingent (Carthage only): 1 resource per contingent
       (cost rises to 2 if Rome holds naval control)
     - Allied contingent (Rome only): free once per season,
       Italian theater only, lost if region has defected
     - Naval investment: 1–2 resources
     - Siege equipment: 1 resource (required for fortification rating 2+)
     - Mid-season emergency reinforcement: 2 resources (once per season)
   - Banking: maximum 1 resource carried over; surplus lost

4. **Recovery**
   - At home base: recover to Fresh automatically
   - At depot, in supply: recover two condition steps
   - In supply, no depot: recover one condition step
   - Out of supply: no recovery, may degrade further

5. **Intelligence reset**
   - All last known positions updated to end-of-season true positions
   - Fresh season begins with accurate starting intelligence

6. **VP snapshot**
   - Count and add season-end VPs to running totals
   - Check victory conditions

7. **New season setup**
   - Initiative pools reset to 4
   - Allied contingent availability reset (Rome)
   - Season turn counter reset to 1
   - Year counter incremented

---

## Core Mechanics Reference

### Supply
- In supply: within 2 regions of nearest friendly depot or home base
- Out of supply: 3+ regions away
- Depots: established by spending 1 resource + 1 initiative + 1 stationary turn
- Depots destroyed if enemy army occupies the region
- No supply line tracing required — radius only

### Condition Track
- Fresh → Worn → Depleted → Broken
- Worn: -5% battle points
- Depleted: -10% battle points + one quality step down in Field of Glory 2
- Broken: cannot initiate battle; if forced to fight -20% points + quality step
- Recovery: stationary turn in supply restores one step during season

### Experience Track
- Levy → Seasoned → Veteran → Elite
- Improves on decisive battle victory (enemy condition dropped)
- Translates to Field of Glory 2 army quality and unit restrictions
- Lost permanently if army destroyed — rebuilt armies start at Levy

### Initiative Pool
- 4 points per side per season
- Resets each winter
- +1 bonus for winning a major battle (awarded immediately)
- Costs:
  - Force battle: 1
  - Scout action: 1 (roll 1d6, on 4+ reveal if target counter is real/dummy)
  - Deep scout: 2 (automatic reveal, no roll)
  - Feint: 1 (move a false marker on opponent's map)
  - Establish depot: 1 (plus resource cost and stationary turn)
  - Declare siege: 1
  - Mid-year naval challenge: 2
  - Force battle after 2 turns mutual refusal: 0

### Communication Delay
- Armies within 2 regions of capital: no delay
- Armies 3+ regions from capital: orders execute one turn late
- Sea crossing in communication chain: additional one turn delay
- Applies to Hannibal once he crosses the Alps

### Intelligence / Fog of War
- Enemy true positions never visible directly
- Adjacent regions: presence of enemy army visible (nothing else)
- Non-adjacent regions: last known position, ages each turn
- Condition hidden unless scouted this season
- Scout action: spend 1 initiative, roll 1d6 — on 4+ update last known position and reveal if real/dummy
- Deep scout: spend 2 initiative — automatic position update
- Feint: spend 1 initiative — place false movement on opponent's intelligence map
- Intelligence resets to true positions each winter

### Defection
- Triggers when: Hannibal wins a major battle in or adjacent to region AND occupies/passes through it
- Roll 1d6 against loyalty rating — defects if roll ≤ defection threshold
- Italian loyalty ratings:
  - Etruria: loyalty 5 (defects on 1 only)
  - Umbria & Picenum: loyalty 5 (defects on 1 only)
  - Campania: loyalty 3 (defects on 1–3)
  - Samnium & Lucania: loyalty 2 (defects on 1–4)
  - Bruttium & Calabria: loyalty 2 (defects on 1–4)
- Modifiers: crushing victory +2, Rome army Broken/absent +1,
  occupied 2+ turns +1, Rome Fresh army present = automatic loyalty
- Defection: region flips politically, unfortified points flip,
  garrisoned/fortified points require siege
- Recovery: Rome occupies with Fresh/Worn army = loyalty restored immediately

### Siege Rules
- Fortification ratings: 1 (minor town), 2 (major city), 3 (capital)
- Declare siege: spend 1 initiative
- Each turn besieging: roll 1d6 + condition modifier vs fortification rating
  - Condition modifiers: Fresh +1, Worn 0, Depleted -1, Broken cannot besiege
  - Beat rating by any amount = 1 breach point accumulated
  - Accumulate breach points = fortification rating → location falls
- Rating 2+ requires siege equipment (1 resource, purchased in advance)
- Relief: friendly army enters region → siege lifted, field battle triggers
- Rating 3 capital: defender may attempt one final field battle before fall
- Isolated fortification (no friendly army within 3 regions, no relief possible):
  falls automatically after one full season

### Victory Conditions
- **Sudden death:** Capture enemy capital (requires completing siege of rating 3 fortification)
- **VP accumulation:** After 5 years, highest VP total wins
- **Tiebreak:** Carthage wins a tie

### VP Sources
| Source | VPs |
|--------|-----|
| Control a region at season end | 1 per region |
| Control a major city strategic point | 1 per city |
| Win a major battle | 1 (one-time) |
| Control Sicily at season end | 2 (replaces standard region VP) |
| Control enemy capital region at season end | 2 |
| Destroy an enemy army entirely | 2 (one-time) |

### Army Destruction Threshold
Destroyed (not just retreated) when:
- Tactical defeat while already Broken
- Tactical defeat with retreat route blocked (encirclement)
- Remains out of supply through entire winter
- Catastrophic Field of Glory 2 result (scenario-specific)

---

## Starting Scenario: 218 BC

### Army Positions

**Carthage:**
| Army | Region | Condition | Experience |
|------|--------|-----------|------------|
| Hannibal | Hispania Citerior | Fresh | Veteran |
| Hasdrubal | Hispania Ulterior | Fresh | Seasoned |

**Rome:**
| Army | Region | Condition | Experience |
|------|--------|-----------|------------|
| Consular Army | Cisalpine Gaul | Fresh | Seasoned |
| Reserve Army | Latium | Fresh | Levy |

### Starting Region Control

**Carthage controls:** Hispania Ulterior, Hispania Citerior, Africa Proper, Numidia East, Numidia West

**Rome controls:** Latium, Etruria, Umbria & Picenum, Campania, Samnium & Lucania, Bruttium & Calabria, Venetia, Liguria

**Neutral:** Cisalpine Gaul (Rome has military presence, no political control), Sicily, Transalpine Gaul, Alpine Passes, Pyrenean Passes, Illyria, Sardinia & Corsica

### Starting Resources
- Rome: 5
- Carthage: 5

### Starting Naval Control
- Carthage holds naval superiority at game start

### Special Starting Rules
- Hannibal's march is committed: Carthage must move Hannibal at least one region toward Italy on turn 1
- Cisalpine Gaul loyalty check: Rome must roll to secure it (loyalty 3) — failure means neutral, no allied contingent
- Sicily starts neutral: first side to move a naval force there claims it

---

## Faction Asymmetry Summary

### Rome
- Heavy infantry core composition
- Allied contingent: free once per season from any loyal Italian region, Italian theater only
- No mercenaries
- Recruitment costs: raise 3, rebuild 4, reinforce 1
- No baseline naval bonus
- Income: stable, regionally based, harder to disrupt

### Carthage
- Combined arms composition (Hannibal), heavy infantry (Hasdrubal)
- Mercenaries: any number per season at 1 resource each (rises to 2 if Rome holds naval)
- No allied contingent
- Same recruitment costs as Rome
- +1 baseline bonus to annual naval roll
- Income: brittle — dependent on naval superiority and fixed city bonuses
- Communication delay: Hannibal in Italy always has additional sea-crossing delay

---

## API Endpoints

```
Authentication
POST /join — player joins as rome or carthage, receives session token

Game State
GET /state — returns filtered game state for requesting player
GET /log — returns visible turn log entries for requesting player

Orders
POST /orders/submit — submit orders for this turn
GET /orders/status — check if opponent has submitted (no content revealed)

Actions
POST /action/scout — spend initiative on scout action
POST /action/feint — spend initiative on feint, specify target region
POST /action/depot — establish depot at current location
POST /action/siege — declare siege on strategic point
POST /action/force — declare force battle on collision
POST /action/refuse — declare refuse battle on collision

Winter Phase
POST /winter/naval — submit naval investment amount
POST /winter/recruit — submit recruitment decisions

Battle
POST /battle/result — enter Field of Glory 2 battle result
GET /battle/briefing — get pre-battle intelligence summary for requesting player

Admin
POST /game/new — create new campaign, initialise 218 BC starting state
GET /game/status — current phase, whose turn, pending actions
```

---

## Notes for Implementation

- The intelligence picture is the most critical hidden information structure — get this right before building anything else in Phase 2
- Supply distance calculation runs automatically every turn — calculate from each army's true position to nearest friendly depot or home base
- Communication delay: flag armies as delayed when their true position is 3+ regions from their capital, or when a sea route is in the communication chain; hold their submitted orders one extra turn before executing
- Attrition is calculated per turn not accumulated across turns — check current turn's situation against threshold table each resolution phase
- Positional drift: increment last_known_turn each turn an army moves without being scouted; use this to show intelligence staleness in the UI
- Adjacent visibility: when serving game state, calculate which enemy armies are in regions adjacent to the requesting player's armies and include presence (not condition/position) in the response
- Winter intelligence reset: at start of each winter phase, update all last_known_region to true_region and reset last_known_turn to current turn

---

*This brief was produced through a full game design session. All mechanics have been deliberately designed and tested conceptually. When implementation questions arise that aren't covered here, refer back to the design session for context before making assumptions.*
