import { describe, expect, it } from 'vitest'
import { parseLine } from './status'
import { parseSettingLine, parseSettingsText } from './settings'
import { GRBL_11H_DEFAULTS } from './settings.fixture'

/** A router copied from a sender console: prefixes, descriptions, CRLF, junk and a grblHAL id. */
const SENDER_CONSOLE = [
  '> $$',
  '[MSG:Check Limits]',
  '$0=10 (Step pulse time, microseconds)',
  '$11=0.020 (Junction deviation, millimeters)',
  '[rx] $20=1',
  '$100 = 40.000 ; x steps/mm',
  '$110=5000.000 (X-axis maximum rate, mm/min)',
  '  $130=838.000',
  'garbage $abc=1 and x$12=3',
  '$999=7',
  '$110=5100.5',
  '<Idle|MPos:0.000,0.000,0.000|FS:0,0>',
  'ok',
].join('\r\n')

describe('parseSettingLine', () => {
  it('reads a setting as GRBL prints it', () => {
    expect(parseSettingLine('$110=5000.000').unwrap()).toEqual({ n: 110, value: 5000 })
    expect(parseSettingLine('$31=0').unwrap()).toEqual({ n: 31, value: 0 })
    expect(parseSettingLine('$12=.002').unwrap()).toEqual({ n: 12, value: 0.002 })
    expect(parseSettingLine('$120=-1').unwrap()).toEqual({ n: 120, value: -1 })
  })

  it('tolerates prefixes, spaces around = and trailing descriptions or comments', () => {
    expect(parseSettingLine('>>> $100=40.000').unwrap()).toEqual({ n: 100, value: 40 })
    expect(parseSettingLine('$100 = 40 (x, step/mm)').unwrap()).toEqual({ n: 100, value: 40 })
    expect(parseSettingLine('$100=40.;x').unwrap()).toEqual({ n: 100, value: 40 })
  })

  it('ignores lines that hold no setting', () => {
    for (const line of [
      'ok',
      '',
      "Grbl 1.1h ['$' for help]",
      '[MSG:Caution: Unlocked]',
      '$N0=G20',
      'x$110=5',
      '$110=5x',
      '$110=',
      '$=1',
    ])
      expect(parseSettingLine(line).isNone(), line).toBe(true)
  })

  it('is what the handshake classifies setting lines with', () => {
    expect(parseLine('$130=200.000')).toEqual({ kind: 'setting', n: 130, value: 200 })
    expect(parseLine('ok')).toEqual({ kind: 'ok' })
  })
})

describe('parseSettingsText', () => {
  it('reads a whole GRBL 1.1 dump and counts the other lines', () => {
    const r = parseSettingsText(GRBL_11H_DEFAULTS)
    expect(r.settings.size).toBe(34)
    expect(r.settings.get(11)).toBe(0.01)
    expect(r.settings.get(132)).toBe(200)
    // banner, `$$`, `ok`
    expect(r.ignoredLines).toBe(3)
  })

  it('reads a sender console paste: last duplicate wins, unknown ids kept, junk counted', () => {
    const r = parseSettingsText(SENDER_CONSOLE)
    expect(Object.fromEntries(r.settings)).toEqual({
      0: 10,
      11: 0.02,
      20: 1,
      100: 40,
      110: 5100.5,
      130: 838,
      999: 7,
    })
    expect(r.ignoredLines).toBe(5)
  })

  it('finds nothing in text without settings', () => {
    expect(parseSettingsText('hello\n\nok').settings.size).toBe(0)
  })
})
