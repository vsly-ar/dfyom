// Jogs through the workholding guard (hardening DF133 RW3): the `run.machine.jog` arguments a
// step and a hold become (today's command without a contact, the stop point as `{ to }` with one,
// nothing when blocked; the frame conversion; rounding towards the start), and on the virtual
// machine (GRBL emulator, in-process host, real timers): a step and a held jog toward a block stop
// at the margin in Idle and never at the travel edge, an unguarded jog (past once, guard off) goes
// through once and the next guarded one stops again, and moving out is allowed.
// Doc: docs/modes/run-workholding.md#jogs, #implementation-rw3
import { afterEach, describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { Ok, type AppResult } from '../../shared/result'
import { createDispatcher } from '../commands/dispatcher'
import { createInProcessWorkers } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { agentSource, fakeIds } from '../commands/testing'
import { planSetup } from '../plan/plan.fixture'
import { toolEnvelope } from '../plan/workholding/envelope'
import type { Footprint, Prism } from '../plan/workholding/obstacles'
import { createToolpathCache } from '../toolpath/cache'
import type { Vec3 } from '../toolpath/model'
import { systemTimerHost } from './clock'
import {
  guardedJog,
  MIN_JOG_MM,
  plainJogArgs,
  type GuardSetup,
  type JogArgs,
  type JogRequest,
} from './guarded-jog'
import { MachineClient } from './host/client'
import { inProcessHostFactory } from './host/in-process'
import type { RunStatus } from './service'

const rect = (x0: number, y0: number, x1: number, y1: number): Footprint => ({
  kind: 'polygon',
  points: [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ],
})
/** A block from X20 to X30, Y−10 to Y10 (setup frame), 20 tall: taller than the tool's Z. */
const BLOCK: Prism = { itemId: 'wh1', footprint: rect(20, -10, 30, 10), zMin: -40, zMax: 20 }
/** A Ø6 tool (WH-F: no holder), margin 2: X+ stops with the axis at 20 − 2 − 3 = 15. */
const SETUP: GuardSetup = {
  envelope: toolEnvelope({ diameter: 6 }, undefined, undefined),
  prisms: [BLOCK],
  margin: 2,
}
const ZERO: Vec3 = [0, 0, 0]
const step = (axis: 0 | 1 | 2, mm: number): JogRequest => ({ kind: 'step', axis, mm, feed: 2000 })
const hold = (axis: 0 | 1 | 2, sign: 1 | -1): JogRequest => ({
  kind: 'hold',
  axis,
  sign,
  feed: 2000,
})

describe('guardedJog: the jog command', () => {
  it('without a contact: exactly today’s step and continuous jog', () => {
    const away = guardedJog({
      request: step(0, -10),
      from: ZERO,
      wco: ZERO,
      offset: ZERO,
      setup: SETUP,
    })
    expect(away).toEqual({ kind: 'send', args: { by: [-10, 0, 0], feed: 2000 }, end: [-10, 0, 0] })
    expect(plainJogArgs(step(2, 5))).toEqual({ by: [0, 0, 5], feed: 2000 })
    const held = guardedJog({
      request: hold(1, 1),
      from: [-100, -100, -50],
      wco: [-100, -100, -50],
      offset: ZERO,
      travel: [300, 300, 100],
      setup: SETUP,
    })
    expect(held).toEqual({
      kind: 'send',
      args: { by: [0, 1, 0], feed: 2000, continuous: true },
      end: [-100, 0, -50],
    })
    // the travel unknown: today's continuous jog (the host refuses it, as today)
    const unknown = guardedJog({
      request: hold(0, 1),
      from: ZERO,
      wco: ZERO,
      offset: ZERO,
      setup: SETUP,
    })
    expect(unknown).toEqual({ kind: 'send', args: { by: [1, 0, 0], feed: 2000, continuous: true } })
  })

  it('a step into the block: { to } at the stop point, rounded towards the start', () => {
    const r = guardedJog({
      request: step(0, 50),
      from: ZERO,
      wco: ZERO,
      offset: ZERO,
      setup: SETUP,
    })
    expect(r.kind).toBe('send')
    if (r.kind !== 'send') return
    expect(r.args.by).toBeUndefined()
    expect(r.args.continuous).toBeUndefined()
    const to = r.args.to!
    expect(to[0]).toBeLessThan(15)
    expect(to[0]).toBeGreaterThanOrEqual(15 - 0.02)
    expect(Math.round(to[0] * 1000)).toBeCloseTo(to[0] * 1000, 6)
    expect([to[1], to[2]]).toEqual([0, 0])
    expect(r.end).toEqual(to)
    expect(r.contact).toMatchObject({ itemId: 'wh1', part: 'tool' })
  })

  it('the frame: MPos − WCO + the setup offset, and back', () => {
    // G54 at machine (−200, −150, −40), the setup's zero at (5, 0) in the setup frame, Z0 3 mm low
    const wco: Vec3 = [-200, -150, -40]
    const offset: Vec3 = [5, 0, -3]
    // the tip at setup (0, 0, 5): machine = setup − offset + wco
    const from: Vec3 = [-205, -150, -32]
    const r = guardedJog({ request: step(0, 50), from, wco, offset, setup: SETUP })
    if (r.kind !== 'send') throw new Error('blocked')
    // setup X 15 = machine X 15 − 5 − 200 = −190
    expect(r.args.to![0]).toBeLessThan(-190)
    expect(r.args.to![0]).toBeGreaterThanOrEqual(-190 - 0.02)
    expect([r.args.to![1], r.args.to![2]]).toEqual([-150, -32])
  })

  it('a hold toward the block: { to } at the stop point instead of the travel edge', () => {
    const r = guardedJog({
      request: hold(0, 1),
      from: [-100, 0, 0],
      wco: [-100, 0, 0],
      offset: ZERO,
      travel: [300, 300, 100],
      setup: SETUP,
    })
    if (r.kind !== 'send') throw new Error('blocked')
    expect(r.args.continuous).toBeUndefined()
    expect(r.args.to![0]).toBeLessThan(-85)
    expect(r.args.to![0]).toBeGreaterThanOrEqual(-85 - 0.02)
  })

  it('at the stop point: blocked further in, free to move out (and along it)', () => {
    const at: Vec3 = [14.99, 0, 0]
    expect(
      guardedJog({ request: step(0, 1), from: at, wco: ZERO, offset: ZERO, setup: SETUP }).kind,
    ).toBe('blocked')
    expect(
      guardedJog({
        request: hold(0, 1),
        from: [-85.01, 0, 0],
        wco: [-100, 0, 0],
        offset: ZERO,
        travel: [1e3, 1e3, 1e3],
        setup: SETUP,
      }),
    ).toMatchObject({ kind: 'blocked', contact: { itemId: 'wh1' } })
    const out = guardedJog({
      request: step(0, -5),
      from: at,
      wco: ZERO,
      offset: ZERO,
      setup: SETUP,
    })
    expect(out).toMatchObject({ kind: 'send', args: { by: [-5, 0, 0] } })
    // up and over the 20 mm block: Z+ free
    expect(
      guardedJog({ request: step(2, 30), from: at, wco: ZERO, offset: ZERO, setup: SETUP }),
    ).toMatchObject({ kind: 'send', args: { by: [0, 0, 30] } })
    // inside the margin (an unguarded jog took it there): deeper refused, out allowed
    const inside: Vec3 = [16.5, 0, 0]
    expect(
      guardedJog({ request: step(0, 0.5), from: inside, wco: ZERO, offset: ZERO, setup: SETUP })
        .kind,
    ).toBe('blocked')
    expect(
      guardedJog({ request: step(0, -1), from: inside, wco: ZERO, offset: ZERO, setup: SETUP }),
    ).toMatchObject({ kind: 'send', args: { by: [-1, 0, 0] } })
    expect(MIN_JOG_MM).toBeGreaterThan(0)
  })
})

// ── on the virtual machine ──────────────────────────────────────────────────────────────────────

const clients: MachineClient[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(5)
  }
  return cond()
}

