// Spec: docs/architecture/grbl.md#plan-export-command, docs/architecture/workers.md#toolpath-cache
import { describe, expect, it } from 'vitest'
import { fail, Ok, type AsyncAppResult } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import type { Services } from '../commands/context'
import { createDispatcher } from '../commands/dispatcher'
import { createInProcessWorkers, type WorkerPort } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { fakeIds, uiSource } from '../commands/testing'
import { planSetup, type PlanSetup } from '../plan/plan.fixture'
import { createToolpathCache, type ToolpathCache } from '../toolpath/cache'
import type { Toolpath } from '../toolpath/model'
import type { GeneratorRequest } from '../toolpath/request'
import { exportPlan, SOFT_LIMIT_NOTE, type ExportFiles, type PlanExport } from './plan-export'

const ui = uiSource()

/** A port that counts runs; `hook` may replace a run's result. */
function countingPort(hook?: (request: GeneratorRequest) => unknown) {
  const inner = createInProcessWorkers()
  const runs: string[] = []
  const port: WorkerPort = {
    async run(task, input, ctl) {
      const request = input as GeneratorRequest
      runs.push(request.inputs[0]!.planOperationId)
      const replaced = await hook?.(request)
      if (replaced !== undefined) return replaced as never
      return inner.run(task, input, ctl)
    },
  }
  return { port, runs }
}

/** Records writes; `error` makes every write fail. */
function memoryFiles(error?: () => AsyncAppResult<{ filePath: string }>) {
  const written: { target: string; text: string; confirm: boolean }[] = []
  const files: ExportFiles = {
    write(target, text, opts) {
      if (error !== undefined) return error()
      written.push({ target, text, confirm: opts.confirm })
      return Promise.resolve(Ok({ filePath: target }))
    },
  }
  return { files, written }
}

interface Setup {
  s: PlanSetup
  planId: string
  order: string[]
  runs: string[]
  written: ReturnType<typeof memoryFiles>['written']
  cache: ToolpathCache
  d: ReturnType<typeof createDispatcher>
  exportCmd(args?: object): AsyncAppResult<unknown>
  generate(): Promise<void>
}

type Result = Omit<PlanExport, 'program' | 'lines' | 'text'> & {
  filePath: string
  lines: number
  softLimitNote?: string
}

async function setup(
  opts: {
    hook?: (request: GeneratorRequest) => unknown
    services?: Partial<Services>
    machine?: boolean
    part?: boolean
    port?: WorkerPort
    writeError?: () => AsyncAppResult<{ filePath: string }>
  } = {},
): Promise<Setup> {
  const s = await planSetup(opts.part === false ? { part: false } : {})
  const planId = await s.create(opts.machine === false ? {} : { machineLibraryItemId: s.machineId })
  const ops = s.plan(planId).setups[0]!.operations
  for (const op of ops.filter((o) => o.tool === ops[1]!.tool))
    await s.run('plan.operation.update', {
      planId,
      planOperationId: op.id,
      overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
    })
  const counting = countingPort(opts.hook)
  const port = opts.port ?? counting.port
  const runs = counting.runs
  const { files, written } = memoryFiles(opts.writeError)
  const cache = createToolpathCache()
  const d = createDispatcher({
    registry: expectOk(createAppRegistry()),
    doc: s.d.doc,
    revision: s.d.revision,
    ids: fakeIds(),
    services: {
      workers: port,
      library: s.library,
      toolpaths: cache,
      exportFiles: files,
      ...opts.services,
    },
  })
  return {
    s,
    planId,
    order: ops.map((o) => o.id),
    runs,
    written,
    cache,
    d,
    exportCmd: async (args = {}) =>
      (await d.dispatch('plan.export', { planId, target: '/out/plan.nc', ...args }, ui)).map(
        (o) => o.value,
      ),
    async generate() {
      const { jobId } = expectOk(await d.dispatch('plan.toolpath.generate', { planId }, ui))
        .value as { jobId: string }
      expectOk(await d.job(jobId).unwrap().result)
    },
  }
}

