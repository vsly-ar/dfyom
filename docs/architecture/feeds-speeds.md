# Feeds-and-speeds calculator

Status: accepted · Code: [`src/core/feeds-speeds/`](../../src/core/feeds-speeds/suggest.ts) · Used by: [plan-v0.1.md](../modes/plan-v0.1.md#feeds-and-speeds) · Presets: [library.md](library.md#feeds-and-speeds-presets) · Values: [quantities.md](quantities.md) · Terms: [glossary.md](../glossary.md) · Task: [v0.1 plan](../plans/v0.1.md) 1.15 (code: 2.12)

The calculator is the third step of the [resolution order](../modes/plan-v0.1.md#feeds-and-speeds) (override → tool preset → **calculator** → strategy fallback). It suggests `spindleSpeed`, `feedRate`, `plungeRate`, `stepdown` and `stepover` for one plan operation from the tool, the stock's material class, the strategy's engagement and the machine, and explains every number ([principles §5](../principles.md#5-user-friendly-beginner-friendly-highly-graphical)).

## Formulas

Symbols follow Sandvik Coromant (ISO): `vc` surface speed, `D` tool diameter, `z` flutes (NOF), `fz` chip load, `n` spindle speed, `vf` feed rate, `ae` radial engagement (stepover), `ap` axial engagement (stepdown), `fn` feed per revolution, `Q` material removal rate, `u` unit power. Metric shown; inch input is converted by the quantity layer.

| #   | Quantity                    | Formula                                                                                     | Source                     |
| --- | --------------------------- | ------------------------------------------------------------------------------------------- | -------------------------- |
| F1  | Spindle speed               | `n = vc·1000 / (π·Dcalc)`; `Dcalc` = `D`, or `De` (F4)                                      | [S1], [MH]                 |
| F2  | Feed rate                   | `vf = n · z · fz_prog`                                                                      | [S1], [MH]                 |
| F3  | Radial chip thinning (RCTF) | `ae < D/2`: `fz_prog = fz / (2·√((ae/D)(1 − ae/D)))`; otherwise `fz_prog = fz`              | [MD], [S1] (`hex`)         |
| F4  | Effective diameter          | `ap < RE`: `De = D − 2·RE + 2·√(ap(2·RE − ap))`; ball: `RE = D/2` gives `De = 2√(ap(D−ap))` | [K1], [HT1]                |
| F5  | Axial chip thinning (ACTF)  | `ap < RE`: `fz_prog = fz / sin κ`, `cos κ = (RE − ap)/RE`; flat end mill: none (`κ = 90°`)  | [S1] (`hex = fz·sin κ`)    |
| F6  | Material removal rate       | `Q = ae · ap · vf` (mm³/min)                                                                | [S1], [MH]                 |
| F7  | Cutting power               | `Pc = Q · u / 60 000` (kW, `u` in W·s/mm³); `u = Kp · 2.73` from Machinery's Handbook `Kp`  | [S1] (`kc`), [MH], [AD]    |
| F8  | Drilling feed               | `vf = fn · n`; `fn` from the data table per material × diameter band                        | [S2]                       |
| F9  | Plunge rate (end mill)      | `plungeRate = kPlunge · vf` (data, e.g. 0.5 wood/plastic, 0.3 metals); drills use F8        | heuristic, to be confirmed |

- F3 and F5 multiply when both apply. Both are capped at ×3 to avoid runaway feeds at tiny engagement ([MD]).
- **Adaptive/HSM:** large chip-thinning gains with deep `ap` and small constant `ae` assume constant tool engagement ([glossary: adaptive clearing](../glossary.md)). v0.1 offset pocketing has full-width engagement in its first ring and in corners, so it gets **no RCTF credit** (see [Engagement](#engagement-per-strategy)).
- Ramps and helices feed at `feedRate` ([plan rule](../modes/plan-v0.1.md#feeds-and-speeds)); Sandvik recommends ~75 % for circular ramping [S3]; v0.1 keeps the cutting feed and relies on the slot engagement below.

## Inputs and outputs

| Input      | From                                                                               | Used for                                  |
| ---------- | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| Tool       | plan's tool copy: `type`, `diameter`, `cornerRadius`, `fluteCount`, `toolMaterial` | F1–F5, F9; data row and diameter band     |
| Material   | stock `material.class` ([library](library.md#stock))                               | data row                                  |
| Engagement | strategy + resolved `stepover`/`stepdown` (override or preset win, see below)      | F3–F7                                     |
| Machine    | `spindle.minSpeed/maxSpeed`, `maxFeedRate.x/y/z`, `spindle.power`¹, `rigidity`¹    | clamps, power check, conservative factors |

¹ New optional machine fields ([Changes to other docs](#changes-to-other-docs-applied-with-task-212)). Without `spindle.power` the power check is skipped (info); without `rigidity` the lowest preset applies.

**Order:** `stepdown` and `stepover` are resolved first (override → preset → calculator → strategy fallback); `n`, `vf` and `plungeRate` are then computed for the **resolved** engagement, so a user stepover still gets chip thinning and a power check.

**Output** `CuttingSuggestion`: each of the five fields is `Option<{ value, derivation }>`; `derivation` lists formula id, inputs and result per step (rendered as formulas and tooltips in the UI, returned verbatim to agents). Derived display values: `vc` actual, `fz` actual, `Q`, `Pc`, spindle load %. Plus `warnings[]`.

| Warning code            | When                                                                     | Effect                                                                     |
| ----------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `feeds.rpmAboveMachine` | `n > spindle.maxSpeed` (small tools, aluminum)                           | `n` = max; `vf` keeps `fz` (F2), actual `vc` shown lower                   |
| `feeds.rpmBelowMachine` | `n < spindle.minSpeed` (large tools, steel, router spindles)             | `n` = min; actual `vc` too high → heat/wear warning; `fz` kept             |
| `feeds.feedClamped`     | `vf > min(maxFeedRate.x, .y)`                                            | `vf` = max; `n` lowered to keep `fz` while `n ≥ minSpeed`, else `fz` drops |
| `feeds.rubbing`         | actual `fz` < data minimum after clamping                                | warn: chips too thin, tool rubs and heats                                  |
| `feeds.powerExceeded`   | `Pc > Pavail` (F7 vs. [machine check](#hobby-machine-realism))           | calculator-owned `stepdown` reduced to fit; else warn only                 |
| `feeds.noData`          | `materialClass = other`, `toolMaterial` unset/`other`, `D` outside bands | no suggestion (`None`); fallback or `plan.check` error as today            |
| `feeds.powerSkipped`    | milling without `spindle.power` (or without a machine)                   | info only: power check skipped; `Pc` still shown                           |

All warnings join `plan.warning.list`; none is an error. Plan-mode machine checks are unchanged ([plan record](../modes/plan-v0.1.md#plan-record)).

## Engagement per strategy

| Strategy (v0.1)  | `ae` used for F3/F6 | `ap`         | Notes                                                                               |
| ---------------- | ------------------- | ------------ | ----------------------------------------------------------------------------------- |
| Facing           | `stepover`          | `stepdown`   | RCTF only when `stepover < D/2` (default 0.75 D: none).                             |
| Pocket (offset)  | `D` (slot)          | `stepdown`   | First ring and corners are full-width; worst case for feed and power.               |
| Profile          | `D` (slot)          | `stepdown`   | First pass is a slot; finishing pass runs at the same `feedRate` (one feed per op). |
| Drilling (drill) | –                   | –            | F1 with drill `vc`, F8, `plungeRate = vf`; peck parameters are strategy-owned.      |
| Drilling (helix) | `D` (slot)          | `helixPitch` | Treated as a slot on a helix.                                                       |

Stepdown suggestion: `ap = apSlot(material) × D × rigidityFactor`, ≤ `fluteLength`; stepover suggestion is left to the strategy fallback in v0.1 (the strategies fix engagement, not the calculator).

## Material data

Curated, versioned TypeScript data in `src/core/feeds-speeds/data.ts` (code, not user data; no `schemaVersion`). Plain numbers in canonical units, since they are constants, not entered quantities.

| Key                                           | Values                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `materialClass × toolMaterial`                | `vc` range (m/min); `apSlot` (× D); `kPlunge`; `u` (W·s/mm³); `source` (URLs) |
| `… × diameter band` (≤ 3, ≤ 6, ≤ 12, ≤ 25 mm) | `fz` range (mm) for end mills; `fn` range (mm/rev) for drills                 |

- Every row cites its source; a lint test fails on a row without one. Ranges, not points: the [rigidity preset](#machine-rigidity-presets) picks the position within each range.
- **Multi-vendor:** each row combines several public vendor charts. Metals from ([HT2], [S1], [MH] `Kp`); wood, sheet goods and plastics from router-bit chip-load charts (e.g. Onsrud, Amana). Unit power for wood/plastic is poorly published: start with a conservative estimate, marked `estimated` in `source`.
- **User override in v0.1 = presets.** Users do not edit the table; they adjust a suggestion and save it as a [preset](library.md#feeds-and-speeds-presets), which wins in the resolution order.

## Live vs. saved

- Suggestions are **computed live** on every plan evaluation (pure, cheap) and never stored in the plan; the UI and `plan.operation.list` show `source: 'calculator'` per field ([plan rule](../modes/plan-v0.1.md#feeds-and-speeds)).
- **Save as preset** copies the current suggestion into a new `CuttingPreset` (name e.g. "Calculated – aluminum", `materialClass` = stock's) through `library.tool.update`; the plan's tool copy updates per the [snapshot rules](library.md#snapshots). Saved values stop following data-table updates – that is the point of a preset.

## Hobby-machine realism

- **Router rpm floor:** trim routers and VFD spindles often cannot go below 8 000–12 000 rpm (`spindle.minSpeed`). Large tools in metal then run too fast (`feeds.rpmBelowMachine`); the UI suggests a smaller tool or fewer flutes.
- **Available power drops at low rpm:** VFD spindles are constant-torque below rated speed, so `Pavail = spindle.power × η × min(1, n / spindle.maxSpeed)`, `η = 0.8`. Router nameplate power is input power; `η` covers it.
- **Rigidity:** hobby frames deflect; keep chip load (thin chips rub) and reduce depth instead – see [presets](#machine-rigidity-presets).
- `spindle.control: manual`: the suggested rpm is shown as a dial hint; the export already pauses for the user ([library](library.md#machine)).

### Machine rigidity presets

`machine.rigidity` is one of five presets (lowest = default). `apFactor` multiplies `apSlot` for the suggested stepdown; `rangePos` is the position within every `vc`, `fz` and `fn` range (0 = low end, 1 = high end). Calibrating a machine's own factors by test cuts in Run mode is later (not v0.1).

| Preset      | `apFactor` | `rangePos` | Example                                                                       |
| ----------- | ---------- | ---------- | ----------------------------------------------------------------------------- |
| `extrusion` | 0.3        | 0          | 2020 aluminium-extrusion frame, printed plastic parts, belts or leadscrews.   |
| `hobby`     | 0.5        | 0.25       | Aluminium-plate gantry on heavier extrusions, V-wheels or small rails, belts. |
| `prosumer`  | 0.75       | 0.5        | Steel or thick-plate router frame, linear rails, ball screws.                 |
| `benchMill` | 0.9        | 0.75       | Converted cast-iron benchtop mill (column and knee or bed type), ball screws. |
| `rigidMill` | 1.0        | 1.0        | Industrial cast-iron or steel mill / VMC; vendor data apply unscaled.         |

## API

```ts
// src/core/feeds-speeds/suggest.ts
suggestCutting(input: CuttingInput): CuttingSuggestion // total, pure; missing data → None fields + warning
```

- `CuttingInput = { tool, materialClass, engagement: { kind: 'slot' | 'stepover' | 'drill' | 'helix', ae?, ap? }, machine: Option<MachineLimits> }`. Inputs are already-valid models, so the function cannot fail; unsupported combinations return `None` fields with `feeds.noData`.
- Query `feedsSpeeds.suggest { toolLibraryItemId, materialClass, engagement, machineLibraryItemId? }` exposes it to MCP/CLI ([LLM-first](../principles.md#1-llm-first)) for "what-if" use outside a plan.
- Plan mode maps its strategy to `engagement` in `src/core/plan/feeds.ts` (resolution order and table above).

## Files

| File                                                                           | Contents                                                                      |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| [`src/core/feeds-speeds/formulas.ts`](../../src/core/feeds-speeds/formulas.ts) | F1–F9 as pure functions on float64 canonical units                            |
| [`src/core/feeds-speeds/data.ts`](../../src/core/feeds-speeds/data.ts)         | Material table with per-row sources, rigidity factors, data lint              |
| [`src/core/feeds-speeds/suggest.ts`](../../src/core/feeds-speeds/suggest.ts)   | `suggestCutting`, `machineLimits`: data lookup, clamps, power check, warnings |
| [`src/core/feeds-speeds/commands.ts`](../../src/core/feeds-speeds/commands.ts) | `feedsSpeeds.suggest` query                                                   |
| `src/core/plan/feeds.ts` (task 2.13)                                           | Strategy → engagement; resolution order; `source` per field                   |

## Testing

- **Golden numbers** from published examples, each test citing its source: Kennametal KDMB ball nose D 0.312″, `ap` 0.047″ → `De` 0.223″ [K1]; Sandvik formula sheet examples for `n`, `vf`, `Pc` [S1]; RCTF at `ae/D` = 0.075 → ×1.90 [MD]. The [S1] sheet states formulas only (no worked examples), so those tests check hand-computed values against its formulas, and F7 against its `Pc = ae·ap·vf·kc / (60·10⁶)` form.
- **Properties:** `n` within machine range after clamping; `vf ≤ maxFeedRate`; RCTF = 1 at `ae ≥ D/2` and capped at 3; `De = D` when `ap ≥ RE`; power check monotonic in `ap`.
- **Data lint:** every row has a source, ranges are ordered, bands cover 0–25 mm without gaps.

## Sources

- [S1] Sandvik Coromant, [Formulas and definitions for milling (metric)](https://cdn.sandvik.coromant.com/files/sitecollectiondocuments/services/metal-cutting-e-learning/formulas-and-definitions/formulas-and-deinitions-for-milling-metric-enu.pdf); [S2] [Drilling formulas](https://www.sandvik.coromant.com/en-us/knowledge/machining-formulas-definitions/drilling-formulas-definitions); [S3] [Ramping](https://www.sandvik.coromant.com/en-gb/knowledge/milling/milling-holes-cavities-pockets/ramping).
- [MH] Machinery's Handbook, power constant `Kp` (unit horsepower) and speed/feed formulas; [AD] Autodesk, [Unit horsepower or specific cutting force](https://help.autodesk.com/cloudhelp/2018/ENU/FCAM/files/GUID-AD4A06B2-6972-4F93-9D7A-E2825783D69D.htm).
- [K1] Kennametal KDMB ball nose working-diameter table ([product page](https://www.kennametal.com/us/en/products/p.2878444.html)); [HT1] Harvey Performance, [Ball nose effective diameter](https://www.harveyperformance.com/in-the-loupe/in-the-loupe-tv-ball-nose-end-mills-effective-diameter/); [HT2] Harvey Tool speeds-and-feeds charts per tool.
- [MD] Machining Doctor, [Chip thinning calculator](https://www.machiningdoctor.com/calculators/chip-thinning-calculator/).

## Implementation decisions (task 2.12)

Where this doc was silent, the implementation chose:

- **Material table empty.** This doc names the sources but no values, and no value may be invented, so `MATERIAL_DATA` ships empty: every call returns `feeds.noData` and plan mode falls back until the cited rows are curated ([v0.1 plan](../plans/v0.1.md) known issues). Each row lists `sources: { ref, fields }[]`; the data lint fails any value no source backs unless the row lists it in `estimated`. Tests use a synthetic fixture (`data.fixture.ts`).
- **Engagement** is a discriminated union: `slot { ap? }`, `stepover { ae, ap? }`, `helix { ap }` (pitch), `drill {}`; lengths are mm numbers. `ap` given = resolved stepdown (override/preset): it is used, no `stepdown` is suggested, and a power excess only warns. A drill engagement needs a `drill` tool and vice versa, else `feeds.noData`.
- **Chip-thinning cap:** the product RCTF × ACTF is capped at ×3 (so each factor is too). `ae` above `D` counts as `D`.
- **Drills** use the row's `vc` (one `vc` per `materialClass × toolMaterial`), F8 for `feedRate` = `plungeRate`, clamped to `maxFeedRate.z` (rpm lowered to keep `fn` while ≥ `minSpeed`); no power check (F6/F7 are milling formulas).
- **Plunge rate** (F9) is clamped to `maxFeedRate.z` with `feeds.feedClamped`.
- **Power reduction** scales the calculator-owned `ap` by `Pavail / Pc` (× 0.999) until `Pc ≤ Pavail` (≤ 30 iterations; Pc is near-linear in `ap`).
- **Output values** are float64 numbers in canonical units (`rpm`, `mm/min`, `mm`), not quantities: "Save as preset" (with the plan UI) turns them into quantities. Derivation steps are `{ step, formula, inputs, result, unit, sources? }` with `step` = `F1`…`F9`, `data`, `rigidity`, `fluteLength`, `power`, `rpmClamp`, `feedClamp` or `cap`; clamp and cap steps appear only when they apply. Display values: `dCalc`, actual `vc`, actual `fz` (drills: `fn`), `chipThinning`, `Q`, `Pc`, `spindleLoad` (Q/Pc `None` for drills).
- **Query** `feedsSpeeds.suggest` returns `None` as `null`; `feedsSpeeds` is a command-layer area ([commands.md](commands.md#naming)). Without a machine there are no clamps, the lowest rigidity applies and the power check is skipped.
- **Plan integration** (`src/core/plan/feeds.ts`: strategy → engagement, resolution order, `source` per field) lands with the plan model (task 2.13).

## Changes to other docs (applied with task 2.12)

Applied together with the calculator code:

- [library.md § Machine](library.md#machine): add `spindle.power` (kind `power`, optional, > 0; rated output power, for the power check) and `rigidity` (enum `extrusion | hobby | prosumer | benchMill | rigidMill`, optional; [presets](#machine-rigidity-presets)).
- [quantities.md § Kinds and units](quantities.md#kinds-and-units): add kind `power`, canonical `W`, spellings `W`, `kW`, `hp` (1 hp = 745.69987158227022 W, mechanical), bare-number default `W`; persisted unit ids `W kW hp`.
