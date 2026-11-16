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
- **Error handling** (oxide.ts Result/Option, AppError, invariant models) is designed in `docs/conventions/error-handling/` (start at its README; draft, awaiting acceptance) – follow its rules for any fallible code.
- Use industry-standard CNC terms; add new ones to `docs/glossary.md`.

## Commands

- `npm run check` – typecheck + tests; run before committing.
- `npm run dev` / `npm run build`.
- Commits touching app code auto-bump the patch version via `.githooks/pre-commit` (`docs/conventions/versioning.md`).
