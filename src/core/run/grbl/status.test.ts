// Parsers against report strings from the GRBL 1.1 wiki and the emulator.
// Spec: docs/modes/run-v0.1.md#testing (Parsers)
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { GrblEmulator } from './emulator/emulator'
import { outLines, send } from './emulator.fixture'
import {
  alarmText,
  errorText,
  parseLine,
  parseModes,
  parseParameters,
  parseSettings,
  parseStatusReport,
  parseVersion,
  positions,
  stateText,
} from './status'

describe('parseLine', () => {
  it('classifies acknowledgements, alarms, messages, feedback, settings and the banner', () => {
    expect(parseLine('ok')).toEqual({ kind: 'ok' })
    expect(parseLine('error:22')).toEqual({ kind: 'error', code: 22 })
    expect(parseLine('ALARM:2')).toEqual({ kind: 'alarm', code: 2 })
    expect(parseLine("[MSG:'$H'|'$X' to unlock]")).toEqual({
      kind: 'message',
      text: "'$H'|'$X' to unlock",
    })
    expect(parseLine('[MSG:Pgm End]')).toEqual({ kind: 'message', text: 'Pgm End' })
    expect(parseLine('[G54:-750.000,-750.000,-50.000]')).toEqual({
      kind: 'feedback',
      tag: 'G54',
      text: '-750.000,-750.000,-50.000',
    })
    expect(parseLine('$110=5000.000')).toEqual({ kind: 'setting', n: 110, value: 5000 })
    expect(parseLine("Grbl 1.1h ['$' for help]")).toEqual({
      kind: 'banner',
      version: '1.1h',
      line: "Grbl 1.1h ['$' for help]",
    })
    expect(parseLine('')).toEqual({ kind: 'other', text: '' })
    expect(parseLine('<Idle|MPos:x>').kind).toBe('status')
    expect(parseLine('<>')).toEqual({ kind: 'other', text: '<>' })
  })
})

describe('the banner (DF87 follow-up)', () => {
  it('is only the whole Grbl / GrblHAL welcome line', () => {
    expect(parseLine("Grbl 1.1f ['$' for help]")).toMatchObject({ kind: 'banner', version: '1.1f' })
    expect(parseLine("GrblHAL 1.1f ['$' or '$HELP' for help]")).toMatchObject({
      kind: 'banner',
      version: '1.1f',
    })
    expect(parseLine('[VER:1.1f.20250929:]')).toEqual({
      kind: 'feedback',
      tag: 'VER',
      text: '1.1f.20250929:',
    })
    expect(parseLine("[MSG:Grbl 1.1f ['$' for help]]").kind).toBe('message')
    expect(parseLine('[MSG:Homing done]').kind).toBe('message')
    expect(parseLine('[OPT:V,15,128]').kind).toBe('feedback')
    expect(parseLine("x Grbl 1.1f ['$' for help]").kind).toBe('other')
    expect(parseLine("Grbl 1.1f ['$' for help] ").kind).toBe('other')
    expect(parseLine('Grbl 1.1f').kind).toBe('other')
  })
})

