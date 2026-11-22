/**
 * GRBL 1.1 response, status-report and `$` parsers for the sender. Pure; positions in mm.
 * Docs: docs/modes/run-v0.1.md#sender, docs/architecture/grbl.md#protocol-subset
 * Source: https://github.com/gnea/grbl/wiki/Grbl-v1.1-Interface
 */
import type { Vec3 } from '../../toolpath/model'
import { parseSettingLine } from './settings'

const MM_PER_INCH = 25.4

/** One received line, classified. Only `ok` and `error` acknowledge a sent line. */
export type GrblLine =
  | { readonly kind: 'ok' }
  | { readonly kind: 'error'; readonly code: number }
  | { readonly kind: 'alarm'; readonly code: number }
  | { readonly kind: 'status'; readonly report: StatusReport }
  /** `[MSG:…]` */
  | { readonly kind: 'message'; readonly text: string }
  /** Other `[TAG:…]` feedback: `$#` (`G54`, …), `$G` (`GC`), `$I` (`VER`, `OPT`), `HLP`. */
  | { readonly kind: 'feedback'; readonly tag: string; readonly text: string }
  | { readonly kind: 'setting'; readonly n: number; readonly value: number }
  /** `Grbl 1.1h ['$' for help]`: the controller (re)started. */
  | { readonly kind: 'banner'; readonly version: string }
  | { readonly kind: 'other'; readonly text: string }

const BANNER = /^Grbl (\S+) \['\$' for help\]$/
const FEEDBACK = /^\[([A-Z0-9]+):(.*)\]$/

export function parseLine(line: string): GrblLine {
  if (line === 'ok') return { kind: 'ok' }
  let m = /^error:(\d+)$/.exec(line)
  if (m) return { kind: 'error', code: Number(m[1]) }
  m = /^ALARM:(\d+)$/.exec(line)
  if (m) return { kind: 'alarm', code: Number(m[1]) }
  if (line.startsWith('<') && line.endsWith('>')) {
    const report = parseStatusReport(line)
    if (report !== undefined) return { kind: 'status', report }
    return { kind: 'other', text: line }
  }
  m = FEEDBACK.exec(line)
  if (m) {
    const tag = m[1] ?? ''
    const text = m[2] ?? ''
    return tag === 'MSG' ? { kind: 'message', text } : { kind: 'feedback', tag, text }
  }
  const setting = parseSettingLine(line)
  if (setting.isSome()) return { kind: 'setting', ...setting.unwrap() }
  m = BANNER.exec(line)
  if (m) return { kind: 'banner', version: m[1] ?? '' }
  return { kind: 'other', text: line }
}

/** A status report as sent, in the controller's report units (`$13`). */
export interface StatusReport {
  /** `Idle`, `Run`, `Hold`, `Jog`, `Alarm`, `Door`, `Check`, `Home`, `Sleep`. */
  readonly state: string
  /** `Hold:0` → 0; absent without a sub-state. */
  readonly subState?: number
  readonly mpos?: Vec3
  readonly wpos?: Vec3
  readonly wco?: Vec3
  /** `Bf`: planner blocks and RX bytes available. */
  readonly buffer?: { readonly blocks: number; readonly rx: number }
  /** `Ln`. */
  readonly line?: number
  /** `F` or `FS` (feed in report units/min, spindle rpm). */
  readonly feed?: number
  readonly spindle?: number
  /** `Ov`: feed, rapid, spindle in %. */
  readonly overrides?: { readonly feed: number; readonly rapid: number; readonly spindle: number }
  /** `A:` accessory letters (`S`, `C`, `F`, `M`); empty string when reported empty. */
  readonly accessories?: string
  /** `Pn:` pins. */
  readonly pins?: string
}

function numbers(text: string): number[] | undefined {
  const parts = text.split(',')
  const out = parts.map(Number)
  return parts.every((p) => p.trim() !== '') && out.every(Number.isFinite) ? out : undefined
}

function vec(text: string): Vec3 | undefined {
  const n = numbers(text)
  return n !== undefined && n.length === 3 ? [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0] : undefined
}

