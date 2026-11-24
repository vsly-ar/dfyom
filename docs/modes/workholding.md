# Workholding: clamps, vises and screws per setup

Status: draft (proposed 2026-11-22 from the [LLM-first black-box test](../plans/v0.4-llm-first.md#source), finding F2; the v0.4 follow-up milestone (after v0.4, before v0.5); every decision below is a proposal until the user answers Q37–Q40) · Plan of record: [plans/v0.4-llm-first.md](../plans/v0.4-llm-first.md) · Base: [plan.md § Setups](plan.md#setups), [plan-v0.2.md § Setups from face directions](plan-v0.2.md#setups-from-face-directions), [plan-v0.1.md § Safe heights](plan-v0.1.md#setup-orientation-work-zero-safe-heights) · Program: [grbl.md](../architecture/grbl.md) · Terms: [glossary.md](../glossary.md)

Today DFYOM has no idea what holds the stock. In the black-box test the bottom program rapided **through a toe clamp at Z1** (retract 2 mm above the face), and nothing flagged it; the agent had to subtract keep-out rectangles from its own design shapes, raise the retract height everywhere and check the G-code with its own script. This doc gives every setup a list of **workholding items** that become obstacles: toolpaths keep out of them, links go up and over them, the clearance height follows them, and a collision check over every move blocks the export when something still hits.

## Decisions

Proposed; settled by [Q37–Q40](../plans/v0.4-llm-first.md#questions-for-the-user).

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

All positions are in the **setup frame**: the [face frame](design-v0.2.md#face-frame) of the setup's up-facing stock face, which is also the program's work coordinate system ([plan-v0.2.md § Work zero](plan-v0.2.md#setups-from-face-directions)): X = `u`, Y = `v`, Z0 on the up-facing stock face, Z up to the spindle. The stock occupies `[0, L] × [0, W] × [−T, 0]` with L, W, T its extents in that orientation. Values are [quantities](../architecture/quantities.md) (formulas over stock faces allowed, e.g. `stock.length / 2`), canonical mm in checks. Edges are named `uMin`, `uMax`, `vMin`, `vMax` (seen from above on the machine: left, right, front, back).

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
- Links between operations over the in-process stock (hardening DF64, draft) are the same kind of post-pass: [safe-links.md](safe-links.md) proposes one pass for both, with the prisms as the floor outside the cleared footprint ([§ Clamps](safe-links.md#clamps)).
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

- The exported header lists the setup's workholding and the work zero, as comments the operator reads at the machine: `(WCS G54: X0 Y0 = front-left corner of the Top face, Z0 = Top face)`, `(Workholding: Toe clamp 1 vMin X45 grip 10 top Z25)`, one line per item ([grbl.md](../architecture/grbl.md) header).
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
