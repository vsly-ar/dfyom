// Run mode's gCode panel under the 3D view (DF84): the program the run job streams, as a
// collapsible, resizable, virtualized list with a header row at each section start; the executing
// line (estimated in main from `Bf`, the acknowledged lines' planner blocks and the position)
// highlighted, the lines in the planner and the lines sent marked. "Follow" keeps the executing
// line in view; the user's own scroll turns it off. The program comes once per job from main
// (`window.dfyom.run.program`, renderer only, no agent tool).
// Doc: docs/modes/run.md#gcode-panel-df84, docs/conventions/ui.md#run-mode-safety-ui
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RunProgram, RunStatus } from '../../../../core/run/service'
import { runMessages } from '../../messages/run'
import { useShell } from '../../shell/ShellContext'
import { Icon } from '../../ui'
import {
  lineState,
  ProgramRows,
  scrollGeometry,
  scrollTopFor,
  visibleRows,
  type RunIndices,
} from './gcode-rows'
import { GCODE_HEIGHT_REM, useRun, type GcodePanelState } from './run-store'
import styles from './Run.module.css'

const m = runMessages.gcode

/** Fixed row height (px) of the virtual list; the CSS row matches it. */
export const GCODE_ROW_PX = 20
/** Rows rendered beyond the visible ones on each side. */
export const GCODE_OVERSCAN = 20
/** The header row (rem); the collapsed panel is this tall. */
export const GCODE_HEADER_REM = 2
export const GCODE_MIN_REM = 6
/** The open panel's largest share of the viewport. */
export const GCODE_MAX_SHARE = 0.6

/** Keys that scroll a focused list: pressing one ends Follow. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

/** The panel's height (rem) as the 3D view must leave it. */
export function gcodePanelRem(state: GcodePanelState): number {
  return state.open ? Math.max(GCODE_MIN_REM, state.height) : GCODE_HEADER_REM
}

/** Where the job is, from the status (undefined without a job of this program). */
export function runIndices(status: RunStatus, jobId: string | undefined): RunIndices | undefined {
  const job = status.job
  if (job === undefined || job.jobId !== jobId) return undefined
  return {
    acknowledged: job.line,
    sent: job.sent ?? job.line,
    executing: job.executing,
    finished: job.phase === 'done',
  }
}

/** The connected panel: run store state, the program fetched from main once per job. */
export function GcodePanel({ insetRight = 0 }: { insetRight?: number }): React.JSX.Element {
  const { bridge } = useShell()
  const status = useRun((s) => s.status)
  const gcode = useRun((s) => s.gcode)
  const setGcode = useRun((s) => s.setGcode)
  const jobId = status.job?.jobId ?? status.lastRun?.jobId
  const program = useProgram(bridge.run.program, jobId)
  // DF93: a loaded gCode file shows its prepared lines while no run streams
  const file = useRun((s) => s.file)
  const filePrepared = file?.state === 'ready' ? file.prepared : undefined
  const fileProgram = useMemo(
    (): ProgramLoad | undefined =>
      filePrepared === undefined
        ? undefined
        : {
            state: 'ready',
            value: {
              jobId: '',
              lines: filePrepared.lines,
              sections: filePrepared.sections,
              operations: [],
            },
          },
    [filePrepared],
  )
  const shown = status.job === undefined && fileProgram !== undefined ? fileProgram : program
  return (
    <GcodePanelView
      program={shown}
      run={runIndices(status, program.value?.jobId)}
      state={gcode}
      onChange={setGcode}
      insetRight={insetRight}
    />
  )
}

type ProgramLoad =
  | { readonly state: 'none' | 'loading' | 'gone'; readonly value?: undefined }
  | { readonly state: 'ready'; readonly value: RunProgram }

