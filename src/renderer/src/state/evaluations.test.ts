// The window's part evaluations: query on bind, pushes, last good mesh kept while pending/failed,
// pushes of another project dropped. Doc: docs/conventions/ui.md#evaluation-status-pending-outdated-failed
import { describe, expect, it } from 'vitest'
import { newProjectDoc, type ProjectDoc } from '../../../core/project/document'
import type { PartEvaluationView } from '../../../shared/preload-api'
import { createEvaluations } from './evaluations'
import type { ReplicaState } from './replica'

const settle = () => new Promise((r) => setTimeout(r, 0))

const mesh = {
  positions: new Float32Array(9),
  indices: new Uint32Array([0, 1, 2]),
  triangleSurface: new Uint32Array([0]),
  surfaces: ['stock.top'],
}

function docWithPart(): ProjectDoc {
  const doc = newProjectDoc({ name: 'B', unitSystem: 'mm' })
  return { ...doc, parts: { part1: { id: 'part1', name: 'P', stock: 's', operations: [] } } }
}

function setup(answer: PartEvaluationView | null) {
  let state: ReplicaState = { status: 'loading' }
  const replicaListeners = new Set<() => void>()
  const push = new Set<(v: PartEvaluationView) => void>()
  const asked: string[] = []
  const evaluations = createEvaluations(
    {
      evaluation: {
        get: (partId) => {
          asked.push(partId)
          return Promise.resolve(answer)
        },
        onChange: (l) => {
          push.add(l)
          return () => push.delete(l)
        },
      },
    },
    {
      getState: () => state,
      subscribe: (l) => (replicaListeners.add(l), () => replicaListeners.delete(l)),
    },
  )
  const stop = evaluations.start()
  return {
    evaluations,
    asked,
    stop,
    open(key: string) {
      state = {
        status: 'open',
        key,
        doc: docWithPart(),
        revision: 1,
        seq: 1,
        file: null,
        savedRevision: 1,
      }
      for (const l of replicaListeners) l()
    },
    push(v: PartEvaluationView) {
      for (const l of push) l(v)
    },
  }
}

describe('evaluations', () => {
  it('asks for each part once the project is bound, then follows pushes', async () => {
    const s = setup({ key: 'p1', partId: 'part1', status: 'done', inputHash: 'h1', mesh })
    s.open('p1')
    await settle()
    expect(s.asked).toEqual(['part1'])
    expect(s.evaluations.getState().get('part1')).toMatchObject({ status: 'done', mesh })

    // pending and failed keep the last good mesh (shown outdated)
    s.push({ key: 'p1', partId: 'part1', status: 'pending', inputHash: 'h2' })
    expect(s.evaluations.getState().get('part1')).toMatchObject({ status: 'pending', mesh })
    s.push({
      key: 'p1',
      partId: 'part1',
      status: 'failed',
      inputHash: 'h2',
      error: { code: 'geometry.evaluation', message: 'x', issues: [], frames: [] },
    })
    expect(s.evaluations.getState().get('part1')).toMatchObject({ status: 'failed', mesh })

    // another project's push is dropped
    s.push({ key: 'other', partId: 'part1', status: 'done', inputHash: 'h9', mesh })
    expect(s.evaluations.getState().get('part1')?.status).toBe('failed')
    s.stop()
  })

  it('a new binding starts over', async () => {
    const s = setup(null)
    s.open('p1')
    s.push({ key: 'p1', partId: 'part1', status: 'done', inputHash: 'h1', mesh })
    expect(s.evaluations.getState().size).toBe(1)
    s.open('p2')
    expect(s.evaluations.getState().size).toBe(0)
    await settle()
    expect(s.asked).toEqual(['part1', 'part1'])
  })
})
