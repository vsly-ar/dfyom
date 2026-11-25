/**
 * An external gCode file for a run (hardening DF93): prepared for GRBL (cleaned lines, `M6` as
 * DFYOM's tool-change marker), checked against the subset the virtual machine's parser runs
 * (refusals and warnings with their source lines), its extent for the file card, the preview
 * moves, and the soft-limit check at a work zero. Pure and headless: the window prepares the file
 * for its preview, `run.job.start { file }` and `run.job.check { file }` again before a run.
 * Doc: docs/modes/run.md#run-an-external-g-code-file-df93
 */
import type { AsyncAppResult } from '../../shared/result'
import type { PlanWarning } from '../plan/checks'
import { DEFAULT_ARC_TOLERANCE } from './executing'
import { initialParserState, parseBlock, type ParserState } from './grbl/emulator/gcode'
import { errorText } from './grbl/status'

type V3 = readonly [number, number, number]

/** File name endings the run dialog offers and `run.job.start { file }` accepts. */
export const GCODE_RUN_EXTENSIONS = ['.nc', '.gcode', '.ngc', '.tap', '.cnc', '.gc'] as const

/** The largest file DFYOM reads for a run (50 MB). */
export const MAX_GCODE_FILE_BYTES = 50 * 1024 * 1024

/** At most this many refusals and warnings are kept (the count says how many there were). */
export const MAX_FILE_ISSUES = 100

/** Arc chords of the preview (mm): coarser than GRBL's `$12`, still smooth on screen. */
export const PREVIEW_ARC_TOLERANCE = 0.02

/** Arc chords of the soft-limit check (mm): the extent is within this of the arcs'. */
const CHECK_ARC_TOLERANCE = 0.01

/** GRBL's line buffer: a line as sent, with its `\n`, must fit 80 bytes. */
const MAX_LINE = 79

const EPS = 1e-6

/**
 * Reads gCode files for `run.job.start { file }` (`ctx.services.gcodeFiles`; main and the CLI read
 * from disk): the text of an absolute path, at most `MAX_GCODE_FILE_BYTES`
 * (`input.malformed` rule `fileTooLarge`), `persist.io` when unreadable.
 */
export interface GcodeFiles {
  read(path: string): AsyncAppResult<string>
}

/** True for a path whose file name ends in one of `GCODE_RUN_EXTENSIONS`. */
export function isRunnableGcodeFileName(path: string): boolean {
  const name = fileNameOf(path).toLowerCase()
  return GCODE_RUN_EXTENSIONS.some((ext) => name.endsWith(ext) && name.length > ext.length)
}

/** The file name of a path (either separator). */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path
}

/** One refusal or warning, at a 1-based line of the file as read. */
export interface FileIssue {
  readonly line: number
  readonly rule: string
  readonly message: string
}

export interface FileToolChange {
  /** 1-based line of the marker in the prepared program. */
  readonly line: number
  readonly n: number
  readonly name: string
}

/** A file prepared for a run. */
export interface PreparedGcodeFile {
  /** The program to stream (cleaned lines; `M6` replaced by the tool-change marker and `M0`). */
  readonly lines: readonly string[]
  /** Per prepared line, its 1-based line in the file. */
  readonly sourceLines: readonly number[]
  /** Lines in the file as read. */
  readonly fileLines: number
  /** Progress and gCode panel sections: one per tool change. */
  readonly sections: readonly { readonly fromLine: number; readonly label: string }[]
  readonly toolChanges: readonly FileToolChange[]
  /** `M0` program pauses (other than the tool changes' own). */
  readonly pauses: number
  /** The first units word: `G21` mm, `G20` inch; undefined without one. */
  readonly units: 'mm' | 'inch' | undefined
  /** Lines that keep the file from running (Start disabled), the first `MAX_FILE_ISSUES`. */
  readonly refusals: readonly FileIssue[]
  readonly refusalCount: number
  /** Lines worth a look that still run. */
  readonly warnings: readonly FileIssue[]
  /**
   * Extent of the moves in work coordinates (mm) per axis, from the axes the program sets
   * absolutely (G53 moves left out); undefined for an axis it never sets.
   */
  readonly extent: readonly ({ readonly min: number; readonly max: number } | undefined)[]
}

