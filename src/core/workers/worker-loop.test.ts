// Spec: docs/architecture/workers.md#message-protocol, #logging-from-workers
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Err, fail, Ok } from '../../shared/result'
import type { AnyWorkerTask, WorkerTask } from '../commands/jobs'
import { PROTOCOL_VERSION, type Endpoint, type WorkerMessage } from './protocol'
import { runWorkerLoop } from './worker-loop'

const settle = () => new Promise((r) => setTimeout(r, 0))

const echo: WorkerTask<{ n: number }, { n: number }> = {
  name: 'test.echo',
  lane: 'toolpath',
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
  timeoutMs: 1000,
  run: (i) => Ok(i),
}

/** Steps `steps` times; the clock advances `stepMs` per step. */
function looper(clock: { t: number }): WorkerTask<{ steps: number; stepMs: number }, null> {
  return {
    name: 'test.loop',
    lane: 'toolpath',
    input: z.object({ steps: z.number(), stepMs: z.number() }),
    output: z.null(),
    timeoutMs: 1000,
    run({ steps, stepMs }, ctl) {
      for (let i = 0; i < steps; i++) {
        clock.t += stepMs
        const s = ctl.steps.step({ done: i + 1, total: steps })
        if (s.isErr()) return Err(s.unwrapErr())
      }
      return Ok(null)
    },
  }
}

const thrower: WorkerTask<null, null> = {
  name: 'test.throw',
  lane: 'toolpath',
  input: z.null(),
  output: z.null(),
  timeoutMs: 1000,
  run() {
    throw new Error('boom')
  },
}

const view: WorkerTask<null, { a: Float32Array }> = {
  name: 'test.view',
  lane: 'toolpath',
  input: z.null(),
  output: z.object({ a: z.instanceof(Float32Array) }),
  timeoutMs: 1000,
  transfer: (o) => [o.a],
  run: () => Ok({ a: new Float32Array(8).subarray(2, 4) }),
}

const owned: WorkerTask<null, { a: Float32Array }> = {
  ...view,
  name: 'test.owned',
  run: () => Ok({ a: new Float32Array(4) }),
}

const logs: WorkerTask<null, null> = {
  name: 'test.log',
  lane: 'toolpath',
  input: z.null(),
  output: z.null(),
  timeoutMs: 1000,
  run(_i, ctl) {
    ctl.log.info({ x: 1 }, 'hello')
    return Ok(null)
  },
}

const geometryOnly: WorkerTask<null, null> = {
  name: 'test.solids',
  lane: 'geometry',
  input: z.null(),
  output: z.null(),
  timeoutMs: 1000,
  async run(_i, ctl) {
    const k = await ctl.solids()
    return k.isErr() ? Err(k.unwrapErr()) : Ok(null)
  },
}

function setup(tasks: AnyWorkerTask[] = [], clock = { t: 0 }) {
  const posted: { m: WorkerMessage; transfer: readonly ArrayBuffer[] | undefined }[] = []
  let listener: (m: unknown) => void = () => {}
  const endpoint: Endpoint = {
    post: (m, transfer) => posted.push({ m: m as WorkerMessage, transfer }),
    onMessage: (l) => (listener = l),
  }
  runWorkerLoop(endpoint, {
    tasks: [echo, thrower, view, owned, logs, geometryOnly, looper(clock), ...tasks],
    now: () => clock.t,
    loadSolids: async () => fail('geometry.evaluation', 'no wasm in this test'),
  })
  const send = async (m: unknown) => {
    listener(m)
    await settle()
    await settle()
  }
  const init = (lane: 'geometry' | 'toolpath' = 'toolpath') =>
    send({
      type: 'init',
      protocol: PROTOCOL_VERSION,
      workerId: `${lane}-1`,
      lane,
      logLevel: 'debug',
    })
  let n = 0
  const run = (task: string, input: unknown) =>
    send({ type: 'run', id: `r${++n}`, task, input, control: new SharedArrayBuffer(4) })
  const of = <T extends WorkerMessage['type']>(type: T) =>
    posted.map((p) => p.m).filter((m): m is Extract<WorkerMessage, { type: T }> => m.type === type)
  const lastResult = () => of('result').at(-1)!
  return { posted, send, init, run, of, lastResult }
}

