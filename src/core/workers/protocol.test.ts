// Spec: docs/architecture/workers.md#message-protocol
import { describe, expect, it } from 'vitest'
import { HostMessage, PROTOCOL_VERSION, WorkerMessage } from './protocol'

const control = new SharedArrayBuffer(4)

describe('host → worker messages', () => {
  it('accepts init (with and without wasm) and run', () => {
    const init = {
      type: 'init',
      protocol: PROTOCOL_VERSION,
      workerId: 'geometry-1',
      lane: 'geometry',
      logLevel: 'info',
    }
    expect(HostMessage.safeParse(init).success).toBe(true)
    expect(HostMessage.safeParse({ ...init, wasm: new ArrayBuffer(8) }).success).toBe(true)
    expect(HostMessage.safeParse({ ...init, region2dWasm: new ArrayBuffer(8) }).success).toBe(true)
    const run = { type: 'run', id: 'r1', task: 'geometry.evaluate', input: { any: 1 }, control }
    expect(HostMessage.safeParse(run).success).toBe(true)
  })

  it.each([
    ['unknown type', { type: 'abort', id: 'r1' }],
    ['unknown lane', { type: 'init', protocol: 1, workerId: 'w', lane: 'gpu', logLevel: 'info' }],
    ['bad level', { type: 'init', protocol: 1, workerId: 'w', lane: 'toolpath', logLevel: 'loud' }],
    [
      'wasm not a buffer',
      { type: 'init', protocol: 1, workerId: 'w', lane: 'geometry', logLevel: 'info', wasm: 'x' },
    ],
    [
      '2D module not a buffer',
      {
        type: 'init',
        protocol: 1,
        workerId: 'w',
        lane: 'toolpath',
        logLevel: 'info',
        region2dWasm: 1,
      },
    ],
    [
      'control not shared',
      { type: 'run', id: 'r1', task: 't', input: 1, control: new ArrayBuffer(4) },
    ],
    ['empty id', { type: 'run', id: '', task: 't', input: 1, control }],
  ])('rejects %s', (_name, m) => {
    expect(HostMessage.safeParse(m).success).toBe(false)
  })
})

describe('worker → host messages', () => {
  const ok = [
    { type: 'ready', protocol: 1, workerId: 'w', initMs: 3, heapBytes: 16 },
    { type: 'ready', protocol: 1, workerId: 'w', initMs: 3 },
    { type: 'progress', id: 'r1', done: 1, total: 4, label: 'pocket1' },
    { type: 'progress', id: 'r1', done: 1 },
    { type: 'checkpoint', id: 'r1', state: 'paused', label: 'level 3/8' },
    { type: 'log', batch: [{ level: 'info', msg: 'x' }] },
    { type: 'result', id: 'r1', result: { ok: true, value: { a: 1 } }, stats: { ms: 1 } },
    {
      type: 'result',
      id: 'r1',
      result: {
        ok: false,
        error: { code: 'op.aborted', message: 'm', issues: [], frames: [{ where: 'x' }] },
      },
      stats: { ms: 1, heapBytes: 2, liveObjects: 0 },
    },
  ]
  it.each(ok.map((m) => [m.type, m]))('accepts %s', (_t, m) => {
    expect(WorkerMessage.safeParse(m).success).toBe(true)
  })

  it.each([
    ['unknown type', { type: 'hello' }],
    ['ready without protocol', { type: 'ready', workerId: 'w', initMs: 3 }],
    ['progress without done', { type: 'progress', id: 'r1' }],
    ['checkpoint bad state', { type: 'checkpoint', id: 'r1', state: 'stopped' }],
    ['log batch not an array', { type: 'log', batch: 'x' }],
    ['result without stats', { type: 'result', id: 'r1', result: { ok: true, value: 1 } }],
    [
      'result with an unknown error code',
      {
        type: 'result',
        id: 'r1',
        result: { ok: false, error: { code: 'nope', message: 'm', issues: [], frames: [] } },
        stats: { ms: 1 },
      },
    ],
  ])('rejects %s', (_name, m) => {
    expect(WorkerMessage.safeParse(m).success).toBe(false)
  })
})
