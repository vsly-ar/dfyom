import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { newProjectDoc } from '../../core/project/document'
import { docToFiles, stableJson } from '../../core/project/layout'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { buildArchive, isSafeEntryName, loadArchive, readArchive, sha256 } from './archive'

const doc = newProjectDoc({ name: 'Bracket', unitSystem: 'mm' })
const info = {
  projectId: 'project-1',
  appVersion: '0.0.8',
  savedAt: '2026-11-17T10:00:00.000Z',
  revision: 4,
}
const built = () => buildArchive(expectOk(docToFiles(doc)), info)

/** Re-zips the entries of an archive after `edit` (tampering in tests). */
function tamper(bytes: Uint8Array, edit: (e: Record<string, Uint8Array>) => void): Uint8Array {
  const entries = unzipSync(bytes)
  edit(entries)
  return zipSync(entries)
}

describe('sha256', () => {
  it('hashes bytes as lowercase hex', () => {
    expect(sha256(strToU8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('buildArchive', () => {
  it('writes the documents plus a manifest listing size and hash of each', () => {
    const a = built()
    const entries = unzipSync(a.bytes)
    expect(Object.keys(entries)).toEqual(['project.json', 'manifest.json'])
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']))
    const text = stableJson({ name: 'Bracket', unitSystem: 'mm' })
    expect(manifest).toEqual({
      format: 'dfyom-project',
      schemaVersion: 1,
      ...info,
      files: [{ path: 'project.json', size: text.length, sha256: sha256(strToU8(text)) }],
    })
    expect(a.manifest).toEqual(manifest)
    expect(a.sha256).toBe(sha256(a.bytes))
  })

  it('is deterministic for the same input', () => {
    expect(sha256(built().bytes)).toBe(sha256(built().bytes))
  })
})

describe('readArchive / loadArchive', () => {
  it('round-trips through the load pipeline', () => {
    const r = expectOk(loadArchive(built().bytes))
    expect(r.doc).toEqual(doc)
    expect(r.manifest.revision).toBe(4)
    expect(r.files.get('project.json')).toBe(stableJson(doc))
  })

  it('rejects data that is not a zip', () => {
    expectErrCode(readArchive(strToU8('not a zip')), 'input.malformed')
  })

  it('rejects a missing or malformed manifest', () => {
    const noManifest = tamper(built().bytes, (e) => delete e['manifest.json'])
    expectErrCode(readArchive(noManifest), 'input.malformed')
    const bad = tamper(built().bytes, (e) => (e['manifest.json'] = strToU8('{')))
    expectErrCode(readArchive(bad), 'input.malformed')
  })

  it('refuses a newer schemaVersion', () => {
    const newer = tamper(built().bytes, (e) => {
      const m = JSON.parse(new TextDecoder().decode(e['manifest.json']))
      e['manifest.json'] = strToU8(JSON.stringify({ ...m, schemaVersion: 2 }))
    })
    expectErrCode(readArchive(newer), 'persist.migration')
  })

  it('rejects a corrupt entry (hash mismatch)', () => {
    const corrupt = tamper(built().bytes, (e) => {
      e['project.json'] = strToU8(stableJson({ name: 'Brackex', unitSystem: 'mm' }))
    })
    const e = expectErrCode(readArchive(corrupt), 'input.malformed')
    expect(e.frames[0]?.data).toMatchObject({ path: 'project.json' })
  })

  it('rejects entries not in the manifest and manifest files missing from the zip', () => {
    const extra = tamper(built().bytes, (e) => (e['other.json'] = strToU8('{}')))
    expectErrCode(readArchive(extra), 'input.malformed')
    const missing = tamper(built().bytes, (e) => delete e['project.json'])
    expectErrCode(readArchive(missing), 'input.malformed')
  })

  it('rejects zip-slip entry names', () => {
    for (const name of ['../evil.json', '/etc/passwd', 'a/../../b', 'C:/x', 'a\\b', 'a//b']) {
      const evil = tamper(built().bytes, (e) => (e[name] = strToU8('{}')))
      const err = expectErrCode(readArchive(evil), 'input.malformed')
      expect(err.message, name).toMatch(/unsafe entry/)
    }
  })

  it('rejects an archive whose uncompressed size exceeds the limit', () => {
    expectErrCode(readArchive(built().bytes, { maxBytes: 10 }), 'input.malformed')
  })
})

describe('isSafeEntryName', () => {
  it('accepts relative forward-slash paths only', () => {
    expect(isSafeEntryName('parts/part-1.json')).toBe(true)
    for (const n of ['', '.', '..', './a', 'a/./b', 'a/', '\0a', 'c:x'])
      expect(isSafeEntryName(n), JSON.stringify(n)).toBe(false)
  })
})
