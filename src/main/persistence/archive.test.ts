import { randomBytes } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { assetPathOf } from '../../core/project/assets'
import { newProjectDoc } from '../../core/project/document'
import { docToFiles, fileContent, stableJson } from '../../core/project/layout'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import {
  CHUNK_BYTES,
  isSafeEntryName,
  loadArchive as loadArchiveFile,
  readArchive as readArchiveFile,
  sha256,
  writeArchive,
} from './archive'
import {
  buildArchive,
  loadArchiveBytes as loadArchive,
  readArchiveBytes as readArchive,
} from './archive.testing'
import { nodeFs, type PersistFs } from './fs'
import { useTempDir } from './fs.testing'

/** `project.json` as written: the document without its record collections. */
const projectJson = (d: object) => fileContent(d, 'project.json').unwrap()

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
  it('hashes bytes as lowercase hex', async () => {
    expect(sha256(strToU8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('buildArchive', () => {
  it('writes the documents plus a manifest listing size and hash of each', async () => {
    const a = await built()
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

  it('is deterministic for the same input', async () => {
    expect(sha256((await built()).bytes)).toBe(sha256((await built()).bytes))
  })
})

describe('readArchive / loadArchive', () => {
  it('round-trips through the load pipeline', async () => {
    const r = expectOk(await loadArchive((await built()).bytes))
    expect(r.doc).toEqual(doc)
    expect(r.manifest.revision).toBe(4)
    expect(r.files.get('project.json')).toBe(projectJson(doc))
  })

  it('rejects data that is not a zip', async () => {
    expectErrCode(await readArchive(strToU8('not a zip')), 'input.malformed')
  })

  it('rejects a missing or malformed manifest', async () => {
    const noManifest = tamper((await built()).bytes, (e) => delete e['manifest.json'])
    expectErrCode(await readArchive(noManifest), 'input.malformed')
    const bad = tamper((await built()).bytes, (e) => (e['manifest.json'] = strToU8('{')))
    expectErrCode(await readArchive(bad), 'input.malformed')
  })

  it('refuses a newer schemaVersion', async () => {
    const newer = tamper((await built()).bytes, (e) => {
      const m = JSON.parse(new TextDecoder().decode(e['manifest.json']))
      e['manifest.json'] = strToU8(JSON.stringify({ ...m, schemaVersion: 2 }))
    })
    expectErrCode(await readArchive(newer), 'persist.migration')
  })

  it('rejects a corrupt entry (hash mismatch)', async () => {
    const corrupt = tamper((await built()).bytes, (e) => {
      e['project.json'] = strToU8(stableJson({ name: 'Brackex', unitSystem: 'mm' }))
    })
    const e = expectErrCode(await readArchive(corrupt), 'input.malformed')
    expect(e.frames[0]?.data).toMatchObject({ path: 'project.json' })
  })

  it('rejects entries not in the manifest and manifest files missing from the zip', async () => {
    const extra = tamper((await built()).bytes, (e) => (e['other.json'] = strToU8('{}')))
    expectErrCode(await readArchive(extra), 'input.malformed')
    const missing = tamper((await built()).bytes, (e) => delete e['project.json'])
    expectErrCode(await readArchive(missing), 'input.malformed')
  })

  it('rejects zip-slip entry names', async () => {
    for (const name of ['../evil.json', '/etc/passwd', 'a/../../b', 'C:/x', 'a\\b', 'a//b']) {
      const evil = tamper((await built()).bytes, (e) => (e[name] = strToU8('{}')))
      const err = expectErrCode(await readArchive(evil), 'input.malformed')
      expect(err.message, name).toMatch(/unsafe entry/)
    }
  })

  it('rejects an archive whose uncompressed size exceeds the limit', async () => {
    expectErrCode(await readArchive((await built()).bytes, { maxBytes: 10 }), 'input.malformed')
  })
})

describe('isSafeEntryName', () => {
  it('accepts relative forward-slash paths only', async () => {
    expect(isSafeEntryName('parts/part-1.json')).toBe(true)
    for (const n of ['', '.', '..', './a', 'a/./b', 'a/', '\0a', 'c:x'])
      expect(isSafeEntryName(n), JSON.stringify(n)).toBe(false)
  })
})

describe('assets (streamed)', () => {
  const tmp = useTempDir()
  const files = () => expectOk(docToFiles(doc))

  /** An asset file in the temp dir, named by its hash like in `work/assets/`. */
  async function asset(bytes: Uint8Array) {
    const path = assetPathOf(sha256(bytes), 'stl')
    const source = join(tmp.dir, sha256(bytes))
    await writeFile(source, bytes)
    return { path, source }
  }

  /** Records every call and the largest chunk read or appended. */
  function watched(): PersistFs & { readonly calls: string[]; readonly maxChunk: () => number } {
    const calls: string[] = []
    let max = 0
    return {
      ...nodeFs,
      calls,
      maxChunk: () => max,
      readFile: (p) => {
        calls.push(`readFile ${p}`)
        return nodeFs.readFile(p)
      },
      readRange: async (p, o, l) => {
        const r = await nodeFs.readRange(p, o, l)
        max = Math.max(max, r.length)
        return r
      },
      appendFile: (p, d) => {
        max = Math.max(max, d.length)
        return nodeFs.appendFile(p, d)
      },
    }
  }

  it('lists each asset in the manifest (path, size, sha256), deflated after the documents', async () => {
    const stl = strToU8('solid x\nendsolid x\n'.repeat(100))
    const a = await asset(stl)
    const built = await buildArchive(files(), info, [a])
    expect(Object.keys(unzipSync(built.bytes))).toEqual(['project.json', a.path, 'manifest.json'])
    expect(built.manifest.files).toContainEqual({
      path: a.path,
      size: stl.length,
      sha256: sha256(stl),
    })
    expect(built.bytes.length).toBeLessThan(stl.length)
    const read = expectOk(await readArchive(built.bytes))
    expect([...read.files.keys()]).toEqual(['project.json'])
    expect(read.sha256).toBe(built.sha256)
  })

  it('a large asset streams through write, verify and unpack in chunks, never whole', async () => {
    const big = new Uint8Array(randomBytes(5 * CHUNK_BYTES + 123))
    const a = await asset(big)
    const fs = watched()
    const archive = join(tmp.dir, 'big.dfyom')
    const w = expectOk(await writeArchive(fs, archive, files(), [a], info))
    expect(w.size).toBeGreaterThan(big.length)
    const out = join(tmp.dir, 'out')
    const r = expectOk(
      await loadArchiveFile(fs, archive, { extract: { dir: out, want: () => true } }),
    )
    expect(r.doc).toEqual(doc)
    expect(r.sha256).toBe(w.sha256)
    expect(sha256(await readFile(join(out, a.path)))).toBe(sha256(big))
    expect(fs.calls).toEqual([]) // no whole-file reads
    // Inflated pieces can exceed a read chunk slightly; nothing near the file size is held.
    expect(fs.maxChunk()).toBeLessThan(2 * CHUNK_BYTES)
  })

  it('extracts only the assets `want` accepts; others are verified but not written', async () => {
    const a = await asset(strToU8('a'))
    const b = await asset(strToU8('b'))
    const built = await buildArchive(files(), info, [a, b])
    const out = join(tmp.dir, 'out')
    expectOk(await readArchive(built.bytes, { extract: { dir: out, want: (p) => p === b.path } }))
    expect(await readdir(join(out, 'assets'))).toEqual([b.path.slice('assets/'.length)])
  })

  it('rejects an asset whose content does not match its name', async () => {
    const a = await asset(strToU8('original'))
    await writeFile(a.source, 'changed')
    const built = await buildArchive(files(), info, [a])
    const e = expectErrCode(await readArchive(built.bytes), 'input.malformed')
    expect(e.message).toMatch(/asset hash does not match its name/)
  })

  it('rejects any other file in assets/', async () => {
    const a = await asset(strToU8('x'))
    const good = (await buildArchive(files(), info, [a])).bytes
    for (const name of ['assets/readme.txt', `assets/${'A'.repeat(64)}.stl`, 'assets/x/y.stl']) {
      const evil = tamper(good, (e) => (e[name] = strToU8('x')))
      const err = expectErrCode(await readArchive(evil), 'input.malformed')
      expect(err.message, name).toMatch(/unexpected file in assets/)
    }
  })

  it('counts the assets zip-bomb guards (per asset, all assets) while inflating', async () => {
    const a = await asset(new Uint8Array(4 * CHUNK_BYTES))
    const built = await buildArchive(files(), info, [a])
    expect(built.bytes.length).toBeLessThan(CHUNK_BYTES)
    const one = expectErrCode(
      await readArchive(built.bytes, { maxAssetBytes: 2 * CHUNK_BYTES }),
      'input.malformed',
    )
    expect(one.message).toMatch(/asset is too large/)
    const all = expectErrCode(
      await readArchive(built.bytes, { maxAssetsBytes: 2 * CHUNK_BYTES }),
      'input.malformed',
    )
    expect(all.message).toMatch(/assets are too large/)
    // assets do not count toward the documents' guard
    expectOk(await readArchive(built.bytes, { maxBytes: 2 * CHUNK_BYTES }))
  })

  it('a record naming an asset the archive lacks does not load', async () => {
    const stl = strToU8('solid a')
    const a = await asset(stl)
    const q = (kind: string, unit: string) => ({
      kind,
      source: '0',
      defaultUnit: unit,
      exact: { num: '0', den: '1' },
    })
    const withRef = {
      ...doc,
      references: {
        r1: {
          id: 'r1',
          partId: 'part-1',
          name: 'A',
          asset: {
            path: a.path,
            sha256: sha256(stl),
            format: 'stl',
            triangles: 0,
            bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
          },
          sourceUnit: 'mm',
          scale: q('scalar', '1'),
          rotation: { x: q('angle', 'deg'), y: q('angle', 'deg'), z: q('angle', 'deg') },
          position: { x: q('length', 'mm'), y: q('length', 'mm'), z: q('length', 'mm') },
        },
      },
    }
    const docs = expectOk(docToFiles(withRef))
    expectOk(await loadArchive((await buildArchive(docs, info, [a])).bytes))
    const e = expectErrCode(
      await loadArchive((await buildArchive(docs, info)).bytes),
      'input.malformed',
    )
    expect(e.message).toMatch(/referenced asset is missing/)
  })

  it('reads a file larger than one chunk that is not a zip as malformed', async () => {
    const path = join(tmp.dir, 'noise.dfyom')
    await writeFile(path, randomBytes(CHUNK_BYTES + 5))
    expectErrCode(await readArchiveFile(nodeFs, path), 'input.malformed')
  })
})
