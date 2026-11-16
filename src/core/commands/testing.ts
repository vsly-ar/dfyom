// Test helpers for commands. Doc: docs/architecture/commands.md#testing
import { expect } from 'vitest'
import type { ProjectDoc } from '../project/document'
import type { Clock, CommandContext, IdGenerator, Source } from './context'
import type { DocumentCommand } from './define'
import { applyDocPatches, parseAndExecute, type DocumentRun } from './history'
import { inProcessWorkers } from './jobs'

/** Deterministic ids: `<prefix>-1`, `<prefix>-2`, … (one counter for all prefixes). */
export function fakeIds(): IdGenerator {
  let n = 0
  return { next: (prefix) => `${prefix}-${++n}` }
}

/** A clock that only moves when told to. */
export function fakeClock(startMs = 0): Clock & { advance(ms: number): void } {
  let t = startMs
  return {
    now: () => t,
    advance(ms) {
      t += ms
    },
  }
}

export const uiSource = (id = 'window-1'): Source => ({ kind: 'ui', id })
export const agentSource = (id = 'agent-1'): Source => ({ kind: 'agent', id })

/** A full context with fakes; override any part. */
export function testContext(over: Partial<CommandContext> = {}): CommandContext {
  return {
    source: uiSource(),
    ids: fakeIds(),
    clock: fakeClock(),
    services: { workers: inProcessWorkers },
    ...over,
  }
}

/** Runs a document command without a dispatcher (raw args are parsed with the command's schema). */
export function runCommand<R>(
  doc: ProjectDoc,
  def: DocumentCommand<never, R> | DocumentCommand,
  rawArgs: unknown,
  ctx: Partial<CommandContext> = {},
): DocumentRun<R> {
  return parseAndExecute(doc, def as DocumentCommand, rawArgs, testContext(ctx)) as DocumentRun<R>
}

/** Undo law: `apply(next, inverse) ≡ doc` and `apply(doc, patches) ≡ next`; the command must succeed. */
export function expectUndoLaw(doc: ProjectDoc, def: DocumentCommand, rawArgs: unknown): void {
  const r = runCommand(doc, def, rawArgs)
  expect(r.result.isOk(), `${def.name} failed`).toBe(true)
  const back = applyDocPatches(r.next, r.inversePatches)
  const forward = applyDocPatches(doc, r.patches)
  expect(back.isOk() && back.unwrap()).toEqual(doc)
  expect(forward.isOk() && forward.unwrap()).toEqual(r.next)
}
