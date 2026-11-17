# Persistence: project archive and working folder

Status: accepted · Decision: [ADR 0006](../decisions/0006-project-archive-with-working-folder.md) · State: [commands.md](commands.md#project-state) · Loading: [migrations.md](../conventions/error-handling/migrations.md)

The project file is a zip archive; the main process unpacks it into a **working folder**, keeps that folder current after every commit, and builds, verifies and atomically swaps a new archive on save.

## Kinds of history

Four different things; only the save history is persisted by this doc.

| Name                                                      | Where                    | Lifetime                                 |
| --------------------------------------------------------- | ------------------------ | ---------------------------------------- |
| Undo history ([commands.md](commands.md#undo--redo))      | Main-process memory      | Until close or crash (v0.1).             |
| Action log ([commands.md](commands.md#action-log))        | Main-process ring buffer | Until close; streamed to agents and UI.  |
| **Save history**                                          | App data, per project    | Last verified archives, retention below. |
| Diagnostic logs ([logging.md](../conventions/logging.md)) | App log folder           | Log rotation.                            |

The archive holds no undo history and no action log in v0.1.

## Files and folders

`<appData>` is Electron's `userData` in the app, or `--data-dir` in headless/CLI runs (injected, so persistence code does not import Electron).

| Item           | Path                                                 | Content                                                                                   |
| -------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Project file   | Anywhere the user chooses, extension `.dfyom`        | Zip of the working folder's documents plus `manifest.json`.                               |
| Project folder | `<appData>/projects/<key>/`                          | `<key>` = project id; a second file with the same id open at once gets `<id>~2`, `~3`, …. |
| Working folder | `<project folder>/work/`                             | Unpacked documents ([layout](#working-folder-layout)), `assets/` (not in v0.1).           |
| State          | `<project folder>/state.json`                        | Project file path, `dirty`, last saved revision and manifest hash, working revision.      |
| Lock           | `<project folder>/lock.json`                         | Instance id, PID, host, `startedAt`, `heartbeatAt`.                                       |
| Save history   | `<project folder>/saves/<savedAt>-r<revision>.dfyom` | Verified archives, identical to what was written to the project file.                     |

- Documents are **JSON**, pretty-printed with stable key order, so they diff cleanly. They are the `ProjectDoc` DTOs ([commands.md](commands.md#project-state)).
- The stock/tool/machine **library is global app data**, not part of a project: sketched as `<appData>/library/`; format and location are defined in task 1.7 (library models doc, [plan](../plans/v0.1.md)).
- `manifest.json`: `{ format: 'dfyom-project', schemaVersion, projectId, appVersion, savedAt, revision, files: [{ path, size, sha256 }] }`. It is the archive's single `schemaVersion` for all its documents.
- Zip entries: JSON is deflated; files that are already compressed (images, recordings) are stored.

### Working-folder layout

One JSON file per top-level record of `ProjectDoc`:

| File                  | Content                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `project.json`        | Project-level fields (id, name, unit system, revision, …)                                                         |
| `parts/<id>.json`     | One part with its operations                                                                                      |
| `plans/<id>.json`     | One plan: status, design snapshot, own library copies, setups ([plan-v0.1.md](../modes/plan-v0.1.md#plan-record)) |
| `snapshots/<id>.json` | One library-item snapshot used by the design (below)                                                              |

### Library references

Decided pending task 1.7 (it may refine fields, not the rule):

- A project uses a library item only through a **snapshot**: `{ id, kind, libraryItemId, takenAt, values }`, a copy of the item's values at the time it was used. Parts and plans reference the snapshot `id`, never the library item directly. Rule: `snapshots/` serves the design (parts); each plan keeps its own snapshots inside `plans/<id>.json` and references only those, so a plan never shares a snapshot with the design or another plan.
- Loading a project never reads the library, so an archive opens unchanged on another machine or after the library item was edited or deleted.
- Library changes reach a project only through an explicit, undoable command (e.g. "update from library"), which replaces the snapshot's `values`.

## Open

1. Resolve the project folder; take the [lock](#lock) or fail with `persist.locked`.
2. If `work/` exists with `dirty: true` → offer **recovery** ([below](#crash-recovery)).
3. Otherwise unpack into a fresh `work/`: reject paths outside the folder (zip-slip), check every entry against the manifest.
4. Load each document through the load pipeline ([migrations.md](../conventions/error-handling/migrations.md#rules-once-data-is-preserved)): `parseWith` → `Model.create`.
5. Start the dispatcher with `revision` from the manifest and an empty undo history.

## Working folder writes

There is no other autosave: the project file changes only on an explicit save.

- After each committed document command, the changed records (known from the patches) are written to `work/`, debounced (~500 ms) and always flushed before save and close.
- Each file is written atomically: write `name.tmp`, fsync, rename. `state.json` (with `dirty: true` and the working revision) is written last.
- Writes run in the main process outside the command queue; a write failure is logged and shown as a persistent warning ("unsaved changes are not protected"), not returned to the command.

## Save

`project.save` is an `effect` command: it holds the project queue, so it sees one stable revision ([commands.md](commands.md#concurrency)).

1. Flush the working folder.
2. Build `<target>.tmp-<random>` **in the target's directory** (same volume, so the rename is atomic); write `manifest.json` last; fsync.
3. **Verify**: reopen the temp archive, check the entry set, sizes and hashes against the manifest, and load every document through the load pipeline.
4. Rename the temp archive over the target (Windows: retry briefly on `EPERM`/`EBUSY`); fsync the directory on POSIX.
5. Copy the new archive into `saves/` (copy-on-write clone where supported) and apply the retention limits. The first save of a session also adds the opened file if its hash is not in `saves/` yet.
6. Update `state.json`: `dirty: false`, saved revision and manifest hash.

Any failure in steps 1–4 deletes the temp file, leaves the project file untouched and returns an `AppError`. A failure in steps 5–6 is logged and shown as a warning; the save itself succeeded. "Save As" is the same sequence with a new target; the project id stays.

## Save-history retention

Fixed in v0.1 (no settings): keep at most **20 saves** and **200 MB per project**, and **2 GB** across all projects; delete oldest first; never delete the newest save of a project.

## Lock

- Create `lock.json` with exclusive create (`wx`); refresh `heartbeatAt` every 30 s; delete on close.
- An existing lock is **stale** if its PID is not alive on this host, or `heartbeatAt` is older than 2 min. A stale lock is replaced by write-temp-and-rename; the takeover is logged.
- A live lock → `persist.locked` with the holder's instance id and start time.

## Crash recovery

- On app start, and on open, list project folders with `dirty: true` and no live lock, including never-saved (untitled) projects.
- **Restore**: load `work/` through the load pipeline and continue as a dirty project (undo history empty). **Discard**: delete `work/` and open the archive (or nothing, for untitled projects).
- If `work/` does not load (inconsistent after a crash mid-flush, or a schema change), recovery fails with its `AppError`; the user can open the last save or a file from `saves/`.

## Schema version (pre-alpha)

Per [migrations.md](../conventions/error-handling/migrations.md#pre-alpha-exception-no-data-preservation-yet): `schemaVersion` stays `1`, no migrations. A project file or working folder that no longer loads is shown with its error and **never** deleted or overwritten automatically; the user may start a new project or discard the working folder after confirming. Agents and CLI need an explicit confirmation flag. A newer `schemaVersion` is refused (`persist.migration`).

## Error codes

| Code                | When                                                           | Status                  |
| ------------------- | -------------------------------------------------------------- | ----------------------- |
| `persist.io`        | Read, write, rename, fsync failed; disk full; permission       | existing                |
| `input.malformed`   | Not a zip, missing or malformed manifest or document, zip-slip | existing                |
| `persist.migration` | Newer `schemaVersion` than the app                             | existing                |
| `model.invariant`   | Document fails a model invariant                               | existing                |
| `persist.locked`    | Project open in another live instance                          | new: `warn`, retryable  |
| `persist.verify`    | Temp archive failed verification (hash, entry set, load)       | new: `error`, retryable |

New codes are added to [`ERROR_CODES`](../../src/shared/errors/codes.ts) with the implementation. Frames carry the project id and file paths, never document content.

## Files (planned)

`src/core` stays headless: it defines the port and the pure parts; the filesystem lives in `src/main`.

| File                                     | Contents                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/core/project/storage.ts`            | `ProjectStorage` port (`open`, `flush`, `save`, `recover`, `listRecoverable`, `close`) used by commands via `ctx.services` |
| `src/core/project/layout.ts`             | `ProjectDoc` ↔ file map (`{ path: json }`), manifest Zod schema, project `MigrationPlan`, load pipeline                    |
| `src/main/persistence/paths.ts`          | `<appData>` resolution (injected; Electron or `--data-dir`)                                                                |
| `src/main/persistence/archive.ts`        | Streaming zip read/write, hashing, zip-slip check                                                                          |
| `src/main/persistence/working-folder.ts` | Atomic file writes, debounced flush, `state.json`                                                                          |
| `src/main/persistence/save.ts`           | Save/verify/replace sequence                                                                                               |
| `src/main/persistence/lock.ts`           | Lock, heartbeat, stale detection                                                                                           |
| `src/main/persistence/recovery.ts`       | Recoverable-project scan, restore, discard                                                                                 |
| `src/main/persistence/retention.ts`      | Save-history limits                                                                                                        |

`src/main/persistence/` must not import Electron except through `paths.ts`, so the CLI and headless instances reuse it. Tests use a temp directory and inject failures (rename, fsync, corrupt entry) to prove the previous file survives.

## v0.1 scope

| In v0.1                                                                     | Later                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| New, open, save, save as, close – for UI, MCP and CLI                       | Persisted undo history ([commands.md](commands.md#open-questions)) |
| Zip archive, manifest, verify, atomic replace                               | `assets/` (reference models, recordings)                           |
| Working folder flush per commit, lock, crash recovery                       | Save-history browser and restore UI                                |
| Save history with fixed retention limits ([below](#save-history-retention)) | Detecting external changes to the project file                     |
| Refuse to open a project locked by another instance                         | Much later: read-only view of a locked project; migrations         |
