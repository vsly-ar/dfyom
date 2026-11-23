// Auto-apply (DF28): due after the setting's seconds without an edit, restarted by every change
// of the pending answer, never while Off, sending, running or failed, and postponed by a modal
// dialog. Doc: docs/architecture/apply.md#auto-apply-df28
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingState } from '../state/pending'
import { autoApplyArmed, useAutoApply } from './useAutoApply'

const pending = (patch: Partial<PendingState> = {}): PendingState => ({
  known: true,
  count: 2,
  changes: [],
  applying: [],
  sending: false,
  error: null,
  applied: false,
  appliedBy: null,
  version: 1,
  toolChanges: new Map(),
  ...patch,
})

describe('auto-apply', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('is armed only while pending changes can apply', () => {
    expect(autoApplyArmed(pending(), 10)).toBe(true)
    expect(autoApplyArmed(pending(), 0)).toBe(false)
    expect(autoApplyArmed(pending({ count: 0 }), 10)).toBe(false)
    expect(autoApplyArmed(pending({ known: false }), 10)).toBe(false)
    expect(autoApplyArmed(pending({ sending: true }), 10)).toBe(false)
    expect(autoApplyArmed(pending({ applying: ['job1'] }), 10)).toBe(false)
    expect(
      autoApplyArmed(
        pending({ error: { code: 'internal.unexpected', message: 'x', issues: [], frames: [] } }),
        10,
      ),
    ).toBe(false)
  })

  it('applies after the delay without edits; each edit restarts the wait', () => {
    const apply = vi.fn()
    const { result, rerender } = renderHook(({ p }) => useAutoApply(p, 10, apply), {
      initialProps: { p: pending() },
    })
    expect(result.current?.durationMs).toBe(10_000)
    act(() => {
      vi.advanceTimersByTime(8000)
    })
    rerender({ p: pending({ version: 2, count: 3 }) })
    act(() => {
      vi.advanceTimersByTime(8000)
    })
    expect(apply).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(result.current).toBeNull()
  })

  it('does nothing while Off and stops waiting when nothing is pending', () => {
    const apply = vi.fn()
    const { result, rerender } = renderHook(({ p, s }) => useAutoApply(p, s, apply), {
      initialProps: { p: pending(), s: 0 },
    })
    expect(result.current).toBeNull()
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    rerender({ p: pending(), s: 5 })
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    rerender({ p: pending({ count: 0, version: 2 }), s: 5 })
    expect(result.current).toBeNull()
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(apply).not.toHaveBeenCalled()
  })

  it('waits again while a modal dialog is open', () => {
    const apply = vi.fn()
    const modal = document.createElement('div')
    modal.setAttribute('data-modal-dialog', '')
    document.body.append(modal)
    renderHook(() => useAutoApply(pending(), 3, apply))
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(apply).not.toHaveBeenCalled()
    modal.remove()
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
