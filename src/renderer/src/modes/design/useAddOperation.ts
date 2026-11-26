// Adding an operation or a hole (the navigator's Add and the face inspector's buttons): values that
// fit the stock, or, with a face selected, `on` that face and values that fit its rectangle and the
// material below it (DF22); the new item is selected. Doc: docs/modes/design.md#design-ui-task-36,
// docs/conventions/ui.md#selection-and-picking
import type { OperationKind } from '../../../../core/design/part.dto'
import { STOCK_TOP } from '../../../../core/design/surfaces'
import { useSettings } from '../../shell/ShellContext'
import { addTarget, selectedFace, type SelectedFace } from './face-selection'
import { facingDepthSuggestion } from './facing-depth'
import { SHAPE_ID_PATTERN } from '../../../../core/design/shape.dto'
import { addArgs, lineWave, roundLength, type DesignPart } from './model'
import { useCommand, useDesignReferences, useDesignSelection } from './useDesign'

/** The stock's size (mm) new operations are placed in; a default block without a stock. */
export function stockDims(part: DesignPart): { length: number; width: number; thickness: number } {
  const s = part.loaded?.stock
  return s
    ? { length: s.length.canonical, width: s.width.canonical, thickness: s.thickness.canonical }
    : { length: 100, width: 60, thickness: 20 }
}

export interface AddOperation {
  /** The selected face Add puts operations on, if any. */
  readonly face: SelectedFace | undefined
  add(kind: OperationKind): Promise<void>
  addHole(): Promise<void>
  /** A pattern with the core defaults on the selected face (patterns P1). */
  addPattern(): Promise<void>
  /** An engraved pattern (engraved-patterns.md E3) on the selected face, else the top. */
  addEngraving(): Promise<void>
}

export function useAddOperation(part: DesignPart): AddOperation {
  const call = useCommand()
  const [selected, select] = useDesignSelection()
  // the default-anchor setting places new pockets and profiles (design-v0.2.md#placement-anchors)
  const defaultAnchor = useSettings((s) => s.settings.defaultAnchor)
  // a new facing faces down to the reference model when there is one (DF4)
  const references = useDesignReferences(part)
  const face = selectedFace(part, selected)

  const add = async (kind: OperationKind) => {
    const target = face === undefined ? undefined : addTarget(face, kind, stockDims(part))
    const onTop = target === undefined || target.on === STOCK_TOP
    const facingDepth =
      kind === 'facing' && onTop ? facingDepthSuggestion(part, references) : undefined
    const room = target?.room ?? stockDims(part)
    // a Line (engraved-patterns.md E1) grooves the part's first shape, else a new wave shape
    let paths: Record<string, unknown> = {}
    if (kind === 'line') {
      let shapeId = (part.dto.shapes ?? []).find((s) => SHAPE_ID_PATTERN.test(s.id))?.id
      if (shapeId === undefined) {
        const s = await call('design.shape.add', {
          partId: part.dto.id,
          items: [lineWave(room, part.units)],
        })
        if (!s.ok) return
        shapeId = (s.value as { shapeId: string }).shapeId
      }
      const L = (mm: number) => roundLength(mm, part.units)
      paths = { paths: [{ shapeId, center: [L(room.length / 2), L(room.width / 2)] }] }
    }
    const r = await call(`design.${kind}.add`, {
      partId: part.dto.id,
      ...addArgs(kind, room, part.units, defaultAnchor),
      ...paths,
      ...(target !== undefined ? { on: target.on } : {}),
      ...(facingDepth !== undefined ? { depth: facingDepth.source } : {}),
    })
    if (r.ok) select((r.value as { operationId: string }).operationId)
  }
  // a hole with the core defaults (simple, 6 mm / 1/4" through) where a new drilling goes; the
  // feature is selected so its inspector is what the user sees next (ui.md § Feature rows)
  const addHole = async () => {
    const target = face === undefined ? undefined : addTarget(face, 'hole', stockDims(part))
    const { center } = addArgs('drilling', target?.room ?? stockDims(part), part.units) as {
      center: string[]
    }
    const r = await call('design.hole.add', {
      partId: part.dto.id,
      center,
      ...(target !== undefined ? { on: target.on } : {}),
    })
    if (r.ok) select((r.value as { featureId: string }).featureId)
  }
  // a pattern with the patterns.md defaults over the selected face (else the top); selected
  const addPattern = async () => {
    const r = await call('design.pattern.add', {
      partId: part.dto.id,
      ...(face !== undefined ? { on: face.id } : {}),
    })
    if (r.ok) select((r.value as { featureId: string }).featureId)
  }
  const addEngraving = async () => {
    const r = await call('design.engraving.add', {
      partId: part.dto.id,
      ...(face !== undefined ? { on: face.id } : {}),
    })
    if (r.ok) select((r.value as { featureId: string }).featureId)
  }
  return { face, add, addHole, addPattern, addEngraving }
}
