# Tapered ball end mill: a new tool type for fine grooves

Status: accepted (2026-11-26; hardening [DF124](../plans/hardening.md#intake-user-feedback-goes-here), the user's TG #409 "Also I have tapered ball nose bits with as low as 3.6°, but it's a different type of the tool"; [Q147–Q153](#questions-for-the-user) take their recommendations, accepted by delegation D77) · Extends: [library.md § Tool](../architecture/library.md#tool) (tool types and fields), [engraved-patterns.md § Line operation](engraved-patterns.md#line-operation) (the groove that uses it) · Related: [design-v0.4.md § Chamfer mill tool type](design-v0.4.md#chamfer-mill-tool-type) (the cone model this follows), DF123 (the chamfer mill's `angle` minimum lowered to 10°, [library.md](../architecture/library.md#tool) `angle` row) · Terms: [glossary.md](../glossary.md)

A **tapered ball end mill** (also tapered ball nose, tapered carving bit) has a ball tip on a cone that widens to the shank. The cone keeps a tiny tip (Ø 0.2–1 mm) stiff: it engraves and carves fine detail at depths a straight Ø 0.5 mm end mill would break at. DFYOM has no type for it today. A chamfer mill is the nearest, but it has a flat or pointed tip and an included angle of at least 10° (DF123), and a 3.6° tapered ball is 7.2° included with a round tip. So this is a new type, `taperedBallEndMill`.

## The tool

How vendors quote a tapered ball end mill, and the ISO 13399 letters where they exist:

| Quantity                        | Vendor wording                                               | Typical values (router carving bits)                   |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| Tip radius r / tip (ball) Ø     | "R0.25", "tip Ø 0.5 mm", "ball dia (D1)", "tip radius .010″" | r 0.1–1.5 mm (Ø 0.2–3 mm)                              |
| Taper angle **per side** θ      | "taper angle 3.6°", "angle per side 1.5°", "TA"              | 0.5°–15° per side; 1°, 1.5°, 2.2°, 3.6°, 5°, 7.5°, 10° |
| Shank Ø                         | "shank 1/8″", "D"                                            | 3.175, 4, 6, 6.35 mm                                   |
| Flute length (LCF)              | "cutting length", "length of cut"                            | 12–30 mm; about where the cone reaches the shank Ø     |
| Overall length (OAL)            | "overall length", "L"                                        | 38–60 mm                                               |
| Large end Ø (DC, largest cut Ø) | rarely quoted ("large end dia"); usually the shank Ø         | = shank Ø                                              |
| Flutes                          | "2 flute", "single flute"                                    | 1–4                                                    |

- **Per side, not included.** Tapered ball end mills are quoted by the angle of one side to the tool axis (half the included angle). The user's 3.6° is per side: a Ø 0.5 mm tip with 3.6° per side reaches a 1/8″ shank (3.175 mm) 21.5 mm above the tip, which matches the usual 20–25 mm flutes; at 3.6° included (1.8° per side) the cone would only reach the shank 42.8 mm up, longer than a 38 mm bit. The Library form shows the included angle next to it and checks the cone against the flute length ([§ Library window](#library-window), [Q153](#questions-for-the-user)). A chamfer mill and V-bit is quoted by its included angle ([glossary](../glossary.md)): that is why the two types do not share the `angle` field ([Q149](#questions-for-the-user)).
- **The shape.** A ball of radius r and a cone of half-angle θ **tangent** to it. Measured up from the tip:
  - tangent height h_t = r (1 − sin θ), where the cone's radius is r cos θ;
  - lower surface at radial distance ρ: z = r − √(r² − ρ²) for ρ ≤ r cos θ, else z = h_t + (ρ − r cos θ) / tan θ;
  - the cone reaches the large end Ø DC at h_D = h_t + (DC/2 − r cos θ) / tan θ;
  - above min(h_D, LCF) the tool is the shank (no cutting edge).
- **Groove width at depth d** (a straight groove cut in one pass, round bottom of radius r):
  - d ≤ h_t: w = 2 √(d (2r − d)) (the ball alone);
  - d > h_t: w = 2 r / cos θ + 2 (d − r) tan θ, capped at DC.
  - The rule of thumb "tip Ø + 2 d tan θ" is 2r (1 − (1 − sin θ) / cos θ) narrower than the exact width for d > h_t: 0.03 mm for R0.25 at 3.6°. DFYOM uses the exact form.
  - Example, R0.25, 3.6°, DC 3.175: 0.60 mm wide at 1 mm, 0.85 mm at 3 mm, 1.85 mm at 11 mm.

## Tool model

One new `type` value and one new field on the existing tool record ([library.md § Tool](../architecture/library.md#tool)); additive, no `schemaVersion` change (pre-alpha rule). The `diameter` follows the chamfer mill's convention ([Q148](#questions-for-the-user)):

| Field                                                                                            | For `taperedBallEndMill`                                                                                   | Invariant                                                                                          |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `diameter`                                                                                       | DC: the large end of the cone, the largest cutting Ø (usually the shank Ø)                                 | > 0 (as every tool)                                                                                |
| `tipDiameter`                                                                                    | The ball Ø at the tip (2r). Required for this type (optional for a chamfer mill, where it is the flat tip) | `required`; 0 < tip < `diameter` (`range`)                                                         |
| `taperAngle`                                                                                     | **New.** Angle of one side to the axis, as vendors quote it                                                | `required`; 0.5° ≤ θ ≤ 30° (`range`, [Q150](#questions-for-the-user)); `notAllowed` on other types |
| `cornerRadius`                                                                                   | Not stored: derived as `tipDiameter` / 2 (as a ball's is DC/2)                                             | `notAllowed`                                                                                       |
| `angle`, `pointAngle`                                                                            | Not stored                                                                                                 | `notAllowed`                                                                                       |
| `fluteLength`                                                                                    | Height of the cutting edge from the tip                                                                    | as every tool (> 0, < OAL); no rule against h_D ([Q153](#questions-for-the-user))                  |
| `shankDiameter`, `overallLength`, `stickout`, `fluteCount`, `toolMaterial`, `coating`, `presets` | As every tool                                                                                              | unchanged                                                                                          |

- **Cutting profile** (shared by simulation, the removal solid, the safe-link stock field and the width read-out): the ball and cone above up to the height min(h_D, LCF); its outer radius there is the tool's cutting radius. A groove deeper than LCF is `dfm.lineTooDeep` (the flute length is the reach, as for a ball end mill).
- **Not an end mill** for the fit rules: `isEndMillType` stays flat, bull nose and ball, so no pocket, profile, facing, drilling or chamfer accepts it ([§ Operations](#which-operations-can-use-it)).
- **No generalized tapered tool.** There is no standard series to suggest from, so the generalized tool's `type` list (the design tool field's `{ kind: "generalized" }`) does not gain the value; a tapered ball is always a library tool (`{ kind: "specific" }`). This also keeps the five `design.*.add` tool schemas unchanged ([§ Agent API](#agent-api)).

Code: `src/core/library/tool.dto.ts` (`TOOL_TYPES`, `TAPER_ANGLE` range, the field), `src/core/library/tool.ts` (invariants, a `taperHeights()` helper giving h_t and h_D), contract comments pointing here.

## Which operations can use it

| Operation / feature                | Uses it     | How                                                                                                                                                                                                                       |
| ---------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Line** (engraving, fluting)      | yes (first) | Its main use. A new line cutter kind; the groove is round-bottomed and widens with depth ([§ Line](#line-operation)).                                                                                                     |
| **Engraved pattern** (feature)     | yes (first) | Through its owned Line, nothing else to change; the read-out's `grooveWidth` and `maxWidth` use the formula above ([engraved-patterns.md § Crossings and groove width](engraved-patterns.md#crossings-and-groove-width)). |
| Edge chamfer, chamfer              | no          | A chamfer needs a chamfer mill whose included angle matches the chamfer; a 7° wall is not a chamfer, and the round tip would leave a fillet at the bottom. The fit table's `type` row refuses it.                         |
| Pocket, profile, facing, drilling  | no          | Their walls are vertical. A tapered tool's wall would lean by θ (0.13 mm per 2 mm of depth at 3.6°), so it can neither finish a wall nor clean a pocket's corner rest above the floor. `type` unfit, `needs` as today.    |
| Profile `on` (groove along a path) | no          | The Line is the groove operation for shaped tools ([Q151](#questions-for-the-user)).                                                                                                                                      |
| Later: 3D finishing, drafted walls | later       | Relief carving and draft-angle walls are where tapered ball end mills shine; they need 3D toolpaths or a draft model that DFYOM does not have yet ([roadmap.md](../roadmap.md)). Not in this doc.                         |

### Line operation

Changes to [engraved-patterns.md § Line operation](engraved-patterns.md#line-operation) and [§ Toolpath (Plan)](engraved-patterns.md#toolpath-plan), made in the same change as the code:

- **Tool field:** `taperedBallEndMill` joins `chamferMill`, `ballEndMill`, `flatEndMill`. The auto choice stays a 60° V-bit ([Q152](#questions-for-the-user)).
- **Line cutter:** `LineCutter` (`src/core/geometry/model.ts`) gains `{ kind: 'taperedBall', diameter, tipDiameter, taperAngle }`; `lineCutter` in [`tool-choice.ts`](../../src/core/design/tool-choice.ts) maps the type to it, and the fit table's `line` row in `src/core/geometry/tool-fit.ts` accepts the type. Library ranking (`fittingLibraryTools`): V-bits first as today, then tapered ball end mills, then the rest by the usual keys.
- **Width read-out:** the formula of [§ The tool](#the-tool).
- **Removal solid:** per chord, the convex hull of the tool solid (ball + truncated cone up to the groove's top, the cone of the cutting profile) at the chord's two ends, as for the other cutters. The tool solid is convex, so the hull is the exact swept volume.
- **Passes and entry:** as for every Line. `entry: 'plunge'` is allowed for tapered ball end mills as for V-bits (a small tip backed by the cone plunges at `plungeRate`); `ramp` stays the default.
- **DFM:** `dfm.lineTooDeep` at the flute length; no other new finding.

## Simulation and deviation

- **Tool profile:** `toolSurface` (`src/core/toolpath/stock-heights.ts`) and `toolProfile` (`src/core/toolpath/simulate.ts`) gain the ball-and-cone branch of [§ The tool](#the-tool), with the cutting radius as the profile's radius (DC/2, or the cone's radius at LCF when the flutes end first). `ToolpathTool` carries `tipDiameter` and `taperAngle` for the type.
- The height-field simulation, the safe-link stock field and the [deviation check](deviation.md) read the same profile, so nothing else changes. The sub-millimetre tip is narrower than the default simulation cell on a large part; the groove still shows (point-sampled at cell centres, as for a V-bit), and its width is exact only to a cell, as today.

## Feeds and speeds

Amends [feeds-speeds.md § Chamfer mills (v0.4)](../architecture/feeds-speeds.md#chamfer-mills-v04) in the same change as the code:

- **Effective diameter (F11):** De = the groove width at the Line's deepest depth ([§ The tool](#the-tool)), capped at the cutting diameter; the speed is chosen there (the largest diameter in contact, conservative for the surface speed, as F10).
- **Treated as a flat end mill of Ø De**, as a chamfer mill: diameter band, F1, F2, F9, `ae = De`. The **small-De rule** (`fzScale`, below 3.175 mm) applies for the same reason as for chamfer mills: the tip is backed by the cone, not a slender shank. A R0.25 tip in wood typically lands at the spindle's top speed with a fraction of the ≤ 6 mm band's chip load.
- **Stepdown suggestion:** the largest ap with ap ≤ apSlot × rigidity × De(ap), solved in closed form (De grows linearly with depth above h_t), at most the flute length. R0.25, 3.6°, factor 1: ≈ 0.54 mm.
- **Engagement:** a new engagement `taper { depth }` beside `chamfer { depth }`; each needs its own type, else `feeds.noData`. Recommended presets use depth = 1 mm (a typical carving depth), not the full cone.

## Library window

- **Type picker:** "Tapered ball end mill" with its own icon (`toolTypeIcon.ts`).
- **Fields, in vendor order:** Tip Ø (ball), with "R 0.25 mm" beside it; Taper angle (per side), with "7.2° included" beside it; Shank Ø; Large end Ø (DC), prefilled from the shank Ø until edited; Flute length; Overall length; Flutes; the common rest.
- **Read-out:** "Cone reaches Ø 3.175 at 21.5 mm" and the groove width at 1 mm depth.
- **Hint (not an error):** when h_D is more than 1.5 × the flute length or under half of it, "The cone reaches the large end at 42.8 mm, the flutes end at 20 mm: is 3.6° the angle per side?" ([Q153](#questions-for-the-user)).
- **Drawing** (`ToolDrawing.tsx`): ball tip, cone and shank to scale (the cone exaggerated to at least 3° so it reads), dimensions for tip Ø, the per-side angle from the axis, DC, LCF and OAL, the same style as the chamfer mill's.

## G-code

Nothing special for GRBL (no cutter compensation; toolpaths are the tip's centre as for every tool). The tool-change message's type word ([grbl.md § pause messages](../architecture/grbl.md#pause-messages-hardening-df63)) is "tapered ball", and the description adds the tip and angle: `R0.25 3.6°`.

## Agent API

No new tool. `library.tool.add` (and the values of `library.tool.update`) gain:

- `type`: one more enum value, `taperedBallEndMill`;
- `taperAngle`: `"Per side: taperedBallEndMill only, 0.5°–30°"`;
- `tipDiameter`'s description widens to `"chamferMill (absent = pointed) or taperedBallEndMill (ball Ø, required): 0 ≤ tip < DC"`.

The generalized tool's type list and the primer are unchanged ([§ Tool model](#tool-model)). Measured on this doc's base (2026-11-26): `tools/list` **116,699** chars (150 tools; `library_tool_add` 2,429 chars, the only tool with the tool values schema). Estimate: +21 (enum) +88 (`taperAngle`) +37 (`tipDiameter`) **≈ +0.15 K → ≈ 116.85 K** of the 120 K budget (`TOOLS_LIST_BUDGET_CHARS`). Target ≤ 0.2 K, measured in T1 and logged in [llm-api.md § Implementation](../architecture/llm-api.md#implementation-task-310). Lever if over: drop the range from the description (the `range` refusal states it).

## Questions for the user

Numbering continues after [roughing.md](roughing.md#questions-for-the-user)'s Q146. "Q147 ok" takes the recommendation; "all ok" takes every one.

1. **Q147 – A new type.** (1) **A new type `taperedBallEndMill`.** (2) A chamfer mill with a "round tip" flag. (3) A ball end mill with an optional taper angle. _Recommendation: (1)._ As you said, it is a different tool: vendors sell it as its own kind, it is quoted per side (chamfer mills by the included angle), and it cuts round-bottomed grooves; (2) would bend the chamfer rules (angle match, 10° minimum) and (3) would make every ball-end-mill rule (pocket fit, floor fillet) check for a taper.
2. **Q148 – What `diameter` means.** (1) **DC, the large end (usually the shank Ø), with the ball Ø in `tipDiameter`**, the chamfer mill's convention. (2) `diameter` is the ball Ø, the large end is derived and the shank Ø required. _Recommendation: (1)._ Every consumer that reads `diameter` as the tool's outer cutting size (simulation, safe links, collision checks, feeds caps) stays right without a special case, and the field set barely grows. The form shows the tip first, so you still enter it as the vendor lists it.
3. **Q149 – Angle field.** (1) **A new `taperAngle`, per side, as vendors quote it,** with the included angle shown beside it. (2) Reuse `angle` as the included angle (7.2° for your bit). _Recommendation: (1)._ Typing the vendor's number is safer than doubling it in your head; one field for two conventions invites a 2× error that no check catches.
4. **Q150 – Angle range.** (1) **0.5°–30° per side.** (2) 0.5°–15° per side (tapered carving bits only). (3) Anything above 0° and below 45°. _Recommendation: (1)._ It covers every tapered ball listed (0.5°–15°) and ball-tipped V-bits up to 60° included; below 0.5° the cone is effectively a straight ball end mill.
5. **Q151 – Operations first.** (1) **Lines and engraved patterns only;** 3D finishing and drafted walls later. (2) Also profile `on` grooves. (3) Also pockets' fine rest. _Recommendation: (1)._ The Line already handles shaped cutters and depth by levels, which is what a tapered bit is for; profiles and pockets assume vertical walls the cone cannot cut.
6. **Q152 – Auto choice for Lines.** (1) **The 60° V-bit stays the default; among library tools V-bits rank first, then tapered ball end mills, then ball and flat.** (2) A tapered ball is only used when you pick it. (3) Tapered ball end mills rank first. _Recommendation: (1)._ It changes no existing project and still offers the tapered bit before a fragile straight one.
7. **Q153 – Flute length against the cone.** (1) **A hint in the Library form only** when the cone reaches the large end beyond 1.5 × the flute length or before half of it. (2) A library warning stored with the tool. (3) An invariant. _Recommendation: (1)._ Real bits differ (a cone may run out above the flutes), so it must not block; but the mismatch is how a per-side/included mix-up shows, and the form is where you type it.

## Slices

Each slice keeps `npm run check` green, updates this doc (an implementation section) and the [hardening plan](../plans/hardening.md) DF124 row, and can merge on its own. The doc's status moves to `accepted` when the questions are answered.

| Slice | What                                                                                                                                                                                                                                                                                                      | Done when                                                                                                                                                                                                                                                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1    | **Tool model and agent.** `taperedBallEndMill` in `TOOL_TYPES` (not in the generalized list), `taperAngle`, the `tipDiameter` rule for the type, `taperHeights()`, fit table `type` rows (refused everywhere but `line`), post type word, `library.tool.*` schema; library.md amended (type row, fields). | Invariant tests (required/range/notAllowed per field, each with a refusal message); round trip through the DTO; tools/list growth ≤ 0.2 K measured and logged; every golden byte-equal.                                                                                                                                                               |
| T2    | **Lines with it.** `LineCutter` kind `taperedBall`, `lineCutter`, ranking, width read-out, removal solid, `toolSurface`/`toolProfile`, feeds F11 with the `taper` engagement and stepdown suggestion, `plunge` entry; engraved-patterns.md and feeds-speeds.md amended.                                   | Width formula equals a simulated cross-section of a straight groove within one cell at 0.5, 1, 3 mm; removed volume of a curved Line matches the swept-profile integral within 1 %; feeds derivation golden for R0.25 3.6° in hardwood; golden `line-tapered-ball.nc` exports and runs to Idle on the virtual machine; every other golden byte-equal. |
| T3    | **Library window.** Type picker and icon, fields in vendor order with the R and included-angle read-outs, cone read-out and the Q153 hint, drawing.                                                                                                                                                       | Component tests with axe (fields, read-outs, hint at 3.6° with 20 mm flutes entered as 1.8°); hidden e2e: add "R0.25 3.6°" in the Library, pick it in a Line's tool field, see the groove width in the read-out.                                                                                                                                      |

## Implementation (T1)

Built (hardening DF124, slice T1): the tool model and the agent, no operation uses the type yet (T2) and the Library form has no fields for it (T3). Code: `src/core/library/tool.dto.ts` (`TOOL_TYPES`, `GENERALIZED_TOOL_TYPES`, `TAPER_ANGLE`, the `taperAngle` field), `src/core/library/tool.ts` (invariants, `taperHeights()` and `Tool.taper`, `effectiveCornerRadius` = tip / 2), `src/core/toolpath/stock-heights.ts` (`taperedBallProfile`), `src/core/post/grbl/post.ts` (type word and description). Tests: `tool.test.ts` (round trip, the 21.5 mm / 42.8 mm cone heights, required / range / notAllowed per field with the refusal text), `tool-commands.test.ts` (`library.tool.add` stores and refuses; generalized refused; fits no pocket), `simulate.test.ts` (profile, the § The tool widths), `post.test.ts` (type word, mm and inch), `suggest.test.ts` (no feeds data). `tools/list` **116,848** chars (+149, [llm-api.md](../architecture/llm-api.md#implementation-task-310)); every golden byte-equal.

**Decided while building** (the doc above left them open or the code needed them):

- **`tipDiameter` range per type.** A chamfer mill keeps 0 ≤ tip < DC (0 = pointed); a tapered ball needs 0 < tip < DC (a ball of Ø 0 is no ball). One field, two rules, each with its own message; the cross-field `notAllowed` now names both types.
- **Generalized types are a separate list.** `GENERALIZED_TOOL_TYPES` (the old five) types `GeneralizedTool.type`, the stored design tool (`part.dto.ts`) and the `tool` arg (`tool-args.ts`), so a generalized tapered ball is `input.malformed` and the five `design.*.add` schemas stay byte-identical. The candidates' output entry lists every type (a library tool may be tapered); output schemas are not in `tools/list`.
- **Fit and plan rows refuse it everywhere in T1, the `line` row included.** The doc's T1 row says "refused everywhere but `line`", but before T2 the Line has no tapered cutter: `lineCutter` would cut the default 60° V-bit and the toolpath would be wrong. So `line` refuses too until T2 adds the cutter; its `type` detail says so with the next step ("a Line cannot use a tapered ball end mill yet: pick a V-bit (chamfer mill), a ball or a flat end mill"), and the plan's `toolType` finding adds "(tapered ball end mills: not yet)". T2 flips both rows.
- **Simulation profile pulled forward.** `ToolpathTool` carries `tipDiameter` and `taperAngle`, and `toolSurface` / `toolProfile` (and the oracle, through `toolSurface`) have the ball-and-cone branch of [§ The tool](#the-tool) with the cutting radius min(DC/2, the cone's radius at LCF). No toolpath reaches it in T1 (every row refuses), but every reader of a `ToolpathTool` (safe links, shape findings, collision) now gets the real shape instead of falling into the flat end mill branch. T2 adds the cross-section and volume tests.
- **Feeds: `feeds.noData` until T2.** The calculator would otherwise treat the tool as a flat end mill of the large end Ø (a slot of Ø 3.175 mm on a Ø 0.5 mm tip). `contextOf` refuses it: "no calculator data for a tapered ball end mill yet: enter the values"; a recommended preset reports that reason, entered presets work.
- **G-code description.** `ProgramTool` gains optional `tipDiameter` and `taperAngle` (set only for the type, in `plan-export.ts`); the post writes `, 3.175 mm tapered ball R0.25 3.6 deg`: the ball's radius in program units (`R0.0098` in an inch program) and ` deg` for `°` (the post's printable-ASCII rule, [grbl.md](../architecture/grbl.md#pause-messages-hardening-df63)).
- **Library window before T3.** The type picker offers "Tapered ball end mill" only on a tool that already is one (added by the agent), so a user cannot pick a type whose fields the form does not show yet; such a tool keeps its tip and taper angle on save (`cleanValues` keeps them for the type and drops them for others). Its icon is the ball end mill's until T3 draws its own; `withToolType` fills a typical tip (Ø 0.5 mm or 0.02″) and 3.6° when a draft becomes one; the type label is "Tapered ball end mill", the short name word "Tapered ball", search aliases "tapered", "taper", "carving".

## Implementation (T2)

Built (hardening DF124, slice T2): Lines and engraved patterns cut with a tapered ball end mill. Code: `src/core/library/tool.ts` (`taperedGrooveWidth`, the one width formula), `src/core/geometry/model.ts` and `schemas.ts` (`LineCutter` kind `taperedBall`), `src/core/geometry/line.ts` (`grooveWidth`, `cutterEdgeHeight`, the ball-and-cone rings of the removal solid), `src/core/geometry/dfm.ts` (`dfm.lineTooDeep`), `src/core/geometry/tool-fit.ts` and `src/core/plan/checks.ts` (the `line` rows accept it), `src/core/design/tool-choice.ts` (`lineCutter`, `dfmTool`, ranking), `src/core/plan/strategy.ts` (plunge entry), `src/core/feeds-speeds/` (`taper` engagement, F11, `taperedStepdown`, preset at 1 mm), `src/core/plan/feeds.ts`. Tests: `line.test.ts` (widths of [§ The tool](#the-tool), the curved line's volume against the swept-profile integral within 1 %, `dfm.lineTooDeep` at the flutes), `simulate.test.ts` (simulated straight-groove width = the read-out within one 0.1 mm cell at 0.5, 1, 3 mm), `formulas.test.ts`, `preset.test.ts`, `suggest.test.ts` (derivation golden `src/core/feeds-speeds/__golden__/tapered-ball-hardwood.json`), `post.test.ts` (golden `line-tapered-ball.nc`, streamed on the virtual machine), `engraving-tapered-ball.test.ts` (auto choice, read-out 0.6 mm, plan without errors, plunge, export to −1 mm, streamed). `tools/list` **117,309** chars (+171, [llm-api.md](../architecture/llm-api.md#implementation-task-310)); every other golden byte-equal.

**Decided while building:**

- **One width formula.** `taperedGrooveWidth` lives beside `taperHeights` in `library/tool.ts` (pure, no geometry imports), so the Line's read-out, the merge and footprint widths (`grooveWidth`) and the F11 step are the same function.
- **Removal solid rings.** The ball's profile is sampled finer than the chord tolerance up to the tangent angle (π/2 − θ), then the cone to h_D, then the large end Ø up to the groove's top (as a V-bit's cylinder above its cone). The swept volume test passes within 1 % on the curved line 0.2 → 1.5 mm.
- **Cutting length.** `dfm.lineTooDeep` uses min(h_D, flute length) for a tapered ball as for a V-bit (`cutterEdgeHeight`, renamed from `vBitEdgeHeight`): a tapered ball's flutes usually end before its cone reaches DC.
- **Ranking:** V-bits (nearest 60° first), then tapered balls, then the rest by the usual keys; with no library V-bit a library tapered ball is the auto choice before the generalized 60° V-bit, as any fitting library tool is.
- **Feeds: RE = 0.** The tool is a flat end mill of Ø De: its ball is already in De, so F4 and F5 do not apply the tip radius again (`effectiveCornerRadius` stays the tip radius for everything else). The stepdown is suggested (`taperAp` step, closed form per piece of De, ≤ flute length); router rows' chart rpm still wins over F1, so the R0.25 3.6° hardwood golden runs at 18,000 rpm, ≈ 600 mm/min, stepdown 0.25 mm (hobby).
- **Agent schema.** The `feedsSpeeds.suggest` engagement union gains `taper { depth }` (+171 chars); the plan operation output's engagement enum gains `taper` (output schemas are not in `tools/list`).
- **Dialect check.** The post test's "no `R` word" rule now skips comments: the tool-change comment carries the ball radius (`R0.25`), which GRBL strips with the comment; the `M0 ;` message was already exempt.

## Implementation (T3)

Built (hardening DF124, slice T3): the Library window and the quick "New tool…" dialogs offer "Tapered ball end mill" for every new tool, with its fields, read-outs, the Q153 hint and its drawing ([ui.md § Tapered ball end mill in the Library window](../conventions/ui.md#tapered-ball-end-mill-in-the-library-window)). Code: `src/renderer/src/library/ToolFields.tsx` (the fields), `form.ts` (`taperedNotes`, `withToolType`, `toolName`), `ToolDrawing.tsx` (the drawing), `ItemTable.tsx` (Angle column), `toolTypeIcon.ts`, `ui/icons/iconSet.ts` (`tapered-ball-end-mill`), `ui/icons/field/FieldIcon.tsx` (`ballTip`, `taperAngle`). Tests: `form.test.ts` (defaults valid in mm and inch, name, read-outs, the hint over 1.5 × and under ½ × with no issue), `LibraryWindow.test.tsx` (vendor order, read-outs, the hint at 1.8° on 20 mm flutes, drawing and legend, save, Angle column, the large end following the shank, axe), `e2e/library.e2e.ts` (hidden: types Ø 0.5 mm, 1.8° then 3.6°, a 1/8 in shank; saved, listed with "3.6°/side", values read back from the library).

**Decided while building:**

- **Fields as notes.** "R 0.25 mm" (Tip diameter (ball)), "7.2° included" (Taper angle (per side)) and "Cone reaches Ø 3.175 mm at 21.5 mm." (Large end diameter, from `taperHeights()`) are field notes in the support area; the Q153 hint is an `info` message at Flute length, so Save never blocks on it. The hint's text names the angle as typed ("is 1.8° the angle per side?").
- **Vendor order with the shank before the large end.** The shank shows in the quick dialog too for this type (the large end follows it). The large end follows the shank while the two are equal (a new one starts equal), so a large end typed apart from the shank, or stored so, stays.
- **Becoming one sets a typical bit:** a 1/8″ (3.175 mm) shank and large end (a shank already entered stays), flutes 20 mm / 3/4″, and T1's R0.25 / 0.01″ at 3.6°, so a new one opens without the hint. Name suggestion "Tapered ball R0.25 3.6°" (the radius in the tip's unit), as the G-code comment.
- **Groove width read-out not yet.** "Width at 1 mm" needs T2's width formula in the core; the form will read it from there rather than repeat the formula. Likewise the e2e's "pick it in a Line's tool field, see the groove width" waits for T2 (the Line refuses the type until then); T3's e2e adds, stores and lists the tool.
- **Drawing.** A schematic as the chamfer mill's: the cone drawn about 9° per side (the doc's "at least 3°"), tangent to the ball; TA (vendor letter, no ISO 13399 symbol) is an arc between a dashed axis-parallel line and the right flank; LCF runs from the cone's top. The legend's columns may now wrap (long names), so it stays inside the aside.
- **Item list.** The Angle column shows "3.6°/side" for this type (sorted by the included angle, beside chamfer mills' included angles).
