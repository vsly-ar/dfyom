# Persistence: project archive and working folder

Status: implemented (incl. [assets and references](#assets-and-references-v02), v0.2 task R1) · Decision: [ADR 0006](../decisions/0006-project-archive-with-working-folder.md) · State: [commands.md](commands.md#project-state) · Loading: [migrations.md](../conventions/error-handling/migrations.md)

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

`<appData>` is Electron's `userData` in the app, or `--data-dir` in headless/CLI runs (injected, so persistence code does not import Electron). The app accepts `--data-dir` too: it then uses it as Electron's `userData` and `<data-dir>/logs/` as the log folder, set before startup, so one flag isolates a run (the [app end-to-end tests](../conventions/testing.md#app-playwright-for-electron) use it).

| Item           | Path                                                 | Content                                                                                                        |
| -------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Project file   | Anywhere the user chooses, extension `.dfyom`        | Zip of the working folder's documents plus `manifest.json`.                                                    |
| Project folder | `<appData>/projects/<key>/`                          | `<key>` = project id; a second file with the same id open at once gets `<id>~2`, `~3`, ….                      |
| Working folder | `<project folder>/work/`                             | Unpacked documents ([layout](#working-folder-layout)), `assets/` ([v0.2](#assets-and-references-v02)).         |
| State          | `<project folder>/state.json`                        | `schemaVersion`, project id, file path, `dirty`, working and last saved revision, archive sha256.              |
| Lock           | `<project folder>/lock.json`                         | Instance id, PID, host, `startedAt`, `heartbeatAt`.                                                            |
| Save history   | `<project folder>/saves/<savedAt>-r<revision>.dfyom` | Verified archives, identical to what was written to the project file.                                          |
| App settings   | `<appData>/settings.json`                            | GUI preferences ([ui.md](../conventions/ui.md#settings)).                                                      |
| App state      | `<appData>/app-state.json`                           | Last window bounds, dialog folders ([ui.md](../conventions/ui.md#remembered-window-state-and-dialog-folders)). |

- Documents are **JSON**, pretty-printed with stable key order, so they diff cleanly. They are the `ProjectDoc` DTOs ([commands.md](commands.md#project-state)).
- The stock/tool/machine **library is global app data**, not part of a project: sketched as `<appData>/library/`; format and location are defined in task 1.7 (library models doc, [plan](../plans/v0.1.md)).
- `manifest.json`: `{ format: 'dfyom-project', schemaVersion, projectId, appVersion, savedAt, revision, files: [{ path, size, sha256 }] }`. It is the archive's single `schemaVersion` for all its documents.
- Zip entries: JSON is deflated; files that are already compressed (images, recordings) are stored.
- Zip library: **fflate** (MIT, so GPL-3.0-or-later compatible; pure JS, no native build), streaming API: archives are written and read in 1 MB chunks, never held in memory (zip-bomb guards counted while inflating: 512 MB for the documents, and for [assets](#assets-and-references-v02) 512 MB each and 2 GB together, since task R2).

### Working-folder layout

One JSON file per top-level record of `ProjectDoc`:

| File                   | Content                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `project.json`         | Project-level fields of `ProjectDoc` (name, unit system, …); id and revision are in the manifest and `state.json` |
| `parts/<id>.json`      | One part with its operations                                                                                      |
| `plans/<id>.json`      | One plan: status, design snapshot, own library copies, setups ([plan-v0.1.md](../modes/plan-v0.1.md#plan-record)) |
| `snapshots/<id>.json`  | One library-item snapshot used by the design (below)                                                              |
| `references/<id>.json` | One reference model record (v0.2, [below](#assets-and-references-v02))                                            |

The mapping is generic: `layout.ts` lists the `ProjectDoc` keys that are record collections (`<key>/<id>.json`, ids must match `[A-Za-z0-9_-]`); every other field goes to `project.json`. `parts` and `snapshots` are registered (task 2.5), `plans` with task 2.13, `references` with v0.2 task R1. Besides these and `assets/` ([below](#assets-and-references-v02)), any other file in an archive or `work/` is `input.malformed`.

### Library references

Decided pending task 1.7 (it may refine fields, not the rule):

- A project uses a library item only through a **snapshot**: `{ id, kind, libraryItemId, takenAt, values }`, a copy of the item's values at the time it was used. Parts and plans reference the snapshot `id`, never the library item directly. Rule: `snapshots/` serves the design (parts); each plan keeps its own snapshots inside `plans/<id>.json` and references only those, so a plan never shares a snapshot with the design or another plan.
- Loading a project never reads the library, so an archive opens unchanged on another machine or after the library item was edited or deleted.
- Library changes reach a project only through an explicit, undoable command (e.g. "update from library"), which replaces the snapshot's `values`.

### Assets and references (v0.2)

Accepted with [reference-model.md](../modes/reference-model.md#storage) (D18, 2026-11-22), implemented by v0.2 task [R1](../plans/v0.2.md#5-reference-model). An **asset** is a binary file the project stores as given (v0.2: the STL of a reference model); records point to it, documents never embed it.

- **Layout:** `work/assets/<sha256>.<ext>` (lower-case hex of the file bytes; v0.2: `.stl`), content-addressed, so the same file imported twice is stored once and two records may share it. A record names its asset by that path and hash. Asset names must match `^[0-9a-f]{64}\.stl$`; any other file in `assets/` is `input.malformed`.
- **Records:** `references` is a record collection in `layout.ts` (`references/<id>.json`), like `parts`.
- **Manifest and archive:** assets are listed in `manifest.json` like every file (path, size, sha256) and deflated in the archive. Open verifies each asset's hash against both the manifest and its file name.
- **Streaming:** archives are written and read as streams (fflate's streaming zip API), so an asset is never held in memory twice and the archive is never built in memory; this replaces the in-memory v0.1 archive. Zip-bomb guards, counted while streaming: the documents together ≤ 512 MB (they are collected in memory); each asset ≤ 512 MB (`MAX_ASSET_BYTES`, also the import limit) and all assets together ≤ 2 GB (`MAX_ASSETS_TOTAL_BYTES`, below the 4 GiB at which zip needs Zip64). Assets do not count toward the documents' guard, so a reference at the import limit never makes a project unopenable (task R2; before, one 512 MB guard counted everything). Save's verify step streams too. Import copies the source file into `work/assets/` with the same atomic write as documents (temp file, fsync, rename), hashing while copying.
- **Unreferenced assets:** undoing an import removes the record, not the file, so redo works. Save writes only assets referenced by a record **or** by an entry of the session's undo or redo history; open (and restore) deletes files in `work/assets/` that no record references, since the undo history starts empty.
- **No `schemaVersion` bump** (pre-alpha rule, [Schema version](#schema-version-pre-alpha)): a project without references has no `references/` and no `assets/`, so v0.1 projects open unchanged.

Implementation (task R1):

- **Records:** `ReferenceDtoSchema` in `src/core/design/reference.dto.ts` is the [data model](../modes/reference-model.md#data-model) as a shape; R2's commands write it. Asset name rules and the scans for referenced assets are in `src/core/project/assets.ts`. A scan collects every string matching the asset path pattern in the records (or in an undo/redo entry's patches), so it can keep too much, never too little.
- **Session port:** `ProjectSession.importAsset(source)` copies a file into `work/assets/` (streamed into `assets/import-<random>.tmp`, hashed on the way, fsynced, renamed to its hash name; the same content again replaces the identical file) and returns `{ path, sha256, size }`. Task R2: `importAsset(source, { maxBytes })` checks the source first (not a readable regular file → `input.malformed` rule `unreadableFile`; larger than `maxBytes`, also if it grows while copying → rule `tooLarge`), so nothing is stored for a refused file; `assetFile(path)` gives the absolute file for the parser; `useHistory` (called by `attachSession`) lets save see the undo/redo stacks.
- **Streaming I/O:** `PersistFs.readRange` and `appendFile` (one call per chunk, so `faultFs` can fail any of them). Inflate input is pushed in 64 KB slices, so one push can expand to at most ~64 MB before the size guard and the asset writes catch up. Documents (small JSON) are collected in memory for the load pipeline; assets never are.
- **Open:** step 1 streams the whole archive and verifies it, hashing assets without writing them. The unpack (step 4) streams the archive a second time and writes only the assets a record references, checking that the file's sha256 is still the one verified. A project without referenced assets (every v0.1 project) is read once.
- **Restore** deletes files in `work/assets/` that no record references (incl. leftover import temp files) before the session starts; a failure there is logged, not returned. A referenced asset missing from `work/` fails the save (`persist.io`); a damaged one fails its verification (`persist.verify`, hash ≠ name).

## Open

1. Read and verify the archive, streamed (zip-slip, manifest, entry set, sizes, hashes incl. assets, load pipeline); nothing is written yet, so a bad file changes nothing.
2. Resolve the file's canonical path (`realpath`: symlinks and `..` resolved; compared case-folded on macOS and Windows, whose volumes are case-insensitive by default), so one file always maps to one folder and lock. Resolve the project folder: the one whose `state.json` names this file, else the first free `<id>`, `<id>~2`, …; an unreadable folder is skipped, never reused. Take the [lock](#lock) or fail with `persist.locked`.
3. If `state.json` says `dirty: true` → release the lock and return **recovery** ([below](#crash-recovery)) instead of opening.
4. Otherwise unpack into a new folder (assets streamed from the archive again, only those a record references: [assets](#assets-and-references-v02)), swap it in as `work/`, then write `state.json`. Zip-slip: entry names must be relative forward-slash paths without `.`/`..`/empty segments or drive letters, and every write is checked to stay inside `work/`.
5. Each document went through the load pipeline in step 1 ([migrations.md](../conventions/error-handling/migrations.md#rules-once-data-is-preserved)): `parseWith` → `Model.create`.
6. Start the dispatcher with an empty undo history at `revision` (`DispatcherOptions.revision`): the manifest's revision for a new folder; otherwise `max(manifest revision, previous working revision) + 1`, so revisions of discarded changes are never reused for other content. `attachSession` feeds its commits to the working folder.

## Working folder writes

There is no other autosave: the project file changes only on an explicit save.

- After each committed document command (and undo/redo), the changed records (known from the patches; a replaced collection rewrites all) are written to `work/`, debounced (~500 ms) and always flushed before save and close. Commits not yet flushed are lost in a crash.
- Each file is written atomically: write `name.tmp`, fsync, rename. `state.json` (with `dirty: true` and the working revision) is written last.
- Writes run in the main process outside the command queue; a write failure is logged and shown as a persistent warning ("unsaved changes are not protected"), not returned to the command. Failed writes stay pending and are retried by the next flush.

## Save

`project.save` is an `effect` command: it holds the project queue, so it sees one stable revision ([commands.md](commands.md#concurrency)).

1. Flush the working folder.
2. Stream `<target>.tmp-<random>` **in the target's directory** (same volume, so the rename is atomic): documents, the assets a record or an undo/redo entry names, `manifest.json` last; fsync.
3. **Verify**: reopen the temp archive, check the entry set, sizes and hashes against the manifest, and load every document through the load pipeline.
4. Rename the temp archive over the target (Windows: retry briefly on `EPERM`/`EBUSY`); fsync the directory on POSIX. Leftover `<target>.tmp-<8 hex>` files of a crashed save are then deleted.
5. Copy the new archive into `saves/` (copy-on-write clone where supported) and apply the retention limits. The first save of a session also adds the file being replaced (if it is a valid archive whose hash is not in `saves/` yet) – before step 2, since the rename replaces it.
6. Update `state.json`: `dirty: false`, saved revision and archive sha256.

Any failure before the rename in step 4 deletes the temp file, leaves the project file untouched and returns an `AppError` (`persist.verify` for a failed verification). Once the rename succeeded the save has happened: a failed directory fsync or a failure in steps 5–6 is logged and returned in the result's `warnings`. "Save As" is the same sequence with a new target; the project id and folder stay. A target must end in `.dfyom`. An existing target that is not this project's file is replaced only with `confirm: true`, only if it is a valid DFYOM archive (any other file is never replaced), and only after it was copied into this project's `saves/`.

## Save-history retention

Fixed in v0.1 (no settings): keep at most **20 saves** and **200 MB per project**, and **2 GB** across all projects; delete oldest first; never delete the newest save of a project. Only files named `<savedAt>-r<revision>.dfyom` (`:` → `-`) are counted or deleted; the total limit also trims other projects' history.

## Lock

- Create `lock.json` exclusively: write a temp file, fsync, then hard-link it to `lock.json` (fails if one exists – exclusive like `wx`, but never visible half-written); refresh `heartbeatAt` every 30 s; delete on close.
- Creating is lock-free (the link fails if a lock exists). Only a holder of the **takeover mutex** `lock.json.takeover` ever removes or replaces `lock.json`; the mutex is created the same exclusive way and holds a unique token. Under it, each operation re-reads `lock.json` and then acts:
  - takeover: if it is still the same stale lock, unlink it and link ours (if absent);
  - refresh: if it is ours, write a temp file and rename it over `lock.json` (atomic replace); otherwise `persist.locked`;
  - release: if it is ours, unlink it.
- A busy mutex is retried briefly; then a takeover returns `persist.locked` and a refresh tries again at the next heartbeat. A mutex older than 10 s (wall time) was left by a crashed instance and is broken (logged); two instances breaking the same dead mutex at once is a remaining tiny race (plan known issues).
- An existing lock is **stale**:
  - same host (same clock): `heartbeatAt` is older than 2 min, or its PID is not alive **and** `heartbeatAt` is older than one interval (30 s). The second condition guards PID namespaces (Flatpak, Snap, containers) that share the host name but not the PIDs.
  - other host: clocks may differ, so only once this instance has seen the same `heartbeatAt` unchanged for 2 min of its own (local) time; a first attempt is refused and a retry after 2 min succeeds.
  - A lock file that does not parse (corrupt) is stale too. The takeover is logged (`warn`).
- A live lock → `persist.locked` with the holder's instance id and start time – also when the same instance opens the same file twice.
- A heartbeat that finds another instance's lock (ours went stale, e.g. while the computer slept) stops and raises a persistent warning. Close deletes the lock only if it is still ours.

## Crash recovery

- On app start, and on open, list project folders with `dirty: true` and no live lock, including never-saved (untitled) projects.
- **Restore**: load `work/` through the load pipeline and continue as a dirty project at its working revision + 1 (commits after the last flush were lost with their revisions; undo history empty). **Discard**: replace `work/` with the archive's content and open it (untitled projects: delete the project folder and open nothing). Discard loads the project file first; if it does not load, nothing is deleted and its error is returned.
- If `work/` does not load (inconsistent after a crash mid-flush, or a schema change), recovery fails with its `AppError` and keeps `work/`; the user can discard, or open the last save or a file from `saves/`.
- Recovery runs before a project dispatcher exists, so it is not a project command: `src/core/project/storage.ts` defines the app-level operations `listRecovery` and `resolveRecovery` (args `{ key, action: 'restore' | 'discard', confirm }`), which the app-scope commands `project.recovery.list` and `project.recovery.resolve` wrap ([llm-api.md](llm-api.md#app-scope-and-project-scope); with `project.create`, `open`, `close`, task 3.10). Discarding needs `confirm: true` for every adapter (UI, MCP, CLI). `key` must match `^[A-Za-z0-9_-]{1,128}(~\d{1,6})?$` (checked in the schema and again in `recover`, which also asserts the folder is inside `<appData>/projects/`), so a key can never address another folder.
- Closing a project with unsaved changes keeps `work/` dirty, so it is offered for recovery next time; an unchanged untitled project's folder is deleted on close.

## Schema version (pre-alpha)

Per [migrations.md](../conventions/error-handling/migrations.md#pre-alpha-exception-no-data-preservation-yet): `schemaVersion` stays `1`, no migrations. A project file or working folder that no longer loads is shown with its error and **never** deleted or overwritten automatically; the user may start a new project or discard the working folder after confirming. Agents and CLI need an explicit confirmation flag. A newer `schemaVersion` is refused (`persist.migration`).

## Error codes

| Code                | When                                                           | Status             |
| ------------------- | -------------------------------------------------------------- | ------------------ |
| `persist.io`        | Read, write, rename, fsync failed; disk full; permission       | existing           |
| `input.malformed`   | Not a zip, missing or malformed manifest or document, zip-slip | existing           |
| `persist.migration` | Newer `schemaVersion` than the app                             | existing           |
| `model.invariant`   | Document fails a model invariant                               | existing           |
| `persist.locked`    | Project open in another live instance                          | `warn`, retryable  |
| `persist.verify`    | Temp archive failed verification (hash, entry set, load)       | `error`, retryable |

Codes are in [`ERROR_CODES`](../../src/shared/errors/codes.ts). Frames carry the project id and file paths, never document content.

## Files

`src/core` stays headless: it defines the port and the pure parts; the filesystem lives in `src/main`.

| File                                     | Contents                                                                                                                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/project/storage.ts`            | `ProjectStorage` port (`create`, `open`, `recover`, `listRecoverable`, `close`); per-project `ProjectSession` (`changed`, `flush`, `save`, `importAsset`, `assetFile`, `useHistory`) = `ctx.services.project`; recovery operations; `attachSession` |
| `src/core/project/commands.ts`           | `project.save` effect command (`target` = Save As)                                                                                                                                                                                                  |
| `src/core/project/layout.ts`             | `ProjectDoc` ↔ file map (`{ path: json }`), manifest Zod schema, project `MigrationPlan`, load pipeline                                                                                                                                             |
| `src/main/persistence/paths.ts`          | `<appData>` resolution (injected; Electron or `--data-dir`), project folder paths                                                                                                                                                                   |
| `src/main/persistence/fs.ts`             | `PersistFs` port over `node:fs` (incl. `lstat`, non-recursive `unlink`, chunked `readRange`/`appendFile`), atomic write, rename retry; tests wrap it with `faultFs` (`fs.testing.ts`)                                                               |
| `src/main/persistence/export-file.ts`    | `ExportFiles` port for `plan.export`: Save As protocol in the user's folder (random temp file, rename, `lstat`, symlinks resolved), replace only with `confirm` ([grbl.md](grbl.md#plan-export-command))                                            |
| `src/main/persistence/storage.ts`        | `createProjectStorage`: the `ProjectStorage` implementation and sessions (open/create/recover/close, save sequence)                                                                                                                                 |
| `src/main/persistence/archive.ts`        | Streaming zip read/write, hashing, zip-slip check; tests build archives in memory with `archive.testing.ts`                                                                                                                                         |
| `src/main/persistence/assets.ts`         | Asset import into `work/assets/`, cleanup of unreferenced assets                                                                                                                                                                                    |
| `src/core/project/assets.ts`             | Asset name rules (`assets/<sha256>.stl`), referenced-asset scans of records and undo history                                                                                                                                                        |
| `src/main/persistence/working-folder.ts` | Atomic file writes, debounced flush, `state.json`                                                                                                                                                                                                   |
| `src/main/persistence/save.ts`           | Save/verify/replace sequence                                                                                                                                                                                                                        |
| `src/main/persistence/lock.ts`           | Lock, heartbeat, stale detection                                                                                                                                                                                                                    |
| `src/main/persistence/recovery.ts`       | Recoverable-project scan, restore, discard                                                                                                                                                                                                          |
| `src/main/persistence/retention.ts`      | Save-history limits                                                                                                                                                                                                                                 |

`src/main/persistence/` does not import Electron (the caller passes `userData` to `paths.ts`), so the CLI and headless instances reuse it. Tests use a temp directory and inject failures through `faultFs` – `fail` (one call throws) and `crash` (that call and every later one throws, so no cleanup runs, like a killed process) – at every step of save, flush and unpack, plus a corrupting write for verification, to prove the previous file survives.

## v0.1 scope

| In v0.1                                                                     | Later                                                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| New, open, save, save as, close – for UI, MCP and CLI                       | Persisted undo history ([commands.md](commands.md#open-questions))                     |
| Zip archive, manifest, verify, atomic replace                               | `assets/` for reference models (v0.2, [above](#assets-and-references-v02)); recordings |
| Working folder flush per commit, lock, crash recovery                       | Save-history browser and restore UI                                                    |
| Save history with fixed retention limits ([below](#save-history-retention)) | Detecting external changes to the project file                                         |
| Refuse to open a project locked by another instance                         | Much later: read-only view of a locked project; migrations                             |