describe('plan.export', () => {
  it('regenerates missing toolpaths, writes the program and reports stats and warnings', async () => {
    const t = await setup()
    const r = expectOk(await t.exportCmd()) as Result
    expect(t.runs).toEqual(t.order)
    expect(r.regenerated).toEqual(t.order)
    expect(r.filePath).toBe('/out/plan.nc')
    expect(r.softLimitChecked).toBe(false)
    // DF58: without the check the result says how to check
    expect(r.softLimitNote).toBe(SOFT_LIMIT_NOTE)
    expect(r.softLimitNote).toContain('run.job.check')
    expect(Array.isArray(r.warnings)).toBe(true)
    expect(r.stats.cutLength).toBeGreaterThan(0)
    expect(r.stats.toolChanges).toBeGreaterThan(0)
    expect(t.written).toHaveLength(1)
    const { text, confirm } = t.written[0]!
    expect(confirm).toBe(false)
    expect(text.endsWith('M30\n')).toBe(true)
    expect(r.lines).toBe(text.split('\n').length - 1)
    // the plan's name, its setup, its tool copies' names and the operations' names
    const plan = t.s.plan(t.planId)
    expect(text).toContain(`(Program: ${plan.name})`)
    expect(text).toContain(`(Setup 1 of 1: ${plan.setups[0]!.name})`)
    // DF58: the setup instructions (an unrotated top setup)
    expect(text).toContain('(Faces: top up, front towards you, right on the right)')
    expect(text).toContain('(Work zero G54 X0 Y0: front-left corner of the top face)')
    expect(text).toContain('(Z0 on the top face: the stock surface facing up)')
    expect(text).toMatch(/^\(Stock X \d+ Y \d+ Z \d+ mm on the machine\)$/m)
    // DF59: the test part's facing overshoots the stock on every side
    expect(text).toMatch(
      /^\(Tool reaches past stock: left [\d.]+, right [\d.]+, front [\d.]+, back [\d.]+ mm\)$/m,
    )
    expect(text).toContain('(Keep clamps clear of those sides, below clearance Z 10 mm)')
    const toolNames = plan.snapshots.filter((c) => c.kind === 'tool').map((c) => c.values.name)
    for (const name of toolNames) expect(text).toContain(name)
    const design = plan.design.part.operations
    for (const op of plan.setups[0]!.operations)
      for (const id of op.designOperationIds)
        expect(text).toContain(design.find((o) => o.id === id)!.name)
    // the regenerated toolpaths are cached: plan.toolpath.get serves them as current
    const got = expectOk(
      t.d.query('plan.toolpath.get', { planId: t.planId, planOperationId: t.order[0] }, ui),
    ).value as { stale: boolean }
    expect(got.stale).toBe(false)
  })

  it('uses cached toolpaths and regenerates only stale ones', async () => {
    const t = await setup()
    await t.generate()
    expect(t.runs).toEqual(t.order)
    const r = expectOk(await t.exportCmd()) as Result
    expect(r.regenerated).toEqual([])
    expect(t.runs).toHaveLength(t.order.length)
    // an edit of the last operation makes only it stale (the hash chains forward)
    const last = t.order.at(-1)!
    expectOk(
      await t.d.dispatch(
        'plan.operation.update',
        { planId: t.planId, planOperationId: last, overrides: { spindleSpeed: '9000' } },
        ui,
      ),
    )
    const again = expectOk(await t.exportCmd({ confirm: true })) as Result
    expect(again.regenerated).toEqual([last])
    expect(t.written.map((w) => w.confirm)).toEqual([false, true])
  })

  it('fails with the generator error (naming the operation) and writes nothing', async () => {
    let failId = ''
    const t = await setup({
      hook: (req) =>
        req.inputs[0]!.planOperationId === failId
          ? fail('plan.check', 'tool does not fit', { where: 'test' })
          : undefined,
    })
    failId = t.order[1]!
    const e = expectErrCode(await t.exportCmd(), 'plan.check')
    expect(e.frames.some((f) => f.data?.['planOperationId'] === failId)).toBe(true)
    expect(t.written).toEqual([])
    // the toolpath before it was generated and stays cached
    expect(t.cache.last(t.planId, t.order[0]!)).toBeDefined()
  })

  it('fails without a machine copy before any generator runs', async () => {
    const t = await setup({ machine: false })
    expectErrCode(await t.exportCmd(), 'post.noMachine')
    expect(t.runs).toEqual([])
    expect(t.written).toEqual([])
  })

  it('exports in every status but archived', async () => {
    const t = await setup()
    const status = async (to?: string) =>
      expectOk(
        await t.d.dispatch(
          'plan.status.set',
          to === undefined ? { planId: t.planId } : { planId: t.planId, status: to },
          ui,
        ),
      )
    const ok = async () => expectOk(await t.exportCmd({ confirm: true }))
    await ok() // draft
    for (const to of ['settledDesign', 'finalized', 'inUse']) {
      await status(to)
      await ok()
    }
    await status('archived')
    expectErrCode(await t.exportCmd({ confirm: true }), 'plan.status')
    await status() // un-archive: back to inUse
    await ok()
  })

  it('rejects a target without a gCode file name and unknown plans', async () => {
    const t = await setup()
    for (const target of ['/out/plan.txt', '/o/.nc', '/o/a.nc.txt', 'C:\\o\\.gcode', '/out/a.nc/x'])
      expect(
        expectErrCode(await t.exportCmd({ target }), 'input.malformed').issues[0]?.path,
        target,
      ).toEqual(['target'])
    // a well-formed id that does not exist reaches the plan lookup
    const e = expectErrCode(await t.exportCmd({ planId: 'plan-missing' }), 'input.malformed')
    expect(e.issues[0]?.rule).toBe('unknownPlan')
    for (const target of ['/out/a.NC', '/out/a.gcode', '/out/a.ngc', 'C:\\o\\b.nc'])
      expectOk(await t.exportCmd({ target, confirm: true }))
  })

  // docs/architecture/grbl.md#file-name-hardening-df62
  it('a folder target (ending in / or \\) writes the short suggested file name', async () => {
    const t = await setup()
    const r = expectOk(await t.exportCmd({ target: '/out/', confirm: true })) as Result
    expect(r.filePath).toBe('/out/bracket.nc')
    expectOk(await t.exportCmd({ target: 'C:\\out\\', confirm: true }))
    expect(t.written.map((w) => w.target)).toEqual(['/out/bracket.nc', 'C:\\out\\bracket.nc'])
  })

  it('changes neither the revision nor the undo history', async () => {
    const t = await setup()
    const before = { revision: t.d.revision, history: t.d.history, doc: t.d.doc }
    expectOk(await t.exportCmd())
    expect(t.d.revision).toBe(before.revision)
    expect(t.d.doc).toBe(before.doc)
    expect(t.d.history.undoable).toEqual(before.history.undoable)
    expect(t.d.history.redoable).toEqual(before.history.redoable)
  })

  it('fails a plan without operations with plan.check (rule empty) before writing', async () => {
    const t = await setup({ part: false })
    expect(t.order).toEqual([])
    const e = expectErrCode(await t.exportCmd(), 'plan.check')
    expect(e.issues[0]).toMatchObject({ rule: 'empty' })
    expect(e.frames.some((f) => f.data?.['planId'] === t.planId)).toBe(true)
    expect(t.written).toEqual([])
  })

  it('post-stage errors carry the plan.export context with the plan id', async () => {
    // a generator result the post cannot write (a non-finite feed)
    const inner = createInProcessWorkers()
    const port: WorkerPort = {
      async run(task, input, ctl) {
        const r = await inner.run(task, input, ctl)
        return r.map((tp) => {
          const t = tp as Toolpath
          const moves = t.passes[0]!.moves.map((m) =>
            m.kind === 'line' ? { ...m, feed: Number.NaN } : m,
          )
          return { ...t, passes: [{ ...t.passes[0]!, moves }, ...t.passes.slice(1)] }
        }) as never
      },
    }
    const t = await setup({ port })
    const e = expectErrCode(await t.exportCmd(), 'model.invariant')
    expect(e.frames.some((f) => f.where === 'plan.export' && f.data?.['planId'] === t.planId)).toBe(
      true,
    )
    expect(t.written).toEqual([])
  })

  it('passes a write failure through', async () => {
    const t = await setup({
      writeError: () => Promise.resolve(fail('persist.io', 'disk full', { where: 'test' })),
    })
    const e = expectErrCode(await t.exportCmd(), 'persist.io')
    expect(e.frames.some((f) => f.where === 'plan.export' && f.data?.['planId'] === t.planId)).toBe(
      true,
    )
  })

  it('fails with internal.unexpected without a file writer or a toolpath cache', async () => {
    const a = await setup({ services: { exportFiles: undefined } as never })
    expectErrCode(await a.exportCmd(), 'internal.unexpected')
    const b = await setup({ services: { toolpaths: undefined } as never })
    expectErrCode(await b.exportCmd(), 'internal.unexpected')
  })
})

