# 0015 – ESLint + typescript-eslint on the TypeScript 6 API; layer boundaries in lint and tsconfig

Status: accepted · Date: 2026-11-16

## Context

- We want a linter that enforces the layer rules of the [source layout](../architecture/overview.md#source-layout) (`src/core` and `src/shared` stay environment-neutral; the renderer never imports the main process) plus a modest recommended rule set for TypeScript and React hooks. Prettier owns formatting.
- The repo compiles with **TypeScript 7.0** (native Go port), which ships **no compiler API**. `typescript-eslint` 8.73 declares `typescript >=4.8.4 <6.1.0` and throws `typescript-eslint does not support TS 7.0.` at load time when `typescript` resolves to 7.0 (verified with a real lint run). Its experimental `tsgo` backend needs a TypeScript **7.1** build aliased as `@typescript/native` (optional peer) and is opt-in; 7.1 is still beta.
- Microsoft's [TypeScript 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0) recommends running side by side: alias `typescript` to the compatibility package `@typescript/typescript6` (re-exports the TS 6 API) and install TypeScript 7 under another alias for `tsc`.
- Alternatives considered:
  - **oxlint** – fast, no TS API needed, but a second config dialect and its own rule implementations; the ESLint ecosystem (react-hooks, typescript-eslint) is what the stack docs assume.
  - **dependency-cruiser** – good for boundaries only; we would still need a linter.
  - **A Vitest test scanning imports** – no editor feedback, reinvents a linter.
- Licenses: ESLint, typescript-eslint, eslint-plugin-react-hooks, eslint-config-prettier, globals – MIT; `@typescript/typescript6` – Apache-2.0. All GPL-3.0-compatible ([ADR 0014](0014-gpl-3-or-later-license.md)).

## Decision

- **ESLint 10 (flat config, `eslint.config.mjs`) with typescript-eslint `recommended`**, plus three type-aware rules (`no-floating-promises`, `no-misused-promises`, `await-thenable`), `eslint-plugin-react-hooks` recommended for the renderer, and `eslint-config-prettier` last. The rest of the type-checked preset is left out: on this codebase it mostly flagged intentional patterns.
- **TypeScript side by side** in `package.json`: `"typescript": "npm:@typescript/typescript6@^6.0.2"` (API for typescript-eslint) and `"typescript7": "npm:typescript@^7.0.2"` (the compiler). `npm run typecheck` calls `node node_modules/typescript7/bin/tsc` explicitly, because both packages ship a `tsc` binary and which one npm links to `node_modules/.bin/tsc` is not reliable.
  - We deviate from the blog's alias name `@typescript/native`: typescript-eslint declares that name as an optional peer for TS ≥ 7.1, and npm 10 (bundled with Node 22, our `.nvmrc`) then tries to install a 7.1 dev build and `npm ci` fails with an out-of-sync lockfile. Verified with Node 22.23 / npm 10.9.
- **Import boundaries in ESLint**:
  - `src/core/**`, `src/shared/**`: `no-restricted-imports` bans `electron`, every Node built-in (bare and `node:*`); a small local rule `layers/no-import-from` bans relative imports that resolve into `src/main`, `src/preload`, `src/renderer`.
  - `src/renderer/**`: `layers/no-import-from` bans `src/main` and `src/preload` (privileged work goes through `window.dfyom`).
  - The local rule resolves paths instead of matching patterns, so `src/renderer/src/main.tsx` is not confused with `src/main/`.
- **No DOM / no Node globals via the existing two tsconfigs**: `src/core` and `src/shared` are type-checked in `tsconfig.node.json` (lib without `DOM`) **and** `tsconfig.web.json` (`types: []`, no `@types/node`). Using `document` fails the first, `process`/`Buffer` the second. No `no-restricted-globals` list is needed.

## Consequences

- `npm run check` = typecheck (TS 7) + lint (TS 6 API) + `format:check` + tests; CI runs the same ([testing.md](../conventions/testing.md#commands)).
- Two TypeScript versions are installed. `npx tsc` and editors that pick the workspace `typescript` package get TS 6; use `npm run typecheck` and the TS 7 native editor extension for TS 7 diagnostics.
- When typescript-eslint supports TS ≥ 7.1 with the stable API: drop both aliases, keep a single `typescript` dependency, restore plain `tsc` in `typecheck`, and supersede this ADR.
- Both tsconfigs must keep including `src/core` and `src/shared`; removing either silently weakens the environment check (comments in both files say so).
