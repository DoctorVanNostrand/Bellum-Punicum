# Bellum Punicum — Agent Onboarding Guide

This is a two-player web campaign manager for the Second Punic War (218–214 BC). Players manage the strategic layer here; individual battles are fought in Field of Glory 2 and results entered manually.

The original design spec is in `bellum_punicum_claude_code_brief.md`. **Read that for game rules.** This file covers the current implementation state, conventions, and gotchas.

---

## How to Run

```bash
node server.js        # starts on http://localhost:3000
```

State is seeded from `data/initial-state.json` on `POST /game/new`. Working state lives in `game-state.json`. The server holds state in memory (`_memState`) as primary; file I/O is best-effort persistence.

---

## File Structure

```
bellum-punicum/
  server.js                  Express backend (~2200 lines)
  game-state.json            Working state (git-ignored after first run)
  data/
    initial-state.json       218 BC seed data
  public/
    index.html               App shell + inline SVG map (20 polygon regions)
    style.css                Dark theme — Rome=red, Carthage=purple, Neutral=dark green
    app.js                   Fetch/render client (~2000 lines, plain JS)
  bellum_punicum_claude_code_brief.md   Original design spec
```

No build step. No React. No TypeScript. Plain JS throughout.

---

## Tech Stack

- **Backend:** Node.js + Express, port 3000
- **Storage:** JSON file (`game-state.json`), in-memory `_memState`
- **Frontend:** Plain HTML/CSS/vanilla JS
- **Map:** SVG polygons in `index.html`, coloured via JS in `app.js`

---

## Key Constants (server.js, top of file)

| Constant | Purpose |
|---|---|
| `INITIATIVE_COSTS` | Cost table for all order types |
| `HOME_BASES` | `{ rome: 'latium', carthage: 'africa_proper' }` — permanent supply sources |
| `ISLAND_REGIONS` | `sicily`, `sardinia` — evacuated at winter |
| `CAPITAL_REGIONS` | `latium`, `africa_proper` — cannot be politically flipped by occupation alone |
| `SEA_CONNECTIONS` | Set of `"from:to"` strings; movement across these requires naval control |
| `LOYALTY_REGIONS` | Italian regions subject to the defection system + their thresholds |

---

## Data Model — Key Fields

### Army
```json
{
  "army_id": "hannibal",
  "side": "carthage",
  "true_region": "hispania_citerior",   // server-only, NEVER sent to opponent
  "composition_profile": "combined_arms",
  "condition": "good",                   // good → worn → depleted → broken
  "experience": "veteran",               // levy → seasoned → veteran → elite
  "points_budget": 1200,
  "in_supply": true,
  "feint_region": null,                  // non-null when feint order is active
  "feint_expires_turn": null,
  "turns_in_field": 0,
  "attrition_pts_this_turn": 0          // stamped by calculateAttrition, read by battle resolve
}
```

### Region
```json
{
  "region_id": "cisalpine_gaul",
  "theater": "italia",                   // iberia | gaul | italia | island | africa | balkans
  "controller": "neutral",              // rome | carthage | neutral
  "loyalty_rating": 3,                  // Italian regions only
  "defected": false,
  "carthage_turns_present": 0,          // Italian regions only — tracks consecutive occupation
  "strategic_points": [...]
}
```

Theaters: `iberia`, `gaul`, `italia`, `island`, `africa`, `balkans` (Illyria).
**Illyria** is `theater: "balkans"` — NOT `"italia"` (was a bug, now fixed).

### Strategic Points
```json
{
  "point_id": "rome",
  "fortification_rating": 3,
  "controller": "rome",
  "under_siege": false,
  "besieging_army_id": null,
  "breach_points_accumulated": 0,
  "siege_equipment_present": false
}
```

SP flipping rules:
- **Fortification 0:** always flips with region
- **Fortification ≥ 1, taken from neutral:** auto-flips with region (no siege needed — no prior defender)
- **Fortification ≥ 1, taken from opponent:** requires siege to flip
- **Defection:** only unfortified SPs flip automatically; fortified ones still require siege

### Intelligence
```json
{
  "rome": {
    "enemy_armies": [
      { "army_id": "hannibal", "last_known_region": "hispania_citerior", "last_known_turn": 1, "condition_known": false }
    ],
    "enemy_depots": []   // permanent once discovered; never removed
  }
}
```

### Depots
```json
{ "depot_id": "depot_start_1", "side": "carthage", "region_id": "hispania_citerior" }
```
Top-level array in game state. Destroyed when enemy army occupies region.

---

## Italian Region Rules (Important)

