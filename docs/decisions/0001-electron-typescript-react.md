# 0001 – Electron + TypeScript + React

Status: accepted · Date: 2026-11-16

## Context

DFYOM is a desktop app that needs filesystem and serial/USB/network device access (machines, MCUs, sensors), rich graphical UI (3D, illustrations, charts), headless operation for agents, and a single language across UI and domain logic.

## Decision

- **Electron** for the desktop shell, built with **electron-vite**.
- **TypeScript** (strict) everywhere.
- **React** for the renderer UI.
- **Vitest** for tests.

## Consequences

- Domain logic in `src/core` must stay platform-agnostic so it runs in renderer, main, workers, CLI and tests ([architecture/overview.md](../architecture/overview.md)).
- Heavy computation needs workers/utility processes to keep the UI responsive.
