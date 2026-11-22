/**
 * Project assets: binary files stored as given under `assets/`, named by their content hash.
 * Doc: docs/architecture/persistence.md#assets-and-references-v02
 *
 * Pure and headless: naming rules and the scans that decide which assets a project still needs.
 * Copying, hashing and streaming live in src/main/persistence.
 */
import type { HistoryView } from '../commands/context'

/** Folder of the assets inside `work/` and the archive. */
export const ASSET_DIR = 'assets'

/** v0.2: STL only. Lower-case hex sha256 of the file bytes plus the extension. */
export const ASSET_NAME = /^[0-9a-f]{64}\.stl$/

/** `assets/<sha256>.stl`, the path records and the manifest use. */
export const ASSET_PATH = /^assets\/[0-9a-f]{64}\.stl$/

export type AssetFormat = 'stl'

/**
 * Largest asset a project stores: the import limit, and the per-asset limit when an archive is
 * read. Doc: docs/architecture/persistence.md#assets-and-references-v02
 */
export const MAX_ASSET_BYTES = 512 * 1024 * 1024

/**
 * All assets of an archive together, counted while reading (the assets' zip-bomb guard; the
 * documents keep their own 512 MB guard). Below 4 GiB, so archives never need Zip64.
 */
export const MAX_ASSETS_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

export function isAssetName(name: string): boolean {
  return ASSET_NAME.test(name)
}

export function isAssetPath(path: string): boolean {
  return ASSET_PATH.test(path)
}

/** `assets/<sha256>.<format>`. */
export function assetPathOf(sha256: string, format: AssetFormat): string {
  return `${ASSET_DIR}/${sha256}.${format}`
}

/** The sha256 an asset path names (its file name without the extension). */
export function assetHashOf(path: string): string {
  const name = path.slice(ASSET_DIR.length + 1)
  return name.slice(0, name.indexOf('.'))
}

/** An asset stored in the working folder, as `ProjectSession.importAsset` returns it. */
export interface AssetRef {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

/**
 * Every asset path named anywhere in `value` (deep scan of strings). Conservative on purpose:
 * a string that names an asset keeps the file, so a scan can never drop data still referenced.
 */
export function assetPathsIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (isAssetPath(value)) into.add(value)
  } else if (Array.isArray(value)) for (const v of value) assetPathsIn(v, into)
  else if (typeof value === 'object' && value !== null)
    for (const v of Object.values(value)) assetPathsIn(v, into)
  return into
}

/** Assets the document's records reference (v0.2: `references/*.asset.path`). */
export function referencedAssets(doc: { readonly references?: unknown }): Set<string> {
  return assetPathsIn(doc.references)
}

/**
 * Assets named by an undo or redo entry (e.g. the record of an undone import), so redo still
 * finds its file after a save and reopen within the session.
 */
export function historyAssets(history: HistoryView, into: Set<string> = new Set()): Set<string> {
  for (const e of [...history.undoable, ...history.redoable]) {
    for (const p of e.patches) assetPathsIn(p.value, into)
    for (const p of e.inversePatches) assetPathsIn(p.value, into)
  }
  return into
}