describe('worker loop', () => {
  it('answers init with ready and the protocol version', async () => {
    const w = setup()
    await w.init()
    expect(w.of('ready')).toEqual([
      expect.objectContaining({
        type: 'ready',
        protocol: PROTOCOL_VERSION,
        workerId: 'toolpath-1',
      }),
    ])
  })

  it('runs a task and posts exactly one result', async () => {
    const w = setup()
    await w.init()
    await w.run('test.echo', { n: 3 })
    expect(w.of('result')).toHaveLength(1)
    expect(w.lastResult()).toMatchObject({ id: 'r1', result: { ok: true, value: { n: 3 } } })
    expect(w.lastResult().stats.ms).toBeGreaterThanOrEqual(0)
  })

  it('an unknown task is internal.unexpected', async () => {
    const w = setup()
    await w.init()
    await w.run('test.nope', null)
    expect(w.lastResult().result).toMatchObject({
      ok: false,
      error: { code: 'internal.unexpected' },
    })
  })

  it('a malformed run with a readable id answers input.malformed; without an id it is dropped', async () => {
    const w = setup()
    await w.init()
    await w.send({ type: 'run', id: 'bad', task: 'test.echo', input: {} }) // no control
    expect(w.lastResult()).toMatchObject({
      id: 'bad',
      result: { ok: false, error: { code: 'input.malformed' } },
    })
    await w.send({ type: 'run', task: 'test.echo' })
    await w.send('garbage')
    expect(w.of('result')).toHaveLength(1)
  })

  it('input that fails the task schema is input.malformed', async () => {
    const w = setup()
    await w.init()
    await w.run('test.echo', { n: 'three' })
    expect(w.lastResult().result).toMatchObject({ ok: false, error: { code: 'input.malformed' } })
  })

  it('throttles progress to one per 50 ms plus the final tick', async () => {
    const w = setup()
    await w.init()
    await w.run('test.loop', { steps: 20, stepMs: 10 }) // 200 ms
    const done = w.of('progress').map((p) => p.done)
    expect(done.at(-1)).toBe(20)
    expect(done.length).toBeLessThanOrEqual(6)
    expect(done[0]).toBe(1)
  })

  it('transfers owned buffers and refuses views that do not own theirs', async () => {
    const w = setup()
    await w.init()
    await w.run('test.owned', null)
    const p = w.posted.at(-1)!
    expect(p.transfer).toHaveLength(1)
    await w.run('test.view', null)
    expect(w.lastResult().result).toMatchObject({
      ok: false,
      error: { code: 'internal.unexpected' },
    })
  })

  it('forwards logs with the worker bindings', async () => {
    const w = setup()
    await w.init()
    await w.run('test.log', null)
    const entries = w.of('log').flatMap((l) => l.batch as Record<string, unknown>[])
    expect(entries.find((e) => e['msg'] === 'hello')).toMatchObject({
      proc: 'worker',
      worker: 'toolpath-1',
      lane: 'toolpath',
      task: 'test.log',
      run: 'r1',
      x: 1,
    })
  })

  it('a throwing task is internal.unexpected and the loop keeps serving', async () => {
    const w = setup()
    await w.init()
    await w.run('test.throw', null)
    expect(w.lastResult().result).toMatchObject({
      ok: false,
      error: { code: 'internal.unexpected' },
    })
    await w.run('test.echo', { n: 1 })
    expect(w.lastResult()).toMatchObject({ id: 'r2', result: { ok: true } })
  })

  it('solids are only available in the geometry lane', async () => {
    const w = setup()
    await w.init('toolpath')
    await w.run('test.solids', null)
    expect(w.lastResult().result).toMatchObject({
      ok: false,
      error: { code: 'internal.unexpected' },
    })
    const g = setup()
    await g.init('geometry')
    await g.run('test.solids', null)
    expect(g.lastResult().result).toMatchObject({
      ok: false,
      error: { code: 'geometry.evaluation' },
    })
  })
})