/** Fetches job `jobId`'s program once; main keeps it from the start, so a miss is retried. */
function useProgram(
  fetch: (jobId: string) => Promise<RunProgram | null>,
  jobId: string | undefined,
): ProgramLoad {
  const [load, setLoad] = useState<{ jobId: string; load: ProgramLoad } | undefined>(undefined)
  useEffect(() => {
    if (jobId === undefined) return
    let live = true
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = (): void => {
      void fetch(jobId).then(
        (p) => {
          if (!live) return
          if (p !== null) setLoad({ jobId, load: { state: 'ready', value: p } })
          else if (++tries < 5) timer = setTimeout(attempt, 400)
          else setLoad({ jobId, load: { state: 'gone' } })
        },
        () => live && setLoad({ jobId, load: { state: 'gone' } }),
      )
    }
    attempt()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [fetch, jobId])
  if (jobId === undefined) return { state: 'none' }
  return load?.jobId === jobId ? load.load : { state: 'loading' }
}

export interface GcodePanelViewProps {
  program: ProgramLoad
  run: RunIndices | undefined
  state: GcodePanelState
  onChange(patch: Partial<GcodePanelState>): void
  insetRight?: number
}

export function GcodePanelView({
  program,
  run,
  state,
  onChange,
  insetRight = 0,
}: GcodePanelViewProps): React.JSX.Element {
  const bodyId = useId()
  const legendId = useId()
  const rootRef = useRef<HTMLElement>(null)
  const p = program.value
  const rows = useMemo(
    () => (p === undefined ? undefined : new ProgramRows(p.lines.length, p.sections)),
    [p],
  )
  const total = p?.lines.length ?? 0
  const current =
    run === undefined
      ? undefined
      : run.finished === true
        ? total
        : run.executing !== undefined && run.executing > 0
          ? run.executing
          : run.acknowledged > 0
            ? run.acknowledged
            : undefined
  const section = rows !== undefined && current !== undefined ? rows.sectionOf(current) : undefined
  const heightRem = gcodePanelRem(state)
  // the 3D view ends above the panel (AppShell's `.viewportCanvas` reads the inset)
  useLayoutEffect(() => {
    const parent = rootRef.current?.parentElement
    if (parent === null || parent === undefined) return
    parent.style.setProperty('--viewport-inset-bottom', `${heightRem}rem`)
    return () => {
      parent.style.removeProperty('--viewport-inset-bottom')
    }
  }, [heightRem])
  // the viewport's height bounds the open panel's (60 %)
  const [parentPx, setParentPx] = useState(0)
  useLayoutEffect(() => {
    const parent = rootRef.current?.parentElement
    if (parent === null || parent === undefined) return
    const read = (): void => setParentPx(parent.clientHeight)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])
  return (
    <section
      ref={rootRef}
      className={styles['gcodePanel']}
      aria-label={m.region}
      data-open={state.open ? '' : undefined}
      style={{ height: `${heightRem}rem`, right: insetRight }}
    >
      {state.open ? (
        <ResizeHandle
          height={state.height}
          parentPx={parentPx}
          onHeight={(height) => onChange({ height })}
        />
      ) : null}
      <div className={styles['gcodeHeader']}>
        <button
          type="button"
          className={styles['gcodeDisclosure']}
          aria-expanded={state.open}
          aria-controls={state.open ? bodyId : undefined}
          onClick={() => onChange({ open: !state.open })}
        >
          <Icon name="chevron-down" className={styles['gcodeChevron']} />
          {m.title}
        </button>
        <span className={styles['gcodeSection']}>{section ?? ''}</span>
        {p !== undefined ? (
          <span className={styles['gcodeCount']}>
            {current !== undefined && run !== undefined && run.finished !== true
              ? m.line(current, total)
              : m.lines(total)}
          </span>
        ) : null}
        {state.open ? (
          <button
            type="button"
            className={styles['gcodeFollow']}
            aria-pressed={state.follow}
            title={m.followHint}
            onClick={() => onChange({ follow: !state.follow })}
          >
            {m.follow}
          </button>
        ) : null}
      </div>
      {state.open ? (
        <div id={bodyId} className={styles['gcodeBody']}>
          {p !== undefined && rows !== undefined ? (
            <>
              <p id={legendId} className={styles['gcodeLegend']}>
                {m.legend}
              </p>
              <ProgramList
                program={p}
                rows={rows}
                run={run}
                follow={state.follow}
                legendId={legendId}
                onUserScroll={() => state.follow && onChange({ follow: false })}
              />
            </>
          ) : (
            <p className={styles['gcodeEmpty']}>
              {program.state === 'loading'
                ? m.loading
                : program.state === 'gone'
                  ? m.gone
                  : m.empty}
            </p>
          )}
        </div>
      ) : null}
    </section>
  )
}

/** The panel's top edge: drag or arrow keys to resize (rem, 6 to 60 % of the viewport). */
function ResizeHandle({
  height,
  parentPx,
  onHeight,
}: {
  height: number
  parentPx: number
  onHeight(height: number): void
}): React.JSX.Element {
  const remPx = (): number => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const maxRem = parentPx > 0 ? Math.max(GCODE_MIN_REM, (parentPx * GCODE_MAX_SHARE) / remPx()) : 40
  const clamp = (h: number): number => Math.min(maxRem, Math.max(GCODE_MIN_REM, h))
  const drag = useRef<{ y: number; h: number } | undefined>(undefined)
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={m.resize}
      aria-valuenow={Math.round(height)}
      aria-valuemin={GCODE_MIN_REM}
      aria-valuemax={Math.round(maxRem)}
      tabIndex={0}
      className={styles['gcodeResize']}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        drag.current = { y: e.clientY, h: height }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d !== undefined) onHeight(clamp(d.h + (d.y - e.clientY) / remPx()))
      }}
      onPointerUp={() => (drag.current = undefined)}
      onPointerCancel={() => (drag.current = undefined)}
      onKeyDown={(e) => {
        const to =
          e.key === 'ArrowUp'
            ? height + 1
            : e.key === 'ArrowDown'
              ? height - 1
              : e.key === 'Home'
                ? GCODE_MIN_REM
                : e.key === 'End'
                  ? maxRem
                  : undefined
        if (to === undefined) return
        e.preventDefault()
        onHeight(clamp(to))
      }}
      onDoubleClick={() => onHeight(clamp(GCODE_HEIGHT_REM))}
    />
  )
}

