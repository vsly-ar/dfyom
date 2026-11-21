# Feeds-and-speeds calculator

Status: implemented (locked inputs: [draft](#locked-inputs-draft)) · Code: [`src/core/feeds-speeds/`](../../src/core/feeds-speeds/suggest.ts) · Used by: [plan-v0.1.md](../modes/plan-v0.1.md#feeds-and-speeds) · Presets: [library.md](library.md#feeds-and-speeds-presets) · Values: [quantities.md](quantities.md) · Terms: [glossary.md](../glossary.md) · Task: [v0.1 plan](../plans/v0.1.md) 1.15 (code: 2.12)

The calculator is the third step of the [resolution order](../modes/plan-v0.1.md#feeds-and-speeds) (override → tool preset → **calculator** → strategy fallback). It suggests `spindleSpeed`, `feedRate`, `plungeRate`, `stepdown` and `stepover` for one plan operation from the tool, the stock's material class, the strategy's engagement and the machine, and explains every number ([principles §5](../principles.md#5-user-friendly-beginner-friendly-highly-graphical)).

## Formulas

Symbols follow Sandvik Coromant (ISO): `vc` surface speed, `D` tool diameter, `z` flutes (NOF), `fz` chip load, `n` spindle speed, `vf` feed rate, `ae` radial engagement (stepover), `ap` axial engagement (stepdown), `fn` feed per revolution, `Q` material removal rate, `u` unit power. Metric shown; inch input is converted by the quantity layer.

| #   | Quantity                    | Formula                                                                                     | Source                     |
| --- | --------------------------- | ------------------------------------------------------------------------------------------- | -------------------------- |
| F1  | Spindle speed               | `n = vc·1000 / (π·Dcalc)`; `Dcalc` = `D`, or `De` (F4); router rows give `n` directly       | [S1], [MH], [AM1]          |
| F2  | Feed rate                   | `vf = n · z · fz_prog`                                                                      | [S1], [MH]                 |
| F3  | Radial chip thinning (RCTF) | `ae < D/2`: `fz_prog = fz / (2·√((ae/D)(1 − ae/D)))`; otherwise `fz_prog = fz`              | [MD], [S1] (`hex`)         |
| F4  | Effective diameter          | `ap < RE`: `De = D − 2·RE + 2·√(ap(2·RE − ap))`; ball: `RE = D/2` gives `De = 2√(ap(D−ap))` | [K1], [HT1]                |
| F5  | Axial chip thinning (ACTF)  | `ap < RE`: `fz_prog = fz / sin κ`, `cos κ = (RE − ap)/RE`; flat end mill: none (`κ = 90°`)  | [S1] (`hex = fz·sin κ`)    |
| F6  | Material removal rate       | `Q = ae · ap · vf` (mm³/min)                                                                | [S1], [MH]                 |
| F7  | Cutting power               | `Pc = Q · u / 60 000` (kW, `u` in W·s/mm³); `u = Kp · 2.73` from unit horsepower `Kp`       | [S1] (`kc`), [MMS], [AD]   |
| F8  | Drilling feed               | `vf = fn · n`; `fn` from the data table per material × diameter band                        | [S2]                       |
| F9  | Plunge rate (end mill)      | `plungeRate = kPlunge · vf` (data: 0.5 wood/plastic, 0.25 metals); drills use F8            | [AM1] ramp-down, estimated |

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

**Order** (replaced by [Locked inputs](#locked-inputs-draft) once accepted): `stepdown` and `stepover` are resolved first (override → preset → calculator → strategy fallback); `n`, `vf` and `plungeRate` are then computed for the **resolved** engagement, so a user stepover still gets chip thinning and a power check.

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

| Key                                           | Values                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `materialClass × toolMaterial`                | `vc` range (m/min) or `n` range (rpm, router charts); `apSlot` (× D); `kPlunge`; `u` (W·s/mm³); `source` (URLs) |
| `… × diameter band` (≤ 3, ≤ 6, ≤ 12, ≤ 25 mm) | `fz` range (mm) for end mills; `fn` range (mm/rev) for drills                                                   |

- Every row cites its source; a lint test fails on a row without one. Ranges, not points: the [rigidity preset](#machine-rigidity-presets) picks the position within each range.
- **Multi-vendor:** each row combines several public vendor charts. Metals from Harvey Tool ([HT3], [HT4]) and unit power [MMS]; wood, sheet goods and plastics from router-bit chip-load charts ([ON], [AM1], [AM2]). Unit power for wood/plastic is poorly published: a conservative estimate, marked `estimated` ([Material data (v0.1)](#material-data-v01)).
- **User override in v0.1 = presets.** Users do not edit the table; they adjust a suggestion and save it as a [preset](library.md#feeds-and-speeds-presets), which wins in the resolution order.

### Material data (v0.1)

**Scope: carbide end mills only** (flat, bull-nose, ball; one row per material class applies to all three). There are **no HSS rows and no drill `fn` bands** yet: those calls return `feeds.noData` and plan mode falls back to the tool preset or the strategy fallback ([resolution order](../modes/plan-v0.1.md#feeds-and-speeds)). Every value is in [`data.ts`](../../src/core/feeds-speeds/data.ts) with its source and the exact table in the row's `sources`.

**Rules used to turn charts into rows:**

- **Conservative envelope.** Where several sources (or several printed grades of one class) give values, the row range is `[lowest printed minimum, lowest printed maximum]`; a single printed value counts as `min = max`. This is the "take the conservative value" rule; it makes some ranges a single point.
- **Representative diameter per band.** Charts print values per nominal inch diameter. Each band uses the smallest chart diameter inside it: ≤ 6 mm ← 1/8″ (3.175 mm), ≤ 12 mm ← 1/4″ (6.35 mm), ≤ 25 mm ← 1/2″ (12.7 mm). Chip load grows with `D`, so larger tools in the band get a lower-than-printed chip load; tools from 6 to 6.35 mm get the 1/4″ value (≤ 6 % larger diameter). The **≤ 3 mm band is empty**: its smallest chart diameter (1/16″ or less) would over-feed sub-millimetre tools, so tools ≤ 3 mm get `feeds.noData`.
- **Speed: `vc` or `n`.** Machining charts (Harvey Tool) give a surface speed, so metal rows have `vc` and use F1. Router-bit charts give no surface speed but a fixed spindle speed (Amana: "CNC Operating Spindle Speed: 18,000 RPM"), so wood, sheet-good and plastic rows set `n` instead and skip F1 (F4 then only affects the actual `vc` shown). The row type allows exactly one of the two; the data lint checks it.
- Chart units are inch: chip load in IPT (× 25.4 → mm), speed in SFM (× 0.3048 → m/min).

| Class     | Speed            | `fz` ≤ 6 mm (1/8″) | `fz` ≤ 12 mm (1/4″) | `fz` ≤ 25 mm (1/2″) | `apSlot` | `kPlunge`¹ | `u` (W·s/mm³) | Sources                                    |
| --------- | ---------------- | ------------------ | ------------------- | ------------------- | -------- | ---------- | ------------- | ------------------------------------------ |
| softwood  | `n` 18 000 rpm   | .005–.007″         | .007–.009″          | .009–.011″          | 1        | 0.5        | 0.6825¹       | [ON] Soft Wood 52-200/57-200, [AM1]        |
| hardwood  | `n` 18 000 rpm   | .003–.005″         | .005–.007″          | .007–.009″          | 1        | 0.5        | 0.6825¹       | [ON] Hard Wood 52-200/57-200, [AM1]        |
| sheetGood | `n` 18 000 rpm   | .005–.007″         | .006–.008″          | .008–.010″          | 1        | 0.5        | 0.6825¹       | [ON] MDF, Soft/Hard Plywood 52-200, [AM1]  |
| plastic   | `n` 18 000 rpm   | .002–.004″         | .003–.005″          | .006–.008″          | 1        | 0.5        | 0.6825¹       | [ON] Soft/Hard Plastic 52-200B/BL, [AM1–2] |
| aluminum  | `vc` 500–650 SFM | .001″              | .002″               | .004″               | 0.5      | 0.25       | 0.6825 (0.25) | [HT3], [HT4], [MMS]                        |
| brass     | `vc` 500 SFM     | .001″              | .002″               | .003″               | 0.5      | 0.25       | 1.365 (0.50)  | [HT3], [HT4], [MMS]                        |
| steel     | `vc` 100–150 SFM | .00048″            | .00095″             | .0019″              | 0.5      | 0.25       | 5.46 (2.00)   | [HT3], [HT4], [MMS]                        |

¹ Estimated (row's `estimated` list); reasoning below. `u` in brackets: unit horsepower (hp per in³/min) from [MMS], × 2.73 (F7).

**Where each number comes from:**

- **Wood and sheet goods:** chip loads from the Onsrud 52-200/57-200 rows (2-flute up/down spiral, the general-purpose series the charts recommend for single pass) and the Amana 2-flute spiral ball nose chart; both agree at 1/8″, 1/4″ and 1/2″ except softwood 1/8″ (Onsrud .006–.008, Amana .005–.007 → .005–.007). MDF, soft plywood and hard plywood print the same 52-200 values. `apSlot = 1`: both charts state "Depth of cut 1 x D" for the printed chip load. `n`: [AM1].
- **Plastic** (soft and hard): Onsrud 52-200B/BL rows of both plastic charts and the Amana charts. At 1/4″ the Amana plastics ball nose chart prints .003–.005 against .004–.006 elsewhere → .003–.005. Harvey's general table lists much lower chip loads for plastics at 200–600 SFM; that is a machining-centre regime, and this doc assigns plastics to router-bit charts, so it is not used. Onsrud warns that too low a chip load in plastic causes rewelding; raise the feed (preset) if chips melt.
- **Aluminium, brass, steel:** [HT3] (general table, 1/8″, 1/4″, 1/2″) and [HT4] (2-flute square end mill product chart, "Slotting" rows at 0.125″, 0.250″, 0.500″). Per diameter the lower printed chip load wins: [HT3] everywhere except steel 1/8″ ([HT4] .00048 < .0005). `vc`: aluminium rows 500–1000 / 800–1500 SFM [HT3] and 1000 (wrought), 750/700/650 (castings up to 12 % Si) SFM [HT4] → 500–650; brass 600–1000 / 800–1500 [HT3] and 500 [HT4] → 500; steel 100–300 (10XX/11XX/13XX) and 100–150 (23XX/31XX) [HT3] and 600 / 200 [HT4] → 100–150. `apSlot = 0.5`: [HT4] slotting axial depth ".50 x Dia" (Onsrud's aluminium router chart allows 1 x D; the lower value wins). Aluminium castings with more than 12 % Si ([HT4] 475 SFM) are not covered.
- **Steel scope:** the steel row uses Harvey's carbon and low-alloy rows only (10xx–15xx, 2xxx–9xxx alloy steels). Stainless, tool and high-strength steels have much lower chip loads in [HT3] and are **not** covered: choose material class `other` for them (known issue in the [v0.1 plan](../plans/v0.1.md)).
- **Unit power `u` (metals):** Machinery's Handbook `Kp` tables are not freely available, so `u` comes from [MMS] Table I "Unit Horsepower" (horsepower at the machine per in³/min, so it already includes losses and is ≥ the handbook's cutter `Kp`; F7 then also applies `η`, so `Pc` is overestimated, never under). Aluminium 0.25; brass "Hard" 0.50 (higher than "Soft" 0.33); steel 2.00 ("400 BHN", the first printed value at or above the 279–344 HBn hardness of [HT4]'s steel rows).

**Estimates (`estimated`):**

- **`u` for wood, sheet goods and plastic = 0.25 × 2.73 = 0.6825 W·s/mm³**, the [MMS] aluminium value. No public chart gives unit power for these materials; wood, MDF and thermoplastics are far weaker than aluminium alloys, so aluminium's unit power is an upper bound and the power check errs towards a shallower stepdown.
- **`kPlunge`:** Amana's charts give "Ramp Down: Feed Rate IPM / # of flutes", i.e. `plungeRate = vf / z`. One row cannot hold `z`, so router rows use 0.5 (the rule for the 2-flute bits the chip loads are printed for; a 1-flute bit gets half the Amana value) and metal rows 0.25 (the rule for 4 flutes; conservative for `z ≤ 4`). Tools with more flutes than that plunge faster than the Amana rule (known issue; F9 could use `1/z` later).

**Gaps:** HSS end mills (all classes), drills (`fn` and drill `vc`), tools ≤ 3 mm and > 25 mm, stainless/tool steels, high-silicon aluminium castings and material class `other` → `feeds.noData`.

## Locked inputs (draft)

Status: **draft**, not implemented: waits for the open questions in [plan-v0.1.md § Locks and auto mode](../modes/plan-v0.1.md#locks-and-auto-mode-draft), which owns when locks exist and what an entered value is. This section is how the calculator uses locked values. Once accepted it replaces the **Order** paragraph in [Inputs and outputs](#inputs-and-outputs) and the "`ap` given" rule in [Implementation decisions](#implementation-decisions-task-212).

A **locked** value is a fixed input: the calculator recommends every unlocked field around it, so locking the spindle speed makes the feed follow it. An **entered** (typed, unlocked) value is not an input: it replaces only its own field's value, and the recommendation of the other fields stays what it would be without it. The [final-value check](#final-value-check-draft) still sees it.

`CuttingInput` gains `locked: { n?, vf?, ap?, ae? }` (canonical numbers). `engagement` then carries only the kind and the strategy's `ae` (no `ap`); a locked stepdown is `locked.ap`, a locked facing stepover `locked.ae`. `plungeRate` is never an input (nothing depends on it), so it has no lock.

| Locked        | Unlocked fields are recommended as                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| none          | As today: `n` from F1 or the chart, clamped; `vf` from F2, clamped (`n` lowered to keep `fz`); `ap` = `apSlot·D·apFactor`, reduced to fit the power; plunge F9.                                                                                                                      |
| `n`           | `n` replaces F1/the chart and the rpm clamp (derivation step `locked`). `vf = n·z·fz_prog` (F2); above `maxFeedXY` it is clamped and `fz` drops (`n` stays): `feeds.feedClamped`, maybe `feeds.rubbing`. `ap` fits the power at this `n` (`Pavail` depends on `n`).                  |
| `vf`          | `n = vf / (z·fz_prog)`: the data chip load is the anchor (router rows: replaces the chart `n`), clamped to `[minSpeed, maxSpeed]`; when clamped, `fz` follows from `vf`: `feeds.rubbing` below the data range, **`feeds.chipLoadHigh`** (new warning) above it. `ap` fits the power. |
| `n` + `vf`    | Chip load is derived, `fz = vf / (n·z·k)`, with `feeds.rubbing` / `feeds.chipLoadHigh` outside the data range. `ap` fits the power.                                                                                                                                                  |
| `ap`          | `n`, `vf` as for the other locks. Power exceeded: an unlocked `vf` is reduced to fit (`n` kept, `fz` drops, maybe `feeds.rubbing`); a locked `vf` only warns (`feeds.powerExceeded`). Replaces today's "given `ap` only warns".                                                      |
| `ae` (facing) | The facing engagement uses it (F3, F6). Pocket and profile engage as a slot whatever the stepover, so their stepover has no lock.                                                                                                                                                    |
| drilling      | `n` locked: `vf = fn·n` (F8), clamped to `maxFeedRate.z`. `vf` locked: `n = vf / fn`, clamped to the spindle range (then `fn` follows: `feeds.rubbing` / `feeds.chipLoadHigh`). `plungeRate = vf`.                                                                                   |

Power fit order with several unlocked fields: `ap` first (keep chip load, reduce depth: [rigidity](#hobby-machine-realism)), then `vf`.

### Impossible locks (draft)

A lock is **unavailable** (the plan refuses it; the UI shows the lock disabled with the reason) when the value breaks a hard limit or leaves the locked set no way to meet one:

| Rule                | When                                                                                                                         | Reason shown (example)                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `invalid`           | No valid value: the input has an error, or the field has no value                                                            | "Enter a valid value to lock it."                                              |
| `spindleRange`      | `n` outside `[spindle.minSpeed, spindle.maxSpeed]` of the plan's machine copy                                                | "24 000 rpm is above this machine's 18 000 rpm."                               |
| `feedLimit`         | `vf > min(maxFeedRate.x, .y)` (drilling: `> maxFeedRate.z`)                                                                  | "6 000 mm/min is above this machine's 5 000 mm/min (X/Y)."                     |
| `toolLength`        | `ap > fluteLength` or `ap > stickout`                                                                                        | "Stepdown 30 mm is deeper than the flute length (22 mm)."                      |
| `stepoverAboveTool` | facing `ae > D`                                                                                                              | "A stepover above the tool diameter leaves ridges."                            |
| `power`             | With this lock every input of F7 is locked (`n`, `vf`, `ap`, facing `ae`) and `Pc > Pavail`: no unlocked field can absorb it | "With spindle speed, feed and stepdown locked the cut needs 1.4 kW of 0.8 kW." |

- Combinations of individually valid locks are otherwise **allowed**: they can only move the chip load or the power, which are recommendations, not limits, so they warn (`feeds.rubbing`, `feeds.chipLoadHigh`, `feeds.powerExceeded`). Without `spindle.power` the `power` rule is skipped; without a machine only `invalid`, `toolLength` and `stepoverAboveTool` apply.
- A stored lock that later breaks a rule (other tool, machine or stock) stays stored but is **inactive**: the recommendation ignores it, and `plan.warning.list` reports `feeds.lockInactive` (warning) on the field with the same reason; the UI offers "Unlock".

### Final-value check (draft)

Because entered values are not inputs, the calculator's own warnings describe its recommendation, not what will run. After resolution `checkCutting(final values)` re-runs the coupling checks on the values that will be used: spindle range, feed limits, chip load against the data range (`feeds.rubbing`, `feeds.chipLoadHigh`) and power at the final `ae`, `ap`, `vf`. These warnings (each with `field`) replace the calculator's in `plan.warning.list`; the calculator's warnings stay in its derivation.

## Live vs. saved

- Suggestions are **computed live** on every plan evaluation (pure, cheap) and never stored in the plan; the UI and `plan.operation.list` show `source: 'calculator'` per field ([plan rule](../modes/plan-v0.1.md#feeds-and-speeds)).
- **Save as preset** copies the current suggestion into a new `CuttingPreset` (name e.g. "Calculated – aluminum", `materialClass` = stock's) through `library.tool.update`; the plan's tool copy updates per the [snapshot rules](library.md#snapshots). Saved values stop following data-table updates – that is the point of a preset.

## Hobby-machine realism

- **Router rpm floor:** trim routers and VFD spindles often cannot go below 8 000–12 000 rpm (`spindle.minSpeed`). Large tools in metal then run too fast (`feeds.rpmBelowMachine`); the UI suggests a smaller tool or fewer flutes.
- **Available power drops at low rpm:** VFD spindles are constant-torque below rated speed, so `Pavail = spindle.power × η × min(1, n / spindle.maxSpeed)`, `η = 0.8`. Router nameplate power is input power; `η` covers it.
- **Rigidity:** hobby frames deflect; keep chip load (thin chips rub) and reduce depth instead – see [presets](#machine-rigidity-presets).
- `spindle.control: manual`: the suggested rpm is shown as a dial hint; the export already pauses for the user ([library](library.md#machine)).

### Machine rigidity presets

`machine.rigidity` is one of five presets (lowest = default). `apFactor` multiplies `apSlot` for the suggested stepdown; `rangePos` is the position within every `vc`, `n`, `fz` and `fn` range (0 = low end, 1 = high end). Calibrating a machine's own factors by test cuts in Run mode is later (not v0.1).

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
- **Data lint:** every row has a source, ranges are ordered, bands cover 0–25 mm without gaps, exactly one of `vc` and `n`.
- **Shipped-table golden cases:** 6 mm 2F carbide slotting MDF and 6061 on the `hobby` preset, 1/4″ slotting hardwood on `prosumer`: `fz`, `vc`/`n`, feed and stepdown lie within the cited chart's printed range ([ON], [AM1], [HT3], [HT4]).

## Sources

- [S1] Sandvik Coromant, [Formulas and definitions for milling (metric)](https://cdn.sandvik.coromant.com/files/sitecollectiondocuments/services/metal-cutting-e-learning/formulas-and-definitions/formulas-and-deinitions-for-milling-metric-enu.pdf); [S2] [Drilling formulas](https://www.sandvik.coromant.com/en-us/knowledge/machining-formulas-definitions/drilling-formulas-definitions); [S3] [Ramping](https://www.sandvik.coromant.com/en-gb/knowledge/milling/milling-holes-cavities-pockets/ramping).
- [MH] Machinery's Handbook, power constant `Kp` (unit horsepower) and speed/feed formulas; [AD] Autodesk, [Unit horsepower or specific cutting force](https://help.autodesk.com/cloudhelp/2018/ENU/FCAM/files/GUID-AD4A06B2-6972-4F93-9D7A-E2825783D69D.htm).
- [K1] Kennametal KDMB ball nose working-diameter table ([product page](https://www.kennametal.com/us/en/products/p.2878444.html)); [HT1] Harvey Performance, [Ball nose effective diameter](https://www.harveyperformance.com/in-the-loupe/in-the-loupe-tv-ball-nose-end-mills-effective-diameter/); [HT2] Harvey Tool speeds-and-feeds charts per tool.
- [MD] Machining Doctor, [Chip thinning calculator](https://www.machiningdoctor.com/calculators/chip-thinning-calculator/).
- [HT3] Harvey Tool, [General Machining Guidelines](https://www.harveytool.com/resources/general-machining-guidelines), tables "Carbide End Mills – Non-Ferrous" and "– Iron, Steel, Stainless" (SFM, chip load by diameter). [HT4] Harvey Tool, [Speeds & Feeds, Miniature End Mills – Square – Stub & Standard, 2 Flutes, series 139xx/502xx](https://harveyperformance.widen.net/content/pnhfzhydtu/pdf/SF_13900.pdf) ("Slotting" rows; one of the [HT2] charts).
- [ON] LMT Onsrud, [Cutting Data Recommendations](https://onsrud.com/forms/cutting-data-recommendations.asp) per material (catalog pp. 114–121): [Soft Wood](https://onsrud.com/images/Soft%20Wood.pdf), [Hard Wood](https://onsrud.com/images/Hard%20Wood.pdf), [MDF](https://onsrud.com/images/MDF.pdf), [Soft Plywood](https://onsrud.com/images/Soft%20Plywood.pdf), [Hard Plywood](https://onsrud.com/images/Hard%20Plywood.pdf), [Soft Plastic](https://onsrud.com/images/Soft%20Plastic.pdf), [Hard Plastic](https://onsrud.com/images/Hard%20Plastic.pdf); also [Aluminum](https://onsrud.com/images/Aluminum.pdf) (compared, not used).
- [AM1] Amana Tool, [2 Flute Solid Carbide CNC Spiral Ball Nose Router Bits speed chart](https://www.amanatool.com/pub/media/productattachments/Spiral-Ball-Nose-Speed-Chart-v6.pdf); [AM2] Amana Tool, [2 & 4 Flute Solid Carbide Spiral Ball Nose for Plastics](https://www.amanatool.com/pub/media/productattachments/Spiral-Ball-Nose-for-Plastics-Speed_Chart-v7.pdf).
- [MMS] Modern Machine Shop, [Start With The Right Speeds And Feeds](https://www.mmsonline.com/articles/start-with-the-right-speeds-and-feeds), Table I "Unit Horsepower" (used instead of [MH] `Kp`, whose tables are not freely available).

## Implementation decisions (task 2.12)

Where this doc was silent, the implementation chose:

- **Material table: carbide only** ([Material data (v0.1)](#material-data-v01)). Each row lists `sources: { ref, fields }[]`; the data lint fails any value no source backs unless the row lists it in `estimated`. Logic tests use a synthetic fixture (`data.fixture.ts`); golden tests check the shipped rows against their cited charts (`suggest.test.ts`).
- **Row speed `vc` or `n`** (type extension): `vc` became optional and `n` (rpm range) was added; exactly one is set. With `n` the speed derivation is a `data` step for `n` instead of F1.
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
