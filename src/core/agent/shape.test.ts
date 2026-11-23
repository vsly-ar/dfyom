// Result shaping at the agent boundary: compact quantities and numbers, DFM warnings as changes,
// the plan.get and plan.toolpath.get summaries and move ranges, the reserved detail args.
// Spec: docs/architecture/llm-api.md#result-size
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { fail, Ok, type AppResult } from '../../shared/result'
import { Warnings } from '../design/commands'
import { CLONES_QUERIES } from '../design/clones/commands'
import { compact, ResultShaper, splitDetail, type ShaperSession, type View } from './shape'
import type { SessionCallResult } from './session'

const q = (source: string, num: string, den = '1', kind = 'length', defaultUnit = 'mm') => ({
  kind,
  source,
  defaultUnit,
  exact: { num, den },
})

describe('compact values', () => {
  it('a literal in the canonical unit is the plain number, anything else { source, value }', () => {
    expect(compact(q('249.748', '62437', '250'))).toBe(249.748)
    expect(compact(q('6 mm', '6'))).toBe(6)
    expect(compact(q('118°', '118', '1', 'angle', 'deg'))).toBe(118)
    expect(compact(q('1/4"', '127', '20'))).toEqual({ source: '1/4"', value: 6.35 })
    expect(compact(q('D/2', '3'))).toEqual({ source: 'D/2', value: 3 })
    expect(compact(q('50%', '1', '2', 'scalar', '%'))).toEqual({ source: '50%', value: 0.5 })
    expect(compact(q('4', '4', '1', 'scalar', '1'))).toBe(4)
    expect(
      compact({
        ...q('10 ±0.05', '10'),
        tolerance: {
          notation: 'symmetric',
          upper: { num: '1', den: '20' },
          lower: { num: '-1', den: '20' },
        },
      }),
    ).toEqual({ source: '10 ±0.05', value: 10, tolerance: { upper: 0.05, lower: -0.05 } })
  })

  it('rounds float noise to 10 significant digits, recursively, without changing the input', () => {
    const input = { a: [2.4000000000000004, { b: 4.800000000000001, c: 3 }], d: 'x' }
    expect(compact(input)).toEqual({ a: [2.4, { b: 4.8, c: 3 }], d: 'x' })
    expect(input.a[0]).toBe(2.4000000000000004)
  })

  it('leaves objects that only look like quantities', () => {
    const notQ = {
      kind: 'length',
      source: '1',
      defaultUnit: 'mm',
      exact: { num: '1', den: '1' },
      x: 1,
    }
    expect(compact(notQ)).toEqual(notQ)
  })
})

describe('reserved detail args', () => {
  it('are removed for the summarized reads, with defaults', () => {
    expect(expectOk(splitDetail('plan.get', { planId: 'p' }))).toEqual({
      args: { planId: 'p' },
      view: { detail: 'summary', from: 0, count: 500 },
    })
    expect(
      expectOk(
        splitDetail('plan.toolpath.get', { planId: 'p', detail: 'full', from: 10, count: 20 }),
      ),
    ).toEqual({
      args: { planId: 'p' },
      view: { detail: 'full', from: 10, count: 20 },
    })
  })

  it('stay in the args of other tools (refused there as unknown) and are checked', () => {
    expect(expectOk(splitDetail('design.part.get', { partId: 'x', detail: 'full' })).args).toEqual({
      partId: 'x',
      detail: 'full',
    })
    // `from` is not reserved on plan.get
    expect(expectOk(splitDetail('plan.get', { planId: 'p', from: 1 })).args).toEqual({
      planId: 'p',
      from: 1,
    })
    expect(
      expectErrCode(splitDetail('plan.get', { planId: 'p', detail: 'all' }), 'input.malformed')
        .issues,
    ).toEqual([expect.objectContaining({ path: ['detail'], rule: 'enum' })])
    expect(
      expectErrCode(
        splitDetail('plan.toolpath.get', { planId: 'p', count: 9999 }),
        'input.malformed',
      ).issues,
    ).toEqual([expect.objectContaining({ path: ['count'], rule: 'integer' })])
  })
})

function fakeSession(peeks: Record<string, unknown> = {}): ShaperSession & { boundKey: string } {
  return {
    boundKey: 'k1',
    peek(name: string, args: object): AppResult<unknown> {
      const key = `${name} ${JSON.stringify(args)}`
      return key in peeks ? Ok(peeks[key]) : fail('input.malformed', `no ${key}`)
    },
    resultSchema(name: string) {
      return name.startsWith('design.pocket.')
        ? z.object({ operationId: z.string(), warnings: Warnings })
        : undefined
    },
  }
}