/** `<State|field|…>`; undefined when malformed. Unknown fields are ignored. */
export function parseStatusReport(text: string): StatusReport | undefined {
  if (!text.startsWith('<') || !text.endsWith('>')) return undefined
  const [head, ...fields] = text.slice(1, -1).split('|')
  const sm = /^([A-Za-z]+)(?::(\d+))?$/.exec(head ?? '')
  if (!sm) return undefined
  const r: {
    -readonly [K in keyof StatusReport]: StatusReport[K] | undefined
  } = { state: sm[1] ?? '' }
  if (sm[2] !== undefined) r.subState = Number(sm[2])
  for (const f of fields) {
    const k = f.indexOf(':')
    const key = k < 0 ? f : f.slice(0, k)
    const value = k < 0 ? '' : f.slice(k + 1)
    switch (key) {
      case 'MPos':
        r.mpos = vec(value)
        break
      case 'WPos':
        r.wpos = vec(value)
        break
      case 'WCO':
        r.wco = vec(value)
        break
      case 'Bf': {
        const n = numbers(value)
        if (n?.length === 2) r.buffer = { blocks: n[0] ?? 0, rx: n[1] ?? 0 }
        break
      }
      case 'Ln': {
        const n = Number(value)
        if (Number.isInteger(n)) r.line = n
        break
      }
      case 'F': {
        const n = Number(value)
        if (Number.isFinite(n)) r.feed = n
        break
      }
      case 'FS': {
        const n = numbers(value)
        if (n?.length === 2) {
          r.feed = n[0]
          r.spindle = n[1]
        }
        break
      }
      case 'Ov': {
        const n = numbers(value)
        if (n?.length === 3) r.overrides = { feed: n[0] ?? 0, rapid: n[1] ?? 0, spindle: n[2] ?? 0 }
        break
      }
      case 'A':
        r.accessories = value
        break
      case 'Pn':
        r.pins = value
        break
    }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) if (v !== undefined) out[k] = v
  return out as unknown as StatusReport
}

/** `Hold:0` style state text of a report. */
export function stateText(r: StatusReport): string {
  return r.subState === undefined ? r.state : `${r.state}:${r.subState}`
}

/**
 * Positions of a report in mm, with the cached `WCO` applied (GRBL sends `WCO` only every
 * 10–30 reports). `inches`: the report is in inch (`$13=1`).
 */
export interface Positions {
  readonly mpos: Vec3
  readonly wpos: Vec3
  readonly wco: Vec3
}

const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k]

export function positions(
  r: StatusReport,
  cachedWco: Vec3,
  inches: boolean,
): Positions | undefined {
  const k = inches ? MM_PER_INCH : 1
  const wco = r.wco === undefined ? cachedWco : scale(r.wco, k)
  if (r.mpos !== undefined) {
    const mpos = scale(r.mpos, k)
    return { mpos, wco, wpos: [mpos[0] - wco[0], mpos[1] - wco[1], mpos[2] - wco[2]] }
  }
  if (r.wpos !== undefined) {
    const wpos = scale(r.wpos, k)
    return { wpos, wco, mpos: [wpos[0] + wco[0], wpos[1] + wco[1], wpos[2] + wco[2]] }
  }
  return undefined
}

/** `$#` lines → offsets by tag (`G54` … `G92`, `TLO` as one number, `PRB` without its flag). */
export function parseParameters(
  lines: readonly GrblLine[],
  inches: boolean,
): ReadonlyMap<string, Vec3> {
  const k = inches ? MM_PER_INCH : 1
  const out = new Map<string, Vec3>()
  for (const l of lines) {
    if (l.kind !== 'feedback') continue
    const v = vec(l.text.split(':')[0] ?? '')
    if (v !== undefined) out.set(l.tag, scale(v, k))
  }
  return out
}

/** `[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]` → its words. */
export function parseModes(lines: readonly GrblLine[]): readonly string[] {
  for (const l of lines) if (l.kind === 'feedback' && l.tag === 'GC') return l.text.split(' ')
  return []
}

/** `$$` lines → setting values. */
export function parseSettings(lines: readonly GrblLine[]): ReadonlyMap<number, number> {
  const out = new Map<number, number>()
  for (const l of lines) if (l.kind === 'setting') out.set(l.n, l.value)
  return out
}

/** `[VER:1.1h.20190830:]` → `1.1h.20190830`. */
export function parseVersion(lines: readonly GrblLine[]): string | undefined {
  for (const l of lines) if (l.kind === 'feedback' && l.tag === 'VER') return l.text.split(':')[0]
  return undefined
}

