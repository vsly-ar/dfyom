/**
 * Resume points and the lead-in (hardening DF129, slice RC2): the modal state a program line starts
 * in (parsed forward with the virtual machine's parser, plus the plane and coolant), the lines a
 * run can safely resume at (operation and pass starts), the findings for any other line, the
 * suggestion after an interruption, and the generated lead-in that brings the machine from a
 * homed, idle state to the start point of a line: retract to the machine top, wait at the tool,
 * spindle on and spin-up, X/Y above the start point, plunge at feed, then the program from the
 * line on, unchanged. Pure and headless; `run.job.start`/`run.job.check { fromLine }` use it.
 * Doc: docs/modes/run-recovery.md#choosing-where-to-resume, #the-lead-in, #implementation-rc2
 */
import { fail, Ok, type AppResult } from '../../shared/result'
import { commentLine, fitName, formatNumber, pauseLine } from '../post/grbl/format'
import { normalize } from './executing'
import { PLANNER_BLOCKS } from './grbl/emulator/planner'
import {
  initialParserState,
  parseBlock,
  type ParserState,
  type SpindleDir,
} from './grbl/emulator/gcode'
import type { SenderProgram } from './grbl/sender'

/** Spin-up dwell of a file's lead-in (Q172), s. A plan's is the post's spin-up. */
export const FILE_SPIN_UP_SECONDS = 5

/** The approach height is at least this far above the start point when it is below the rapid height (mm). */
export const APPROACH_MIN_MM = 1

const MM_PER_INCH = 25.4
const EPS = 1e-6
/** End points only: chords do not matter here, a coarse tolerance keeps the scan fast. */
const SCAN_ARC_TOLERANCE = 0.1
/** DFYOM's tool-change marker as a whole line, and the `M0` after it (grbl.md#output-dialect). */
const MARKER = /^\(DFYOM TOOL CHANGE (\d+): ([^()]*)\)$/
const MARKER_PAUSE = /^M0( ;.*)?$/
const MOTION_WORD = /G0*([0-3])(?![0-9.])/
const AXIS_WORD = /[XYZ][+-]?[\d.]/
const G53 = /G0*53(?![0-9.])/
const AXES = [/X[+-]?[\d.]/, /Y[+-]?[\d.]/, /Z[+-]?[\d.]/] as const
const M7 = /M0*7(?![0-9.])/
const M8 = /M0*8(?![0-9.])/
const M9 = /M0*9(?![0-9.])/
const PLANES = [
  [/G0*17(?![0-9.])/, 17],
  [/G0*18(?![0-9.])/, 18],
  [/G0*19(?![0-9.])/, 19],
] as const
/** DFYOM's own instruction comments around a tool change: not operation labels. */
const INSTRUCTION = /^(Tool change to T\d|Stop the spindle|Set spindle to|Z0 for tool|Touch off Z)/
/** Axis words that are not a motion: `G10` (refused in files, never in plans). */
const NOT_MOTION = /G0*10(?![0-9.])/

/** Work coordinates (mm); an axis is undefined while the program has not set it absolutely. */
export type Pos = readonly [number | undefined, number | undefined, number | undefined]

/** The coolant outputs (`M7` mist, `M8` flood, `M9` both off; a program end switches them off). */
export interface Coolant {
  readonly mist: boolean
  readonly flood: boolean
}

/** The modal state for a resume (docs/modes/run-recovery.md#what-dfyom-can-know-about-where-the-job-stopped). */
export interface ModalState {
  /** The virtual machine's parser state, G54 taken as the origin: positions are work coordinates. */
  readonly parser: ParserState
  /** `G17` (the only plane GRBL's subset here runs; `G18`/`G19` are refused). */
  readonly plane: 17 | 18 | 19
  readonly coolant: Coolant
}

export function initialModal(): ModalState {
  return {
    parser: initialParserState([0, 0, 0], [0, 0, 0]),
    plane: 17,
    coolant: { mist: false, flood: false },
  }
}

/**
 * One program line applied to the modal state, as GRBL's protocol loop reads it (no comments,
 * spaces or lower case; `$` lines are not gCode); a line the parser refuses leaves the state as it
 * was, as GRBL does after an error. Also used by the run recorder (journal.ts).
 */
