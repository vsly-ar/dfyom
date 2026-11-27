// The interrupted run found at launch (hardening DF129, RC6): a journal becomes the last run's
// record with `launch`; a run that itself started at a line maps back to the original program,
// with and without the kept copy; an ended run is nothing to recover.
// Spec: docs/modes/run-recovery.md#implementation-rc6
import { describe, expect, it } from 'vitest'
import { originalLine, streamedLine } from './interruption'
import { JOURNAL_FORMAT, type RunJournal } from './journal'
import { launchRecord, originalProgramHash } from './launch'

const original = [
  'G21 G90',
  'G0 Z5',
  'G0 X0 Y0',
  'G1 Z-1 F300',
  ...Array.from({ length: 20 }, (_, i) => `G1 X${i + 1} F600`),
  'G0 Z5',
  'G0 X0 Y5',
  'G1 Z-1 F300',
  ...Array.from({ length: 20 }, (_, i) => `G1 X${i + 1} F600`),
]

const journal = (
  over: Partial<RunJournal['job']> = {},
  progress = { executing: 15 },
): RunJournal => ({
  format: JOURNAL_FORMAT,
  state: 'interrupted',
  reason: 'appCrashed',
  startedAt: '2026-11-27T10:00:00.000Z',
  updatedAt: '2026-11-27T10:05:00.000Z',
  job: {
    jobId: 'job-r',
    kind: 'file',
    file: { name: 'lid.nc', path: '/w/lid.nc' },
    programHash: 'streamed',
    // started at line 27 (the second pass) behind a lead-in of 10 lines
    resumed: { programHash: 'original', fromLine: 27, leadIn: 10 },
    lines: 10 + original.length - 26,
    sections: [
      { fromLine: 1, label: 'Lead-in' },
      { fromLine: 11, label: 'Tool 1' },
    ],
    toolChanges: [],
    ...over,
  },
  machine: { target: 'virtual', machineKey: 'k' },
  workZero: { start: [-400, -300, -50], last: [-400, -300, -50] },
  progress: {
    sent: progress.executing + 8,
    acknowledged: progress.executing + 3,
    executing: progress.executing,
    executingFrom: 'estimate',
    sentAt: '2026-11-27T10:05:00.000Z',
    acknowledgedAt: '2026-11-27T10:05:00.000Z',
    executingAt: '2026-11-27T10:05:00.000Z',
  },
  position: {
    section: 'Tool 1',
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
})

describe('launchRecord (DF129 RC6)', () => {
  it('a run started at a line: lines mapped to the original program, its start suggested again', () => {
    const j = journal()
    expect(originalProgramHash(j)).toBe('original')
    const r = launchRecord({ journal: j, program: original, file: 'same' })!
    const i = r.lastRun.interruption!
    // streamed line 15 is original line 15 − 10 + 27 − 1 = 31
    expect(i).toMatchObject({
      reason: 'appCrashed',
      executing: 31,
      acknowledged: 34,
      sent: 39,
      lines: original.length,
      programHash: 'original',
      suggestion: { line: 27 },
      resumedRun: { fromLine: 27, leadIn: 10 },
      launch: { machine: { target: 'virtual' }, file: 'same', program: true },
    })
    expect(r.lastRun).toMatchObject({ jobId: 'job-r', file: { path: '/w/lid.nc' } })
    // the panel's program is the original: the lead-in's section dropped, the rest shifted back
    expect(r.program?.lines).toBe(original)
    expect(r.program?.sections).toEqual([{ fromLine: 27, label: 'Tool 1' }])
    expect(streamedLine(31, i.resumedRun)).toBe(15)
    expect(streamedLine(20, i.resumedRun)).toBeUndefined()
    expect(originalLine(15, { ...i.resumedRun!, lines: original })).toBe(31)
  })

  it('without the kept program: the facts and the mapping, no program; only a start line is known', () => {
    const r = launchRecord({ journal: journal(), file: 'changed' })!
    const i = r.lastRun.interruption!
    expect(i.executing).toBe(31)
    // the run's own start line is the one resume point known without the program
    expect(i.suggestion).toEqual({ line: 27, kind: 'pass' })
    expect(i.launch).toMatchObject({ file: 'changed', program: false })
    expect(r.program).toBeUndefined()
    // a run from the beginning keeps the journal's line count
    const { resumed: _resumed, ...job } = journal().job
    const plain: RunJournal = {
      ...journal(),
      job: { ...job, programHash: 'p', lines: 44, sections: [] },
    }
    const p = launchRecord({ journal: plain })!.lastRun.interruption!
    expect(p.suggestion).toBeUndefined()
    expect(p).toMatchObject({
      lines: 44,
      executing: 15,
      programHash: 'p',
      launch: { file: 'missing', program: false },
    })
  })

  it('an ended run is nothing to recover', () => {
    for (const state of ['done', 'stopped', 'failed'] as const)
      expect(launchRecord({ journal: { ...journal(), state }, program: original })).toBeUndefined()
  })
})
