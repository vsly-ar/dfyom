// The gCode panel's rows (DF84): the program's lines with a header row at each section start,
// each line's state from the run's indices, and the virtual list's scroll arithmetic (rows only
// for what is visible; positions scaled past the browser's element height limit). Pure.
// Doc: docs/modes/run.md#gcode-panel-df84, docs/conventions/ui.md#run-mode-safety-ui

/** A section start (`SenderProgram.sections`). */
export interface SectionStart {
  readonly fromLine: number
  readonly label: string
}

export type Row =
  | { readonly kind: 'section'; readonly section: number; readonly label: string }
  | { readonly kind: 'line'; readonly line: number }

/** Line rows plus a header row before each section's first line. */
export class ProgramRows {
  /** Row index of each section's header, ascending. */
  private readonly headers: readonly number[]
  readonly count: number

  constructor(
    readonly lines: number,
    readonly sections: readonly SectionStart[],
  ) {
    this.headers = sections.map((s, i) => s.fromLine - 1 + i)
    this.count = lines + sections.length
  }

  /** Headers at or before row `r` (−1 when none). */
  private lastHeaderAtOrBefore(r: number): number {
    let lo = 0
    let hi = this.headers.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.headers[mid]! <= r) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return found
  }

  row(r: number): Row {
    const s = this.lastHeaderAtOrBefore(r)
    if (s >= 0 && this.headers[s] === r)
      return { kind: 'section', section: s, label: this.sections[s]!.label }
    return { kind: 'line', line: r - (s + 1) + 1 }
  }

  /** The row of 1-based `line`. */
  rowOfLine(line: number): number {
    // sections starting at or before the line put their header above it
    let lo = 0
    let hi = this.sections.length - 1
    let n = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.sections[mid]!.fromLine <= line) {
        n = mid + 1
        lo = mid + 1
      } else hi = mid - 1
    }
    return line - 1 + n
  }

  /** The label of the section holding 1-based `line`, if any. */
  sectionOf(line: number): string | undefined {
    let label: string | undefined
    for (const s of this.sections) {
      if (s.fromLine > line) break
      label = s.label
    }
    return label
  }
}

/** Where the run is in the program (1-based lines; 0 = none yet). */
export interface RunIndices {
  /** The line the machine executes (estimate); undefined while not known. */
  readonly executing?: number | undefined
  /** Lines acknowledged by the controller. */
  readonly acknowledged: number
  /** Lines written to the controller. */
  readonly sent: number
  /** The run ended successfully: every line has run. */
  readonly finished?: boolean
}

export type LineState = 'done' | 'executing' | 'planned' | 'sent' | 'pending'

/**
 * A line's state: run (`done`), the one executing, acknowledged and waiting in the planner
 * (`planned`), sent and not yet acknowledged (`sent`), or not sent (`pending`).
 */
export function lineState(line: number, run: RunIndices | undefined): LineState {
  if (run === undefined) return 'pending'
  if (run.finished === true) return 'done'
  const executing = run.executing ?? 0
  if (line < executing) return 'done'
  if (line === executing) return 'executing'
  if (line <= run.acknowledged) return run.executing === undefined ? 'done' : 'planned'
  if (line <= run.sent) return 'sent'
  return 'pending'
}

/** Chromium lays out elements up to ~33.5 M px; the list stays well below (scaled past it). */
export const MAX_SCROLL_PX = 10_000_000

/** The list's scroll geometry: spacer height and the factor from scroll position to content. */
export function scrollGeometry(
  rows: number,
  rowPx: number,
  viewPx: number,
): { readonly spacer: number; readonly scale: number } {
  const total = rows * rowPx
  if (total <= MAX_SCROLL_PX) return { spacer: total, scale: 1 }
  const range = Math.max(1, MAX_SCROLL_PX - viewPx)
  return { spacer: MAX_SCROLL_PX, scale: (total - viewPx) / range }
}

/** The rows to render (with `overscan` on each side) at `scrollTop`, and the content offset. */
export function visibleRows(
  rows: number,
  rowPx: number,
  viewPx: number,
  scrollTop: number,
  overscan: number,
): { readonly first: number; readonly last: number; readonly offset: number } {
  const { scale } = scrollGeometry(rows, rowPx, viewPx)
  const offset = scrollTop * scale
  const first = Math.max(0, Math.floor(offset / rowPx) - overscan)
  const last = Math.min(rows - 1, Math.ceil((offset + viewPx) / rowPx) + overscan)
  return { first, last, offset }
}

/** The scroll position that puts row `row` a third down the view. */
export function scrollTopFor(row: number, rows: number, rowPx: number, viewPx: number): number {
  const { spacer, scale } = scrollGeometry(rows, rowPx, viewPx)
  const content = row * rowPx - viewPx / 3
  return Math.max(0, Math.min(spacer - viewPx, content / scale))
}
