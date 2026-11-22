# Packaging and local install

Status: implemented

How the app is packaged as `DFYOM.app` and installed for the developer. Local installs only: no code signing, no notarization, no installer image or auto-update yet. Config: [`electron-builder.config.mjs`](../../electron-builder.config.mjs).

## Commands

| Command                  | Does                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run package`        | `electron-vite build`, then electron-builder `--dir`: an unpacked `release/mac-arm64/DFYOM.app` (`release/` is gitignored)            |
| `npm run install:local`  | `package`, then [`scripts/install-local.mjs`](../../scripts/install-local.mjs) copies the app to `~/Applications/DFYOM.app` (no sudo) |
| `npm run smoke:packaged` | The [smoke tests](testing.md#app-playwright-for-electron) on the packaged executable, windows hidden; run after `package`             |

`smoke:packaged` is optional, not part of `npm run check` or CI. **When a milestone is reached** (a plan in [plans/](../plans/) closes), run `npm run install:local`, then `npm run smoke:packaged`, so the installed app is that milestone's version (`package.json` `version`, shown in the window title and Finder's Get Info).

## Install

- The installed copy is replaced only while it is not running: `pgrep -f ~/Applications/DFYOM.app` finds a process → the script refuses with a message and exits 1; quit DFYOM and run it again.
- It copies with `ditto` to `~/Applications/.DFYOM.app.installing`, then swaps it in, so a failed copy keeps the old app.
- App data (projects, library, settings, logs) lives in the user's app data folder ([persistence.md](../architecture/persistence.md#files-and-folders)), not in the bundle, so it survives reinstalling.

## Configuration

- **`appId` `app.dfyom`** (reverse DNS of the product name; no domain is registered, and it only has to be unique on the machine). It is the macOS bundle identifier; changing it later makes macOS treat the app as a different one (permissions, Dock).
- **`productName` `DFYOM`:** the bundle and menu name; the dev-only bundle rename ([ui.md](ui.md#app-name-and-icon)) is not needed.
- **Target** `dir`, `arm64` (the developer's Mac). A `dmg` or `zip` target is one more entry in `mac.target` when wanted.
- **asar:** on. The main process reads `manifold.wasm` and the vendored `cavalier_contours.wasm` with `fs` from inside the asar, so nothing is unpacked.
- **Signing:** `identity: null`, `notarize: false`. The binaries keep Electron's ad hoc linker signature, enough for Apple Silicon; the bundle is not sealed, so Gatekeeper would refuse a copy downloaded from the internet (quarantined), not a local build.
- **Icon:** Electron's until the icon is designed ([ui.md](ui.md#app-name-and-icon), B21); it then goes in `build/` (`buildResources`).
- **Fuses** are left at Electron's defaults (`runAsNode` on, which the future `dfyom` launcher needs, [llm-api.md](../architecture/llm-api.md#processes-and-hosting)).

## What goes in

- `out/**` (main, preload, renderer, worker and machine-host chunks, `cavalier_contours.wasm` via `?asset`) and `package.json`; no source maps, fixtures or vendor sources.
- **Production dependencies:** only the packages the main process `require`s at run time (`MAIN_EXTERNALS` in the config) and their dependencies. Renderer libraries are bundled by Vite and left out; `manifold-3d` ships only `manifold.js` and `manifold.wasm` (its own dependencies serve its CLI). A new `require` of a dependency in `src/main` must be added to `MAIN_EXTERNALS`.
- **Licence texts** in `DFYOM.app/Contents/Resources`: `LICENSE.txt` (the app, GPL-3.0-or-later) and `THIRD-PARTY-NOTICES.txt` (the 2D module's crates, [ADR 0019](../decisions/0019-2d-geometry-library.md)); Electron adds its own `LICENSE.electron.txt` and `LICENSES.chromium.html`.

## Smoke test

`DFYOM_E2E_APP=<executable>` makes the e2e fixture launch that executable instead of `out/main/index.js`. `DFYOM_HIDE_WINDOWS=1` is honoured by packaged builds too, so the packaged run shows no window. On a packaged app the first smoke test also checks `app.isPackaged`, the name `DFYOM`, the asar app path and the licence texts.

A dependency missing from the asar makes the packaged app stop at start with Electron's main-process error box (hidden in a test run, so the test just times out). To find it, require the externals inside the app with `ELECTRON_RUN_AS_NODE=1 DFYOM.app/Contents/MacOS/DFYOM -e "require('module').createRequire('<app.asar>/out/main/index.js')('<pkg>')"`.

## Dependency

`electron-builder` (dev dependency, MIT, so GPL-3.0-or-later compatible per [ADR 0014](../decisions/0014-gpl-3-or-later-license.md)); it is a build tool and is not shipped in the app.
