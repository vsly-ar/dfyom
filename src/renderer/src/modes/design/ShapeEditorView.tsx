// The Shape Editor's viewport side (task U1): while a shape is selected in design mode, its flat
// view covers the 3D viewport (kept mounted underneath, so leaving the editor returns to the view
// it had). The live outline comes from the renderer's 2D port (stored items plus the drag
// preview); an invalid state keeps the last valid outline and marks its issue. Without the port
// (still loading, failed, tests) the outline is the one `design.shape.get` resolved.
// Doc: docs/conventions/ui.md#shape-editor, docs/architecture/shapes.md#where-the-2d-layer-runs
import { useMemo, useRef } from 'react'
import { resolveShape, type ResolvedShape, type ShapeSummary } from '../../../../core/design/shape'
import type { Element } from '../../../../core/geometry/2d/model'
import { chainBounds } from '../../../../core/geometry/2d/model'
import type { Issue } from '../../../../shared/errors/app-error'
import { shapeMessages } from '../../messages/shape'
import { useRegion2d, useUi } from '../../shell/ShellContext'
import { ShapeView, type FlatDrawing } from '../../viewport/ShapeView'
import { badMark, type ShapeHandle } from '../../viewport/shape-handles'
import { anyFormula, definitionNumbers, issueItem, itemNumbers, type ItemNumbers } from './shape-model'
import { useDesignPart, useDesignSelection } from './useDesign'
import { useShapeDrag } from './useShapeDrag'
import { isShapeId, useShapeInfo } from './useShapes'

const m = shapeMessages

function drawingOfResolved(r: ResolvedShape): FlatDrawing {
  const loops =
    r.kind === 'path'
      ? [{ elements: r.path.elements, closed: false, hole: false }]
      : r.region.pieces.flatMap((p) => [
          { elements: p.outer.elements, closed: true, hole: false },
          ...p.holes.map((h) => ({ elements: h.elements, closed: true, hole: true })),
        ])
  return { loops, bounds: chainBounds(loops.flatMap((l) => l.elements)) }
}

function drawingOfSummary(s: ShapeSummary): FlatDrawing {
  const loops =
    s.kind === 'path'
      ? [{ elements: (s.path ?? []) as Element[], closed: false, hole: false }]
      : (s.pieces ?? []).flatMap((p) => [
          { elements: p.outer as Element[], closed: true, hole: false },
          ...p.holes.map((h) => ({ elements: h as Element[], closed: true, hole: true })),
        ])
  return { loops, bounds: { min: s.bounds.min, max: s.bounds.max } }
}

/** The flat view when the design selection is a shape; nothing otherwise. */
export function ShapeEditorLayer({ insetRight = 0 }: { insetRight?: number }): React.JSX.Element | null {
  const [selected] = useDesignSelection()
  if (!isShapeId(selected)) return null
  return <ShapeEditorView key={selected} shapeId={selected} insetRight={insetRight} />
}

function ShapeEditorView({
  shapeId,
  insetRight,
}: {
  shapeId: string
  insetRight: number
}): React.JSX.Element | null {
  const part = useDesignPart()
  const [, select] = useDesignSelection()
  const port = useRegion2d()
  const info = useShapeInfo(part, shapeId)
  const shape = part?.dto.shapes?.find((s) => s.id === shapeId)
  const editor = useUi((s) => s.shapeEditor)
  const preview = useUi((s) => s.shapePreview)
  const stored = useUi((s) => s.shapeIssues)
  const showItems = useUi((s) => s.showShapeItems)
  const setShowItems = useUi((s) => s.setShowShapeItems)
  const onDrag = useShapeDrag(part?.dto.id ?? '', shape, port)
  const lastGood = useRef<FlatDrawing | null>(null)

  const selectedItem = editor?.shapeId === shapeId ? editor.item : 0
  const items = useMemo((): (ItemNumbers | undefined)[] => {
    const list = shape?.items.map((dto) => itemNumbers(dto)) ?? []
    if (preview?.shapeId === shapeId) list[preview.index] = preview.item
    return list
  }, [shape, preview, shapeId])

  // the live outline: the current definition through the renderer's port
  const live = useMemo((): { drawing: FlatDrawing | null; issues: readonly Issue[] } => {
    if (port === undefined || shape === undefined) return { drawing: null, issues: [] }
    const def = definitionNumbers(shape.items)
    if (def === undefined) return { drawing: null, issues: [] }
    if (preview?.shapeId === shapeId) def[preview.index] = preview.item
    const r = resolveShape(port, def)
    return r.isOk()
      ? { drawing: drawingOfResolved(r.unwrap()), issues: [] }
      : { drawing: null, issues: r.unwrapErr().issues }
  }, [port, shape, preview, shapeId])

  let drawing: FlatDrawing | null
  if (port !== undefined) {
    if (live.drawing !== null) lastGood.current = live.drawing
    drawing = live.drawing ?? lastGood.current
  } else {
    drawing = info?.resolved !== undefined ? drawingOfSummary(info.resolved) : null
    if (drawing !== null) lastGood.current = drawing
    else drawing = lastGood.current
  }
  const issues: readonly Issue[] =
    live.issues.length > 0
      ? live.issues
      : stored?.shapeId === shapeId
        ? stored.issues
        : (info?.issues ?? [])
  const bad = useMemo(() => {
    for (const i of issues) {
      const n = issueItem(i)
      if (n !== undefined) return { item: n, mark: badMark(i.path.slice(2), items[n]) }
    }
    return null
  }, [issues, items])

  if (part === undefined || shape === undefined) return null
  const sel = Math.min(selectedItem, shape.items.length - 1)
  const selItem = shape.items[sel]
  const loops = drawing?.loops.length ?? 0
  const elements = drawing?.loops.reduce((s, l) => s + l.elements.length, 0) ?? 0
  const summary = m.view.summary({
    name: shape.name,
    loops,
    elements,
    face: null,
    item: selItem === undefined ? null : m.inspector.itemLabel(selItem.kind, sel + 1),
  })
  return (
    <ShapeView
      name={shape.name}
      face={null}
      drawing={drawing}
      items={items}
      selected={sel}
      segment={editor?.shapeId === shapeId ? editor.segment : null}
      showItems={showItems}
      onShowItems={setShowItems}
      isLocked={(n: number, h: ShapeHandle) => {
        const dto = shape.items[n]
        return dto !== undefined && anyFormula(dto, h.paths)
      }}
      bad={bad}
      units={part.units}
      onDrag={onDrag}
      onExit={() => select(null)}
      summary={summary}
      insetRight={insetRight}
    />
  )
}
