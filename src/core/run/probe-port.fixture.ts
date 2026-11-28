// Test-only: a probe port straight onto the virtual machine's emulator (each line runs to its
// `ok`/`error`), for the probe-cycle runner and the routines. Doc: docs/modes/run-probing.md
import { fail, Ok } from '../../shared/result'
import { bytes, outLines, settle, statusOf } from './grbl/emulator.fixture'
import type { GrblEmulator } from './grbl/emulator/emulator'
import type { ProbePort } from './probe-cycle'

/** A port straight onto the emulator: each line runs to its `ok`/`error`. */
export function emuPort(
  emu: GrblEmulator,
  opts: { duringProbe?: (emu: GrblEmulator) => boolean } = {},
) {
  const sent: string[] = []
  const listeners = new Set<(code: number) => void>()
  const port: ProbePort = {
    status: () => {
      const s = emu.status()
      const pins = /\|Pn:([A-Z]+)/.exec(statusOf(emu))?.[1]
      return Promise.resolve(
        Ok({
          state: s.state,
          mpos: s.mpos,
          wpos: [s.mpos[0] - s.wco[0], s.mpos[1] - s.wco[1], s.mpos[2] - s.wco[2]] as const,
          spindle: s.spindleSpeed,
          ...(pins === undefined ? {} : { pins }),
        }),
      )
    },
    command: (line) => {
      sent.push(line)
      emu.receive(bytes(`${line}\n`))
      if (line.includes('G38') && opts.duringProbe?.(emu) === true) {
        // Stop: feed hold + reset; the line in flight fails as the sender's would
        emu.receive(Uint8Array.of(0x21))
        emu.advance(500)
        emu.receive(Uint8Array.of(0x18))
        outLines(emu)
        return Promise.resolve(fail('machine.reset', 'reset during the line', { where: 'test' }))
      }
      settle(emu)
      const out = outLines(emu)
      for (const l of out) {
        const m = /^ALARM:(\d+)$/.exec(l)
        if (m) for (const f of listeners) f(Number(m[1]))
      }
      const err = out.find((l) => l.startsWith('error:'))
      if (err !== undefined) return Promise.resolve(fail('machine.error', err, { where: 'test' }))
      return Promise.resolve(Ok(out))
    },
    onAlarm: (f) => {
      listeners.add(f)
      return () => listeners.delete(f)
    },
    unlock: () => {
      sent.push('$X')
      emu.receive(bytes('$X\n'))
      outLines(emu)
      return Promise.resolve(Ok(undefined))
    },
  }
  return { port, sent }
}
