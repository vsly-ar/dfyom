# Feeds-and-speeds calculator

Status: stub · Used by: [plan-v0.1.md](../modes/plan-v0.1.md#feeds-and-speeds) · Presets: [library.md](library.md#feeds-and-speeds-presets) · Values: [quantities.md](quantities.md) · Roadmap: [v0.1](../roadmap.md#v01--25d-basics-to-the-virtual-machine)

Scope only; nothing is decided.

## Scope

- Suggest spindle speed, feed rate, plunge rate, stepdown and stepover when a plan operation has no override and the tool has no matching preset (third step of the [resolution order](../modes/plan-v0.1.md#feeds-and-speeds)).
- Inputs: tool (type, diameter, flutes, tool material), stock material class, operation and strategy (slotting, stepover, ramp), machine (spindle range, maximum feed rates, spindle power).
- Surface speed (cutting speed per material and tool material) → spindle speed.
- Chip load per tooth with **chip thinning** at small radial engagement → feed rate.
- **Power** (material removal rate × specific cutting energy) checked against the spindle; may reduce stepdown or feed.
- Show every suggestion with its source and the values it derived from, so the user can save it as a preset.

## Open questions

- Source and license of material data (surface speed, chip load, specific cutting energy).
- New quantity kinds (surface speed, chip load, power) vs. derived display values.
- Machine fields needed (spindle power, rigidity class) – a [library.md](library.md#machine) change.
