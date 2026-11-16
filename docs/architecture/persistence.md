# Persistence: project archive and working folder

Status: draft · Decision: [ADR 0006](../decisions/0006-project-archive-with-working-folder.md) · Loading and migrations: [migrations.md](../conventions/error-handling/migrations.md)

## Files and folders

| Item           | Where                                         | Content                                                                                |
| -------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Project file   | Anywhere the user chooses                     | Archive (proposed: zip) of the working folder.                                         |
| Working folder | App data directory, one folder per project id | Unpacked project: `manifest.json`, JSON documents, assets. Layout: _to be documented_. |
| Save history   | App data directory, per project               | The last N verified archives.                                                          |
| Lock           | Inside the working folder                     | Instance id, PID, host, timestamp.                                                     |

- Documents inside the archive are **JSON** (readable and diffable by humans and agents). Large binaries (reference models, recordings) live in an `assets/` area and count toward the size limits.
- `manifest.json` lists every file with a content hash and holds the archive's `schemaVersion`.
- A project stores **snapshots** of the library items it uses (stock, tools, machines, workholding), so editing a library never changes an existing plan silently.

## Open

1. Take the lock (refuse if another live instance holds it; detect stale locks).
2. If a working folder for this project id exists and has unsaved changes → offer **recovery** (restore it or discard it).
3. Otherwise unpack the archive into a fresh working folder.
4. Run the load pipeline ([migrations.md](../conventions/error-handling/migrations.md#rules-once-data-is-preserved)) on each document.

## Save

1. Write the working folder into a temporary archive next to the target file.
2. **Verify**: reopen the temporary archive, check every file against the manifest hashes, and parse every document.
3. fsync, then rename the temporary archive over the project file (atomic replace).
4. Move the replaced version into the save history and apply the retention limits.

Any failure leaves the previous project file untouched and returns an `AppError` (`persist.io`).

## Open questions

- Working-folder layout (one file per part/plan/setup?).
- Retention defaults (N, per-project and total size limits) and whether they are user settings.
- Autosave: periodic archive or only working-folder writes.
- Archive format details: zip vs. alternatives, compression of large assets.