export function stepModal(
  s: ModalState,
  raw: string,
  arcTolerance = SCAN_ARC_TOLERANCE,
): {
  readonly state: ModalState
  readonly parsed: ReturnType<typeof parseBlock> | undefined
  readonly code: string
} {
  const code = normalize(raw)
  if (code === '' || code.startsWith('$')) return { state: s, parsed: undefined, code }
  const parsed = parseBlock(code, s.parser, { arcTolerance })
  if (parsed.isErr()) return { state: s, parsed, code }
  const block = parsed.unwrap()
  const plane = PLANES.find(([re]) => re.test(code))?.[1] ?? s.plane
  let coolant = s.coolant
  if (M9.test(code) || block.actions.some((a) => a.kind === 'programEnd'))
    coolant = { mist: false, flood: false }
  else if (M7.test(code) || M8.test(code))
    coolant = { mist: coolant.mist || M7.test(code), flood: coolant.flood || M8.test(code) }
  return { state: { parser: block.state, plane, coolant }, parsed, code }
}

/** What a program line does, with the state it starts in. */
export interface ScannedLine {
  /** 1-based. */
  readonly line: number
  readonly before: ModalState
  /** The start point (work, mm). */
  readonly start: Pos
  readonly end: Pos
  /** `rapid`/`feed`: a G0/G1–G3 that moves; `none` otherwise. */
  readonly motion: 'none' | 'rapid' | 'feed'
  /** A feed arc (G2/G3). */
  readonly arc: boolean
  /** A DFYOM tool-change marker followed by its `M0`. */
  readonly toolChange?: { readonly n: number; readonly name: string }
  /** The tool in effect at the line (the last tool-change marker at or before it). */
  readonly tool?: { readonly n: number; readonly name: string; readonly line: number }
  /** The last `G0` Z of the program before the line (work, mm; G53 moves left out). */
  readonly rapidZ: number | undefined
  /** The feed of the last Z-only `G1` down before the line (mm/min). */
  readonly plungeFeed: number | undefined
  /** A whole-line comment's text. */
  readonly comment?: string
}

/** Parses a program once, line by line (docs/modes/run-recovery.md#implementation-rc2). */
export function scanProgram(lines: readonly string[]): ScannedLine[] {
  const out: ScannedLine[] = []
  let state = initialModal()
  let pos: Pos = [undefined, undefined, undefined]
  let tool: ScannedLine['tool']
  let rapidZ: number | undefined
  let plungeFeed: number | undefined
  lines.forEach((raw, i) => {
    const text = raw.trim()
    const marker = MARKER.exec(text)
    const toolChange =
      marker !== null && MARKER_PAUSE.test((lines[i + 1] ?? '').trim())
        ? { n: Number(marker[1]), name: marker[2] ?? '' }
        : undefined
    // a marker names the tool from its line on, also the first, loaded one (no M0)
    if (marker !== null) tool = { n: Number(marker[1]), name: marker[2] ?? '', line: i + 1 }
    const before = state
    const step = stepModal(state, raw)
    let motion: ScannedLine['motion'] = 'none'
    let arc = false
    let end: Pos = pos
    if (step.parsed?.isOk() === true) {
      const block = step.parsed.unwrap()
      const moves = block.actions.filter((a) => a.kind === 'move')
      if (moves.length > 0) {
        const g53 = G53.test(step.code)
        const abs = block.state.absolute
        const target = block.state.position
        const axis = (k: 0 | 1 | 2): number | undefined => {
          if (!AXES[k].test(step.code)) return pos[k]
          // G53 targets are machine coordinates; incremental from an unknown axis stays unknown
          if (g53) return undefined
          return abs || pos[k] !== undefined ? target[k] : undefined
        }
        end = [axis(0), axis(1), axis(2)]
        motion = moves[0]?.rapid === true ? 'rapid' : 'feed'
        arc = block.state.motion === 2 || block.state.motion === 3
        const zOnly = end[0] === pos[0] && end[1] === pos[1]
        if (motion === 'rapid' && !g53 && AXES[2].test(step.code) && end[2] !== undefined)
          rapidZ = end[2]
        if (
          motion === 'feed' &&
          !arc &&
          zOnly &&
          end[2] !== undefined &&
          pos[2] !== undefined &&
          end[2] < pos[2]
        )
          plungeFeed = block.state.feed
      }
      state = step.state
    }
    const comment =
      step.code === '' && /^\(.*\)$/.test(text) && marker === null ? text.slice(1, -1) : undefined
    out.push({
      line: i + 1,
      before,
      start: pos,
      end,
      motion,
      arc,
      ...(toolChange === undefined ? {} : { toolChange }),
      ...(tool === undefined ? {} : { tool }),
      rapidZ,
      plungeFeed,
      ...(comment === undefined ? {} : { comment }),
    })
    pos = end
  })
  return out
}

