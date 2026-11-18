// Test-only rigs for GrblSender: the virtual machine on a VirtualClock, a transport wrapper that
// checks character counting independently, and a scripted fake transport for byte-level cases.
// Not app code. Doc: docs/modes/run-v0.1.md#testing
import { expect } from 'vitest'
import { fail, Ok, type AsyncAppResult } from '../../../shared/result'
import { expectOk } from '../../../shared/testing/result'
import { clockTimers, VirtualClock } from '../clock'
import type { ControllerTransport } from '../transport'
import { GrblEmulator, RX_BUFFER_SIZE, type EmulatorOptions } from './emulator/emulator'
import { FAST } from './emulator.fixture'
import {
  GrblSender,
  type PhaseChange,
  type RunProgress,
  type SenderEvent,
  type SenderOptions,
} from './sender'
import { VirtualGrblTransport } from './virtual-transport'

export const HOUR = 3_600_000
const text = (b: Uint8Array) => String.fromCharCode(...b)

/**
 * Wraps a transport and keeps its own character count: bytes of lines written minus the lines
 * acknowledged, so tests check the sender's arithmetic without trusting it.
 */
export class CountingTransport implements ControllerTransport {
  /** Most line bytes ever unacknowledged at once. */
  maxInflight = 0
  /** Every line received, in order. */
  readonly received: string[] = []
  readonly written: string[] = []
  /** Single-byte writes (real-time commands), in order. */
  readonly realtime: number[] = []
  /** Called after each write reached the controller, before any reply is delivered. */
  afterWrite: ((bytes: Uint8Array) => void) | undefined
  private used = 0
  private readonly sizes: number[] = []
  private rx = ''

  constructor(private readonly inner: ControllerTransport) {
    inner.onData((b) => this.observe(b))
  }

  write(bytes: Uint8Array): AsyncAppResult<void> {
    const t = text(bytes)
    if (bytes.length === 1 && !t.endsWith('\n')) this.realtime.push(bytes[0] ?? 0)
    if (t.endsWith('\n')) {
      this.written.push(t.slice(0, -1))
      this.sizes.push(bytes.length)
      this.used += bytes.length
      this.maxInflight = Math.max(this.maxInflight, this.used)
    }
    const r = this.inner.write(bytes)
    this.afterWrite?.(bytes)
    return r
  }

  onData(listener: (bytes: Uint8Array) => void): () => void {
    return this.inner.onData(listener)
  }

  close(): AsyncAppResult<void> {
    return this.inner.close()
  }

  private observe(b: Uint8Array): void {
    const parts = (this.rx + text(b)).split('\r\n')
    this.rx = parts.pop() ?? ''
    for (const l of parts) {
      if (l === '') continue
      this.received.push(l)
      if (l === 'ok' || l.startsWith('error:')) this.used -= this.sizes.shift() ?? 0
      if (l.startsWith('Grbl ')) {
        this.used = 0
        this.sizes.length = 0
      }
    }
  }
}

export interface Rig {
  readonly clock: VirtualClock
  readonly emu: GrblEmulator
  readonly io: CountingTransport
  readonly sender: GrblSender
  readonly events: SenderEvent[]
  readonly phases: PhaseChange[]
  readonly progress: RunProgress[]
}

/** Lets pending promise continuations run (the sender's API and the test's awaits). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

/** Advances virtual time timer by timer until `done()`; false if the limit passes first. */
export async function until(
  clock: VirtualClock,
  done: () => boolean,
  limitMs = HOUR,
): Promise<boolean> {
  const end = clock.now() + limitMs
  for (;;) {
    await flush()
    if (done()) return true
    let next = clock.nextAt()
    if (next === undefined) {
      // nothing scheduled: let every pending continuation run before giving up
      await new Promise((r) => setImmediate(r))
      if (done()) return true
      next = clock.nextAt()
    }
    if (next === undefined || next > end) return false
    clock.advanceTo(next)
  }
}

