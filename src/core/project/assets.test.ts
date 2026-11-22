import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../commands/history'
import { uiSource } from '../commands/testing'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import {
  assetHashOf,
  assetPathOf,
  historyAssets,
  isAssetName,
  isAssetPath,
  referencedAssets,
} from './assets'
import { parseManifest } from './layout'

const H = 'a'.repeat(64)
const P = `assets/${H}.stl`

describe('asset names', () => {
  it('accept only lower-case sha256 hex plus .stl', () => {
    expect(isAssetName(`${H}.stl`)).toBe(true)
    expect(isAssetPath(P)).toBe(true)
    for (const n of [`${'A'.repeat(64)}.stl`, `${H}.STL`, `${H}.obj`, 'a.stl', `${H}.stl.tmp`])
      expect(isAssetName(n), n).toBe(false)
    for (const p of [`assets/x/${H}.stl`, `../assets/${H}.stl`, `${H}.stl`])
      expect(isAssetPath(p), p).toBe(false)
    expect(assetPathOf(H, 'stl')).toBe(P)
    expect(assetHashOf(P)).toBe(H)
  })
})

describe('referenced assets', () => {
  it('collects every asset path named by a reference record', () => {
    const B = `assets/${'b'.repeat(64)}.stl`
    const doc = { references: { r1: { asset: { path: P } }, r2: { asset: { path: B } } } }
    expect([...referencedAssets(doc)].sort()).toEqual([P, B])
    expect(referencedAssets({}).size).toBe(0)
  })

  it('includes the assets an undo or redo entry names (an undone import)', () => {
    const entry = (value: unknown, inverse: unknown): HistoryEntry => ({
      seq: 1,
      command: 'design.reference.import',
      args: {},
      source: uiSource(),
      title: 'Import',
      patches: [{ op: 'add', path: ['references', 'r1'], value }],
      inversePatches: [{ op: 'remove', path: ['references', 'r1'], value: inverse }],
      revisionBefore: 1,
      revisionAfter: 2,
      at: 'now',
    })
    const found = historyAssets({ undoable: [], redoable: [entry({ asset: { path: P } }, null)] })
    expect([...found]).toEqual([P])
    expect(
      historyAssets({ undoable: [entry({ name: 'x' }, 'not/an/asset')], redoable: [] }).size,
    ).toBe(0)
  })
})

describe('manifest with assets', () => {
  const manifest = (path: string, sha256: string) => ({
    format: 'dfyom-project',
    schemaVersion: 1,
    projectId: 'p',
    appVersion: '0',
    savedAt: '2026-11-17T10:00:00.000Z',
    revision: 1,
    files: [{ path, size: 3, sha256 }],
  })

  it('lists assets whose hash equals their name', () => {
    expectOk(parseManifest(manifest(P, H)))
    const e = expectErrCode(parseManifest(manifest(P, 'c'.repeat(64))), 'input.malformed')
    expect(e.message).toMatch(/asset hash/)
    expectErrCode(parseManifest(manifest('assets/notes.txt', H)), 'input.malformed')
  })
})
