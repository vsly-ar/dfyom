# 0006 – Project file is an archive, edited in an unpacked working folder

Status: accepted · Date: 2026-11-16

## Context

A project holds many parts, plans, library snapshots and possibly large binaries (reference models, run recordings). It should be a single file for the user, its contents should be readable by agents and diffable, and a crash or failed save must never corrupt the last good version.

## Decision

- The project file is an **archive**. On open it is unpacked into a **working folder** where the app reads and writes files with a flexible layout.
- On save a new archive is built, its **integrity is verified**, and only then does it replace the previous project file.
- The app keeps the **last N saves** on disk, limited by count and/or size (per project and in total).

## Consequences

- Saving is atomic from the user's point of view; the previous file stays intact until the new one is verified.
- The working folder doubles as crash recovery and as a place agents can inspect.
- Multiple app instances need locking so that one project is not opened twice.
- Design: [architecture/persistence.md](../architecture/persistence.md). Schema evolution: [migrations.md](../conventions/error-handling/migrations.md).
