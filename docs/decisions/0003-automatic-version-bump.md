# 0003 – Automatic patch version bump on app-code commits

Status: accepted · Date: 2026-11-16

## Context

The app version should change on every commit that changes the app's code, without relying on developers (or agents) remembering it.

## Decision

A dependency-free git `pre-commit` hook (`.githooks/`, enabled via `core.hooksPath` in the `prepare` script) runs `scripts/bump-version.mjs`, which bumps the patch version when staged files include app code.

## Consequences

- Patch numbers grow quickly; that is intended. Minor/major are bumped manually.
- Behaviour and escape hatches: [conventions/versioning.md](../conventions/versioning.md).