/** DFYOM's tool-change marker (grbl.md#output-dialect), matched on a whole line. */
const MARKER = /^\(DFYOM TOOL CHANGE (\d+): ([^()]*)\)$/
/** A header tool line, e.g. Fusion's `(T1 D=6 CR=0 - ZMIN=-5 - flat end mill)`. */
/** The line after a marker that pauses: `M0`, or `M0 ;message`. */
const MARKER_PAUSE = /^M0( ;.*)?$/
const TOOL_LINE = /^T(\d+)\s+(.+)$/i
const WORD = /([A-Z])([+-]?(?:\d+\.?\d*|\.\d+))/g

interface Word {
  readonly letter: string
  readonly text: string
  readonly value: number
}

/** Code words of a normalized line (`G0X1`), or undefined when it is not all words. */
function wordsOf(code: string): Word[] | undefined {
  const out: Word[] = []
  let at = 0
  for (const m of code.matchAll(WORD)) {
    if (m.index !== at) return undefined
    out.push({ letter: m[1] ?? '', text: m[0], value: Number(m[2]) })
    at = m.index + m[0].length
  }
  return at === code.length ? out : undefined
}

/**
 * A line split as GRBL reads it: the code (no comments, spaces, `/` or lower case), its comments'
 * texts, the line with comment characters GRBL would misread replaced, and bad code characters.
 */
function splitLine(raw: string): {
  code: string
  comments: string[]
  cleaned: string
  badCode: string | undefined
} {
  let code = ''
  let cleaned = ''
  let badCode: string | undefined
  const comments: string[] = []
  let comment: 'paren' | 'semi' | undefined
  let text = ''
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0
    const printable = c >= 0x20 && c <= 0x7e && ch !== '?' && ch !== '!' && ch !== '~'
    if (comment !== undefined) {
      if (comment === 'paren' && ch === ')') {
        comment = undefined
        comments.push(text.trim())
        text = ''
        cleaned += ch
        continue
      }
      const safe = printable ? ch : ' '
      text += safe
      cleaned += safe
      continue
    }
    if (ch === '(') {
      comment = 'paren'
      cleaned += ch
    } else if (ch === ';') {
      comment = 'semi'
      cleaned += ch
    } else if (ch === '\t' || ch === ' ') cleaned += ' '
    else {
      if (!printable && badCode === undefined)
        badCode = c < 0x20 || c > 0x7e ? `byte 0x${c.toString(16)}` : `'${ch}'`
      if (ch !== '/') code += ch.toUpperCase()
      cleaned += ch
    }
  }
  if (comment !== undefined && text.trim() !== '') comments.push(text.trim())
  return { code, comments, cleaned: cleaned.trim(), badCode }
}