const known = (p: Pos): p is readonly [number, number, number] =>
  p[0] !== undefined && p[1] !== undefined && p[2] !== undefined

const movesXY = (l: ScannedLine): boolean =>
  l.start[0] === undefined ||
  l.start[1] === undefined ||
  l.end[0] === undefined ||
  l.end[1] === undefined ||
  Math.abs(l.end[0] - l.start[0]) > EPS ||
  Math.abs(l.end[1] - l.start[1]) > EPS

const changesZ = (l: ScannedLine): boolean =>
  l.start[2] === undefined || l.end[2] === undefined || Math.abs(l.end[2] - l.start[2]) > EPS

/** A line a run can resume at without findings. */
export interface ResumePoint {
  /** 1-based line of the program: the first feed move of a pass. */
  readonly line: number
  /** `operation`: the first pass of an operation (or tool run); `pass`: any later pass start. */
  readonly kind: 'operation' | 'pass'
  /** The operation's label (its comment, or the tool) for an operation start. */
  readonly label?: string
}

/**
 * The resume points of a program (docs/modes/run-recovery.md#choosing-where-to-resume):
 * **pass starts** – the first feed move after an X/Y rapid (programs rapid sideways only above
 * the stock) or after a rapid back up to the height of the last X/Y rapid, with its start point
 * known; and **operation starts** – the first pass start at or after each operation boundary:
 * `operationStarts` (a plan's operation lines), else the tool-change markers and the whole-line
 * comments between passes (a file's operation comments, e.g. Fusion's `(Pocket2)`). Never inside
 * a ramp, a helix or a tool change: a pass start is the first line of its entry.
 */
export function resumePoints(
  scan: readonly ScannedLine[],
  opts: { readonly operationStarts?: readonly number[] } = {},
): ResumePoint[] {
  const passes: number[] = []
  let sinceFeed = { xyRapid: false, upTo: -Infinity }
  let xyRapidZ = Infinity
  let firstFeed = true
  for (const l of scan) {
    if (l.motion === 'rapid') {
      if (movesXY(l)) {
        sinceFeed = { ...sinceFeed, xyRapid: true }
        xyRapidZ = l.end[2] ?? xyRapidZ
      } else if (l.end[2] !== undefined)
        sinceFeed = { ...sinceFeed, upTo: Math.max(sinceFeed.upTo, l.end[2]) }
    } else if (l.motion === 'feed') {
      const retracted = sinceFeed.xyRapid || sinceFeed.upTo >= xyRapidZ - EPS
      if ((firstFeed || retracted) && known(l.start)) passes.push(l.line)
      firstFeed = false
      sinceFeed = { xyRapid: false, upTo: -Infinity }
    }
  }
  // operation boundaries: a plan's operation lines, else tool changes and comments between passes
  const bounds: { line: number; label: string; tool: boolean }[] = []
  if (opts.operationStarts !== undefined) {
    for (const b of opts.operationStarts)
      bounds.push({ line: b, label: scan[b - 1]?.comment ?? `line ${b}`, tool: false })
  } else {
    let between = true
    for (const l of scan) {
      // any marker, also a first, loaded tool's (no M0)
      if (l.tool?.line === l.line)
        bounds.push({ line: l.line, label: `tool ${l.tool.n}: ${l.tool.name}`, tool: true })
      else if (l.comment !== undefined && between && !INSTRUCTION.test(l.comment))
        bounds.push({ line: l.line, label: l.comment, tool: false })
      if (l.motion === 'feed') between = false
      else if (l.motion === 'rapid' && (movesXY(l) || (l.end[2] ?? -Infinity) > (l.start[2] ?? 0)))
        between = true
    }
  }
  // each pass start takes the boundaries since the pass before: the last comment and tool name it
  const out: ResumePoint[] = []
  let b = 0
  for (const line of passes) {
    const mine: typeof bounds = []
    while (b < bounds.length && (bounds[b]?.line ?? Infinity) <= line) mine.push(bounds[b++]!)
    if (mine.length === 0) {
      out.push({ line, kind: 'pass' })
      continue
    }
    // the operation comment comes before its tool change (DFYOM, Fusion); without one, the last
    const tool = mine.filter((x) => x.tool).at(-1)
    const comments = mine.filter((x) => !x.tool)
    const comment =
      (tool === undefined ? undefined : comments.filter((x) => x.line < tool.line).at(-1)) ??
      comments.at(-1)
    const label = [comment, tool].flatMap((x) => (x === undefined ? [] : [x.label])).join(' · ')
    out.push({ line, kind: 'operation', label })
  }
  return out
}

