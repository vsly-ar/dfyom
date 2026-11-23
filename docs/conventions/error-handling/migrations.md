# Persistence and migrations

Status: implemented · Part of [error handling](README.md)

Loading saved data: DTOs, the load pipeline, step-by-step schema migrations.

## Pre-alpha exception: no data preservation yet

**In force until the developer declares that the app is in real use and its data is worth preserving.** At that point this section, and every link to it, is deleted, and the rules below apply in full.

Until then (pre-alpha and alpha), persisted app data – project and library files, settings, caches, anything the app writes – does **not** have to survive changes to its shape or meaning:

- **Don't bump `schemaVersion`** (every document stays at `1`), don't freeze old DTO types, and don't write migrations. Change the current Zod schema in place.
- Data that no longer loads (`input.malformed`, `model.invariant`, `persist.migration`) is **reset instead of repaired**: the UI shows what failed and offers "Discard and start fresh", which deletes the data only after the user confirms. Agents and the CLI may reset only with an explicit confirmation flag; nothing is ever wiped automatically. Project files: `project.open { reset: true }` ([persistence.md § Open](../../architecture/persistence.md#open)); a newer `schemaVersion` is still refused, never reset.
- Everything else here still applies: DTOs + `toDTO()`, the load pipeline (it simply runs no migration steps), `parseWith` before `Model.create`, and refusing a newer `schemaVersion`.
- When preservation starts, the schemas at that moment become the `schemaVersion: 1` baseline. Data written before then needs no upgrade path.

## Rules once data is preserved

Persisted data are **DTOs** (plain JSON). Models never serialize themselves implicitly; they expose `toDTO()` and are rebuilt with `create()`/`fromDTO()`.

Load pipeline:

```text
read file (tryAsync, persist.io)
 → JSON.parse (tryCatch, input.malformed)
 → migrate(raw, plan): step-by-step DTO migrations to plan.current (persist.migration)
 → parseWith(CurrentDocSchema, …) (input.malformed)        ← Zod shape check, see helpers.md
 → Model.create(dto) (model.invariant, issue paths prefixed with the DTO path)
 → Ok({ value, notes })
```

Migration rules:

1. **One `schemaVersion` per document** (project file, library file), integer, bumped whenever the persisted shape or meaning changes.
2. The **current** DTO shape is a Zod schema; its type is `z.infer<…>` ([helpers.md](helpers.md#parsing-untrusted-data-zod)). **Historical DTO types are frozen** as plain TS types (`DocV1`, `DocV2`, …), snapshotted when the version is superseded, and never edited.
3. A migration is a **pure DTO → DTO function** for exactly one step `vN → vN+1`. It never constructs models: the model classes of version N no longer exist.
4. Migrations return `AppResult`; a throwing migration is a bug and is classified via `tryCatch` (`persist.migration`, frame with `from` and the step description).
5. When a migration has to **change user data** (e.g. an invariant became stricter), it records a `MigrationNote` instead of failing silently; notes are shown to the user on open and logged.
6. If data cannot be repaired automatically, the load returns `model.invariant` with full paths (`chamfer.sizeMm`) – the UI offers a repair flow; data is never dropped silently.
7. A document with a **newer** `schemaVersion` than the app is refused (`persist.migration`), never "best-effort" loaded.
8. Before writing a migrated document back, the original file is backed up.
9. Every migration has a test with a fixture of the old version.

Implementation: the generic runner `migrate(raw, plan)` with `Migration`, `MigrationPlan`, `MigrationNote`, `Migrated` in [`src/shared/migrate.ts`](../../../src/shared/migrate.ts). Each document kind (project, library, …) defines its own `MigrationPlan` (`document`, `current`, `migrations`) next to its current Zod schema. A complete example (v1 → v2 with a clamping note, then `parseWith` and `Model.create`) is in [`migrate.test.ts`](../../../src/shared/migrate.test.ts).