function ProgramList({
  program,
  rows,
  run,
  follow,
  legendId,
  onUserScroll,
}: {
  program: RunProgram
  rows: ProgramRows
  run: RunIndices | undefined
  follow: boolean
  legendId: string
  onUserScroll(): void
}): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewPx, setViewPx] = useState(0)
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (el === null) return
    const read = (): void => setViewPx(el.clientHeight)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // jsdom and a first frame without layout: render a screenful
  const view = viewPx > 0 ? viewPx : 12 * GCODE_ROW_PX
  const { spacer } = scrollGeometry(rows.count, GCODE_ROW_PX, view)
  const { first, last, offset } = visibleRows(
    rows.count,
    GCODE_ROW_PX,
    view,
    scrollTop,
    GCODE_OVERSCAN,
  )
  const executing = run?.finished === true ? undefined : run?.executing
  const target = executing ?? (run !== undefined && run.acknowledged > 0 ? run.acknowledged : 0)
  const scrollTo = useCallback(
    (line: number) => {
      const el = scrollerRef.current
      if (el === null || line < 1) return
      const top = scrollTopFor(rows.rowOfLine(line), rows.count, GCODE_ROW_PX, view)
      if (Math.abs(el.scrollTop - top) >= 1) {
        el.scrollTop = top
        setScrollTop(top)
      }
    },
    [rows, view],
  )
  useLayoutEffect(() => {
    if (follow) scrollTo(target)
  }, [follow, target, scrollTo])
  const gutter = `${String(program.lines.length).length + 1}ch`
  const items: React.JSX.Element[] = []
  for (let r = first; r <= last; r++) {
    const row = rows.row(r)
    const top = scrollTop + r * GCODE_ROW_PX - offset
    if (row.kind === 'section') {
      items.push(
        <div
          key={`s${r}`}
          role="listitem"
          aria-posinset={r + 1}
          aria-setsize={rows.count}
          className={styles['gcodeSectionRow']}
          style={{ top }}
        >
          {row.label}
        </div>,
      )
      continue
    }
    const state = lineState(row.line, run)
    items.push(
      <div
        key={`l${row.line}`}
        role="listitem"
        aria-posinset={r + 1}
        aria-setsize={rows.count}
        aria-current={state === 'executing' ? 'step' : undefined}
        data-state={state}
        className={styles['gcodeRow']}
        style={{ top }}
      >
        <span className={styles['gcodeNumber']} style={{ width: gutter }}>
          {row.line}
        </span>
        <span className={styles['gcodeMark']} aria-hidden="true" />
        <span className={styles['gcodeText']}>{program.lines[row.line - 1]}</span>
      </div>,
    )
  }
  return (
    <div
      ref={scrollerRef}
      role="list"
      aria-label={m.list}
      aria-describedby={legendId}
      tabIndex={0}
      className={styles['gcodeList']}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onWheel={onUserScroll}
      onTouchStart={onUserScroll}
      onPointerDown={(e) => {
        // the scroll bar belongs to the list element itself; rows are its descendants
        if (e.target === e.currentTarget) onUserScroll()
      }}
      onKeyDown={(e) => {
        if (SCROLL_KEYS.has(e.key)) onUserScroll()
      }}
    >
      <div className={styles['gcodeSpacer']} style={{ height: spacer }}>
        {items}
      </div>
    </div>
  )
}