/** A comment's text, safe inside `( )` and the marker. */
function commentSafe(text: string): string {
  return text.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Refused words: what they do and what to change (docs/modes/run.md#run-an-external-g-code-file-df93). */
function refusedWord(w: Word): { rule: string; message: string } | undefined {
  if (w.letter !== 'G') return undefined
  const g = Math.round(w.value * 10) / 10
  if (g === 28 || g === 30 || g === 28.1 || g === 30.1)
    return {
      rule: 'storedPosition',
      message: `${w.text} goes to a position stored in the controller, which DFYOM cannot check against the travel; post without it (Fusion: turn off "Use G28")`,
    }
  if (g >= 92 && g < 93)
    return {
      rule: 'offset',
      message: `${w.text} shifts the coordinates; set the work zero in Run mode instead`,
    }
  if (g === 10)
    return {
      rule: 'setsWorkZero',
      message: `${w.text} sets the work zero from the program; set it in Run mode instead`,
    }
  if (g >= 55 && g < 60)
    return { rule: 'workOffset', message: `${w.text}: DFYOM runs at G54 only; post for G54` }
  if (g >= 38 && g < 39)
    return { rule: 'probe', message: `${w.text} probes; use Probe Z in Run mode instead` }
  if (g === 41 || g === 42)
    return {
      rule: 'cutterCompensation',
      message: `${w.text}: GRBL has no cutter compensation; post with it off`,
    }
  if (g >= 43 && g < 44)
    return {
      rule: 'toolLength',
      message: `${w.text}: tool length offsets are not run; DFYOM sets Z zero at each tool change`,
    }
  if (g === 73 || g === 76 || (g >= 81 && g <= 89))
    return {
      rule: 'cannedCycle',
      message: `${w.text} is a canned cycle GRBL does not run; post drilling as plain moves`,
    }
  if (g === 93)
    return {
      rule: 'inverseTime',
      message: `${w.text}: inverse-time feed is not run; post with G94`,
    }
  if (g === 18 || g === 19)
    return {
      rule: 'plane',
      message: `${w.text}: arcs outside the XY plane are not run; post arcs as lines or in G17`,
    }
  return undefined
}

const isM = (w: Word, n: number): boolean => w.letter === 'M' && w.value === n

class Issues {
  readonly list: FileIssue[] = []
  count = 0
  add(line: number, rule: string, message: string): void {
    this.count++
    if (this.list.length < MAX_FILE_ISSUES) this.list.push({ line, rule, message })
  }
}

/**
 * Prepares a file's text for a run (docs/modes/run.md#run-an-external-g-code-file-df93): the
 * lines to stream, the tool changes, refusals and warnings, units and the extent.
 */
export function prepareGcodeFile(text: string): PreparedGcodeFile {
  const source = text.split('\n')
  if (source.at(-1) === '') source.pop()
  const lines: string[] = []
  const sourceLines: number[] = []
  const sections: { fromLine: number; label: string }[] = []
  const toolChanges: FileToolChange[] = []
  const refusals = new Issues()
  const warnings = new Issues()
  const warned = new Set<string>()
  const warnOnce = (line: number, rule: string, message: string) => {
    if (warned.has(rule)) return
    warned.add(rule)
    warnings.add(line, rule, message)
  }
  const toolTable = new Map<number, string>()
  const extentLo = [Infinity, Infinity, Infinity]
  const extentHi = [-Infinity, -Infinity, -Infinity]
  const known = [false, false, false]
  let state: ParserState = initialParserState([0, 0, 0], [0, 0, 0])
  let units: 'mm' | 'inch' | undefined
  let lastT: number | undefined
  let lastComment: { text: string; line: number } | undefined
  let spindleOn = false
  let ended = false
  let pauses = 0
  const push = (line: string, from: number) => {
    lines.push(line)
    sourceLines.push(from)
  }

  source.forEach((rawLine, i) => {
    const n = i + 1
    const raw = rawLine.replace(/\r$/, '')
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed === '%') return
    // a DFYOM export's own marker (and any other line) passes as it is when it is clean
    const { code, comments, cleaned, badCode } = splitLine(trimmed)
    if (code === '') {
      if (comments.length === 0) return
      const m = MARKER.exec(cleaned)
      if (m) {
        toolChanges.push({ line: lines.length + 1, n: Number(m[1]), name: m[2] ?? '' })
        sections.push({ fromLine: lines.length + 1, label: `tool ${m[1]}: ${m[2] ?? ''}` })
        push(cleaned, n)
        return
      }
      const textOf = commentSafe(comments.join(' '))
      const tool = TOOL_LINE.exec(textOf)
      if (tool) toolTable.set(Number(tool[1]), (tool[2] ?? '').trim())
      lastComment = { text: textOf, line: n }
      push(cleaned.length <= MAX_LINE ? cleaned : `(${textOf.slice(0, MAX_LINE - 2).trim()})`, n)
      return
    }
    if (badCode !== undefined) {
      refusals.add(
        n,
        'character',
        `the code contains ${badCode}, which GRBL reads as a real-time command or rejects`,
      )
      push(cleaned, n)
      return
    }
    if (code.startsWith('$')) {
      refusals.add(n, 'systemCommand', `${code}: DFYOM sends no $ commands from a file`)
      push(cleaned, n)
      return
    }
    if (ended) warnOnce(n, 'afterEnd', 'lines after the program end (M2/M30) still run')
    const words = wordsOf(code)
    if (words?.some((w) => w.letter === 'T') === true)
      lastT = Math.trunc(words.find((w) => w.letter === 'T')?.value ?? 0)
    // M6: the tool-change marker and its M0 (grbl.md#output-dialect); other words stay
    if (words?.some((w) => isM(w, 6)) === true) {
      const t = lastT ?? toolChanges.length + 1
      const recent =
        lastComment !== undefined && n - lastComment.line <= 3 ? lastComment.text : undefined
      // the line's comment, the header's tool line, the comment just before, else the number
      const name = commentSafe(
        comments.join(' ') || toolTable.get(t) || recent || `Tool ${t}`,
      ).slice(0, MAX_LINE - 30)
      const rest = words.filter((w) => !isM(w, 6) && w.letter !== 'T').map((w) => w.text)
      if (rest.length > 0) {
        const r = parseLine(rest.join(''), n)
        if (r !== undefined) push(rest.join(' '), n)
      }
      toolChanges.push({ line: lines.length + 1, n: t, name })
      sections.push({ fromLine: lines.length + 1, label: `tool ${t}: ${name}` })
      push(`(DFYOM TOOL CHANGE ${t}: ${name})`, n)
      push('M0', n)
      return
    }
    if (parseLine(code, n) !== undefined)
      push(cleaned.length <= MAX_LINE ? cleaned : code.length <= MAX_LINE ? code : cleaned, n)
    else push(cleaned, n)
    if (words?.some((w) => isM(w, 0)) === true && !MARKER.test(lines.at(-2) ?? '')) pauses++
    if (code.length > MAX_LINE)
      refusals.add(n, 'lineLength', `the code is ${code.length} characters; GRBL takes ${MAX_LINE}`)
  })

  /** Checks and parses one line's code; the parsed state, or undefined when refused. */
  function parseLine(code: string, n: number): ParserState | undefined {
    const words = wordsOf(code)
    for (const w of words ?? []) {
      const refused = refusedWord(w)
      if (refused !== undefined) {
        refusals.add(n, refused.rule, refused.message)
        return undefined
      }
    }
    const parsed = parseBlock(code, state, { arcTolerance: PREVIEW_ARC_TOLERANCE })
    if (parsed.isErr()) {
      const status = parsed.unwrapErr()
      refusals.add(n, 'grbl', `${code}: GRBL error ${status}, ${errorText(status)}`)
      return undefined
    }
    const block = parsed.unwrap()
    const g = (v: number) => words?.some((w) => w.letter === 'G' && w.value === v) === true
    if (units === undefined && (g(20) || g(21))) units = g(20) ? 'inch' : 'mm'
    if (words?.some((w) => isM(w, 1)) === true)
      warnOnce(n, 'optionalStop', 'M1: GRBL ignores the optional stop; the run does not stop there')
    if (words?.some((w) => isM(w, 2) || isM(w, 30)) === true) ended = true
    if (words?.some((w) => isM(w, 3) || isM(w, 4)) === true) spindleOn = true
    const g53 = g(53)
    const moves = block.actions.filter((a) => a.kind === 'move')
    if (moves.length > 0) {
      if (units === undefined)
        warnOnce(
          n,
          'noUnits',
          'no G20/G21 before the first move: the controller runs it in its current units (mm after power-up)',
        )
      if (!spindleOn && moves.some((a) => a.kind === 'move' && !a.rapid))
        warnOnce(
          n,
          'noSpindle',
          'a feed move before any spindle start (M3/M4): fine with a hand-switched spindle',
        )
      ;(['X', 'Y', 'Z'] as const).forEach((axis, k) => {
        if (words?.some((w) => w.letter === axis) !== true) return
        if (!block.state.absolute && !known[k] && !g53)
          warnOnce(
            n,
            'incrementalStart',
            `an incremental ${axis} move before any absolute one: it starts where the machine is`,
          )
        if (block.state.absolute || g53) known[k] = true
      })
      if (!g53)
        for (const mv of moves)
          for (let k = 0; k < 3; k++) {
            if (!known[k]) continue
            const v = mv.target[k] ?? 0
            extentLo[k] = Math.min(extentLo[k] ?? v, v)
            extentHi[k] = Math.max(extentHi[k] ?? v, v)
          }
    }
    state = block.state
    return block.state
  }

  return {
    lines,
    sourceLines,
    fileLines: source.length,
    sections,
    // a marker without its M0 (a DFYOM export's first, loaded tool) does not stop the run
    toolChanges: toolChanges.filter((tc) => MARKER_PAUSE.test(lines[tc.line] ?? '')),
    pauses,
    units,
    refusals: refusals.list,
    refusalCount: refusals.count,
    warnings: warnings.list,
    extent: [0, 1, 2].map((k) =>
      Number.isFinite(extentLo[k]) ? { min: extentLo[k] ?? 0, max: extentHi[k] ?? 0 } : undefined,
    ),
  }
}

/** A gCode line as GRBL reads it: no comments, spaces, `/` or lower case. */
function normalize(raw: string): string {
  return splitLine(raw).code
}

/** The preview's moves: segment end points (6 floats each, work coordinates) and rapid flags. */
export interface FileMoves {
  readonly positions: Float32Array
  readonly rapid: Uint8Array
  readonly segments: number
}

/**
 * The moves of a prepared program for the 3D preview, in work coordinates from the work origin
 * (arcs at `PREVIEW_ARC_TOLERANCE`); G53 moves are not drawn. Lines the parser refuses are skipped.
 */
export function fileMoves(lines: readonly string[]): FileMoves {
  let pos = new Float32Array(6 * 1024)
  let rapid = new Uint8Array(1024)
  let count = 0
  let state = initialParserState([0, 0, 0], [0, 0, 0])
  for (const line of lines) {
    const code = normalize(line)
    if (code === '' || code.startsWith('$')) continue
    const parsed = parseBlock(code, state, { arcTolerance: PREVIEW_ARC_TOLERANCE })
    if (parsed.isErr()) continue
    const block = parsed.unwrap()
    const g53 = /G0*53(?![0-9.])/.test(code)
    let at = state.position
    for (const a of block.actions) {
      if (a.kind !== 'move') continue
      if (!g53 && Math.hypot(a.target[0] - at[0], a.target[1] - at[1], a.target[2] - at[2]) > EPS) {
        if (count === rapid.length) {
          const p = new Float32Array(pos.length * 2)
          p.set(pos)
          pos = p
          const r = new Uint8Array(rapid.length * 2)
          r.set(rapid)
          rapid = r
        }
        pos.set([at[0], at[1], at[2], a.target[0], a.target[1], a.target[2]], count * 6)
        rapid[count] = a.rapid ? 1 : 0
        count++
      }
      at = a.target
    }
    state = block.state
  }
  return { positions: pos.slice(0, count * 6), rapid: rapid.slice(0, count), segments: count }
}

/**
 * The soft-limit check of a prepared program (docs/modes/run.md#run-an-external-g-code-file-df93):
 * parsed at `workZero` from the machine position `mpos`; X and Y over the whole program, Z until
 * the first tool change (Z zero is set again there), G53 targets always; each axis must stay in
 * `[−travel, 0]`. Findings in the plan's `softLimit` shape, machine coordinates (mm).
 */
export function fileSoftLimits(
  lines: readonly string[],
  at: { readonly workZero: V3; readonly mpos: V3; readonly travel: V3 },
): PlanWarning[] {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  let state = initialParserState(at.mpos, at.workZero)
  let afterToolChange = false
  let marker = false
  for (const line of lines) {
    // Z is zeroed again at the first tool change that pauses (as plan-export's extent)
    if (marker && MARKER_PAUSE.test(line)) afterToolChange = true
    marker = MARKER.test(line.trim())
    const code = normalize(line)
    if (code === '' || code.startsWith('$')) continue
    const parsed = parseBlock(code, state, {
      arcTolerance: Math.max(CHECK_ARC_TOLERANCE, DEFAULT_ARC_TOLERANCE),
    })
    if (parsed.isErr()) continue
    const block = parsed.unwrap()
    const g53 = /G0*53(?![0-9.])/.test(code)
    for (const a of block.actions) {
      if (a.kind !== 'move') continue
      for (let k = 0; k < 3; k++) {
        if (k === 2 && afterToolChange && !g53) continue
        const v = a.target[k] ?? 0
        lo[k] = Math.min(lo[k] ?? v, v)
        hi[k] = Math.max(hi[k] ?? v, v)
      }
    }
    state = block.state
  }
  const out: PlanWarning[] = []
  ;(['x', 'y', 'z'] as const).forEach((axis, k) => {
    const from = lo[k] ?? Infinity
    const to = hi[k] ?? -Infinity
    const travel = at.travel[k] ?? 0
    if (!Number.isFinite(from) || !Number.isFinite(to)) return
    if (from < -travel - EPS || to > EPS)
      out.push({
        code: 'plan.machine',
        severity: 'warning',
        field: 'machine',
        rule: 'softLimit',
        message: `the program leaves the ${axis.toUpperCase()} soft limits at this work zero`,
        params: { axis, min: from, max: to, travel },
      })
  })
  return out
}