describe('exportPlan (the path run mode shares)', () => {
  it('runs the soft-limit check only with a work zero', async () => {
    const t = await setup()
    const services = { workers: createInProcessWorkers(), toolpaths: t.cache }
    const without = expectOk(await exportPlan(t.d.doc, t.planId, services))
    expect(without.softLimitChecked).toBe(false)
    expect(without.warnings.some((w) => w.rule === 'softLimit')).toBe(false)
    // a work zero at machine zero puts the whole program above the travel (MPos ≤ 0)
    const off = expectOk(await exportPlan(t.d.doc, t.planId, services, { workZero: [0, 0, 0] }))
    expect(off.softLimitChecked).toBe(true)
    expect(off.warnings.some((w) => w.rule === 'softLimit')).toBe(true)
    // the same program either way; nothing regenerated the second time
    expect(off.text).toBe(without.text)
    expect(off.regenerated).toEqual([])
    expect(without.lines.length).toBeGreaterThan(0)
  })

  it('reports progress per plan operation and stops on an aborted signal', async () => {
    const t = await setup()
    const services = { workers: createInProcessWorkers(), toolpaths: t.cache }
    const labels: string[] = []
    expectOk(
      await exportPlan(t.d.doc, t.planId, services, {
        progress: (p) => labels.push(p.label ?? ''),
      }),
    )
    expect(labels.length).toBeGreaterThanOrEqual(t.order.length)
    // DF43: progress names the operations ("Export: Pocket 1" in Run), never their ids
    const ids = Object.values(t.d.doc.plans)[0]!.setups.flatMap((s) =>
      s.operations.map((o) => o.id),
    )
    for (const label of labels) for (const id of ids) expect(label).not.toContain(id)
    const names = Object.values(t.d.doc.parts)[0]!.operations.map((o) => o.name)
    expect(labels.some((l) => names.some((n) => l.startsWith(n)))).toBe(true)
    const ac = new AbortController()
    ac.abort()
    expectErrCode(
      await exportPlan(
        t.d.doc,
        t.planId,
        { ...services, toolpaths: createToolpathCache() },
        {
          signal: ac.signal,
        },
      ),
      'op.aborted',
    )
  })
})
