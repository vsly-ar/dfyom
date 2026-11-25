// The exploded split preview of the design scene (split parts 4a polish): while a source part with
// a split shows its part inspector (the Split section), the viewport draws its pieces pulled apart
// and its lines and levels as plane handles. A drag moves a cut live in the preview, snapped (whole
// millimetres and the part's middle; Alt or snapping off: 0.01 mm), and commits the whole split
// with `design.split.set` at most every COMMIT_MS and on release, all one gesture (one undo step),
// so the fields, chips and findings follow while dragging; Escape reverts the gesture. A step the
// core refuses (removing pieces with plans) ends the drag and reverts it; the fields keep that path.
// Doc: docs/conventions/ui.md#split-part-split-parts-4a, docs/modes/split-parts.md#implementation-4a-polish
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DfmWarning } from '../../../../core/geometry/model'
import { designMessages } from '../../messages/design'
import { useUi } from '../../shell/ShellContext'
import { useCancelGesture } from '../../shell/hooks'
import type { SplitDragPhase, SplitOverlay } from '../../viewport/SplitLayer'
import type { DesignPart } from './model'
import {
  cutFindings,
  cutShift,
  cutSource,
  explodeGap,
  explodedCells,
  piecesOf,
  snapCut,
  splitArgs,
  splitCuts,
  type CutDraft,
  type SplitArgs,
  type SplitCut,
} from './split-view'
import { useCommand } from './useDesign'

const t = designMessages.split

/** A drag commits at most this often (each step regenerates the pieces and their findings). */
export const COMMIT_MS = 200

const cutKey = (c: { kind: string; index: number }) => `${c.kind}-${c.index}`

/** The split with one cut moved to `at` (mm), as `design.split.set` args. */
function withCut(args: SplitArgs, cut: CutDraft, units: 'mm' | 'inch'): SplitArgs {
  const source = cutSource(cut.at, units)
  return cut.kind === 'line'
    ? { ...args, lines: args.lines.map((l, i) => (i === cut.index ? { ...l, at: source } : l)) }
    : { ...args, levels: args.levels.map((l, i) => (i === cut.index ? source : l)) }
}

let gestures = 0

export function useSplitScene(
  part: DesignPart | undefined,
  shown: boolean,
  warnings: readonly DfmWarning[],
): { split: SplitOverlay | null; summary: string | undefined } {
  const call = useCommand()
  const cancelGesture = useCancelGesture()
  const snapOn = useUi((s) => s.snapOn)
  const focus = useUi((s) => s.splitFocus)
  const setFocus = useUi((s) => s.setSplitFocus)
  const [draft, setDraft] = useState<CutDraft | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const session = useRef<{
    gesture: string
    committed: number
    last: number
    busy: boolean
    queued: CutDraft | null
    failed: boolean
  } | null>(null)
  const split = part?.dto.split
  const stock = part?.loaded?.stock
  const active =
    shown && part !== undefined && part.dto.derivedFrom === undefined && split !== undefined
  // a part switch or the section closing drops a drag in progress
  useEffect(() => {
    if (!active) setDraft(null)
  }, [active])

  const size = useMemo(
    () =>
      stock === undefined
        ? undefined
        : { L: stock.length.canonical, W: stock.width.canonical, T: stock.thickness.canonical },
    [stock],
  )
  const units = part?.units ?? 'mm'
  const cuts = useMemo(() => (split === undefined ? [] : splitCuts(split, draft)), [split, draft])
  const committedCuts = useMemo(() => (split === undefined ? [] : splitCuts(split)), [split])

  const overlay = useMemo((): SplitOverlay | null => {
    if (!active || split === undefined || size === undefined || part === undefined) return null
    const gap = explodeGap(size)
    const send = async (cut: CutDraft) => {
      const s = session.current
      if (s === null || s.failed) return
      if (s.busy) {
        s.queued = cut
        return
      }
      s.busy = true
      s.last = performance.now()
      const r = await call(
        'design.split.set',
        { partId: part.dto.id, split: withCut(splitArgs(split), cut, units) },
        { gesture: s.gesture },
      )
      s.busy = false
      if (!r.ok) {
        // a step that would remove pieces with plans (or any refusal): revert the drag
        s.failed = true
        if (s.committed > 0) await cancelGesture(s.gesture)
        setDraft(null)
        return
      }
      s.committed++
      const q = s.queued
      s.queued = null
      if (q !== null) await send(q)
    }
    const onDrag = (phase: SplitDragPhase, key: string, value: number, mods: { alt: boolean }) => {
      const cut = committedCuts.find((c) => cutKey(c) === key)
      if (cut === undefined) return
      const at = snapCut(
        value,
        cut.axis,
        size,
        snapOn && !mods.alt,
        Math.max(size.L, size.W, size.T) * 0.015,
      )
      const next: CutDraft = { kind: cut.kind, index: cut.index, at }
      if (phase === 'start') {
        session.current = {
          gesture: `split-drag-${++gestures}`,
          committed: 0,
          last: performance.now(),
          busy: false,
          queued: null,
          failed: false,
        }
        setFocus({ kind: cut.kind, index: cut.index })
        return setDraft({ kind: cut.kind, index: cut.index, at: cut.at })
      }
      const s = session.current
      if (s === null || s.failed) return
      if (phase === 'cancel') {
        session.current = null
        setDraft(null)
        if (s.committed > 0 || s.busy) void cancelGesture(s.gesture)
        return
      }
      setDraft(next)
      if (phase === 'move') {
        if (performance.now() - s.last >= COMMIT_MS) void send(next)
        return
      }
      // end: the final value, then the preview follows the document again
      void send(next).then(() => {
        if (session.current === s) session.current = null
        setDraft(null)
      })
    }
    const label = (c: SplitCut) =>
      c.kind === 'line'
        ? `${t.lineAt(c.axis as 'x' | 'y')} ${cutSource(c.at, units)}`
        : `${t.levelAt} ${cutSource(c.at, units)}`
    return {
      cells: explodedCells(cuts, size, gap),
      cuts: cuts.map((c) => {
        const key = cutKey(c)
        // findings are of the committed value: none shown while the preview is ahead of it
        const committed = committedCuts.find((x) => cutKey(x) === key)
        const findings =
          committed !== undefined && Math.abs(committed.at - c.at) < 1e-6
            ? cutFindings(warnings, c)
            : []
        return {
          key,
          axis: c.axis,
          at: c.at,
          shift: cutShift(cuts, c, size, gap),
          caption:
            findings.length === 0 ? label(c) : `${label(c)} · ${t.cutFindings(findings.length)}`,
          focused: focus?.kind === c.kind && focus.index === c.index,
          dragging: draft?.kind === c.kind && draft.index === c.index,
        }
      }),
      stock: { min: [0, 0, -size.T], max: [size.L, size.W, 0] },
      onDrag,
      onHover: setHover,
    }
  }, [
    active,
    split,
    size,
    part,
    cuts,
    committedCuts,
    warnings,
    focus,
    draft,
    units,
    snapOn,
    call,
    cancelGesture,
    setFocus,
  ])
  const hovered = overlay?.cuts.find((c) => c.key === hover)
  const summary =
    overlay === null
      ? undefined
      : t.viewportSummary(
          piecesOf(part!.doc, part!.dto.id).length,
          (hovered ?? overlay.cuts.find((c) => c.dragging || c.focused))?.caption,
        )
  return { split: overlay, summary }
}
