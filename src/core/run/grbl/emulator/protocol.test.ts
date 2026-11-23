// Protocol conformance of the virtual machine. Spec: docs/architecture/grbl.md#protocol-subset
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../../../shared/testing/result'
import { bytes, emulator, outLines, send, settle, statusOf } from '../emulator.fixture'
import { GrblEmulator } from './emulator'

const BANNER = "Grbl 1.1h ['$' for help]"
const UNLOCK = "[MSG:'$H'|'$X' to unlock]"

describe('startup', () => {
  it('starts in Alarm with the unlock message when homing is enabled (default)', () => {
    const emu = emulator({ homing: true })
    expect(emu.readOutput()).toBe(`\r\n${BANNER}\r\n${UNLOCK}\r\n`)
    expect(emu.status().state).toBe('Alarm')
    expect(send(emu, 'G0 X-1\n')).toEqual(['error:9'])
    expect(send(emu, '$X\n')).toEqual(['[MSG:Caution: Unlocked]', 'ok'])
    expect(emu.status().state).toBe('Idle')
  })

  it('starts Idle at MPos 0,0,0 without homing', () => {
    const emu = emulator()
    expect(outLines(emu)).toEqual([BANNER])
    expect(emu.status()).toMatchObject({ state: 'Idle', mpos: [0, 0, 0] })
    expect(send(emu, '$X\n')).toEqual(['ok'])
  })

  it('rejects unknown and invalid settings', () => {
    expectErrCode(GrblEmulator.create({ settings: { 7: 1 } }), 'model.invariant')
    expectErrCode(GrblEmulator.create({ settings: { 110: -1 } }), 'model.invariant')
    const e = expectErrCode(
      GrblEmulator.create({ homing: false, settings: { 20: 1 } }),
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toEqual(['softLimitsNeedHoming'])
  })
})

describe('lines and responses', () => {
  it('answers ok for empty and comment-only lines, one per end-of-line byte', () => {
    const emu = emulator()
    emu.readOutput()
    expect(send(emu, '\n(just a comment)\n; another\n')).toEqual(['ok', 'ok', 'ok'])
    expect(send(emu, '\r\n')).toEqual(['ok', 'ok'])
  })

  it('reports error:11 for a line over the 80-char line buffer and traces it', () => {
    const emu = emulator()
    emu.readOutput()
    const long = `G0X${'1'.repeat(80)}`
    expect(send(emu, `${long}\n`)).toEqual(['error:11'])
    expect(emu.trace.violations).toEqual([{ t: 0, kind: 'lineTooLong', detail: long }])
    // Spaces and comments do not count against the line buffer.
    expect(send(emu, `G0 X1 (${'c'.repeat(90)})\n`)).toEqual(['ok'])
  })

  it.each([
    ['1', 1],
    ['G', 2],
    ['G1.5 X1', 23],
    ['G81 X1 Y1 Z-1 R1 F100', 20],
    ['G28', 20],
    ['G92 X0', 20],
    ['G55', 20],
    ['G18', 20],
    ['G93', 20],
    ['G43.1 Z1', 20],
    ['M6 T2', 20],
    ['M8', 20],
    ['A1', 20],
    ['G10 L20 P2 X0', 20],
    ['G90 G91', 21],
    ['G0 G1 X1', 24],
    ['M3 M5', 21],
    ['G1 X1', 22],
    ['G2 X1 Y1 I1', 22],
    ['G0 X1 X2', 25],
    ['G0 X1 G10 L20 P1 X0', 24],
    ['G10 L20 P1', 26],
    ['G4', 28],
    ['G10 X1', 28],
    ['G10 P1 X1', 20],
    ['G10 L2 P1 R1 X0', 20],
    ['G2 X10 R5 I5 F100', 36],
    ['G0 G1.5 X1', 24],
    ['G91.1', 20],
    ['T300', 38],
    ['F-1', 4],
    ['S-1', 4],
    ['G53 G2 X1 Y1 I1 F100', 30],
    ['G0 X1 I1', 36],
    ['G4 P1 L2', 36],
    ['G2 Z1 I1 F100', 32],
    ['G2 X10 F100', 35],
    ['G2 X10 I1 F100', 33],
    ['G2 X10 R2 F100', 34],
  ])('%s → error:%i', (line, code) => {
    const emu = emulator()
    emu.readOutput()
    expect(send(emu, `${line}\n`)).toEqual([`error:${code}`])
    expect(emu.status().state).toBe('Idle')
  })

  it('accepts the post-processor subset and leaves state unchanged on error', () => {
    const emu = emulator()
    emu.readOutput()
    const program = [
      '(DFYOM program header)',
      'G90 G94 G17 G21',
      'G54',
      'T2',
      'N10 G0 Z5',
      'G1 X1 F100',
      'g1 y1',
      'G2 X2 Y0 I0 J-1',
      'G3 X1 Y1 I-1 J0',
      'G4 P0',
      'G20',
      'G21 G91 G0 X1',
      'G90',
      'G53 G0 Z0',
      'G10 L2 P1 X0',
      'G10 L20 X0',
      'M3 S1000',
      'M4',
      'M5',
    ]
    for (const l of program) {
      emu.receive(bytes(`${l}\n`))
      settle(emu) // the arcs fill the planner: their ok comes when blocks finish
      expect(outLines(emu), l).toEqual(['ok'])
    }
    expect(send(emu, 'G91 G1 X1 F0\n')).toEqual(['error:22'])
    expect(send(emu, '$G\n')).toEqual(['[GC:G0 G54 G17 G21 G90 G94 M5 M9 T2 F100 S1000]', 'ok'])
  })
})

describe('status report', () => {
  it('rotates WCO and Ov fields like GRBL (idle: every 10 reports)', () => {
    const emu = emulator()
    const reports = Array.from({ length: 12 }, () => statusOf(emu))
    expect(reports[0]).toBe('<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>')
    expect(reports[1]).toBe('<Idle|MPos:0.000,0.000,0.000|FS:0,0|Ov:100,100,100>')
    expect(reports[2]).toBe('<Idle|MPos:0.000,0.000,0.000|FS:0,0>')
    expect(reports[10]).toContain('|WCO:')
    expect(reports[11]).toContain('|Ov:')
  })

  it('reports WPos and the buffer state per $10, and inches per $13', () => {
    const emu = emulator()
    send(emu, 'G10 L20 P1 X-10 Y0 Z0\n')
    expect(send(emu, '$10=2\n')).toEqual(['ok'])
    expect(statusOf(emu)).toBe(
      '<Idle|WPos:-10.000,0.000,0.000|Bf:15,128|FS:0,0|WCO:10.000,0.000,0.000>',
    )
    send(emu, '$10=1\n')
    send(emu, '$13=1\n')
    expect(statusOf(emu)).toMatch(/^<Idle\|MPos:0\.0000,0\.0000,0\.0000\|FS:0\.0,0\|WCO:0\.3937,/)
  })

  it('shows the running spindle speed clamped to $30 and the accessory state', () => {
    const emu = emulator({ settings: { 30: 24000, 31: 5000 } })
    send(emu, 'M3 S30000\n')
    statusOf(emu)
    const r = statusOf(emu)
    expect(r).toBe('<Idle|MPos:0.000,0.000,0.000|FS:0,24000|Ov:100,100,100|A:S>')
    send(emu, 'S1000\n')
    expect(statusOf(emu)).toContain('FS:0,5000')
    send(emu, String.fromCharCode(0x9b)) // spindle override −10 %
    expect(emu.status().spindleSpeed).toBe(5000)
    send(emu, 'S20000\n')
    expect(emu.status().spindleSpeed).toBe(18000)
    send(emu, 'M5\n')
    expect(emu.status().spindleSpeed).toBe(0)
  })
})

describe('$ commands', () => {
  it('prints help, settings, modes, build info and parameters', () => {
    const emu = emulator()
    emu.readOutput()
    expect(send(emu, '$\n')).toEqual([
      '[HLP:$$ $# $G $I $N $x=val $Nx=line $J=line $SLP $C $X $H ~ ! ? ctrl-x]',
      'ok',
    ])
    const settings = send(emu, '$$\n')
    expect(settings).toContain('$10=1')
    expect(settings).toContain('$11=0.010')
    expect(settings).toContain('$12=0.002')
    expect(settings).toContain('$20=0')
    expect(settings).toContain('$22=0')
    expect(settings).toContain('$30=1000')
    expect(settings).toContain('$110=6000.000')
    expect(settings).toContain('$120=100.000')
    expect(settings.at(-1)).toBe('ok')
    expect(send(emu, '$G\n')).toEqual(['[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]', 'ok'])
    expect(send(emu, '$I\n')).toEqual(['[VER:1.1h.20190830:]', '[OPT:V,15,128]', 'ok'])
    send(emu, 'G10 L2 P1 X-1.5\n')
    const params = send(emu, '$#\n')
    expect(params[0]).toBe('[G54:-1.500,0.000,0.000]')
    expect(params).toContain('[PRB:0.000,0.000,0.000:0]')
    expect(params.at(-1)).toBe('ok')
  })

  it.each([
    ['$110=1000', 'ok'],
    ['$13=1', 'ok'],
    ['$999=1', 'error:3'],
    ['$7=1', 'error:3'],
    ['$1=-1', 'error:4'],
    ['$1=', 'error:2'],
    ['$Q', 'error:2'],
    ['$1', 'error:3'],
    ['$20=1', 'error:10'],
    ['$H', 'error:5'],
    ['$GX', 'error:3'],
    ['$#1', 'error:3'],
    ['$N', 'error:3'],
    ['$SLP', 'error:3'],
    ['$RST=*', 'error:3'],
  ])('%s → %s', (line, response) => {
    const emu = emulator()
    emu.readOutput()
    expect(send(emu, `${line}\n`).at(-1)).toBe(response)
  })

  it('applies $22=0 by clearing soft limits, and $20 needs homing', () => {
    const emu = emulator({ homing: true })
    send(emu, '$X\n')
    expect(send(emu, '$22=0\n')).toEqual(['ok'])
    expect(send(emu, '$$\n')).toContain('$20=0')
    expect(send(emu, '$20=1\n')).toEqual(['error:10'])
  })

  it('check mode parses without moving and leaves with a soft reset', () => {
    const emu = emulator()
    emu.readOutput()
    expect(send(emu, '$C\n')).toEqual(['[MSG:Enabled]', 'ok'])
    expect(emu.status().state).toBe('Check')
    expect(send(emu, 'G1 X10 F100\nG4 P5\nM0\nG81\n')).toEqual(['ok', 'ok', 'ok', 'error:20'])
    expect(emu.nextEventAt()).toBeUndefined()
    expect(emu.status().mpos).toEqual([0, 0, 0])
    expect(send(emu, '$H\n')).toEqual(['error:8'])
    expect(send(emu, '$C\n')).toEqual(['[MSG:Disabled]', 'ok', BANNER])
    expect(emu.status().state).toBe('Idle')
    expect(send(emu, '$G\n')[0]).toBe('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]')
  })

  it('blocks $$ while running and settings writes outside Idle/Alarm', () => {
    const emu = emulator()
    emu.readOutput()
    send(emu, 'G1 X100 F600\n')
    expect(send(emu, '$$\n')).toEqual(['error:8'])
    expect(send(emu, '$110=1\n')).toEqual(['error:8'])
    expect(send(emu, '$J=X1 F100\n')).toEqual(['error:8'])
    expect(send(emu, '$G\n')[1]).toBe('ok')
  })
})

describe('homing, alarms and reset', () => {
  it('homes with $H: Home state, ok when done, MPos −$27 per axis', () => {
    const emu = emulator({ homing: true })
    emu.readOutput()
    expect(send(emu, '$H\n')).toEqual([])
    expect(emu.status().state).toBe('Home')
    expect(send(emu, 'G0 X-1\n')).toEqual([]) // waits in RX until homing is done
    // Z then XY cycle from the switches (MPos 0): each pulls off 1 mm at $25 = 500 mm/min,
    // locates 1 mm at $24 = 25 mm/min and pulls off again: 0.12 + 2.4 + 0.12 s = 2.64 s.
    emu.advanceTo(5279)
    expect(outLines(emu)).toEqual([])
    emu.advanceTo(5280)
    expect(outLines(emu)).toEqual(['ok', 'ok'])
    expect(emu.trace.samples.find((x) => x.state === 'Idle')?.mpos).toEqual([-1, -1, -1])
    expect(emu.status().state).toBe('Idle') // G0 X-1 from X-1: nothing to do
    expect(emu.trace.transitions.map((t) => t.to)).toEqual(['Home', 'Idle'])
  })

  it('homes per the homing direction mask ($23) and pull-off ($27), moving in Home reports', () => {
    // travel 200 (defaults); X and Z home to +, Y to − ($23=2: front), pull-off 2 mm
    const emu = expectOk(
      GrblEmulator.create({
        homing: true,
        settings: { 23: 2, 27: 2 },
        position: [-100, -100, -50],
      }),
    )
    emu.readOutput()
    expect(emu.status().mpos).toEqual([-100, -100, -50])
    send(emu, '$H\n')
    // Z approaches its switch at 0 first (50 mm at 500 mm/min = 6 s): halfway after 3 s
    emu.advanceTo(3000)
    expect(emu.status()).toMatchObject({ state: 'Home', mpos: [-100, -100, -25] })
    const zDone = 6000 + (2 / 500 + 2 / 25 + 2 / 500) * 60_000
    // XY together: X to + (100 mm), Y to − (100 mm to −200), each at $25
    emu.advanceTo(zDone + 6000)
    const mid = emu.status().mpos
    expect(mid[0]).toBeCloseTo(-50, 6)
    expect(mid[1]).toBeCloseTo(-150, 6)
    expect(mid[2]).toBeCloseTo(-2, 6)
    settle(emu)
    expect(outLines(emu)).toEqual(['ok'])
    expect(emu.status()).toMatchObject({ state: 'Idle', mpos: [-2, -198, -2] })
    // soft limits stay [−travel, 0] for every direction: Y−3 leaves the travel
    expect(send(emu, '$J=G91 Y-3 F100\n')).toEqual(['error:15'])
    expect(send(emu, '$J=G91 Y-2 F100\n')).toEqual(['ok'])
  })

  it('a reset while homing (ALARM:6) leaves the position where the cycle was', () => {
    const emu = expectOk(GrblEmulator.create({ homing: true, position: [-100, -100, -50] }))
    emu.readOutput()
    send(emu, '$H\n')
    emu.advanceTo(3000)
    expect(send(emu, '\x18')[0]).toBe('ALARM:6')
    expect(emu.status().mpos).toEqual([-100, -100, -25])
    expect(emu.nextEventAt()).toBeUndefined()
  })

  it('soft reset during motion raises ALARM:3 and locks', () => {
    const emu = emulator()
    emu.readOutput()
    send(emu, 'G1 X100 F600\n')
    emu.advance(1000)
    expect(send(emu, '\x18')).toEqual(['ALARM:3', BANNER, UNLOCK])
    expect(emu.status().state).toBe('Alarm')
    expect(emu.nextEventAt()).toBeUndefined()
    expect(send(emu, 'G0 X0\n')).toEqual(['error:9'])
  })

  it('soft reset in Hold:0 keeps position and goes Idle without an alarm', () => {
    const emu = emulator()
    emu.readOutput()
    send(emu, 'G1 X100 F600\n')
    emu.advance(1000)
    send(emu, '!')
    settle(emu)
    const pos = emu.status().mpos
    expect(emu.status().state).toBe('Hold:0')
    expect(send(emu, '\x18')).toEqual([BANNER])
    expect(emu.status()).toMatchObject({ state: 'Idle', mpos: pos })
    expect(send(emu, '$G\n')[0]).toBe('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]')
  })

  it('soft reset while homing raises ALARM:6', () => {
    const emu = emulator({ homing: true })
    emu.readOutput()
    send(emu, '$H\n')
    emu.advance(100)
    expect(send(emu, '\x18')).toEqual(['ALARM:6', BANNER, UNLOCK])
  })

  it('a gCode target outside soft limits raises ALARM:2 and needs a reset', () => {
    const emu = emulator({ homing: true })
    send(emu, '$H\n')
    settle(emu)
    emu.readOutput()
    expect(send(emu, 'G0 X1\n')).toEqual(['ALARM:2', '[MSG:Reset to continue]'])
    expect(send(emu, '?$X\n')).toEqual([]) // GRBL waits for the reset only
    expect(send(emu, '\x18')).toEqual([BANNER, UNLOCK])
    expect(emu.status().state).toBe('Alarm')
    expect(send(emu, '$X\n')).toEqual(['[MSG:Caution: Unlocked]', 'ok'])
  })

  it('soft limit during motion: decelerates first, then alarms, keeping position', () => {
    const emu = emulator({ homing: true })
    send(emu, '$H\n')
    settle(emu)
    emu.readOutput()
    expect(send(emu, 'G1 X-100 F3000\n')).toEqual(['ok'])
    emu.advance(500) // at 50 mm/s after 12.5 mm, from the homed X−1
    expect(send(emu, 'G1 X-100 Y-2000\n')).toEqual([])
    expect(emu.status().state).toBe('Hold:1')
    settle(emu)
    expect(outLines(emu)).toEqual(['ALARM:2', '[MSG:Reset to continue]'])
    // Stopped after another 12.5 mm of deceleration; ALARM:2 keeps the position.
    expect(emu.status().mpos[0]).toBeCloseTo(-26, 6)
    expect(emu.status().state).toBe('Alarm')
    send(emu, '\x18')
    expect(emu.status().mpos[0]).toBeCloseTo(-26, 6)
  })

  it('soft limit check covers check mode', () => {
    const emu = emulator({ homing: true })
    send(emu, '$X\n$C\n')
    emu.readOutput()
    expect(send(emu, 'G0 Z1\n')).toEqual(['ALARM:2', '[MSG:Reset to continue]'])
  })
})

describe('realtime bytes and buffers', () => {
  it('drops bytes beyond the RX buffer and records the overflow', () => {
    const emu = emulator()
    emu.readOutput()
    send(emu, `G1 X100 F60\n`)
    // The planner is not full, so lines run as they arrive; a line without EOL fills RX.
    send(emu, `(${'x'.repeat(140)}`)
    expect(emu.status().rxFree).toBe(0)
    expect(emu.trace.violations.filter((v) => v.kind === 'rxOverflow')).toHaveLength(13)
  })

  it('uses all 128 RX bytes (the GRBL ring buffer has one spare slot)', () => {
    const emu = emulator()
    emu.readOutput()
    send(emu, '!') // suspended: lines stay in RX
    send(emu, `(${'x'.repeat(126)}\n`)
    expect(emu.status().rxFree).toBe(0)
    expect(emu.trace.violations).toEqual([])
    expect(send(emu, '~')).toEqual(['ok'])
  })

  it('records non-ASCII bytes inside a line and acts on realtime bytes in comments', () => {
    const emu = emulator()
    emu.readOutput()
    send(emu, 'G1 X100 F600\n')
    emu.advance(500)
    const out = send(emu, '(Ã¸ dia ?)\n')
    expect(out[0]).toMatch(/^<Run\|/)
    expect(out[1]).toBe('ok')
    expect(emu.trace.violations.map((v) => [v.kind, v.detail])).toEqual([
      ['nonAscii', '0xc3'],
      ['nonAscii', '0xb8'],
    ])
  })

  it('applies feed and rapid overrides and reports them', () => {
    const emu = emulator()
    statusOf(emu)
    send(emu, '\x91\x91\x94\x97')
    expect(statusOf(emu)).toContain('|Ov:119,25,100')
    send(emu, '\x90\x95')
    for (let i = 0; i < 25; i++) send(emu, '\x92')
    expect(statusOf(emu)).toContain('|Ov:10,100,100')
  })

  it('ignores unknown extended bytes', () => {
    const emu = emulator()
    emu.readOutput()
    expect(send(emu, '\xa0\xff')).toEqual([])
    expect(emu.trace.violations).toEqual([])
  })

  it('pauses with ! in Idle (Hold:0) and resumes with ~', () => {
    const emu = emulator()
    emu.readOutput()
    send(emu, '!')
    expect(emu.status().state).toBe('Hold:0')
    expect(send(emu, 'G0 X1\n')).toEqual([]) // GRBL processes no lines while suspended
    expect(send(emu, '~')).toEqual(['ok'])
    expect(emu.status().state).toBe('Run')
  })

  it('encodes positions without negative zero', () => {
    const emu = emulator()
    send(emu, 'G10 L20 P1 X0.0001\n')
    send(emu, '$10=0\n')
    expect(statusOf(emu)).toContain('WPos:0.000,0.000,0.000')
    expect(bytes('A')).toEqual(Uint8Array.of(65))
  })
})

describe('GRBL source fidelity', () => {
  it('M2/M30 restore the feed, rapid and spindle overrides', () => {
    const emu = emulator()
    send(emu, '\x91\x96\x9a')
    send(emu, 'M30\n')
    statusOf(emu)
    expect(statusOf(emu)).toContain('|Ov:100,100,100')
  })

  it('keeps reading and planning lines while decelerating in Hold:1', () => {
    const emu = emulator()
    emu.readOutput()
    send(emu, 'G1 X100 F3000\n')
    emu.advance(1000)
    send(emu, '!')
    expect(emu.status().state).toBe('Hold:1')
    expect(send(emu, 'G1 X200\n')).toEqual(['ok'])
    expect(emu.status().plannerFree).toBe(13)
    settle(emu)
    expect(emu.status().state).toBe('Hold:0')
    expect(send(emu, 'G1 X300\n')).toEqual([]) // suspended once stopped
    send(emu, '~')
    settle(emu)
    expect(emu.status().mpos).toEqual([300, 0, 0])
  })

  it('records nothing with trace: false', () => {
    const emu = emulator({ trace: false })
    send(emu, `G1 X10 F600\n(Ã)\nG0X${'1'.repeat(80)}\n`)
    settle(emu)
    expect(emu.trace).toEqual({
      lines: [],
      samples: [],
      responses: [],
      transitions: [],
      violations: [],
    })
  })
})