const SUMMARY: View = { detail: 'summary', from: 0, count: 500 }
const call = (name: string, value: unknown, applied?: unknown): SessionCallResult => ({
  name,
  kind: name.endsWith('.get') || name.endsWith('.list') ? 'query' : 'command',
  result: Ok({ value, revision: 3, ...(applied === undefined ? {} : { applied }) } as never),
})
const valueOf = (c: SessionCallResult) => expectOk(c.result).value as Record<string, unknown>

const warn = (code: string, operation: string, message = code, parameter?: string) => ({
  code,
  severity: 'warning',
  message,
  operation,
  ...(parameter === undefined ? {} : { parameter }),
  params: {},
})

describe('DFM warnings as changes', () => {
  it('lists what changed since the session last received the part’s warnings', () => {
    const shaper = new ResultShaper(fakeSession())
    const a = warn('dfm.cornerSharp', 'pocket1')
    const b = warn('dfm.depthExceedsStock', 'pocket2', 'too deep', 'depth')
    const args = { partId: 'P' }
    // the first time: all added
    const first = shaper.shape(
      call('design.pocket.add', { operationId: 'pocket2', warnings: [a, b] }),
      args,
      SUMMARY,
    )
    expect(valueOf(first)['warnings']).toEqual({ count: 2, added: [a, b] })
    // b changes, a goes, c comes
    const b2 = { ...b, message: 'much too deep' }
    const c = warn('dfm.toolUnfit', 'pocket2', 'unfit', 'tool')
    const next = shaper.shape(
      call('design.pocket.update', { operationId: 'pocket2', warnings: [b2, c] }),
      args,
      SUMMARY,
    )
    expect(valueOf(next)['warnings']).toEqual({
      count: 2,
      added: [c],
      changed: [b2],
      removed: [{ code: 'dfm.cornerSharp', operation: 'pocket1' }],
    })
    // nothing changed: just the count
    const same = shaper.shape(
      call('design.pocket.update', { operationId: 'pocket2', warnings: [b2, c] }),
      args,
      SUMMARY,
    )
    expect(valueOf(same)['warnings']).toEqual({ count: 2 })
  })

  it('design.warning.list stays complete and is the new baseline; applied warnings are changes too', () => {
    const shaper = new ResultShaper(fakeSession())
    const a = warn('dfm.cornerSharp', 'pocket1')
    const b = warn('dfm.toolUnfit', 'pocket1', 'unfit', 'tool')
    const listed = shaper.shape(
      call('design.warning.list', { warnings: [a] }),
      { partId: 'P' },
      SUMMARY,
    )
    expect(valueOf(listed)['warnings']).toEqual([a])
    const edited = shaper.shape(
      call(
        'design.pocket.update',
        { operationId: 'pocket1', warnings: [a, b] },
        { changes: 1, warnings: [{ partId: 'P', warnings: [a] }] },
      ),
      { partId: 'P' },
      SUMMARY,
    )
    expect(valueOf(edited)['warnings']).toEqual({ count: 2, added: [b] })
    // Apply chose another tool: the unfit warning is gone again
    expect(expectOk(edited.result).applied).toEqual({
      changes: 1,
      warnings: [
        {
          partId: 'P',
          count: 1,
          removed: [{ code: 'dfm.toolUnfit', operation: 'pocket1', parameter: 'tool' }],
        },
      ],
    })
  })

  it('starts over when the session is bound to another project', () => {
    const session = fakeSession()
    const shaper = new ResultShaper(session)
    const a = warn('dfm.cornerSharp', 'pocket1')
    shaper.shape(call('design.warning.list', { warnings: [a] }), { partId: 'P' }, SUMMARY)
    session.boundKey = 'k2'
    const r = shaper.shape(
      call('design.pocket.update', { operationId: 'pocket1', warnings: [a] }),
      { partId: 'P' },
      SUMMARY,
    )
    expect(valueOf(r)['warnings']).toEqual({ count: 1, added: [a] })
  })

  // X1 found the preview's own Clones warnings shaped as changes of the part's: every part
  // warning came back `removed`, and the next edit listed them all as `added` again
  it("leaves a query's own warnings (design.clones.preview) as they are and keeps the baseline", () => {
    const preview = CLONES_QUERIES.find((d) => d.name === 'design.clones.preview')!
    const session = fakeSession()
    const shaper = new ResultShaper({
      ...session,
      resultSchema: (name) =>
        name === preview.name ? (preview.result as z.ZodType) : session.resultSchema(name),
    })
    const a = warn('dfm.tabsRelocated', 'profile1')
    shaper.shape(call('design.warning.list', { warnings: [a] }), { partId: 'P' }, SUMMARY)
    const r = shaper.shape(
      call(preview.name, { instances: [], rows: [], warnings: [] }),
      { partId: 'P' },
      SUMMARY,
    )
    expect(valueOf(r)['warnings']).toEqual([])
    const next = shaper.shape(
      call('design.pocket.add', { operationId: 'pocket1', warnings: [a] }),
      { partId: 'P' },
      SUMMARY,
    )
    expect(valueOf(next)['warnings']).toEqual({ count: 1 })
  })

  it('passes errors unchanged', () => {
    const shaper = new ResultShaper(fakeSession())
    const err: SessionCallResult = {
      name: 'plan.get',
      kind: 'query',
      result: fail('input.malformed', 'x'),
    }
    expect(shaper.shape(err, {}, SUMMARY)).toBe(err)
  })
})