/** GRBL 1.1 error messages (doc/csv/error_codes_en_US.csv). */
export const GRBL_ERRORS: Readonly<Record<number, string>> = {
  1: 'G-code words consist of a letter and a value. Letter was not found.',
  2: 'Numeric value format is not valid or missing an expected value.',
  3: "Grbl '$' system command was not recognized or supported.",
  4: 'Negative value received for an expected positive value.',
  5: 'Homing cycle is not enabled via settings.',
  6: 'Minimum step pulse time must be greater than 3usec.',
  7: 'EEPROM read failed. Reset and restored to default values.',
  8: "Grbl '$' command cannot be used unless Grbl is IDLE.",
  9: 'G-code locked out during alarm or jog state.',
  10: 'Soft limits cannot be enabled without homing also enabled.',
  11: 'Max characters per line exceeded. Line was not processed and executed.',
  12: "Grbl '$' setting value exceeds the maximum step rate supported.",
  13: 'Safety door detected as opened and door state initiated.',
  14: 'Build info or startup line exceeded EEPROM line length limit.',
  15: 'Jog target exceeds machine travel. Command ignored.',
  16: "Jog command with no '=' or contains prohibited g-code.",
  17: 'Laser mode requires PWM output.',
  20: 'Unsupported or invalid g-code command found in block.',
  21: 'More than one g-code command from same modal group found in block.',
  22: 'Feed rate has not yet been set or is undefined.',
  23: 'G-code command in block requires an integer value.',
  24: 'Two G-code commands that both require the use of the XYZ axis words were detected in the block.',
  25: 'A G-code word was repeated in the block.',
  26: 'A G-code command implicitly or explicitly requires XYZ axis words in the block, but none were detected.',
  27: 'N line number value is not within the valid range of 1 - 9,999,999.',
  28: 'A G-code command was sent, but is missing some required P or L value words in the line.',
  29: 'Grbl supports six work coordinate systems G54-G59. G59.1, G59.2, and G59.3 are not supported.',
  30: 'The G53 G-code command requires either a G0 seek or G1 feed motion mode to be active.',
  31: 'There are unused axis words in the block and G80 motion mode cancel is active.',
  32: 'A G2 or G3 arc was commanded but there are no XYZ axis words in the selected plane to trace the arc.',
  33: 'The motion command has an invalid target.',
  34: 'A G2 or G3 arc, traced with the radius definition, had a mathematical error when computing the arc geometry.',
  35: 'A G2 or G3 arc, traced with the offset definition, is missing the IJK offset word in the selected plane.',
  36: "There are unused, leftover G-code words that aren't used by any command in the block.",
  37: 'The G43.1 dynamic tool length offset command cannot apply an offset to an axis other than its configured axis.',
  38: 'Tool number greater than max supported value.',
}

/** GRBL 1.1 alarm messages (doc/csv/alarm_codes_en_US.csv). */
export const GRBL_ALARMS: Readonly<Record<number, string>> = {
  1: 'Hard limit triggered. Machine position is likely lost. Re-homing is highly recommended.',
  2: 'G-code motion target exceeds machine travel. Machine position safely retained.',
  3: 'Reset while in motion. Lost steps are likely. Re-homing is highly recommended.',
  4: 'Probe fail. The probe is not in the expected initial state before starting probe cycle.',
  5: 'Probe fail. Probe did not contact the workpiece within the programmed travel.',
  6: 'Homing fail. Reset during active homing cycle.',
  7: 'Homing fail. Safety door was opened during active homing cycle.',
  8: 'Homing fail. Cycle failed to clear limit switch when pulling off.',
  9: 'Homing fail. Could not find limit switch within search distance.',
  10: 'Homing fail. Could not find the second limit switch for self-squaring.',
}

export function errorText(code: number): string {
  return GRBL_ERRORS[code] ?? `Unknown error ${code}.`
}

export function alarmText(code: number): string {
  return GRBL_ALARMS[code] ?? `Unknown alarm ${code}.`
}

/** Alarms after which the machine position is lost or must be re-homed (`homed` becomes false). */
export const POSITION_ALARMS: ReadonlySet<number> = new Set([1, 2, 3, 6, 7, 8, 9, 10])