async function virtualMachine() {
  const s = await planSetup()
  const client = new MachineClient({
    factory: inProcessHostFactory({ timers: systemTimerHost }),
    logLevel: 'warn',
  })
  clients.push(client)
  const d = createDispatcher({
    registry: expectOk(createAppRegistry()),
    doc: s.d.doc,
    revision: s.d.revision,
    ids: fakeIds(),
    services: {
      workers: createInProcessWorkers(),
      library: s.library,
      toolpaths: createToolpathCache(),
      exportFiles: { write: async (target) => Ok({ filePath: target }) },
      machine: client,
    },
  })
  const agent = agentSource()
  const run = async (name: string, args: object): Promise<AppResult<unknown>> =>
    (await d.dispatch(name, args, agent)).map((o) => o.value)
  const status = () => expectOk(d.query('run.status.get', {}, agent)).value as RunStatus
  expectOk(
    await run('run.connection.open', {
      target: 'virtual',
      machineId: s.machineId,
      timeScale: 'max',
    }),
  )
  const { jobId } = expectOk(await run('run.machine.home', {})) as { jobId: string }
  expectOk(await d.job(jobId).unwrap().result)
  /** A jog's ok comes before its motion: wait for Idle at its end (or Idle after `ms`). */
  const settle = async (end?: Vec3) =>
    expect(
      await waitFor(
        () =>
          status().state === 'Idle' &&
          (end === undefined || status().mpos.every((v, i) => Math.abs(v - end[i]!) < 5e-4)),
      ),
    ).toBe(true)
  const send = async (args: JogArgs) => {
    expectOk(await run('run.machine.jog', args))
  }
  /** The guarded jog from where the machine is, as the run store builds it. */
  const guarded = (request: JogRequest) => {
    const st = status()
    const wco: Vec3 = [st.mpos[0] - st.wpos[0], st.mpos[1] - st.wpos[1], st.mpos[2] - st.wpos[2]]
    return guardedJog({
      request,
      from: st.mpos,
      wco,
      offset: ZERO,
      ...(st.envelope === undefined ? {} : { travel: st.envelope.travel }),
      setup: SETUP,
    })
  }
  // the work zero 10 mm under the tip, somewhere in the middle of the travel
  await send({ to: [-200, -150, -30], feed: 5000 })
  await settle([-200, -150, -30])
  expectOk(await run('run.workZero.set', { axes: ['x', 'y', 'z'], values: [0, 0, 10] }))
  await waitFor(() => status().wpos[2] === 10)
  return { run, status, settle, send, guarded }
}