const toolpath = {
  planOperationId: 'op1',
  tool: 'snap-1',
  spindleSpeed: 18000,
  stats: { cutLength: 100.123456789012, rapidLength: 20, estimatedSeconds: 60 },
  passes: [
    {
      kind: 'rough',
      moves: [
        { kind: 'rapid', to: [0, 0, 5] },
        { kind: 'line', to: [10, 0, -1], feed: 500 },
        { kind: 'arc', to: [10, 10, -1], center: [10, 5], cw: false, feed: 500 },
      ],
    },
    {
      kind: 'drill',
      moves: [
        { kind: 'drill', at: [-2, 3], top: 0, bottom: -6, cycle: 'simple', retract: 2, feed: 100 },
      ],
    },
  ],
}

describe('plan.toolpath.get', () => {
  it('summarizes by default: moves per pass, bounds of the end points, stats', () => {
    const shaper = new ResultShaper(fakeSession())
    const r = shaper.shape(
      call('plan.toolpath.get', { toolpath, stale: false, pendingApply: false }),
      {},
      SUMMARY,
    )
    expect(valueOf(r)).toEqual({
      toolpath: {
        planOperationId: 'op1',
        tool: 'snap-1',
        spindleSpeed: 18000,
        stats: { cutLength: 100.1234568, rapidLength: 20, estimatedSeconds: 60 },
        moves: 4,
        passes: [
          { kind: 'rough', moves: 3 },
          { kind: 'drill', moves: 1 },
        ],
        bounds: { min: [-2, 0, -6], max: [10, 10, 5] },
      },
      stale: false,
      pendingApply: false,
      detail: expect.stringContaining('detail: "full"'),
    })
  })

  it('detail "full" returns a range of the moves across passes', () => {
    const shaper = new ResultShaper(fakeSession())
    const r = shaper.shape(
      call('plan.toolpath.get', { toolpath, stale: false, pendingApply: false }),
      {},
      { detail: 'full', from: 2, count: 1 },
    )
    const v = valueOf(r) as { toolpath: { passes: unknown[] }; moves: unknown }
    expect(v.toolpath.passes).toEqual([
      { kind: 'rough', first: 2, moves: [toolpath.passes[0]!.moves[2]] },
    ])
    expect(v.moves).toEqual({ from: 2, count: 1, total: 4, next: 3 })
    const last = valueOf(
      shaper.shape(
        call('plan.toolpath.get', { toolpath, stale: false, pendingApply: false }),
        {},
        {
          detail: 'full',
          from: 2,
          count: 500,
        },
      ),
    ) as { toolpath: { passes: { first: number }[] }; moves: unknown }
    expect(last.toolpath.passes.map((p) => p.first)).toEqual([2, 3])
    expect(last.moves).toEqual({ from: 2, count: 2, total: 4, next: null })
  })

  it('keeps a null toolpath', () => {
    const shaper = new ResultShaper(fakeSession())
    const v = { toolpath: null, stale: true, pendingApply: false }
    expect(valueOf(shaper.shape(call('plan.toolpath.get', v), {}, SUMMARY))).toEqual(v)
  })
})

