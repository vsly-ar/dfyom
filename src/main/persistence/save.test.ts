import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { newProjectDoc } from '../../core/project/document'
import { docToFiles } from '../../core/project/layout'
import { noopLogger } from '../../shared/logging'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { buildArchive, loadArchive, sha256 } from './archive'
import { nodeFs, type PersistFs } from './fs'
import { faultFs, useTempDir } from './fs.testing'
import { addToHistory, writeVerifiedArchive } from './save'

const tmp = useTempDir()
const v1 = newProjectDoc({ name: 'Version 1', unitSystem: 'mm' })
const v2 = newProjectDoc({ name: 'Version 2', unitSystem: 'mm' })
const info = (revision: number) => ({
  projectId: 'project-1',
  appVersion: '0.0.8',
  savedAt: `2026-11-17T10:00:0${revision}.000Z`,
  revision,
})
const target = () => join(tmp.dir, 'docs', 'bracket.dfyom')

async function original(): Promise<Uint8Array> {
  const a = buildArchive(expectOk(docToFiles(v1)), info(1))
  await mkdir(join(tmp.dir, 'docs'), { recursive: true })
  await writeFile(target(), a.bytes)
  return a.bytes
}

const write = (fs: PersistFs) =>
  writeVerifiedArchive({
    fs,
    target: target(),
    files: expectOk(docToFiles(v2)),
    info: info(2),
    log: noopLogger,
  })

const siblings = async () => (await readdir(join(tmp.dir, 'docs'))).sort()

describe('writeVerifiedArchive', () => {
  it('replaces the target with a verified archive and leaves no temp file', async () => {
    await original()
    const built = expectOk(await write(nodeFs))
    const bytes = await readFile(target())
    expect(sha256(bytes)).toBe(built.sha256)
    expect(expectOk(loadArchive(bytes)).doc).toEqual(v2)
    expect(await siblings()).toEqual(['bracket.dfyom'])
  })

  it('creates a new target (Save As / first save)', async () => {
    await mkdir(join(tmp.dir, 'docs'))
    expectOk(await write(nodeFs))
    expect(expectOk(loadArchive(await readFile(target()))).doc).toEqual(v2)
  })

  it('builds the temp archive in the target directory, verifies it, then renames', async () => {
    await original()
    const fs = faultFs(() => undefined)
    expectOk(await write(fs))
    const steps = fs.calls.map((c) =>
      c.replace(/\.tmp-[0-9a-f]+/, '.tmp-X').replace(join(tmp.dir, 'docs'), 'D'),
    )
    expect(steps.slice(0, 5)).toEqual([
      'writeFile D/bracket.dfyom.tmp-X',
      'fsync D/bracket.dfyom.tmp-X',
      'readFile D/bracket.dfyom.tmp-X',
      'rename D/bracket.dfyom.tmp-X',
      'fsyncDir D',
    ])
  })

  it('a corrupt temp archive fails verification (persist.verify); the target is untouched', async () => {
    const before = await original()
    const corrupting: PersistFs = {
      ...nodeFs,
      writeFile: (p, d, o) =>
        nodeFs.writeFile(
          p,
          p.includes('.tmp-') && typeof d !== 'string'
            ? d.map((b, i) => (i === 40 ? b ^ 0xff : b))
            : d,
          o,
        ),
    }
    expectErrCode(await write(corrupting), 'persist.verify')
    expect(new Uint8Array(await readFile(target()))).toEqual(before)
    expect(await siblings()).toEqual(['bracket.dfyom'])
  })

  it('an I/O failure at any step before the rename keeps the target and removes the temp file', async () => {
    const before = await original()
    for (const op of ['writeFile', 'fsync', 'readFile', 'rename'] as const) {
      const fs = faultFs((o) => (o === op ? 'fail' : undefined))
      expectErrCode(await write(fs), 'persist.io')
      expect(new Uint8Array(await readFile(target())), op).toEqual(before)
      expect(await siblings(), op).toEqual(['bracket.dfyom'])
    }
  })

  it('a crash (kill) at any step leaves either the intact original or the complete new file', async () => {
    const before = await original()
    let crashes = 0
    for (let n = 1; ; n++) {
      const fs = faultFs((_op, _p, i) => (i === n ? 'crash' : undefined))
      const r = await write(fs)
      if (!fs.crashed) break
      crashes++
      const now = new Uint8Array(await readFile(target()))
      const loaded = expectOk(loadArchive(now))
      if (sha256(now) === sha256(before)) expect(loaded.doc).toEqual(v1)
      else expect(loaded.doc).toEqual(v2)
      // Killed before the rename completed: the call failed and the original is intact.
      const renamed = fs.calls.slice(0, n - 1).some((c) => c.startsWith('rename'))
      if (!renamed) {
        expect(r.isErr()).toBe(true)
        expect(now).toEqual(before)
      }
      await writeFile(target(), before)
    }
    expect(crashes).toBeGreaterThanOrEqual(4)
  })

  it('a later save removes temp files a crashed save left behind', async () => {
    await original()
    await writeFile(`${target()}.tmp-0123abcd`, 'half')
    await writeFile(join(tmp.dir, 'docs', 'other.dfyom.tmp-0123abcd'), 'not ours')
    expectOk(await write(nodeFs))
    expect(await siblings()).toEqual(['bracket.dfyom', 'other.dfyom.tmp-0123abcd'])
  })
})

describe('addToHistory', () => {
  it('copies an archive into saves/ unless a save with the same hash exists', async () => {
    await original()
    const saves = join(tmp.dir, 'saves')
    const bytes = await readFile(target())
    const a = expectOk(
      await addToHistory({
        fs: nodeFs,
        saves,
        source: target(),
        manifest: expectOk(loadArchive(bytes)).manifest,
        onlyIfNew: true,
      }),
    )
    expect(a.unwrap()).toBe('2026-11-17T10-00-01.000Z-r1.dfyom')
    const again = expectOk(
      await addToHistory({
        fs: nodeFs,
        saves,
        source: target(),
        manifest: expectOk(loadArchive(bytes)).manifest,
        onlyIfNew: true,
      }),
    )
    expect(again.isNone()).toBe(true)
    expect(await readdir(saves)).toEqual(['2026-11-17T10-00-01.000Z-r1.dfyom'])
    expect(sha256(await readFile(join(saves, a.unwrap())))).toBe(sha256(bytes))
  })
})
