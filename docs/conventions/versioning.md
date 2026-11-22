# Versioning

Status: implemented · Decision: [ADR 0003](../decisions/0003-automatic-version-bump.md)

The app version (`package.json` `version`) **bumps its patch number automatically on every commit that changes app code**.

## How

- Git hook: `.githooks/pre-commit` → `scripts/bump-version.mjs` (rules live in that file: `APP_CODE_PATTERNS` and ignored patterns).
- Hooks are activated by `npm install` (the `prepare` script sets `git config core.hooksPath .githooks`).
- When staged files match, the script bumps the patch version in `package.json` and `package-lock.json` and stages both.
- Docs, tests, markdown and tooling-only commits do not bump.

## Notes

- **Minor = last closed milestone** (D31, 2026-11-22): when a milestone `docs/plans/v0.N.md` closes, set the version to `0.N.0` in the closing commit (`npm version 0.N.0 --no-git-tag-version`), then reinstall the local app ([packaging.md](packaging.md)). Patches keep bumping automatically in between. v0.1 and v0.2 are closed, so the line is `0.2.x` until v0.3 closes. Major stays 0 until the developer ends pre-alpha.
- If `package.json`/`package-lock.json` have **unstaged** changes, the hook aborts rather than staging them silently.
- Escape hatch: `SKIP_VERSION_BUMP=1 git commit …` (e.g. for `--amend` of an already-bumped commit).
