// The run journal file (hardening DF129, RC1): atomic, serialized saves where the latest wins, a
// crash mid-write leaving the previous journal, reading back (`running` → `appCrashed`, unreadable
// → discarded). Spec: docs/modes/run-recovery.md#implementation-rc1
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTestLogger } from '../../shared/testing/logger'
import { JOURNAL_FORMAT, type RunJournal } from '../../core/run/journal'
import { faultFs, testFs, useTempDir } from './fs.testing'
import { createRunJournalStore, loadRunJournal, RUN_JOURNAL_FILE, sha256 } from './run-journal'

const tmp = useTempDir()

const journal = (acknowledged: number, over: Partial<RunJournal> = {}): RunJournal => ({
  format: JOURNAL_FORMAT,
  state: 'running',
  startedAt: '2026-11-26T10:00:00.000Z',
  updatedAt: '2026-11-26T10:00:01.000Z',
  job: {
    jobId: 'job-1',
    kind: 'file',
    file: { name: 'lid.nc', path: '/tmp/lid.nc' },
    programHash: sha256('G21\nG1 X1 F100'),
    lines: 100,
    sections: [],
    toolChanges: [{ line: 3, n: 1, name: '6 mm flat end mill' }],
  },
  machine: {
    target: 'serial',
    port: { path: '/dev/cu.usbmodem1101', baud: 115_200 },
    machineKey: 'k',
  },
  workZero: { start: [-400, -200, -80], last: [-400, -200, -80] },
  progress: {
    sent: acknowledged + 10,
    acknowledged,
    executing: Math.max(0, acknowledged - 5),
    executingFrom: 'estimate',
    sentAt: '2026-11-26T10:00:01.000Z',
    acknowledgedAt: '2026-11-26T10:00:01.000Z',
    executingAt: '2026-11-26T10:00:01.000Z',
  },
  position: {
    modal: {
      motion: 1,
      units: 'mm',
      distance: 'absolute',
      feed: 600,
      spindle: 'cw',
      spindleSpeed: 18_000,
      toolWord: 1,
      plane: 17,
      coolant: { mist: false, flood: false },
    },
  },
  ...over,
})

describe('run journal', () => {
  it('saves atomically: temp file, fsync, rename, directory fsync', async () => {
    const fs = faultFs(() => undefined)
    const store = createRunJournalStore({ appData: tmp.dir, log: createTestLogger(), fs })
    store.save(journal(10))
    await store.flush()
    const file = join(tmp.dir, RUN_JOURNAL_FILE)
    expect(fs.calls).toEqual([
      `writeFile ${file}.tmp`,
      `fsync ${file}.tmp`,
      `rename ${file}.tmp`,
      `fsyncDir ${tmp.dir}`,
    ])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(journal(10))
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('saves one after another, the latest winning when saves queue up', async () => {
    const fs = faultFs(() => undefined)
    const store = createRunJournalStore({ appData: tmp.dir, log: createTestLogger(), fs })
    for (let i = 1; i <= 5; i++) store.save(journal(i))
    await store.flush()
    const writes = fs.calls.filter((c) => c.startsWith('writeFile'))
    expect(writes.length).toBeLessThanOrEqual(2)
    expect((await loadRunJournal(tmp.dir, createTestLogger(), testFs))?.progress.acknowledged).toBe(
      5,
    )
  })

  it('a crash at any step of a save leaves the previous complete journal', async () => {
    for (const op of ['writeFile', 'fsync', 'rename'] as const) {
      const log = createTestLogger()
      const first = createRunJournalStore({ appData: tmp.dir, log, fs: testFs })
      first.save(journal(10))
      await first.flush()
      const fs = faultFs((o) => (o === op ? 'crash' : undefined))
      const store = createRunJournalStore({ appData: tmp.dir, log, fs })
      store.save(journal(20))
      await store.flush()
      expect(fs.crashed).toBe(true)
      // the run goes on: one warning, no throw
      expect(log.at('warn').map((e) => e.msg)).toEqual(['run journal not saved'])
      const read = await loadRunJournal(tmp.dir, createTestLogger(), testFs)
      expect(read?.progress.acknowledged).toBe(10)
    }
  })

  it('a failing disk is logged once per run, not at every save', async () => {
    const log = createTestLogger()
    const fs = faultFs((o) => (o === 'writeFile' ? 'fail' : undefined))
    const store = createRunJournalStore({ appData: tmp.dir, log, fs })
    store.save(journal(1))
    await store.flush()
    store.save(journal(2))
    await store.flush()
    expect(log.at('warn')).toHaveLength(1)
  })

  it('reads a running journal as interrupted by an app crash; an ended one as it is', async () => {
    const log = createTestLogger()
    const file = join(tmp.dir, RUN_JOURNAL_FILE)
    expect(await loadRunJournal(tmp.dir, log, testFs)).toBeUndefined()
    await writeFile(file, JSON.stringify(journal(40)))
    expect(await loadRunJournal(tmp.dir, log, testFs)).toMatchObject({
      state: 'interrupted',
      reason: 'appCrashed',
      progress: { acknowledged: 40 },
    })
    await writeFile(file, JSON.stringify(journal(100, { state: 'done' })))
    expect((await loadRunJournal(tmp.dir, log, testFs))?.state).toBe('done')
    expect(log.at('warn')).toEqual([])
  })

  it('discards an unreadable journal (truncated, another format) with a warning', async () => {
    const file = join(tmp.dir, RUN_JOURNAL_FILE)
    for (const text of [JSON.stringify(journal(5)).slice(0, 40), '{"format":0}']) {
      const log = createTestLogger()
      await writeFile(file, text)
      expect(await loadRunJournal(tmp.dir, log, testFs)).toBeUndefined()
      expect(log.at('warn').map((e) => e.msg)).toEqual(['run journal invalid; discarded'])
      expect(await testFs.stat(file)).toBeUndefined()
    }
  })
})
