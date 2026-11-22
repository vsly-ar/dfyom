// The renderer mesh push: one push per status and input hash, the mesh only when done.
// Doc: docs/architecture/workers.md#evaluation-status
import { describe, expect, it } from 'vitest'
import type { PartEvaluationState } from '../core/design/evaluation'
import { fail } from '../shared/result'
import type { PartEvaluationView } from '../shared/preload-api'
import { evaluationView, followEvaluations, planEvaluationView } from './evaluation-push'
import { menuTemplate } from './menu'
import { safeFileName } from './file-dialogs'

const evaluation = {
  positions: new Float32Array(9),
  indices: new Uint32Array([0, 1, 2]),
  triangleSurface: new Uint32Array([0]),
  surfaces: ['stock.top'],
  volume: 1,
  pieces: 1,
  warnings: [],
  stats: { ms: 1, triangles: 1 },
}

function fakeHost() {
  let state: PartEvaluationState | undefined = { status: 'pending', inputHash: 'h1' }
  let planState: PartEvaluationState | undefined = { status: 'pending', inputHash: 'p1' }
  const listeners = new Set<(partId: string) => void>()
  const planListeners = new Set<(planId: string) => void>()
  return {
    host: {
      evaluation: () => state,
      onEvaluation: (_key: string, l: (partId: string) => void) => {
        listeners.add(l)
        return () => void listeners.delete(l)
      },
      planEvaluation: () =>
        planState === undefined ? undefined : { partId: 'part1', state: planState },
      onPlanEvaluation: (_key: string, l: (planId: string) => void) => {
        planListeners.add(l)
        return () => void planListeners.delete(l)
      },
    },
    set(next: PartEvaluationState | undefined) {
      state = next
      for (const l of listeners) l('part1')
    },
    setPlan(next: PartEvaluationState | undefined) {
      planState = next
      for (const l of planListeners) l('plan1')
    },
  }
}

describe('evaluation push', () => {
  it('pushes each status and input once, with the mesh only when done', () => {
    const h = fakeHost()
    const sent: PartEvaluationView[] = []
    const off = followEvaluations(h.host, 'p1', (v) => sent.push(v))
    h.set({ status: 'pending', inputHash: 'h1' })
    h.set({ status: 'pending', inputHash: 'h1' }) // unchanged: not again
    h.set({ status: 'done', inputHash: 'h1', evaluation })
    h.set({
      status: 'failed',
      inputHash: 'h2',
      error: fail('geometry.evaluation', 'x').unwrapErr(),
    })
    expect(sent.map((v) => [v.status, v.inputHash, v.mesh !== undefined])).toEqual([
      ['pending', 'h1', false],
      ['done', 'h1', true],
      ['failed', 'h2', false],
    ])
    expect(sent[1]!.mesh!.surfaces).toEqual(['stock.top'])
    expect(sent[2]!.error?.code).toBe('geometry.evaluation')
    h.set(undefined) // the part is gone: nothing
    expect(sent).toHaveLength(3)
    off()
    h.set({ status: 'pending', inputHash: 'h3' })
    expect(sent).toHaveLength(3)
    expect(evaluationView(h.host, 'p1', 'part1')).toMatchObject({ status: 'pending', key: 'p1' })
  })

  it("pushes a plan's part evaluation with its plan id, deduplicated apart from the part's", () => {
    const h = fakeHost()
    const sent: PartEvaluationView[] = []
    const off = followEvaluations(h.host, 'p1', (v) => sent.push(v))
    h.set({ status: 'done', inputHash: 'h1', evaluation })
    // same status and hash as the part's: still pushed (another subject)
    h.setPlan({ status: 'done', inputHash: 'h1', evaluation })
    h.setPlan({ status: 'done', inputHash: 'h1', evaluation })
    h.setPlan(undefined) // the plan is gone: nothing
    expect(sent.map((v) => [v.planId, v.partId, v.status])).toEqual([
      [undefined, 'part1', 'done'],
      ['plan1', 'part1', 'done'],
    ])
    expect(sent[1]!.mesh).toBeDefined()
    off()
    h.setPlan({ status: 'pending', inputHash: 'h4' })
    expect(sent).toHaveLength(2)
    expect(planEvaluationView(h.host, 'p1', 'plan1')).toMatchObject({
      planId: 'plan1',
      status: 'pending',
    })
    h.setPlan(undefined)
    expect(planEvaluationView(h.host, 'p1', 'plan1')).toBeNull()
  })

  it('the menu has File, Edit, View, Window and Help with the documented accelerators', () => {
    const t = menuTemplate('linux', false)
    expect(t.map((m) => m.label ?? m.role)).toEqual(['File', 'Edit', 'View', 'windowMenu', 'help'])
    const accelerators = t.flatMap((m) =>
      Array.isArray(m.submenu) ? m.submenu.map((i) => i.accelerator).filter(Boolean) : [],
    )
    expect(accelerators).toEqual([
      'CmdOrCtrl+N',
      'CmdOrCtrl+O',
      'CmdOrCtrl+S',
      'CmdOrCtrl+Shift+S',
      'CmdOrCtrl+Z',
      'Ctrl+Y',
      'CmdOrCtrl+Enter',
      'CmdOrCtrl+1',
      'CmdOrCtrl+2',
      'CmdOrCtrl+3',
      'CmdOrCtrl+Shift+L',
    ])
    expect(menuTemplate('darwin', true)[0]).toEqual({ role: 'appMenu' })
  })

  it('suggests a safe file name from the project name', () => {
    expect(safeFileName('Bracket: v2/a')).toBe('Bracket  v2 a')
    expect(safeFileName('  ')).toBe('Untitled')
  })
})
