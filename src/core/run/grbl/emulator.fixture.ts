// Test-only helpers for the virtual machine: direct byte I/O. Not app code; streaming tests use
// GrblSender (sender.fixture.ts). Doc: docs/architecture/grbl.md
import { expectOk } from '../../../shared/testing/result'
import { GrblEmulator, type EmulatorOptions } from './emulator/emulator'

export const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))

/** Fast machine for timing tests: 100 mm/s² on every axis, 6000 mm/min max rate, 1 m travel. */
export const FAST: Readonly<Record<number, number>> = {
  110: 6000,
  111: 6000,
  112: 6000,
  120: 100,
  121: 100,
  122: 100,
  130: 1000,
  131: 1000,
  132: 1000,
}

export function emulator(options: EmulatorOptions = {}): GrblEmulator {
  return expectOk(
    GrblEmulator.create({ homing: false, ...options, settings: { ...FAST, ...options.settings } }),
  )
}

/** Sends text at the current time and returns the output lines it produced right away. */
export function send(emu: GrblEmulator, text: string): string[] {
  emu.receive(bytes(text))
  return outLines(emu)
}

export function outLines(emu: GrblEmulator): string[] {
  return emu
    .readOutput()
    .split('\r\n')
    .filter((l) => l !== '')
}

/** Runs every pending event (until the machine waits for input). */
export function settle(emu: GrblEmulator, limitMs = 3_600_000): void {
  const end = emu.time + limitMs
  for (let t = emu.nextEventAt(); t !== undefined && t <= end; t = emu.nextEventAt()) {
    emu.advanceTo(t)
  }
}

export function statusOf(emu: GrblEmulator): string {
  const out = send(emu, '?')
  const s = out.find((l) => l.startsWith('<'))
  if (s === undefined) throw new Error(`no status report in ${JSON.stringify(out)}`)
  return s
}
