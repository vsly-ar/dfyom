// Uncaught errors in the machine host: logged `fatal`, then the process or thread exits, so main
// fails the run with machine.connection (docs/modes/run-v0.1.md#implementation-task-39).
import { describe, expect, it, vi } from 'vitest'
import { noopLogger, type Logger } from '../../shared/logging'
import { uncaughtHandler } from './serve'

describe('machine host uncaught errors', () => {
  it.each(['utility', 'worker'] as const)('%s: logs fatal and exits with 1', (proc) => {
    vi.useFakeTimers()
    const fatal = vi.fn()
    const log: Logger = { ...noopLogger, fatal }
    const exit = vi.fn()
    uncaughtHandler(() => log, proc, exit, 'uncaught exception')(new Error('boom'))
    expect(fatal).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(100)
    expect(exit).toHaveBeenCalledWith(1)
    vi.useRealTimers()
  })
})