describe('parseStatusReport', () => {
  it('reads the wiki examples', () => {
    expect(parseStatusReport('<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>')).toEqual(
      { state: 'Idle', mpos: [0, 0, 0], feed: 0, spindle: 0, wco: [0, 0, 0] },
    )
    const r = parseStatusReport(
      '<Hold:0|WPos:1.000,-2.500,3.250|Bf:15,128|Ln:99|F:500|Ov:100,50,120|A:SFM|Pn:XZ>',
    )
    expect(r).toEqual({
      state: 'Hold',
      subState: 0,
      wpos: [1, -2.5, 3.25],
      buffer: { blocks: 15, rx: 128 },
      line: 99,
      feed: 500,
      overrides: { feed: 100, rapid: 50, spindle: 120 },
      accessories: 'SFM',
      pins: 'XZ',
    })
    expect(stateText(r!)).toBe('Hold:0')
    expect(stateText(parseStatusReport('<Run|MPos:1,2,3>')!)).toBe('Run')
  })

  it('rejects malformed reports and ignores malformed or unknown fields', () => {
    expect(parseStatusReport('Idle|MPos:0,0,0')).toBeUndefined()
    expect(parseStatusReport('<|MPos:0,0,0>')).toBeUndefined()
    expect(parseStatusReport('<Idle|MPos:1,2|Bf:x,1|Xyz:5>')).toEqual({ state: 'Idle' })
  })

  it('applies a cached WCO to MPos or WPos reports, in mm', () => {
    const wco: [number, number, number] = [-750, -750, -50]
    expect(
      positions(parseStatusReport('<Idle|MPos:-740.000,-700.000,-40.000>')!, wco, false),
    ).toEqual({
      mpos: [-740, -700, -40],
      wpos: [10, 50, 10],
      wco,
    })
    expect(positions(parseStatusReport('<Idle|WPos:10.000,50.000,10.000>')!, wco, false)).toEqual({
      mpos: [-740, -700, -40],
      wpos: [10, 50, 10],
      wco,
    })
    // inch reports ($13=1) with a fresh WCO
    const p = positions(
      parseStatusReport('<Idle|MPos:-1.0000,-2.0000,0.5000|WCO:-1.0000,0.0000,0.0000>')!,
      wco,
      true,
    )!
    expect(p.mpos).toEqual([-25.4, -50.8, 12.7])
    expect(p.wco).toEqual([-25.4, 0, 0])
    expect(p.wpos[0]).toBeCloseTo(0, 9)
    expect(positions(parseStatusReport('<Idle|FS:0,0>')!, wco, false)).toBeUndefined()
  })

  it('reads every $10 report form and builds with more axes (DF87)', () => {
    const wco: [number, number, number] = [-100, -50, -20]
    const forms = [
      '<Idle|WPos:10.000,20.000,5.000|FS:0,0>', // $10=0
      '<Idle|MPos:-90.000,-30.000,-15.000|FS:0,0>', // $10=1
      '<Idle|WPos:10.000,20.000,5.000|Bf:15,128|FS:0,0>', // $10=2
      '<Idle|MPos:-90.000,-30.000,-15.000|Bf:15,128|FS:0,0|Pn:Z>', // $10=3
      '<Idle|MPos:-90.000,-30.000,-15.000,0.000|FS:0,0>', // a 4-axis build
      '<Idle|WPos:10.000,20.000,5.000,12.500|FS:0,0|WCO:-100.000,-50.000,-20.000,0.000>',
    ]
    for (const f of forms)
      expect(positions(parseStatusReport(f)!, wco, false), f).toEqual({
        mpos: [-90, -30, -15],
        wpos: [10, 20, 5],
        wco,
      })
  })
})

describe('$ reports from the emulator', () => {
  const emu = () => expectOk(GrblEmulator.create({ homing: false }))

  it('$#, $G, $$ and $I', () => {
    const e = emu()
    outLines(e)
    send(e, 'G10 L2 P1 X-750 Y-700.5 Z-50\n')
    const params = parseParameters(send(e, '$#\n').map(parseLine), false)
    expect(params.get('G54')).toEqual([-750, -700.5, -50])
    expect(params.get('G92')).toEqual([0, 0, 0])
    expect(params.has('TLO')).toBe(false)
    expect(parseModes(send(e, '$G\n').map(parseLine))).toContain('G21')
    const settings = parseSettings(send(e, '$$\n').map(parseLine))
    expect(settings.get(10)).toBe(1)
    expect(settings.get(130)).toBeGreaterThan(0)
    expect(parseVersion(send(e, '$I\n').map(parseLine))).toBe('1.1h.20190830')
  })

  it('$# in inch ($13=1) is converted to mm', () => {
    const e = emu()
    outLines(e)
    send(e, '$13=1\n')
    send(e, 'G21 G10 L2 P1 X-254 Y0 Z0\n')
    const params = parseParameters(send(e, '$#\n').map(parseLine), true)
    expect(params.get('G54')?.[0]).toBeCloseTo(-254, 6)
  })
})

describe('messages', () => {
  it('knows GRBL texts for errors and alarms', () => {
    expect(errorText(22)).toMatch(/Feed rate/)
    expect(errorText(999)).toBe('Unknown error 999.')
    expect(alarmText(2)).toMatch(/exceeds machine travel/)
    expect(alarmText(77)).toBe('Unknown alarm 77.')
  })
})
