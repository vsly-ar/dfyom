# Workholding: clamps, vises and screws per setup

Status: implemented (hardening DF59, 2026-11-24; accepted Q37–Q40) except what [Implementation notes](#implementation-notes-df59) defers: the hops inside an operation come with DF64's link pass (proposed 2026-11-22 from the [LLM-first black-box test](../plans/v0.4-llm-first.md#source), finding F2; the user answered Q37–Q40 on 2026-11-24, TG #270 "ok", every recommendation taken) · Plan of record: [plans/v0.4-llm-first.md](../plans/v0.4-llm-first.md) · Base: [plan.md § Setups](plan.md#setups), [plan-v0.2.md § Setups from face directions](plan-v0.2.md#setups-from-face-directions), [plan-v0.1.md § Safe heights](plan-v0.1.md#setup-orientation-work-zero-safe-heights) · Program: [grbl.md](../architecture/grbl.md) · Terms: [glossary.md](../glossary.md)

Today DFYOM has no idea what holds the stock. In the black-box test the bottom program rapided **through a toe clamp at Z1** (retract 2 mm above the face), and nothing flagged it; the agent had to subtract keep-out rectangles from its own design shapes, raise the retract height everywhere and check the G-code with its own script. This doc gives every setup a list of **workholding items** that become obstacles: toolpaths keep out of them, links go up and over them, the clearance height follows them, and a collision check over every move blocks the export when something still hits.

## Decisions

Settled by [Q37–Q40] (user, 2026-11-24, every recommendation taken)(../plans/v0.4-llm-first.md#questions-for-the-user).

| Id   | Decision                                                                                                                                                                                                                      | Section                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| WH-A | Workholding belongs to a **plan setup**, not to the design: it depends on how the stock sits on the machine. Items are stored inline in the setup with built-in defaults; a workholding library comes later (Q37).            | [Model](#model)                                   |
| WH-B | Every item expands to **obstacle prisms** (a 2D footprint in the setup frame plus a Z range). Every check works on prisms only, so a new kind is only a new expansion.                                                        | [Obstacles](#obstacles)                           |
| WH-C | **Links and rapids hop up and over** an obstacle instead of raising the retract height everywhere; the clearance height defaults to the top of the highest item plus the margin (Q39).                                        | [Links and safe heights](#links-and-safe-heights) |
| WH-D | **Cutting moves never enter a keep-out zone.** Region operations (pocket, facing) leave the zone uncut and say so; a profile, groove or drilling that would cross one is an error that blocks the export of that setup (Q38). | [Keep-out in toolpaths](#keep-out-in-toolpaths)   |
| WH-E | One **collision check** over every move of the setup's program (rapids, links, leads, pecks, tool changes) against the obstacles; errors block `plan.export` and `run.job.start` like every other error finding.              | [Collision check](#collision-check)               |
| WH-F | The tool is checked as a conservative vertical cylinder of radius max(cutting Ø, shank Ø) / 2 from its tip upward; holders and collet nuts come with a machine holder model later (Q40).                                      | [Collision check](#collision-check)               |
| WH-G | One arrangement per setup. Moving clamps half-way through is a **second setup of the same direction** ("Top 2", already supported by split), not a step inside a setup.                                                       | [Not yet](#not-yet)                               |

## Frame

All positions are in the **setup frame**: the [face frame](design-v0.2.md#face-frame) of the setup's up-facing stock face, which is the program's work coordinate system shifted by the setup's work zero ([plan-v0.2.md § Work zero](plan-v0.2.md#setups-from-face-directions); the zero is the frame's origin unless the setup moves it, DF78, [alignment.md § Frames](alignment.md#frames)): X = `u`, Y = `v`, Z0 on the up-facing stock face, Z up to the spindle. The stock occupies `[0, L] × [0, W] × [−T, 0]` with L, W, T its extents in that orientation. Values are [quantities](../architecture/quantities.md) (formulas over stock faces allowed, e.g. `stock.length / 2`), canonical mm in checks. Edges are named `uMin`, `uMax`, `vMin`, `vMax` (seen from above on the machine: left, right, front, back).

## Model

A setup record gains `workholding: WorkholdingItem[]` (absent = empty; pre-alpha, no schema bump, [migrations.md](../conventions/error-handling/migrations.md#pre-alpha-exception-no-data-preservation-yet)). Each item: `{ id, name, kind, …kind parameters }`; ids `wh1`, `wh2`, … per plan; default names "Toe clamp 1", "Vise", "Screw 3".

| Kind       | Parameters (defaults)                                                                                                                                                                                                                 | Typical use                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `toeClamp` | `edge` (`uMin`…`vMax`), `at` (position along the edge, mm from the edge's start), `width` (30 mm), `grip` (overlap onto the stock, 10 mm), `reach` (beyond the edge: strap, bolt, heel; 50 mm), `top` (highest point above Z0, 25 mm) | Toe / strap clamps and hold-down clamps on a router table         |
| `vise`     | `axis` (`u` or `v`: the direction the jaws close along), `protrusion` (stock above the jaw tops, 5 mm), `jawLength` (150 mm, centred on the stock), `jawThickness` (20 mm), `soft` (false)                                            | Machine vise, soft jaws (soft only changes the label in v1)       |
| `screw`    | `center` `[u, v]`, `headDiameter` (8 mm), `top` (head top above Z0; 0 = flush or countersunk)                                                                                                                                         | Hold-down screws through the waste into the spoilboard            |
| `block`    | `center` `[u, v]`, `length`, `width`, `rotation` (0°), `bottom` (Z, default the table: −T), `top` (Z)                                                                                                                                 | Fixture blocks, stops, dowels, anything else: the escape hatch    |
| `base`     | `type` (`spoilboard` or `fixturePlate`), `sacrificial` (true for a spoilboard, false for a fixture plate)                                                                                                                             | What the stock sits on; only matters for breakthrough             |
| `surface`  | `type` (`tape`, `vacuum`, `glue`)                                                                                                                                                                                                     | Holds the bottom face; no obstacle, but pieces cut free stay held |

- **Invariants** (`model.invariant`, path `setups.<id>.workholding.<n>.<param>`): sizes > 0; `toeClamp.at` within the edge, `grip` < the stock extent across the edge; `vise` needs two parallel stock sides along `axis` (any setup of a block stock has them); at most one `vise`, one `base`, one `surface` per setup; `top` > `bottom`.
- **No item = today's behaviour** plus one info finding per setup, `plan.workholding.none` ("No workholding in Top: rapids are not checked against clamps"), so an agent learns the concept exists.

## Obstacles

`obstacles(setup) → Prism[]`, pure in `src/core/plan/` (each prism `{ itemId, loop (2D, setup frame), zMin, zMax }`, `zMin = −∞` meaning "down to the table"):

| Kind       | Prisms                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toeClamp` | One rectangle `width` wide from `grip` inside the edge to `reach` outside it, `zMin` = −∞ outside the stock and Z0 over it (two prisms), `zMax` = `top` |
| `vise`     | Two jaws on the two stock sides normal to `axis`: `jawThickness` × `jawLength`, from −∞ to `−protrusion`                                                |
| `screw`    | A circle of `headDiameter`, from −∞ (the shank goes through the stock) to `top`                                                                         |
| `block`    | The rotated rectangle from `bottom` to `top`                                                                                                            |
| `base`     | The whole table below the stock: from −∞ to −T (only checked against breakthrough, [below](#collision-check))                                           |
| `surface`  | none                                                                                                                                                    |

The **margin** `workholdingMargin` (setup field, default 2 mm / 0.08″, ≥ 0) is added around every prism, sideways and above. The **keep-out zone** of a prism for a tool of radius R is its footprint offset by R + margin (2D port `offset`), up to `zMax` + margin.

## Links and safe heights

- **Clearance height** (rapids between operations, tool changes, start, end): its default becomes max(10 mm, highest `zMax` over all prisms + margin), measured from Z0 as before. A value set by the user stays; one below that height is the error `plan.workholding.clearanceLow` (blocks export) naming the item.
- **Retract height** stays low (default 2 mm above the operation's surface). Inside an operation every rapid on the retract plane and every link that would pass through a keep-out zone below its top is rewritten as a **hop**: straight up to the zone's top (`zMax` + margin; the highest of the zones crossed), across, straight down to the retract plane. A hop never goes above the clearance height (it is at most that by construction).
- Links between operations over the in-process stock (hardening DF64, L1–L2 implemented) are the same kind of post-pass: [safe-links.md](safe-links.md) reads `floorAlong` for every link, the items in place of the clamp height ([§ Clamps](safe-links.md#clamps)).
- The hops are a **post-pass over the setup's ordered toolpaths** (`linkAroundWorkholding`), after generation and before the check: the per-operation toolpath cache keeps its keys, and moving a clamp re-runs only the post-pass and the check. In the black-box test this replaces "clearance 35 / retract 27 on both setups" (+120 s) with a few hops.

## Keep-out in toolpaths

Cutting moves are feed moves below Z0 + margin; none may enter a keep-out zone below the zone's top.

- **Pocket and facing** (regions): the keep-out footprints offset by the margin join the region's islands for the generator ([plan-v0.3.md § Offset clearing](plan-v0.3.md)), so the clearing goes around them. Material the design removes but the tool cannot reach there is reported as `plan.workholding.unmachined` (warning, per operation and item, with the area in mm² and its bounds), and the [deviation check](deviation.md) attributes it to workholding. Generator input includes the footprints, so these operations regenerate when a clamp moves.
- **Profile, groove, drilling, chamfer:** if a pass crosses a keep-out zone the error `plan.workholding.collision` (kind `cut`) names the operation, the item and the place; nothing is skipped silently (skipping part of a profile would leave the part attached in an unknown way). The fix is to move the clamp, add a second setup, or (later) let a tab sit under the clamp.
- The agent never edits design shapes to dodge clamps again; the design stays the part, the plan holds the clamps.

## Collision check

`checkWorkholding(program moves, tool, prisms, margin) → Finding[]`, run after the link post-pass for every setup and again by `plan.export` on the final moves (the **export guard**):

- **Tool envelope (WH-F):** a vertical cylinder of radius max(cutting diameter, shank diameter) / 2 from the tip up to infinity. A move collides when, at any point of it, the tip is below a prism's `zMax` + margin and the tool axis is within the radius + margin of the prism's footprint. Lines exactly; arcs and helices exactly in XY with Z taken as the move's lowest Z (conservative).
- **Every move** of the setup's program: the first rapid, rapids at clearance, retracts, hops, links, lead arcs, ramps and helices, pecks, tool-change moves and the end. Findings: `plan.workholding.collision` (error, kind `rapid`, `link` or `cut`) with the operation, item, move index, the lowest Z and the minimum distance; `plan.workholding.close` (warning) when the distance is under 2 × margin.
- **Breakthrough into the base:** a cut below −T (through features use `breakthrough`, [plan-v0.1.md](plan-v0.1.md)) is fine on a sacrificial `base`, an error `plan.workholding.breakthrough` on a fixture plate, and unchecked without a `base` item (today's behaviour).
- **Screws inside the part:** a `screw` whose footprint meets the part's final solid in that setup is `plan.workholding.inPart` (warning): it would leave a hole in the part.
- **Held pieces:** with a `surface` item, pieces cut free count as held, so `plan.cutoutBeforeSetup` and the loose-piece warnings ([glossary: Loose piece](../glossary.md)) are suppressed for that setup; without one, a piece cut free with no tabs is `plan.workholding.partLoose` (warning).
- Errors block `plan.export` of that setup and `run.job.start` on it, as every error finding does ([plan-v0.2.md § Export](plan-v0.2.md)); the result names the first collision so an agent can act in one step.

## Program and Run

- The exported header lists the setup's workholding after the work zero lines, as comments the operator reads at the machine: one line per item, `(Workholding: Toe clamp 1: front X45 grip 10 top Z25)` (the item's summary in the program's units), then `(Every move checked: 2 mm clear of the workholding)`; with items, DF59's "Keep clamps …" lines are left out ([grbl.md § Header](../architecture/grbl.md)).
- The setup-change dialog ([ui.md § Setup change](../conventions/ui.md)) draws the items in its picture and lists them ("Place 4 toe clamps: …"); the virtual machine does not check them (Plan already did).

## Commands and queries

One union-style tool keeps the agent API small ([llm-api.md](../architecture/llm-api.md), budget per [Q41](../plans/v0.4-llm-first.md#questions-for-the-user)):

| Command / query        | Args                                                                                                                          | Result                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `plan.workholding.set` | `{ planId, setupId, items?: WorkholdingItem[], copyFrom?: setupId, margin? }` – replaces the setup's whole list (declarative) | `{ items (with ids and `bounds` of their prisms), clearanceHeight, findings }` (only the workholding findings of that setup) |

- A `document` command (undoable, one step); `items` and `copyFrom` are exclusive; `copyFrom` copies another setup's items by edge and position (both are face-frame relative, so a flip keeps "front edge at X45").
- Items without `id` get new ids; items with an id keep it (so the UI's drag sends the edited list and selection survives).
- It is an **instant reaction** for the plan record and a deferred one for toolpaths of region operations ([apply.md](../architecture/apply.md#instant-and-deferred-reactions)).
- Reading: the items are part of the setup records in `plan.get` and `plan.setup` results; no separate `list` tool.

## UI (summary)

Rules go to a [ui.md](../conventions/ui.md) amendment (plan task 1.6):

- **Setup inspector:** a "Workholding" section: the item list (icon, name, one-line summary), an Add menu (Toe clamp, Vise, Screw, Block, Spoilboard / fixture plate, Tape / vacuum), the margin, and per item its fields; the derived clearance height shows "from Toe clamp 2 + 2 mm".
- **Plan viewport:** items drawn as neutral solid geometry (not the accent, not the stock colour), keep-out zones as a faint dashed halo while an item is selected; toe clamps drag along their edge with snap to the stock corners and the edge midpoint; a colliding move draws red with a marker at the first hit, and the finding selects it.
- **Run scene and setup-change picture:** the same items, so the operator sees what to place.

## Testing

- `obstacles` per kind (prisms, margins, rotations, every edge); `linkAroundWorkholding` (a link across one clamp hops once, across two hops to the higher top, no hop when the link clears); keep-out islands (coverage oracle: no cut inside the zone, leftover area equals `unmachined`).
- `checkWorkholding` against the black-box test's case: the bottom program of the enclosure with retract 2 mm and the four clamps (pads 30 × 10 at x 30–60 / 190–220, y 0–10 / 190–200, 25 mm tall) reports the rapid at Z1 across the clamp at x 188–222; after the post-pass, none.
- An **independent G-code oracle** in tests (parses the exported program, true G2/G3 arcs, like the test agent's `clampcheck`) confirms the minimum distance ≥ margin, so the check is never verified only by itself.

## Implementation notes (DF59)

Built in hardening DF59 (2026-11-24). Code: `src/core/plan/workholding/` (`items.ts` model, defaults, invariants and summaries; `obstacles.ts` prisms, distances, the derived clearance and the link interface; `setup.ts` the memoised per-setup view; `check.ts` the collision check; `findings.ts` the findings; `commands.ts` `plan.workholding.set`), `src/core/toolpath/keep-out.ts` (keep-out regions), the export guard in `src/core/post/plan-export.ts`, the header in `src/core/post/grbl/post.ts`; UI in `src/renderer/src/modes/plan/Workholding.tsx`, `workholding-scene.ts` and `src/renderer/src/viewport/WorkholdingLayer.tsx`.

- **Storage.** `setup.workholding?: WorkholdingItem[]`, `setup.workholdingMargin?: length` and `setup.clearanceHeightSet?: true` (the user set the clearance height; `plan.setup.update { clearanceHeight: 'auto' }` clears it and restores the default). Optional fields, no `schemaVersion` change. Item params are plain quantities (no formulas over stock faces yet). Ids `wh<n>` are unique per plan; a split setup starts without items.
- **Toe clamp position.** `at` is the clamp's centre along the edge, in the setup frame's coordinate along that edge (X for the front and back edges, Y for left and right; default the middle). Moving a clamp to another edge without an `at` re-centres it. Summaries name the edge and that coordinate: `front X125 grip 10 top Z12`.
- **Clearance (WH-C).** `effectiveClearance`: not set by the user, the setup's clearance height is max(stored, highest item top + margin), rounded up to 0.1 mm, and the inspector says where it comes from ("From Toe clamp 2 + 2 mm."). Set by the user below that, `plan.workholding.clearanceLow` (error, field `setup.clearanceHeight`). Every reader of the clearance (inputs, machine and Z headroom checks, header) uses `setupWorkholding(setup, stock).clearance`.
- **Keep-out (WH-D).** Facing and pocket inputs carry `keepOut` (the setup's prisms in the setup frame and the margin; the keep-out undoes the setup's turn into the face frame, never a moved work zero) when the setup has items; the zones a pass reaches below (`deepest < zMax + margin`) are grown by the margin (2D port offset; the generator keeps the tool radius off them) and subtracted from the region; the facing then runs as a region pocket (ramp entry, one finish pass at depth). `plan.workholding.unmachined` (warning) is the region ∩ (footprint ⊕ margin) per item, in mm² with its bounds in the WCS. The toolpath cache key adds `keepOut` only when present, so plans without items keep their keys.
- **Collision check (WH-E/F).** `checkWorkholding` walks every move of the setup's toolpaths in order (drill cycles expanded with their rapid to the retract plane, arcs split into chords with 0.001 mm sagitta at the arc's lowest Z) with a tool of radius max(cutting Ø, shank Ø) / 2; a move part below `zMax + margin` closer than the margin (0.01 mm tolerance) is a collision: kind `cut` (feed), `link` (a rapid with both ends at or above the clearance height) or `rapid`. The first collision per (operation, item, kind) is reported, with `params { setupId, itemId, kind, moveIndex, x, y, lowestZ, gap }`; `x`, `y` (and the message's "near X… Y…") are in the WCS, so with a moved work zero they are what the machine shows ([alignment.md](alignment.md) S12). `plan.workholding.close` (warning) is limited to rapids and links under 2 × margin (feed moves beside a clamp are the keep-out's job). A fixture-plate `base` makes a cut below −T `plan.workholding.breakthrough` (error).
- **Where errors block.** Workholding findings are listed by `plan.warning.list` but kept out of `planFindings`, so they do not block toolpath generation; `plan.export` (and with it `run.job.start`, which exports) runs the static and move checks of the exported setup on the final moves and fails with `plan.check`, the first error's message and every error as an issue (`rule` = finding code).
- **In-operation rapids are not lifted here.** A rapid on the retract plane across a clamp is reported (`collision`, kind `rapid`, "raise the retract height above Z… or move the item") instead of rewritten as a hop: the hops are DF64's link pass (below). The user's case does not need one: the keep-out leaves the facing's links clear of the clamps (the exported program is checked by an independent G-code oracle in `user-case.test.ts`).
- **Agent API.** `plan.workholding.set` (2.26 K of `tools/list`; one flat item schema with every kind's params and one description, parameters that are not the kind's are refused with rule `notForKind`; an item with an `id` merges with the stored item; `copyFrom` copies another setup's list with new ids; an empty list removes the field). Result: items with `summary`, `bounds` and `top`, the clearance height in project units and this setup's static findings.

### Obstacle interface for DF64's link pass

`setupWorkholding(setup, stock).obstacles` is a `WorkholdingObstacles` (`obstacles.ts`): `{ prisms, margin, floorAlong(a, b, radius) }`. `floorAlong` returns the highest `zMax + margin` over the prisms whose footprint comes within `radius + margin` of the XY segment a→b, or −∞ when none does: a link (or a hop's horizontal leg) at or above it passes every item. DF64's `planLinks` uses it as the floor outside the cleared footprint in place of `clampHeight` ([safe-links.md § Clamps](safe-links.md#clamps)); the rewritten moves then go through the same `checkWorkholding` at export.

### `clampHeight` superseded by items

[safe-links.md](safe-links.md) (DF64) adds an optional per-setup `clampHeight`. When a setup has workholding items, the items are the floor and `clampHeight` is ignored (derived: the highest item top); it stays the fallback for a setup without items. DF64 reads `setupWorkholding(…).prisms.length > 0` to choose ([safe-links.md § Implementation notes](safe-links.md#implementation-notes-l1l3)).

### Deferred

| Item                                                            | Why / where                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Hops inside an operation and between operations                 | DF64's link pass, through the interface above                                  |
| `plan.workholding.inPart`, `partLoose`, held pieces (`surface`) | Need the part solid per setup and the loose-piece rules; next workholding step |
| Formulas in item params (`stock.length / 2`)                    | Plain quantities for now                                                       |
| Toe clamp drag in the viewport, the setup-change dialog list    | UI follow-up; the inspector edits every param                                  |
| Items in the Run scene                                          | With the setup-change picture                                                  |

## Not yet

| Item                                          | Why / where                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| Workholding library (Library window tab)      | After the item kinds settle; `ui-library-window.md` already reserves the tab    |
| Moving clamps between operations of one setup | Use a second setup of the same direction (WH-G); a "move clamps" pause later    |
| Holder, collet nut and spindle collision      | Needs a holder model on the machine (WH-F)                                      |
| A tab placed under a clamp automatically      | After profiles and tabs see workholding                                         |
| DFM in Design using workholding               | Design has no setups; plan findings carry it                                    |
| Clamping force, vibration, part deflection    | Simulation, much later ([plan.md § Simulation](plan.md#simulation--prediction)) |
| Automatic arrangement (`auto: 'toeClamps'`)   | Proposed as task W6 in the plan, first to cut                                   |

## Open questions

- Should `toeClamp.top` default from the stock thickness (a clamp is usually set level, top ≈ stock top + 15–25 mm) or stay a fixed 25 mm? Proposal: fixed, shown in the inspector.
- Does a link that hops count against the time estimate (yes, it is a real move) and should the estimate show "+N s for workholding"? Proposal: yes, in the export stats.
