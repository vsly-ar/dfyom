// The window's shared job reads (P7, idle cost): one `job.list` poll for all readers, none idle.
// Doc: docs/research/2026-11-23-idle-cost.md, docs/conventions/ui.md#jobs-and-progress
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionEvent } from '../../../core/commands/action-log'
import type { CallReply } from '../../../shared/preload-api'
import { createJobsFeed, JOB_POLL_MS } from './hooks'

function fake(state: { running: boolean }) {
  let calls = 0
  let emit: (e: ActionEvent) => void = () => {}
  const bridge = {
    call: (): Promise<CallReply> => {
      calls++
      const jobs = state.running
        ? [{ jobId: 'j1', name: 'plan.toolpath.generate', state: 'running' }]
        : [{ jobId: 'j0', name: 'plan.toolpath.generate', state: 'finished' }]
      return Promise.resolve({ ok: true, value: { jobs } } as CallReply)
    },
  }
  const events = {
    onEvent: (l: (e: ActionEvent) => void) => {
      emit = l
      return () => (emit = () => {})
    },
  }
  return {
    bridge,
    events,
    calls: () => calls,
    job: () => emit({ type: 'job' } as unknown as ActionEvent),
  }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

describe('createJobsFeed', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reads once for all readers and polls only while a job runs', async () => {
    const state = { running: true }
    const f = fake(state)
    const feed = createJobsFeed(f.bridge, f.events)
    const offA = feed.subscribe(() => {})
    const offB = feed.subscribe(() => {})
    // both readers ask at once (the status bar and the Apply button): one read
    feed.refresh()
    feed.refresh()
    await settle()
    expect(feed.get().map((j) => j.id)).toEqual(['j1'])
    const afterFirst = f.calls()
    expect(afterFirst).toBeLessThanOrEqual(2) // the first, plus at most one coalesced re-read
    await vi.advanceTimersByTimeAsync(10 * JOB_POLL_MS)
    // one poll per interval, not one per reader
    expect(f.calls() - afterFirst).toBeLessThanOrEqual(10)
    expect(f.calls() - afterFirst).toBeGreaterThanOrEqual(9)

    // the job ends: one more read, then nothing while idle
    state.running = false
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS)
    expect(feed.get()).toEqual([])
    const idle = f.calls()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.calls()).toBe(idle)

    // a job event reads again
    state.running = true
    f.job()
    await settle()
    expect(f.calls()).toBe(idle + 1)
    expect(feed.get().map((j) => j.id)).toEqual(['j1'])

    // the last reader leaves: the poll stops
    offA()
    offB()
    const left = f.calls()
    await vi.advanceTimersByTimeAsync(10 * JOB_POLL_MS)
    expect(f.calls()).toBe(left)
  })
})
