// Path of the vendored 2D module in the build: electron-vite copies it next to the main-process
// chunks (`?asset`). Kept apart from node.ts so Vitest never sees the build-only import.
// Doc: docs/architecture/shapes.md#where-the-2d-layer-runs
/// <reference types="electron-vite/node" />
import wasmPath from '../../../vendor/cavalier-contours/cavalier_contours.wasm?asset'

export const CAVALIER_WASM_PATH: string = wasmPath
