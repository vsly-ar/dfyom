# Persistence and migrations

Status: draft – ready for review · Part of [error handling](README.md) · Code blocks are the [reference design](README.md#reference-design)

Loading saved data: DTOs, the load pipeline, step-by-step schema migrations.

Persisted data are **DTOs** (plain JSON). Models never serialize themselves implicitly; they expose `toDTO()` and are rebuilt with `create()`/`fromDTO()`.

Load pipeline:

```text
read file (tryAsync, persist.io)
 → JSON.parse (tryCatch, input.malformed)
 → migrate(raw): step-by-step DTO migrations to CURRENT_SCHEMA (persist.migration)
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

```ts
interface Migration {
  readonly from: number
  readonly describe: string
  readonly up: (doc: unknown, notes: MigrationNote[]) => AppResult<unknown>
}

const MIGRATIONS: readonly Migration[] = [
  {
    from: 1,
    describe: 'rename chamfer.angle/size → angleDeg/sizeMm; v2 forbids angle ≥ 90°, clamp to 89°',
    up(raw, notes) {
      const d = raw as DocV1
      let angleDeg = d.chamfer.angle
      if (angleDeg >= 90) {
        notes.push({
          from: 1,
          path: ['chamfer', 'angleDeg'],
          message: `angle ${angleDeg}° is no longer allowed; clamped to 89°`,
        })
        angleDeg = 89
      }
      return Ok<DocV2>({ schemaVersion: 2, chamfer: { angleDeg, sizeMm: d.chamfer.size } })
    },
  },
]

export function migrate(raw: unknown): AppResult<Migrated<CurrentDoc>> {
  const v = readVersion(raw) // input.malformed if missing
  if (v.isErr()) return v
  let version = v.unwrap()
  if (version > CURRENT_SCHEMA)
    return fail(
      'persist.migration',
      `document schema ${version} is newer than this app (${CURRENT_SCHEMA})`,
    )
  const notes: MigrationNote[] = []
  let doc: unknown = raw
  while (version < CURRENT_SCHEMA) {
    const step = MIGRATIONS.find((m) => m.from === version)
    if (step === undefined) return fail('persist.migration', `no migration from schema ${version}`)
    const out = tryCatch(
      () => step.up(doc, notes),
      'persist.migration',
      `migration from v${version} threw`,
    ).andThen((r) => r)
    if (out.isErr())
      return Err(out.unwrapErr().withContext('migrate', { from: version, step: step.describe }))
    doc = out.unwrap()
    version += 1
  }
  return Ok({ value: doc as CurrentDoc, notes })
}
```
