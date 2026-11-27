// The pre-flight's "Start at" (DF129 RC3), pure parts: the select's options from a program's
// resume points (grouped by operation, passes counted), the lead-in's lines read back as steps for
// the preview, the snap of a line to the resume point at or before it, and the 3D view's skipped
// segments (the toolpath before the start line, dimmed like the done part).
// Doc: docs/modes/run-recovery.md#implementation-rc3, #the-lead-in
import type { ResumePoint } from '../../../../core/run/recovery'
import { scanProgram, type ScannedLine } from '../../../../core/run/recovery'
import { runMessages } from '../../messages/run'
import type { SelectOption } from '../../ui'
import { advancePlayback, type ToolpathLines } from '../../viewport'

const m = runMessages.startAt

/** The select's value: the beginning, a resume point (`p:<line>`) or "Choose a line…". */
export type StartAtValue = 'beginning' | 'line' | `p:${number}`

/** "Start at"'s options: Beginning, the resume points grouped by operation, Choose a line…. */
export function startAtOptions(points: readonly ResumePoint[]): SelectOption<StartAtValue>[] {
  const out: SelectOption<StartAtValue>[] = [{ value: 'beginning', label: m.beginning }]
  let group: string = m.beforeOperations
  let pass = 1
  for (const p of points) {
    if (p.kind === 'operation') {
      group = p.label ?? m.beforeOperations
      pass = 1
      out.push({ value: `p:${p.line}`, label: m.operationStart(p.line), group })
    } else {
      pass += 1
      out.push({ value: `p:${p.line}`, label: m.pass(pass, p.line), group })
    }
  }
  out.push({ value: 'line', label: m.chooseLine })
  return out
}

/** The resume point at or before `line`, if any. */
export function snapToPoint(points: readonly ResumePoint[], line: number): ResumePoint | undefined {
  return points.filter((p) => p.line <= line).at(-1)
}

/** One step of the lead-in as the pre-flight lists it (values as the program writes them). */
export type LeadInStep =
  | { readonly kind: 'retract' }
  | { readonly kind: 'toolWait'; readonly n: number; readonly name: string }
  | { readonly kind: 'coolant'; readonly flood: boolean }
  | {
      readonly kind: 'spindle'
      readonly rpm: string
      readonly ccw: boolean
      readonly dwell?: string | undefined
    }
  | { readonly kind: 'spindleManual'; readonly rpm: string }
  | { readonly kind: 'moveXY'; readonly x: string; readonly y: string }
  | { readonly kind: 'approach'; readonly z: string }
  | { readonly kind: 'plunge'; readonly z: string; readonly feed?: string | undefined }

const TOOL = /^\(DFYOM TOOL CHANGE (\d+): ([^()]*)\)$/
const word = (line: string, letter: string): string | undefined =>
  new RegExp(`${letter}(-?[\\d.]+)`).exec(line)?.[1]

/**
 * The lead-in's lines (`recovery.ts` `leadInLines`, docs/modes/run-recovery.md#the-lead-in) as
 * steps, and its units (`in` under G20). The repeated modal lines and the top after the tool wait
 * are not steps of their own.
 */
export function leadInSteps(lines: readonly string[]): {
  steps: LeadInStep[]
  unit: 'mm' | 'in'
} {
  const steps: LeadInStep[] = []
  const unit = lines.some((l) => /\bG20\b/.test(l)) ? 'in' : 'mm'
  let retracted = false
  let zMoves = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim()
    const tool = TOOL.exec(l)
    if (tool) {
      steps.push({ kind: 'toolWait', n: Number(tool[1]), name: tool[2]!.trim() })
      continue
    }
    if (/^G53 G0 Z/.test(l)) {
      if (!retracted) steps.push({ kind: 'retract' })
      retracted = true
      continue
    }
    if (l === 'M7' || l === 'M8') {
      steps.push({ kind: 'coolant', flood: l === 'M8' })
      continue
    }
    if (/^M[34] S/.test(l)) {
      const rpm = Number(word(l, 'S') ?? 0).toLocaleString('en-GB')
      const next = lines[i + 1]?.trim() ?? ''
      if (/^\(Set spindle to /.test(next)) {
        steps.push({ kind: 'spindleManual', rpm })
        i += 2 // the comment and its M0
        continue
      }
      const dwell = /^G4 P/.test(next) ? word(next, 'P') : undefined
      if (dwell !== undefined) i += 1
      steps.push({ kind: 'spindle', rpm, ccw: l.startsWith('M4'), dwell })
      continue
    }
    if (/^G0 X/.test(l)) {
      steps.push({ kind: 'moveXY', x: word(l, 'X') ?? '', y: word(l, 'Y') ?? '' })
      continue
    }
    if (/^G[01] Z/.test(l)) {
      const z = word(l, 'Z') ?? ''
      zMoves += 1
      if (zMoves === 1 && l.startsWith('G0')) steps.push({ kind: 'approach', z })
      else steps.push({ kind: 'plunge', z, feed: l.startsWith('G1') ? word(l, 'F') : undefined })
    }
  }
  return { steps, unit }
}

/** A step's sentence (`unit` of the lead-in). */
export function stepText(s: LeadInStep, unit: 'mm' | 'in'): string {
  switch (s.kind) {
    case 'retract':
      return m.steps.retract
    case 'toolWait':
      return m.steps.toolWait(s.n)
    case 'coolant':
      return m.steps.coolant(s.flood)
    case 'spindle':
      return m.steps.spindle(s.rpm, s.ccw, s.dwell)
    case 'spindleManual':
      return m.steps.spindleManual(s.rpm)
    case 'moveXY':
      return m.steps.moveXY(s.x, s.y, unit)
    case 'approach':
      return m.steps.approach(s.z, unit)
    case 'plunge':
      return m.steps.plunge(s.z, unit, s.feed)
  }
}

/**
 * The segments of `lines` (the run scene's moves) the program runs before `fromLine`: the scene
 * dims them like the done part. Follows each skipped motion line's end point along the moves, as
 * the run's playback follows `wpos` (`zLevel`: the scene's Z offset, DF69). 0 when none is found.
 */
export function skippedSegments(
  lines: ToolpathLines,
  program: readonly string[] | readonly ScannedLine[],
  fromLine: number,
  zLevel = 0,
): number {
  const scan: readonly ScannedLine[] =
    typeof program[0] === 'string'
      ? scanProgram(program as readonly string[])
      : (program as readonly ScannedLine[])
  let at = 0
  let found = false
  for (const l of scan) {
    if (l.line >= fromLine) break
    if (l.motion === 'none') continue
    const [x, y, z] = l.end
    if (x === undefined || y === undefined || z === undefined) continue
    const next = advancePlayback(lines, at, [x, y, z + zLevel])
    if (next !== at || distanceOk(lines, next, [x, y, z + zLevel])) {
      at = next
      found = true
    }
  }
  return found ? Math.min(lines.segments, at + 1) : 0
}

/** Whether segment `i` ends at `p` (the first match of `advancePlayback` from its own index). */
function distanceOk(lines: ToolpathLines, i: number, p: readonly number[]): boolean {
  if (i >= lines.segments) return false
  const o = i * 6 + 3
  const q = lines.positions
  return Math.hypot((q[o] ?? 0) - p[0]!, (q[o + 1] ?? 0) - p[1]!, (q[o + 2] ?? 0) - p[2]!) <= 0.1
}