describe('plan.get', () => {
  const part = { id: 'P', stock: 'snap-stock', operations: [{ id: 'pocket1' }, { id: 'drill1' }] }
  const plan = {
    id: 'plan-1',
    name: 'Plan',
    status: 'draft',
    design: { partId: 'P', takenAt: '2026-01-01T00:00:00Z', hash: 'h', taken: part, part },
    snapshots: [
      { id: 'snap-stock', kind: 'stock', values: { name: 'Beech' } },
      { id: 'snap-tool', kind: 'tool', values: { name: '6 mm end mill' } },
      { id: 'snap-m', kind: 'machine', values: { name: 'Router' } },
    ],
    machine: 'snap-m',
    setups: [
      {
        id: 's1',
        name: 'Top',
        workOffset: 'G54',
        clearanceHeight: q('10 mm', '10'),
        retractHeight: q('2 mm', '2'),
        operations: [
          {
            id: 'op1',
            designOperationIds: ['pocket1'],
            tool: 'snap-tool',
            overrides: {},
            strategy: {},
          },
          { id: 'op2', designOperationIds: ['drill1'], overrides: {}, strategy: {} },
        ],
      },
    ],
  }
  const peeks = {
    'plan.operation.list {"planId":"plan-1"}': {
      operations: [
        {
          id: 'op1',
          kind: 'pocket',
          feeds: {
            spindleSpeed: { value: 18000, unit: 'rpm' },
            stepover: { value: 2.4000000000000004 },
          },
        },
        { id: 'op2', kind: 'drilling', feeds: { spindleSpeed: null } },
      ],
    },
    'plan.warning.list {"planId":"plan-1"}': {
      warnings: [
        { severity: 'error', planOperationId: 'op2', code: 'plan.toolMissing' },
        { severity: 'warning', code: 'plan.machine' },
      ],
    },
    'plan.toolpath.get {"planId":"plan-1","planOperationId":"op1"}': {
      toolpath: { stats: { estimatedSeconds: 30 } },
      stale: false,
    },
    'plan.toolpath.get {"planId":"plan-1","planOperationId":"op2"}': {
      toolpath: null,
      stale: true,
    },
  }

  it('summarizes by default: setups, operations with tool, feeds, time and findings', () => {
    const shaper = new ResultShaper(fakeSession(peeks))
    const r = shaper.shape(call('plan.get', { plan }), { planId: 'plan-1' }, SUMMARY)
    expect(valueOf(r)).toEqual({
      plan: {
        id: 'plan-1',
        name: 'Plan',
        status: 'draft',
        design: {
          partId: 'P',
          takenAt: '2026-01-01T00:00:00Z',
          hash: 'h',
          operations: 2,
          planEdits: false,
        },
        machine: 'Router',
        stock: 'Beech',
        setups: [
          {
            id: 's1',
            name: 'Top',
            direction: '+z',
            rotation: 0,
            clearanceHeight: 10,
            retractHeight: 2,
            operations: [
              {
                id: 'op1',
                kind: 'pocket',
                designOperationIds: ['pocket1'],
                tool: '6 mm end mill',
                feeds: { spindleSpeed: 18000, stepover: 2.4 },
                seconds: 30,
                toolpath: 'current',
              },
              {
                id: 'op2',
                kind: 'drilling',
                designOperationIds: ['drill1'],
                tool: null,
                feeds: { spindleSpeed: null },
                seconds: null,
                toolpath: 'none',
                findings: { error: 1 },
              },
            ],
            seconds: null,
          },
        ],
        seconds: null,
        findings: { error: 1, warning: 1 },
      },
      detail: expect.stringContaining('detail: "full"'),
    })
  })

  it('detail "full" returns the record with compact quantities', () => {
    const shaper = new ResultShaper(fakeSession(peeks))
    const r = shaper.shape(
      call('plan.get', { plan }),
      { planId: 'plan-1' },
      { ...SUMMARY, detail: 'full' },
    )
    const v = valueOf(r) as { plan: typeof plan }
    expect(v.plan.snapshots).toEqual(plan.snapshots)
    expect(v.plan.setups[0]!.clearanceHeight).toBe(10)
  })
})

