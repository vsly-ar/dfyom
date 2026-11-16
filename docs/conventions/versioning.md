# Versioning

Status: implemented · Decision: [ADR 0003](../decisions/0003-automatic-version-bump.md)

The app version (`package.json` `version`) **bumps its patch number automatically on every commit that changes app code**.

## How

- Git hook: `.githooks/pre-commit` → `scripts/bump-version.mjs` (rules live in that file: `APP_CODE_PATTERNS` and ignored patterns).
- Hooks are activated by `npm install` (the `prepare` script sets `git config core.hooksPath .githooks`).
- When staged files match, the script bumps the patch version in `package.json` and `package-lock.json` and stages both.
- Docs, tests, markdown and tooling-only commits do not bump.

## Notes

- Minor/major bumps are manual: `npm version minor --no-git-tag-version`.
- If `package.json`/`package-lock.json` have **unstaged** changes, the hook aborts rather than staging them silently.
- Escape hatch: `SKIP_VERSION_BUMP=1 git commit …` (e.g. for `--amend` of an already-bumped commit).