describe('guarded jogs on the virtual machine (DF133 RW3)', { timeout: 60_000 }, () => {
  it('a step toward the block stops at the margin; further in is blocked; moving out is allowed', async () => {
    const t = await virtualMachine()
    expect(t.status().wpos).toEqual([0, 0, 10])
    const r = t.guarded(step(0, 50))
    if (r.kind !== 'send' || r.end === undefined) throw new Error('not sent')
    await t.send(r.args)
    await t.settle(r.end)
    const x = t.status().wpos[0]
    expect(x).toBeLessThan(15)
    expect(x).toBeGreaterThanOrEqual(15 - 0.02)
    expect(t.guarded(step(0, 10)).kind).toBe('blocked')
    const out = t.guarded(step(0, -5))
    expect(out).toMatchObject({ kind: 'send', args: { by: [-5, 0, 0] } })
    if (out.kind !== 'send') return
    await t.send(out.args)
    await t.settle(out.end)
    expect(t.status().wpos[0]).toBeCloseTo(x - 5, 3)
  })

  it('a held jog toward the block ends in Idle at the stop point, never at the travel edge', async () => {
    const t = await virtualMachine()
    const r = t.guarded(hold(0, 1))
    if (r.kind !== 'send' || r.end === undefined) throw new Error('not sent')
    expect(r.args.continuous).toBeUndefined()
    await t.send(r.args)
    await t.settle(r.end)
    expect(t.status().mpos[0]).toBeLessThan(0)
    expect(t.status().wpos[0]).toBeLessThan(15)
    expect(t.status().wpos[0]).toBeGreaterThanOrEqual(15 - 0.02)
    // away from the block: today's continuous jog to the travel edge
    const away = t.guarded(hold(1, 1))
    expect(away).toMatchObject({ kind: 'send', args: { continuous: true } })
  })

  it('an unguarded jog (past once, guard off) goes through once; the next guarded one stops', async () => {
    const t = await virtualMachine()
    const first = t.guarded(step(0, 50))
    if (first.kind !== 'send') throw new Error('blocked')
    await t.send(first.args)
    await t.settle(first.end)
    // "Jog past once": today's command, as asked
    const m = t.status().mpos
    await t.send(plainJogArgs(step(0, 3)))
    await t.settle([m[0] + 3, m[1], m[2]])
    expect(t.status().wpos[0]).toBeGreaterThan(17)
    // re-armed: starting inside the margin, further in is refused, out is allowed
    expect(t.guarded(step(0, 1))).toMatchObject({ kind: 'blocked', contact: { itemId: 'wh1' } })
    expect(t.guarded(step(0, -1))).toMatchObject({ kind: 'send', args: { by: [-1, 0, 0] } })
  })
})