// Spec: docs/architecture/llm-api.md#a1-compact-results
describe('design.shape.get detail and no stacks (A1)', () => {
  const shapeValue = {
    shape: {
      id: 'shape-1',
      name: 'Outline',
      items: [
        {
          kind: 'path',
          op: 'add',
          closed: true,
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
        { kind: 'circle', op: 'subtract', center: [0.5, 0.5], diameter: q('0.2', '1', '5') },
      ],
    },
    usedBy: ['pocket1'],
    resolved: {
      kind: 'region',
      pieces: [{ outer: [{}, {}, {}], holes: [[{}], [{}]] }],
      elements: 5,
      area: 0.4685840735,
      bounds: { min: [0, 0], max: [1, 1] },
      length: 3.2,
    },
  }

  it('takes detail, default full; "summary" drops the item lists and resolved loops', () => {
    expect(expectOk(splitDetail('design.shape.get', { partId: 'P', shapeId: 's' }))).toEqual({
      args: { partId: 'P', shapeId: 's' },
      view: { detail: 'full', from: 0, count: 500 },
    })
    expect(
      expectOk(splitDetail('design.shape.get', { partId: 'P', shapeId: 's', detail: 'summary' }))
        .view.detail,
    ).toBe('summary')
    // plan reads accept "summary" too
    expect(expectOk(splitDetail('plan.get', { planId: 'p', detail: 'summary' })).view.detail).toBe(
      'summary',
    )
    const shaper = new ResultShaper(fakeSession())
    const full = shaper.shape(
      call('design.shape.get', shapeValue),
      {},
      { ...SUMMARY, detail: 'full' },
    )
    expect((valueOf(full)['resolved'] as Record<string, unknown>)['pieces']).toHaveLength(1)
    const r = shaper.shape(call('design.shape.get', shapeValue), {}, SUMMARY)
    expect(valueOf(r)).toEqual({
      shape: {
        id: 'shape-1',
        name: 'Outline',
        items: [
          { kind: 'path', op: 'add', closed: true, points: 3 },
          { kind: 'circle', op: 'subtract', center: 2, diameter: 0.2 },
        ],
      },
      usedBy: ['pocket1'],
      resolved: {
        kind: 'region',
        pieces: 1,
        holes: 2,
        elements: 5,
        area: 0.4685840735,
        bounds: { min: [0, 0], max: [1, 1] },
        length: 3.2,
      },
      detail: expect.stringContaining('detail: "full"'),
    })
  })

  it('drops string stack keys at any depth of a value and of applied', () => {
    const shaper = new ResultShaper(fakeSession())
    const err = {
      code: 'geometry.evaluation',
      message: 'open loop',
      stack: 'Error\n at x (app.asar)',
    }
    const r = shaper.shape(
      call(
        'job.get',
        { jobId: 'j', outcome: { ok: false, error: { ...err, cause: err } } },
        {
          error: err,
        },
      ),
      {},
      SUMMARY,
    )
    expect(JSON.stringify(expectOk(r.result))).not.toContain('stack')
    expect(valueOf(r)).toEqual({
      jobId: 'j',
      outcome: {
        ok: false,
        error: {
          code: 'geometry.evaluation',
          message: 'open loop',
          cause: { code: 'geometry.evaluation', message: 'open loop' },
        },
      },
    })
  })
})

describe('evaluate jobs and tool names (llm-api.md, DF41 F5, F8)', () => {
  it('a finished design.part.evaluate outcome lists its warnings as changes', () => {
    const shaper = new ResultShaper(fakeSession())
    const a = warn('dfm.cornerSharp', 'pocket1')
    const b = warn('dfm.toolUnfit', 'pocket1', 'unfit', 'tool')
    shaper.shape(call('design.warning.list', { warnings: [a] }), { partId: 'P' }, SUMMARY)
    shaper.shape(call('design.part.evaluate', { jobId: 'job-1' }), { partId: 'P' }, SUMMARY)
    const job = (warnings: unknown[]) => ({
      jobId: 'job-1',
      name: 'design.part.evaluate',
      state: 'finished',
      outcome: { ok: true, value: { evaluation: 'done', warnings } },
    })
    const waited = valueOf(shaper.shape(call('job.wait', job([a, b])), { jobId: 'job-1' }, SUMMARY))
    expect(waited['outcome']).toEqual({
      ok: true,
      value: { evaluation: 'done', warnings: { count: 2, added: [b] } },
    })
    // other jobs pass as they are
    const other = { ...job([a]), jobId: 'job-2' }
    expect(valueOf(shaper.shape(call('job.get', other), { jobId: 'job-2' }, SUMMARY))).toEqual(
      other,
    )
  })

  it('names specific tools by their snapshot, in the value and in applied', () => {
    const snapshots: Record<string, unknown> = {
      's-1': { id: 's-1', values: { name: 'Flat 3', diameter: q('3 mm', '3') } },
    }
    const shaper = new ResultShaper({ ...fakeSession(), snapshot: (id) => snapshots[id] })
    const tool = { kind: 'specific', snapshotId: 's-1' }
    const shapedCall = shaper.shape(
      call(
        'design.operation.list',
        { operations: [{ id: 'pocket1', tool }] },
        { toolChanges: [{ operationId: 'pocket1', to: tool }] },
      ),
      { partId: 'P' },
      SUMMARY,
    )
    const named = { ...tool, name: 'Flat 3', diameter: 3 }
    expect(valueOf(shapedCall)['operations']).toEqual([{ id: 'pocket1', tool: named }])
    const applied = (expectOk(shapedCall.result) as { applied?: { toolChanges: unknown[] } })
      .applied
    expect(applied?.toolChanges).toEqual([{ operationId: 'pocket1', to: named }])
  })
})