/** A finding for a chosen resume line (warning tone; the start is allowed after reading it). */
export type ResumeFinding =
  /** The line starts below work Z 0: the lead-in plunges into the cut there. */
  | { readonly rule: 'inMaterial'; readonly z: number }
  /** The line is inside a ramp or helical entry; `from` is the entry's first line. */
  | { readonly rule: 'ramp'; readonly helix: boolean; readonly from: number }
  /** The lead-in waits at this tool (always, Q167). */
  | { readonly rule: 'toolChange'; readonly n: number; readonly name: string }
  /** The program moves incrementally (`G91`) at the line. */
  | { readonly rule: 'incremental' }

/**
 * The line a resume at `line` really starts at: a tool-change marker or its `M0` is passed over
 * (the lead-in waits at that tool itself).
 */
export function resumeLineOf(scan: readonly ScannedLine[], line: number): number {
  let at = line
  const l = scan[at - 1]
  if (l?.toolChange !== undefined) at += 2
  else if (scan[at - 2]?.toolChange !== undefined) at += 1
  return at
}

/** The findings of a resume at `line` (docs/modes/run-recovery.md#choosing-where-to-resume). */
export function resumeFindings(scan: readonly ScannedLine[], line: number): ResumeFinding[] {
  const out: ResumeFinding[] = []
  const at = scan[resumeLineOf(scan, line) - 1]
  if (at === undefined) return out
  if (at.start[2] !== undefined && at.start[2] < -EPS)
    out.push({ rule: 'inMaterial', z: at.start[2] })
  // inside a run of feed moves that change Z (a plunge, a ramp, a helix), not at its first line
  const zFeed = (l: ScannedLine | undefined) => l?.motion === 'feed' && changesZ(l)
  let k = at.line - 1
  // the first motion line at or after the line
  while (k < scan.length && scan[k]?.motion === 'none') k++
  if (zFeed(scan[k])) {
    let from = k
    let helix = scan[k]?.arc === true
    for (let j = k - 1; j >= 0; j--) {
      const l = scan[j]
      if (l?.motion === 'none') continue
      if (!zFeed(l)) break
      from = j
      helix ||= l?.arc === true
    }
    if (from < k) out.push({ rule: 'ramp', helix, from: from + 1 })
  }
  if (at.tool !== undefined) out.push({ rule: 'toolChange', n: at.tool.n, name: at.tool.name })
  if (!at.before.parser.absolute) out.push({ rule: 'incremental' })
  return out
}

/**
 * The suggested resume point after an interruption (Q160): the latest resume point at or before
 * the lower bound of where the run stopped – the executing line at the last report, else the
 * acknowledged lines minus a full planner (erring early); `waitingAt` (the run waited at a tool
 * change or pause on that line) suggests the first point after the wait. `safest` is the operation
 * start the suggestion belongs to (the first point when the program has none). Undefined without resume points.
 */
