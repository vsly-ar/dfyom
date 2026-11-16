# 0008 – Heavy work in workers, machine I/O in a utility process

Status: accepted · Date: 2026-11-16

## Context

Geometry, toolpaths and simulation are CPU-heavy and must not block the UI ([overview.md#threading](../architecture/overview.md#threading)). Machine control must keep running even if a window freezes or crashes. Headless mode has no renderer.

## Decision

- Geometry, toolpath and simulation work runs in **Web Workers** (renderer) or **`worker_threads`** (headless/CLI), behind one worker interface in `src/core` (pure code, no environment-specific imports).
- Machine and device I/O (serial, network, MCUs) runs in an **Electron utility process**, independent of any renderer.

## Consequences

- `src/core` code must be runnable in any worker type; the worker interface hides the difference.
- A UI crash never interrupts a running job; the utility process owns run state and safety watchdogs ([modes/run.md#safety](../modes/run.md#safety)).
- Progress, pause and abort travel over one message protocol for both worker kinds.
