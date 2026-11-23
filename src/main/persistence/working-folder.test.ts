import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { newProjectDoc } from '../../core/project/document'
import { docToFiles, fileContent, type ProjectLayout } from '../../core/project/layout'
import { noopLogger } from '../../shared/logging'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { faultFs, testFs, useTempDir } from './fs.testing'
import { projectPaths } from './paths'
import { readState, readWork, unpack, WorkingFolder, type ProjectState } from './working-folder'

/** `project.json` as written: the document without its record collections. */
const projectJson = (d: object) => fileContent(d, 'project.json').unwrap()

const tmp = useTempDir()
const doc = newProjectDoc({ name: 'Bracket', unitSystem: 'mm' })
const state: ProjectState = {
  schemaVersion: 1,
  projectId: 'project-1',
  filePath: '/x/a.dfyom',
  dirty: false,
  workingRevision: 3,
  savedRevision: 3,
  savedSha256: 'a'.repeat(64),
}
const withParts: ProjectLayout = { collections: ['parts'] }
const partsDoc = { name: 'P', unitSystem: 'mm', parts: { 'part-1': { id: 'part-1' } } }

const paths = () => projectPaths(tmp.dir, 'project-1')
const read = (p: string) => readFile(p, 'utf8')

describe('unpack / readWork / readState', () => {
  it('writes the documents into a fresh work/ and state.json last', async () => {
    const fs = faultFs(() => undefined)
    expectOk(await unpack(fs, paths(), expectOk(docToFiles(doc)), state))
    expect(await read(join(paths().work, 'project.json'))).toBe(projectJson(doc))
    expect(JSON.parse(await read(paths().state))).toEqual(state)
    expect(fs.calls.at(-4)).toMatch(/^writeFile .*state\.json\.tmp$/)
    expect(expectOk(await readWork(testFs, paths())).get('project.json')).toBe(projectJson(doc))
    expect(expectOk(await readState(testFs, paths())).unwrap()).toEqual(state)
  })

  it('replaces an existing work/ and leaves no temp folders', async () => {
    await mkdir(paths().work, { recursive: true })
    await writeFile(join(paths().work, 'old.json'), '{}')
    expectOk(await unpack(testFs, paths(), expectOk(docToFiles(doc)), state))
    expect(await readdir(paths().work)).toEqual(['project.json'])
    expect((await readdir(paths().folder)).sort()).toEqual(['state.json', 'work'])
  })

  it('a crash while unpacking leaves the previous work/ and state intact', async () => {
    expectOk(await unpack(testFs, paths(), expectOk(docToFiles(doc)), state))
    const other = newProjectDoc({ name: 'Other', unitSystem: 'inch' })
    for (let n = 1; ; n++) {
      const fs = faultFs((op, _p, i) => (i === n && op !== 'readdir' ? 'crash' : undefined))
      const r = await unpack(fs, paths(), expectOk(docToFiles(other)), {
        ...state,
        workingRevision: 9,
      })
      if (!fs.crashed) break
      expect(r.isErr()).toBe(true)
      const st = expectOk(await readState(testFs, paths())).unwrap()
      const work = await readWork(testFs, paths())
      // Either the old pair is intact, or the new work/ is in place but state is not yet
      // updated (not dirty, so the next open unpacks again) – never a dirty, broken mix.
      expect(st.dirty).toBe(false)
      if (work.isOk() && st.workingRevision === 3)
        expect([projectJson(doc), projectJson(other)]).toContain(work.unwrap().get('project.json'))
    }
  })

  it('readWork ignores leftover *.tmp files and finds collection records', async () => {
    const files = expectOk(docToFiles(partsDoc, withParts))
    expectOk(await unpack(testFs, paths(), files, state))
    await writeFile(join(paths().work, 'project.json.tmp'), 'half')
    const work = expectOk(await readWork(testFs, paths()))
    expect([...work.keys()].sort()).toEqual(['parts/part-1.json', 'project.json'])
  })

  it('readState: None when missing, persist.migration when newer', async () => {
    expect(expectOk(await readState(testFs, paths())).isNone()).toBe(true)
    await mkdir(paths().folder, { recursive: true })
    await writeFile(paths().state, JSON.stringify({ ...state, schemaVersion: 2 }))
    expectErrCode(await readState(testFs, paths()), 'persist.migration')
    await writeFile(paths().state, '{')
    expectErrCode(await readState(testFs, paths()), 'input.malformed')
  })
})