export function suggestResume(
  points: readonly ResumePoint[],
  at: {
    readonly executing: number
    readonly acknowledged: number
    readonly waitingAt?: number | undefined
  },
): { readonly suggestion: ResumePoint; readonly safest: ResumePoint } | undefined {
  if (points.length === 0) return undefined
  let suggestion: ResumePoint | undefined
  if (at.waitingAt !== undefined) suggestion = points.find((p) => p.line > (at.waitingAt ?? 0))
  if (suggestion === undefined) {
    const lower =
      at.executing > 0 ? at.executing : Math.max(0, at.acknowledged - PLANNER_BLOCKS - 1)
    suggestion = points.filter((p) => p.line <= lower).at(-1) ?? points[0]
  }
  if (suggestion === undefined) return undefined
  const line = suggestion.line
  // a program without operation starts is one operation: its first point (DF129 RC5)
  const safest =
    points.filter((p) => p.kind === 'operation' && p.line <= line).at(-1) ?? points[0] ?? suggestion
  return { suggestion, safest }
}

/** What the lead-in needs besides the program. */
export interface LeadInOptions {
  /** The machine top (machine Z, mm): `machineTopZ` of the controller's envelope. */
  readonly topZ: number
  /** The spin-up dwell (s): the plan's spin-up, `FILE_SPIN_UP_SECONDS` for a file (Q172). */
  readonly spinUpSeconds: number
  /** `manual`: a hand-switched spindle, a program pause asks to start it. */
  readonly spindleControl: 'gcode' | 'manual'
}

/** A program resumed at a line: the lead-in, then the program's lines from the line on. */
export interface ResumedProgram {
  /** The line the program resumes at (after `resumeLineOf`). */
  readonly fromLine: number
  readonly leadIn: readonly string[]
  /** Lead-in + remainder; sections shifted, a `Lead-in` section first. */
  readonly program: SenderProgram
  /** Added to an original line (≥ `fromLine`) gives its line in `program`. */
  readonly offset: number
  readonly findings: readonly ResumeFinding[]
}

/**
 * The lead-in and the resumed program (docs/modes/run-recovery.md#the-lead-in). `input.malformed`
 * (path `fromLine`) for a line outside the program or one whose start point the program has not
 * set yet (before its first absolute move, or after a G53 move).
 */
export function resumeProgram(
  program: SenderProgram,
  line: number,
  opts: LeadInOptions,
  scan: readonly ScannedLine[] = scanProgram(program.lines),
): AppResult<ResumedProgram> {
  const where = 'resumeProgram'
  const n = program.lines.length
  const bad = (rule: string, message: string) =>
    fail('input.malformed', message, {
      where,
      data: { fromLine: line, lines: n },
      issues: [{ path: ['fromLine'], rule, message }],
    })
  if (!Number.isInteger(line) || line < 1 || line > n)
    return bad('range', `line ${line} is not in the program (1–${n})`)
  const from = resumeLineOf(scan, line)
  const at = scan[from - 1]
  if (at === undefined) return bad('range', `nothing to run after line ${line}`)
  if (!known(at.start))
    return bad(
      'noStartPoint',
      `the program has not set where line ${from} starts (before its first absolute X, Y and Z, or after a G53 move)`,
    )
  const leadIn = leadInLines(at, opts)
  const rest = program.lines.slice(from - 1)
  const first = restateMotion(scan, program.lines, from)
  if (first !== undefined) rest[first.index] = first.text
  const offset = leadIn.length - (from - 1)
  const sections: { fromLine: number; label: string }[] = [{ fromLine: 1, label: 'Lead-in' }]
  const current = program.sections.filter((s) => s.fromLine <= from).at(-1)
  if (current !== undefined) sections.push({ fromLine: leadIn.length + 1, label: current.label })
  for (const s of program.sections)
    if (s.fromLine > from) sections.push({ fromLine: s.fromLine + offset, label: s.label })
  return Ok({
    fromLine: from,
    leadIn,
    program: { lines: [...leadIn, ...rest], sections },
    offset,
    findings: resumeFindings(scan, from),
  })
}

/**
 * The first motion line from `from` on relies on a modal motion mode it does not state (`X10 Y5`
 * under `G2`): the lead-in's own moves leave G0/G1 set, and GRBL cannot set G2/G3 without axis
 * words, so that line gets its motion word (`G2 X10 Y5`).
 */
