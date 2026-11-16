# 0013 – GRBL/grblHAL as the first supported controller

Status: accepted · Date: 2026-11-16

## Context

The [v0.1 slice](../roadmap.md) needs one gCode dialect and one controller to stream to and emulate ([modes/run.md](../modes/run.md#open-questions)). Target users mostly own hobby and prosumer routers.

## Decision

Support the **GRBL family** (GRBL, grblHAL; FluidNC as a compatible variant) first: gCode export dialect, serial streaming protocol and the **virtual machine** emulator.

## Consequences

- One post-processor and one protocol to start; the controller interface must still allow others (LinuxCNC, …) later.
- The virtual machine emulates GRBL's protocol and state machine closely enough for run-mode tests ([testing.md](../conventions/testing.md)).