describe('WorkingFolder', () => {
  const open = async (fs = testFs, layout?: ProjectLayout, start: object = doc) => {
    expectOk(await unpack(testFs, paths(), expectOk(docToFiles(start, layout)), state))
    return new WorkingFolder({
      fs,
      paths: paths(),
      state,
      files: expectOk(docToFiles(start, layout)),
      log: noopLogger,
      debounceMs: 10_000,
      ...(layout === undefined ? {} : { layout }),
    })
  }

  it('flush writes the changed records, then state.json with dirty and the revision', async () => {
    const wf = await open()
    const next = newProjectDoc({ name: 'Renamed', unitSystem: 'mm' })
    wf.changed([{ op: 'replace', path: ['name'], value: 'Renamed' }], next, 4)
    expectOk(await wf.flush())
    expect(await read(join(paths().work, 'project.json'))).toBe(projectJson(next))
    expect(JSON.parse(await read(paths().state))).toMatchObject({ dirty: true, workingRevision: 4 })
    expect(wf.state.dirty).toBe(true)
  })

  it('deletes the file of a removed record and writes added ones', async () => {
    const wf = await open(testFs, withParts, partsDoc)
    const next = { ...partsDoc, parts: { 'part-2': { id: 'part-2' } } }
    wf.changed(
      [
        { op: 'remove', path: ['parts', 'part-1'] },
        { op: 'add', path: ['parts', 'part-2'], value: { id: 'part-2' } },
      ],
      next as never,
      4,
    )
    expectOk(await wf.flush())
    expect((await readdir(join(paths().work, 'parts'))).sort()).toEqual(['part-2.json'])
  })

  it('debounces: writes after the delay without an explicit flush', async () => {
    expectOk(await unpack(testFs, paths(), expectOk(docToFiles(doc)), state))
    const wf = new WorkingFolder({
      fs: testFs,
      paths: paths(),
      state,
      files: expectOk(docToFiles(doc)),
      log: noopLogger,
      debounceMs: 5,
    })
    const next = newProjectDoc({ name: 'Later', unitSystem: 'mm' })
    wf.changed([{ op: 'replace', path: ['name'], value: 'Later' }], next, 4)
    await vi.waitFor(async () =>
      expect(JSON.parse(await read(paths().state))).toMatchObject({ workingRevision: 4 }),
    )
    expect(await read(join(paths().work, 'project.json'))).toBe(projectJson(next))
  })

  it('a failed write is reported as a warning, keeps the old file and is retried by the next flush', async () => {
    let failing = true
    const fs = faultFs((op) => (failing && op === 'rename' ? 'fail' : undefined))
    const warnings: string[] = []
    expectOk(await unpack(testFs, paths(), expectOk(docToFiles(doc)), state))
    const wf = new WorkingFolder({
      fs,
      paths: paths(),
      state,
      files: expectOk(docToFiles(doc)),
      log: noopLogger,
      debounceMs: 10_000,
      onWarning: (w) => warnings.push(w),
    })
    const next = newProjectDoc({ name: 'Renamed', unitSystem: 'mm' })
    wf.changed([{ op: 'replace', path: ['name'], value: 'Renamed' }], next, 4)
    expectErrCode(await wf.flush(), 'persist.io')
    expect(warnings).toEqual(['unsaved changes are not protected'])
    expect(await read(join(paths().work, 'project.json'))).toBe(projectJson(doc))
    expect(JSON.parse(await read(paths().state))).toMatchObject({ dirty: false })
    failing = false
    expectOk(await wf.flush())
    expect(await read(join(paths().work, 'project.json'))).toBe(projectJson(next))
  })

  it('a crash at any step of a flush leaves every work/ file complete (old or new)', async () => {
    const next = newProjectDoc({ name: 'Renamed', unitSystem: 'mm' })
    for (let n = 1; ; n++) {
      const fs = faultFs((_op, _p, i) => (i === n ? 'crash' : undefined))
      const wf = await open(fs)
      wf.changed([{ op: 'replace', path: ['name'], value: 'Renamed' }], next, 4)
      await wf.flush()
      const work = expectOk(await readWork(testFs, paths()))
      expect([projectJson(doc), projectJson(next)]).toContain(work.get('project.json'))
      const st = expectOk(await readState(testFs, paths())).unwrap()
      // state.json is written last: dirty only once the documents are on disk.
      if (st.dirty) expect(work.get('project.json')).toBe(projectJson(next))
      if (!fs.crashed) break
    }
  })
})