The loyalty/defection system (`LOYALTY_REGIONS`) only covers five Italian regions:
`etruria`, `umbria_picenum`, `campania`, `samnium_lucania`, `bruttium_calabria`, `cisalpine_gaul`.

**Occupation rules for Italian theater:**
- **Rome cannot take Italian regions by military occupation** — only loyalty recovery
- **Carthage CAN occupy neutral Italian regions** (e.g. neutral Cisalpine Gaul)
- **Carthage cannot take Roman-held Italian regions by occupation** — only through battle victory or defection roll

These exceptions appear in three places in `server.js`:
1. `applyMilitaryOccupation()` — `italiaBlocked` check
2. Force/refuse resolution — `italiaBocked` check
3. Battle resolve — `italiaBlocked` check

---

## Server Functions — Key Ones

| Function | Location | What it does |
|---|---|---|
| `calculateSupply(state)` | ~line 60 | BFS from each army ≤2 hops to any supply source |
| `applyMilitaryOccupation(state)` | ~line 480 | Flips uncontested non-home regions each turn |
| `detectEncounters(state, enteredFrom)` | ~line 750 | Finds regions with armies from both sides |
| `filterStateForPlayer(state, player)` | ~line 860 | Produces fog-of-war filtered state for each player |
| `calculateAttrition(state, turn)` | ~line 610 | Per-turn attrition; stamps `attrition_pts_this_turn` |
| `checkDefection(state, regionId, crushingVictory)` | ~line 528 | Rolls for Italian defection after Carthage battle win |
| `checkLoyaltyRecovery(state)` | ~line 576 | Restores Italian regions when Rome moves Good/Worn army in |
| `finalizeTurn(state)` | ~line 700 | Runs end-of-turn: supply → attrition → occupation → loyalty → VP |
| `runWinterAutomation(state)` | ~line 1650 | Attrition → recovery → island evacuation → VP snapshot → new season |
| `updateIntelligence(state)` | ~line 400 | Updates last known positions based on adjacency / scouts |

---

## API Endpoints (Actual)

```
GET  /join-status              Are both sides taken?
POST /join                     Join as rome or carthage; returns session token
POST /game/new                 Reset game to 218 BC initial state
POST /game/reset               Alias for /game/new (clears session tokens too)
GET  /game/status              Phase, active_player, orders_submitted status

GET  /state                    Filtered game state for requesting player
GET  /log                      Visible log entries for requesting player

POST /orders                   Submit orders for this turn (holds until both submit)
POST /force-refuse/declare     Declare force or refuse for a pending encounter
POST /emergency-reinforce      Spend 2 resources to reinforce mid-season (once per season)
POST /battle/resolve           Enter Field of Glory 2 result; advances battle queue

POST /winter/naval-bid         Submit naval investment (0–2 resources)
POST /winter/recruit           Submit recruitment decisions; triggers winter automation

POST /dev/trigger-winter       Dev shortcut — jump to winter phase
POST /dev/trigger-game-over    Dev shortcut — end game
POST /admin/sim/start          Simulation mode
GET  /admin/sim/state          Simulation state
```

Authentication: all `/state`, `/orders`, `/battle/*`, `/winter/*` endpoints read `X-Session-Token` header and resolve `player` from `state.sessions`.

---

## Turn Flow (Implemented)

```
Both submit orders (POST /orders)
  → resolveTurn() fires automatically when orders_submitted = { rome: true, carthage: true }
  → applyOrders: move, feint, scout, deep_scout, establish_depot, siege
  → detectEncounters → pending_encounters
  → phantom encounter injection (for feint contacts)
  → if encounters: phase = "encounter", wait for force/refuse declarations
  → POST /force-refuse/declare (both sides)
    → if phantom: reveal feint, log feint_revealed event
    → if real: resolve force/refuse (battle or retreat or shared occupation)
    → if battle triggered: pending_battles queue, phase = "battle"
  → POST /battle/resolve (winner enters result)
    → checkDefection if Carthage won Italian battle
    → loops until pending_battles empty
  → finalizeTurn: supply → attrition → occupation → loyalty recovery → turn counter
  → if turn 8: phase = "winter"
    → POST /winter/naval-bid (both)
    → POST /winter/recruit (both)
      → runWinterAutomation: attrition → recovery → island evacuation → VP → new season
```

---

## Condition Scale

`good → worn → depleted → broken`

- **Attrition points** accumulate within a turn and cause step drops:
  - 2 pts → −1 step
  - 3 pts → −2 steps
- **Battle resolve** asks for "Minor loss" or "Decisive loss":
  - Both add +1 pt on top of supply attrition
  - Decisive also applies direct −1 step immediately