/** Drives the clock until `p` settles and returns its value. */
export async function drive<T>(clock: VirtualClock, p: Promise<T>, limitMs = HOUR): Promise<T> {
  let settled = false
  let value: T | undefined
  void p.then((v) => {
    settled = true
    value = v
  })
  expect(await until(clock, () => settled, limitMs)).toBe(true)
  return value as T
}

export function machine(options: EmulatorOptions = {}): GrblEmulator {
  return expectOk(
    GrblEmulator.create({ homing: false, ...options, settings: { ...FAST, ...options.settings } }),
  )
}

/** A sender on the virtual machine (`emu`), not yet connected. */
export function rig(emu: GrblEmulator, opts: Partial<SenderOptions> = {}): Rig {
  const clock = new VirtualClock()
  const io = new CountingTransport(new VirtualGrblTransport(emu, clock))
  const sender = new GrblSender(io, clock, { timers: clockTimers(clock), ...opts })
  const events: SenderEvent[] = []
  sender.onEvent((e) => events.push(e))
  return { clock, emu, io, sender, events, phases: [], progress: [] }
}

/** A connected sender on the virtual machine. */
export async function connected(
  emu: GrblEmulator,
  opts: Partial<SenderOptions> = {},
): Promise<Rig> {
  const r = rig(emu, opts)
  expectOk(await drive(r.clock, r.sender.connect()))
  return r
}

/** Starts a run that records phases and progress into the rig. */
export function start(
  r: Rig,
  lines: readonly string[],
  sections: { fromLine: number; label: string }[] = [],
) {
  return r.sender.run(
    { lines, sections },
    { phase: (p) => r.phases.push(p), progress: (p) => r.progress.push(p) },
  )
}

/**
 * A transport the test answers by hand: `writes` records what the sender wrote, `reply` delivers
 * bytes (in chunks as given), `failWrites` makes writes fail.
 */
export class ScriptedTransport implements ControllerTransport {
  readonly writes: string[] = []
  failWrites = false
  closed = false
  private readonly listeners = new Set<(b: Uint8Array) => void>()
  /** Called after each write (auto-responders). */
  onWrite: ((t: string) => void) | undefined

  write(bytes: Uint8Array): AsyncAppResult<void> {
    if (this.failWrites)
      return Promise.resolve(
        fail('machine.connection', 'port gone', { where: 'ScriptedTransport' }),
      )
    const t = text(bytes)
    this.writes.push(t)
    this.onWrite?.(t)
    return Promise.resolve(Ok(undefined))
  }

  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): AsyncAppResult<void> {
    this.closed = true
    return Promise.resolve(Ok(undefined))
  }

  reply(...chunks: string[]): void {
    for (const c of chunks) {
      const b = Uint8Array.from(c, (ch) => ch.charCodeAt(0))
      for (const l of [...this.listeners]) l(b)
    }
  }
}

/** The GRBL handshake answers for a ScriptedTransport (banner already sent by the test). */
export function answerHandshake(t: ScriptedTransport, version = '1.1h.20190830'): void {
  t.onWrite = (w) => {
    if (w === '$I\n') t.reply(`[VER:${version}:]\r\n[OPT:V,15,128]\r\nok\r\n`)
    else if (w === '$$\n') t.reply('$10=1\r\n$13=0\r\n$130=800.000\r\nok\r\n')
    else if (w === '$#\n') t.reply('[G54:0.000,0.000,0.000]\r\nok\r\n')
    else if (w === '$G\n') t.reply('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\r\nok\r\n')
    else if (w === '?') t.reply('<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>\r\n')
  }
}

/** Replies to every `?` with `report` (e.g. none after a critical alarm: `undefined`). */
export function answerStatus(t: ScriptedTransport, report: () => string | undefined): void {
  const handshake = t.onWrite
  t.onWrite = (w) => {
    if (w === '?') {
      const r = report()
      if (r !== undefined) t.reply(`${r}\r\n`)
    } else handshake?.(w)
  }
}

export { RX_BUFFER_SIZE }
