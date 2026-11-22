# Plan mode

Status: draft · Terms: [glossary.md](../glossary.md)

**Goal:** turn designed parts into a concrete, optimized, simulated manufacturing process using concrete machines and tools.

The v0.1 subset (one setup, tool assignment, pass strategies, toolpaths) is specified in [plan-v0.1.md](plan-v0.1.md). v0.2 (accepted: one setup per approach direction, tools resolved from the design's tool field) is in [plan-v0.2.md](plan-v0.2.md).

## Scope

Initially **3-axis milling / router CNC machines**; keep 4th and 5th axis in mind in the data model.

## Setups

- A plan is a sequence of **setups**.
- In the first setup the user positions the stock, the parts (from [design mode](design.md)) inside it, and **workholding** devices (from a library).
- Within a setup the user plans **probing/zeroing**, **tool changes** and **passes**.
- Later setups do not require selecting stock and positioning parts again.
- Between setups the stock can be **repositioned** and workholding changed.
- The stock can be **cut apart** during the process, producing multiple pieces that are repositioned independently in later setups.

## Optimization (manual and automatic)

- Minimize air-cutting, tool travel and tool changes.
- Share one tool's roughing/finishing passes across multiple operations and parts.
- Possibly rough through the stock for operations on the other side.

## Simulation / prediction

With exact obstacles, spindle and machine geometry known, predict what can go wrong: **collisions**, **weak structural support** of stock regions at any point in time (e.g. when cutting thin features), etc.

## Output

Each fully planned setup can be **exported as gCode**.

## Open questions

- Toolpath generation: own engine vs. library.
- Simulation fidelity (voxel / dexel / mesh) and performance budget – see [architecture/overview.md#threading](../architecture/overview.md#threading).
- gCode dialects / post-processors per machine controller.