- **Winter attrition:** OOS army drops −2 steps; cannot recover
- **Winter recovery:** home base → Good; in supply elsewhere → +1 step; OOS → none
- `attrition_pts_this_turn` is stamped by `calculateAttrition()` and read by battle resolve to determine net condition

---

## Fog of War

`filterStateForPlayer(state, player)` removes:
- `army.true_region` for enemy armies (sends `last_known_region` instead)
- Enemy `pending_order`
- Enemy `orders` object entirely
- Enemy depots from `depots[]` (sent as empty array for opponent)
- Phantom encounters (`is_phantom: true`):
  - Feinting side: encounter stripped from `pending_encounters`; `phantom_encounter_pending: true` added to state
  - Deceived side: encounter shown without `is_phantom`, `feinting_army_id`, `feinting_side` fields; feinting army injected as present in that region

---

## Phantom Encounter (Feint Contact) Mechanic

When army A moves into a region where army B has placed a feint (but B's true position is elsewhere):

1. `resolveTurn` detects the contact → adds to `phantomRegions` Set
2. Suppresses immediate feint reveal for that region
3. After `detectEncounters`, injects `{ is_phantom: true, feinting_side, feinting_army_id, ... }` encounter
4. Feinting side is auto-declared `[]` (no armies there for them to engage)
5. Deceived side goes through normal force/refuse UI
6. On resolve: feint cleared, `feint_revealed` log event emitted with `feinting_side`, `deceived_side`, `deceived_choice`, `force_wasted`
7. If deceived side chose Refuse: their army retreats to `entered_from` region

---

## Log Events

All `state.log.push()` entries must include both `turn` and `year` fields. The client's `showResolutionSummary()` filters by `e.turn === resolvedTurn && e.year === currentYear`.

`visible_to` is `'rome'`, `'carthage'`, or `'both'`. The `/log` endpoint filters by this.

---

## UI Patterns (app.js / style.css)

- **No global `.hidden { display: none }`** — all `.hidden` rules are element-specific in style.css. When adding a new element that needs hide/show, add `#element-id.hidden { display: none; }` explicitly.
- Modal visibility is driven by `render()` using player-specific `localStorage` keys: `bp_turn_seen_rome`, `bp_turn_seen_carthage`, `bp_year_seen_rome`, `bp_year_seen_carthage`.
- Army condition colouring: good=green bold, worn=dim, depleted=orange bold, broken=red bold.
- Map pip colours: good=green, worn=orange, depleted=amber, broken=red.

---

## Known Deviations from the Design Spec

| Spec says | Implementation |
|---|---|
| `Fresh / Worn / Depleted / Broken` | `good / worn / depleted / broken` (`good` replaces `Fresh`) |
| Season turns per year: 10 | `season_turns_per_year: 8` in initial-state.json |
| Income: 1 resource per 2 regions | Implemented as `Math.floor(controlled.length / 2)` |
| Illyria listed under Italia | Fixed: `theater: "balkans"` |
| Allied contingent for Rome | Not yet implemented |
| Communication delay | Not yet implemented |
| Sardinia & Corsica as island | `ISLAND_REGIONS` has `'sardinia'` but region_id is `'sardinia_corsica'` — verify if needed |

---

## Backlog (Unimplemented)

- **Depot discovery via fog of war** — `updateIntelligence()` and `processScouting()` don't yet populate `enemy_depots` intel array
- **Loyalty/defection display** — logic exists; UI surfacing is minimal
- **Victory conditions** — VP tracking works; win detection not fully wired
- **Allied contingent** (Rome) — not implemented
- **Communication delay** — not implemented
- **Force/refuse consecutive refusal tracking** — `consecutive_refusals` field exists on encounters; auto-force at 2 not wired

---

## Common Pitfalls

1. **Edit tool failures:** Always read the exact lines before editing. The Edit tool requires exact string matches — whitespace, trailing commas, everything.
2. **Year vs turn in logs:** `calculateAttrition` runs after `finalizeTurn` increments `current_season_turn`, so it uses `state.campaign.current_season_turn - 1` for the turn number but `current_year` is still correct. Battle resolve events run after `finalizeTurn` too — year is correct.
3. **Italian region exceptions:** Three separate code paths (occupation, force/refuse, battle resolve) each have their own `italiaBlocked` check. If changing Italian region rules, update all three.
4. **SP flip from neutral:** When a region is taken from `neutral`, all SPs flip regardless of fortification rating. The `prevController` must be captured before `region.controller = newSide`.
5. **`_memState` is primary:** The server loads from file on startup but writes to `_memState` in memory. `saveState()` writes back to file. Never read `game-state.json` directly in code — always use the in-memory state passed around as `state`.
