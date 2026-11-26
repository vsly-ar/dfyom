# Tapered ball end mill: a new tool type for fine grooves

Status: draft (2026-11-26; hardening [DF124](../plans/hardening.md#intake-user-feedback-goes-here), the user's TG #409 "Also I have tapered ball nose bits with as low as 3.6°, but it's a different type of the tool"; awaits answers to [Q147–Q153](#questions-for-the-user)) · Extends: [library.md § Tool](../architecture/library.md#tool) (tool types and fields), [engraved-patterns.md § Line operation](engraved-patterns.md#line-operation) (the groove that uses it) · Related: [design-v0.4.md § Chamfer mill tool type](design-v0.4.md#chamfer-mill-tool-type) (the cone model this follows), DF123 (the chamfer mill's `angle` minimum lowered to 10°, [library.md](../architecture/library.md#tool) `angle` row) · Terms: [glossary.md](../glossary.md)

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
