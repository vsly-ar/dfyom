# 0016 – Compute workers in the dispatcher's process

Status: accepted · Date: 2026-11-17 · Supersedes: [ADR 0008](0008-threading-split-by-job.md)

## Context

[ADR 0008](0008-threading-split-by-job.md) put geometry, toolpath and simulation work in renderer Web Workers (GUI) or `worker_threads` (headless/CLI). Since then the [command layer](../architecture/commands.md#project-state) placed the authoritative `ProjectDoc`, the dispatcher and every job handler in the process that owns the project: Electron main, or the headless/CLI Node process. A renderer Web Worker would put every job behind IPC, need a window to exist, tie jobs to a window's lifetime and keep two code paths. Machine control must keep running even if a window freezes or crashes.

## Decision

- Computation the dispatcher runs or caches (part evaluation, toolpath generation; later simulation and optimization whose results agents can query) runs in **`worker_threads` in the dispatcher's process**, in the app and headless/CLI alike, behind one worker interface in `src/core` (pure code, no environment-specific imports). Design: [workers.md](../architecture/workers.md).
- **Renderer Web Workers** are used only for work derived from what one window shows (e.g. simulation playback); never for results agents can query. The worker side of the protocol stays environment-neutral so both kinds share it.
- Machine and device I/O (serial, network, MCUs) runs in an **Electron utility process**, independent of any renderer (unchanged from ADR 0008).

## Consequences

- `src/core` code must be runnable in any worker type; the worker interface hides the difference.
- One evaluation per part serves the UI, MCP and CLI; results reach renderers over IPC (copied, not transferred).
- A UI crash never interrupts a running job; the utility process owns run state and safety watchdogs ([modes/run.md#safety](../modes/run.md#safety)).
- Progress, pause and abort travel over one message protocol for every worker kind.
- Compute load stays off the main thread, but message handling, input building and caches run on it; their cost is budgeted in [workers.md](../architecture/workers.md#performance-budgets).
