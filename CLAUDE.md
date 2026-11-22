# CLAUDE.md

Guidance for AI agents working in this repo. Keep it short; link to docs instead of restating them.

## Start here

- Product & principles: `docs/vision.md`, `docs/principles.md`
- Docs index and status meanings: `docs/README.md`
- Source layout and process model: `docs/architecture/overview.md`

## Rules

- **Docs before code.** Before implementing anything, find or write its doc. Don't implement docs marked `stub`/`draft` without confirming with the user. Update docs in the same change as code (`docs/conventions/documentation.md`).
- **Link, don't copy** between docs; contracts live in code with comments pointing to the doc.
- **`src/core` stays headless** – no Electron/DOM/Node-only imports.
- **Error handling** (oxide.ts Result/Option, AppError, invariant models) is implemented in `src/shared/` and documented in `docs/conventions/error-handling/` (start at its README) – follow its rules for any fallible code.
- **Pre-alpha: no data migrations.** Don't bump `schemaVersion` or write migrations; incompatible data is reset after user confirmation ([migrations.md](docs/conventions/error-handling/migrations.md#pre-alpha-exception-no-data-preservation-yet)). Only the developer ends this phase.
- Use industry-standard CNC terms; add new ones to `docs/glossary.md`.
- **Keep the current plan current.** When work starts, finishes or uncovers a task/issue, update the current plan (status, next up, known issues) in the same commit. `docs/plans/v0.1.md`–`v0.4.md` are closed; the hardening milestone (D43) is next, then `docs/plans/v0.4-llm-first.md` (draft). Open v0.4 issues are listed in `docs/plans/v0.4.md`.

## Commands

- `npm run check` – typecheck + lint + format check + tests; run before committing (CI runs it too, see `docs/conventions/testing.md`).
- `npm run dev` / `npm run build`.
- Commits touching app code auto-bump the patch version via `.githooks/pre-commit` (`docs/conventions/versioning.md`).