function restateMotion(
  scan: readonly ScannedLine[],
  lines: readonly string[],
  from: number,
): { index: number; text: string } | undefined {
  for (let k = from - 1; k < scan.length; k++) {
    const raw = lines[k] ?? ''
    const code = normalize(raw)
    if (MOTION_WORD.test(code) || NOT_MOTION.test(code)) return undefined
    if (!AXIS_WORD.test(code)) continue
    const m = scan[k]?.before.parser.motion
    if (m !== 0 && m !== 1 && m !== 2 && m !== 3) return undefined
    return { index: k - from + 1, text: `G${m} ${raw.trim()}` }
  }
  return undefined
}

/** The lead-in's lines in the program's units at the line (docs/modes/run-recovery.md#the-lead-in). */
function leadInLines(at: ScannedLine, opts: LeadInOptions): string[] {
  const s = at.before.parser
  const inch = !s.metric
  const per = inch ? 1 / MM_PER_INCH : 1
  const num = (mm: number) => formatNumber(mm * per, inch ? 4 : 3)
  const feed = (mmMin: number) => formatNumber(mmMin * per, inch ? 2 : 1)
  const modes = `G90 G94 G${at.before.plane} ${inch ? 'G20' : 'G21'}`
  const top = `G53 G0 Z${num(opts.topZ)}`
  const [x, y, z] = at.start as readonly [number, number, number]
  const toolN = at.tool?.n ?? (s.tool > 0 ? s.tool : 1)
  const toolName = at.tool?.name ?? `Tool ${toolN}`
  const out: string[] = [
    commentLine(`Resume at line ${at.line}: lead-in`),
    modes,
    'G54',
    'M5',
    'M9',
    top,
    // the tool wait (Q167): the tool-change dialog – check or change the bit, set Z zero
    `(${fitName(`DFYOM TOOL CHANGE ${toolN}: `, toolName, '', 68)})`,
    pauseLine(fitName(`Check T${toolN} `, toolName, ', then zero Z', 66)),
    modes,
    'G54',
    top,
  ]
  if (at.before.coolant.mist) out.push('M7')
  if (at.before.coolant.flood) out.push('M8')
  if (s.spindle !== 'off') out.push(...spindleLines(s.spindle, s.spindleSpeed, opts))
  out.push(`G0 X${num(x)} Y${num(y)}`)
  // the program's own rapid height there, never closer than 1 mm above a start point below it;
  // a start at or above it is reached by the rapid; without one, 1 mm above the start (or Z 0)
  const rapid = at.rapidZ
  const approachZ =
    rapid === undefined
      ? Math.max(z, 0) + APPROACH_MIN_MM
      : z < rapid - EPS
        ? Math.max(rapid, z + APPROACH_MIN_MM)
        : z
  out.push(`G0 Z${num(approachZ)}`)
  if (approachZ - z > EPS) {
    const plunge = at.plungeFeed ?? (s.feed > 0 ? s.feed / 2 : undefined)
    out.push(plunge === undefined ? `G0 Z${num(z)}` : `G1 Z${num(z)} F${feed(plunge)}`)
  }
  // the distance mode and feed at the line; its motion word goes on its first motion line
  const tail: string[] = []
  if (!s.absolute) tail.push('G91')
  if (s.feed > 0) tail.push(`F${feed(s.feed)}`)
  if (tail.length > 0) out.push(tail.join(' '))
  return out
}

function spindleLines(dir: SpindleDir, rpm: number, opts: LeadInOptions): string[] {
  const s = formatNumber(rpm, 0)
  const on = `${dir === 'ccw' ? 'M4' : 'M3'} S${s}`
  if (opts.spindleControl === 'manual') {
    const text = `Set spindle to ${s} rpm`
    return [on, commentLine(text), pauseLine(text)]
  }
  const p = formatNumber(opts.spinUpSeconds, 2)
  return p === '0' ? [on] : [on, `G4 P${p}`]
}

/** SHA-256 (hex) of a program's lines joined with `\n`: the journal's `programHash`. */
export async function programHash(lines: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(lines.join('\n'))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
