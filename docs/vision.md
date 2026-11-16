# Vision

Status: accepted

**DFYOM – Design For Your Own Manufacturing** is a desktop app for people who own one or more CNC machines for subtractive manufacturing. It targets **hobbyists and small business professionals** (e.g. a CNC shop with prosumer-level routers), not experts. It lets them design manufacturable parts, then plan and automate the manufacturing process.

## Three modes

1. **Design** – design parts that can be manufactured on the machines you actually have, starting from stock and cutting operations rather than from free-form CAD. → [modes/design.md](modes/design.md)
2. **Plan** – turn designed parts into concrete setups, tool changes and passes for concrete machines and tools; optimize, simulate, export gCode. → [modes/plan.md](modes/plan.md)
3. **Run** – run gCode on the machine and go beyond it: sensors, external devices, automation, calibration. → [modes/run.md](modes/run.md)

## Project model

- One project can contain **multiple parts** and **multiple plans**.
- Stock, tools, machines and workholding devices come from **libraries** (see [glossary.md](glossary.md)).

## How it is built

- Stack: Electron + TypeScript + React ([decisions/0001-electron-typescript-react.md](decisions/0001-electron-typescript-react.md)).
- Principles that shape every feature: [principles.md](principles.md).
