// Where a run stopped (hardening M5): the operation of a line, and the conservative resume point.
// Spec: docs/modes/run-machine.md#section-resume-m5
import { describe, expect, it } from 'vitest'
import type { JobAbout } from '../service'
import { operationAt, PLANNER_LINES, stoppedOperation } from './client'

const about: JobAbout = {
  plan: {
    planId: 'p',
    planName: 'Plan 1',
    setupId: 's',
    setupName: 'Top',
    setup: 1,
    setups: 1,
  },
  operations: [
    { planOperationId: 'a', fromLine: 11 },
    { planOperationId: 'b', fromLine: 40 },
    { planOperationId: 'c', fromLine: 100 },
  ],
}

describe('resume point', () => {
  it('names the operation holding a line; the header belongs to the first', () => {
    expect(operationAt(about, 1)).toBe('a')
    expect(operationAt(about, 39)).toBe('a')
    expect(operationAt(about, 40)).toBe('b')
    expect(operationAt(about, 500)).toBe('c')
  })

  it('counts back by the planner buffer: a stop just past a boundary offers the operation before', () => {
    expect(stoppedOperation(about, 40 + PLANNER_LINES - 1, false)).toBe('a')
    expect(stoppedOperation(about, 40 + PLANNER_LINES, false)).toBe('b')
    expect(stoppedOperation(about, 3, false)).toBe('a')
  })

  it('at a tool change: the operation of that tool change', () => {
    expect(stoppedOperation(about, 101, true)).toBe('c')
  })
})
