// The shape picker of a pocket or profile (task U2): one Select with the inline kinds (Rectangle,
// Circle) and the part's named shapes (mini outline, "Used by n"), plus "New shape…", "Edit shape…"
// (the picked named shape, DF147 SL1) and "Import SVG…" (DF49: imports and uses the first shape, one undo step); under it "Edit shape" and "Place
// as drawn" (X2-2: at its own coordinates, a section's shape where the section lies) for a named
// shape or "Convert to shape" for an inline one, and the shape's issues and corner warnings with
// "Round corners to ≥ r" (or to the largest radius each corner takes). The placement
// fields (rotation, mirror) follow the anchor and position in the Shape group (OperationFields.tsx). A choice is one command on `shape`; an open path picked on a profile
// cutting Outside or Inside sets side On in the same command, with a notice.
// Doc: docs/conventions/ui.md#shape-in-the-operation-inspector, #import-svg-where-it-is-looked-for-df49,
// docs/modes/design-v0.3.md#dfm-checks-for-shapes
import { useMemo } from 'react'
import { resolveShape } from '../../../../core/design/shape'
import type { ShapeDTO } from '../../../../core/design/shape.dto'
import { chainBounds, type Element } from '../../../../core/geometry/2d/model'
import type { Region2dPort } from '../../../../core/geometry/2d/port'
import type { DfmWarning } from '../../../../core/geometry/model'
import { designMessages } from '../../messages/design'
import { dfmMessages, lengthSource } from '../../messages/dfm'
import { useRegion2d } from '../../shell/ShellContext'
import { Icon, Button, Field, Select, type FieldMessage } from '../../ui'
import { chainPath, fitView, unplacePoint } from '../../viewport/flat-view'
import styles from './Design.module.css'
import { dfmNames, quantityOf, updateArgs } from './model'
import {
  cornerPoints,
  isCornerWarning,
  EDIT_SHAPE,
  IMPORT_SVG,
  isOpenNamed,
  NEW_SHAPE,
  pickerValue,
  cornerRadiusFor,
  drawnPlacement,
  roundCornerFixes,
  shapeChoiceArgs,
  shapePlacement,
  type ItemFix,
  type PickerValue,
} from './operation-shape'
import type { OperationFieldsContext } from './OperationFields'
import { definitionNumbers } from './shape-model'
import type { UnitSystem } from '../../../../core/project/document'

const t = designMessages.inspector
const p = t.picker

/** Design-only actions of the picker (the plan copy has none). */
export interface ShapeActions {
  /** Adds a shape, references it here and opens the Shape Editor. */
  newShape(): void
  /** Imports an SVG and uses its first shape here, one undo step (DF49). */
  importSvg(): void
  /** Selects the shape's row (the Shape Editor). */
  editShape(shapeId: string): void
  /** `design.shape.convert` of the inline shape. */
  convert(): void
  /** Item updates of a named shape (the corner fix). */
  updateItems(shapeId: string, fixes: readonly ItemFix[]): void
  /** A profile's open path picked while cutting Outside or Inside: shape and side On, one step. */
  pickOnLine(shape: Record<string, unknown>): void
  /** X2-2 "Place as drawn": anchor min/min, then the position `center` (mm), one undo step. */
  placeAsDrawn(center: readonly [number, number]): void
}

/** A Line's Path picker actions (DF147 SL1, design only). */
export interface LineShapeActions {
  /** Adds an open-path shape, makes it path `index`'s and opens the Shape Editor, one undo step. */
  newShape(index: number): void
  /** Opens the shape in the Shape Editor window. */
  editShape(shapeId: string): void
}

/** A named shape's loops resolved by the renderer's port (shape frame, mm). */
export function shapeLoops(
  port: Region2dPort | undefined,
  shape: ShapeDTO,
  /** The part's shapes: the sources of offset items (design-llm-first.md § Offset item). */
  all?: readonly ShapeDTO[],
): { elements: readonly Element[]; closed: boolean }[] {
  if (port === undefined) return []
  const def = definitionNumbers(shape.items, all, shape.id)
  if (def === undefined) return []
  const r = resolveShape(port, def)
  if (r.isErr()) return []
  const s = r.unwrap()
  return s.kind === 'path'
    ? [{ elements: s.path.elements, closed: false }]
    : s.region.pieces.flatMap((piece) => [
        { elements: piece.outer.elements, closed: true },
        ...piece.holes.map((h) => ({ elements: h.elements, closed: true })),
      ])
}

const MINI = { w: 28, h: 18 }

/** A shape's outline at icon size (the picker's list). */
export function MiniOutline({
  loops,
}: {
  loops: readonly { elements: readonly Element[]; closed: boolean }[]
}): React.JSX.Element {
  const bounds = chainBounds(loops.flatMap((l) => l.elements))
  const v = fitView(bounds, MINI.w, MINI.h, 0.06)
  const fill = loops
    .filter((l) => l.closed)
    .map((l) => chainPath(v, l.elements, true))
    .join('')
  return (
    <svg
      className={styles['miniOutline']}
      width={MINI.w}
      height={MINI.h}
      viewBox={`0 0 ${MINI.w} ${MINI.h}`}
      aria-hidden="true"
    >
      {fill ? <path className={styles['miniFill']} d={fill} fillRule="evenodd" /> : null}
      {loops.map((l, i) => (
        <path key={i} className={styles['miniEdge']} d={chainPath(v, l.elements, l.closed)} />
      ))}
    </svg>
  )
}

/** Paths of the inline shape fields: their issues show there, every other `shape` issue here. */
const FIELD_PATHS = new Set([
  'shape.center.0',
  'shape.center.1',
  'shape.length',
  'shape.width',
  'shape.diameter',
  'shape.cornerRadius',
  'shape.rotation',
])

export function ShapePicker({
  ctx,
  actions,
}: {
  ctx: OperationFieldsContext
  actions?: ShapeActions | undefined
}): React.JSX.Element | null {
  const port = useRegion2d()
  const op = ctx.op
  // a feature's owned shapes (patterns P1) are not offered
  const shapes = useMemo(
    () => (ctx.part.dto.shapes ?? []).filter((s) => s.owner === undefined),
    [ctx.part],
  )
  const outlines = useMemo(
    () => new Map(shapes.map((s) => [s.id, shapeLoops(port, s, shapes)])),
    [shapes, port],
  )
  if (op.kind !== 'pocket' && op.kind !== 'profile') return null
  const shape = op.shape
  const usedBy = (id: string) =>
    ctx.part.dto.operations.filter(
      (o) =>
        (o.kind === 'pocket' || o.kind === 'profile') &&
        o.shape.kind === 'named' &&
        o.shape.shapeId === id,
    ).length

  const choose = (value: string) => {
    if (value === NEW_SHAPE) return actions?.newShape()
    if (value === IMPORT_SVG) return actions?.importSvg()
    if (value === EDIT_SHAPE) return shape.kind === 'named' && actions?.editShape(shape.shapeId)
    const choice = value as PickerValue
    if (choice === pickerValue(shape)) return
    const id = choice.startsWith('named:')
      ? choice.slice(6)
      : shape.kind === 'named'
        ? shape.shapeId
        : undefined
    const loops = id === undefined ? [] : (outlines.get(id) ?? [])
    const bounds = chainBounds(loops.flatMap((l) => l.elements))
    const args = shapeChoiceArgs(shape, choice, bounds, ctx.units)
    // only On cuts an open path (`openNeedsOn`): switch the side with the pick, one undo step
    const open =
      op.kind === 'profile' &&
      op.side !== 'on' &&
      choice.startsWith('named:') &&
      isOpenNamed(shapes.find((s) => s.id === id))
    if (!open) return ctx.send({ shape: args }, 'shape')
    if (actions) return actions.pickOnLine(args)
    ctx.send({ shape: args, side: 'on' }, 'shape')
  }

  const options = [
    { value: 'rectangle', label: t.shapes.rectangle, group: p.inline },
    { value: 'circle', label: t.shapes.circle, group: p.inline },
    ...shapes.map((s) => ({
      value: `named:${s.id}`,
      label: s.name,
      group: p.named,
      description: p.usedBy(usedBy(s.id)),
      icon: <MiniOutline loops={outlines.get(s.id) ?? []} />,
    })),
    ...(actions && !ctx.readOnly
      ? [
          { value: NEW_SHAPE, label: p.newShape, group: p.named },
          ...(shape.kind === 'named'
            ? [{ value: EDIT_SHAPE, label: p.editShapeEntry, group: p.named }]
            : []),
          { value: IMPORT_SVG, label: p.importSvg, group: p.named },
        ]
      : []),
  ]

  // corner warnings on a general shape: "Round corners to ≥ r"
  const named = shape.kind === 'named' ? shapes.find((s) => s.id === shape.shapeId) : undefined
  const loadedOp = ctx.part.loaded?.part.operations.find((o) => o.id === op.id)
  const placement =
    port !== undefined &&
    loadedOp !== undefined &&
    (loadedOp.kind === 'pocket' || loadedOp.kind === 'profile')
      ? shapePlacement(port, loadedOp.shape, ctx.part.loaded?.part.shapes)
      : undefined
  // X2-2: the shape at its own coordinates (a section's shape where the section lies)
  const drawn =
    port !== undefined &&
    loadedOp !== undefined &&
    (loadedOp.kind === 'pocket' || loadedOp.kind === 'profile')
      ? drawnPlacement(port, loadedOp.shape, ctx.part.loaded?.part.shapes)
      : undefined
  // the fix rounds each corner to the tool radius, or as far as the corner takes (X2 finding)
  const cornerFix = (w: DfmWarning): { fix?: FieldMessage['fix']; note?: string } | undefined => {
    if (ctx.readOnly || !isCornerWarning(w) || w.suggestion === undefined) return undefined
    const r = w.suggestion.value
    const tool = lengthSource(r, ctx.units, 'up')
    const text = (plan: { limited: boolean; range: readonly [number, number] | undefined }) => {
      const fit = plan.range && lengthRange(plan.range, ctx.units)
      return {
        label: plan.limited && fit !== undefined ? p.roundCornersFit(fit) : p.roundCorners(tool),
        note: plan.limited && fit !== undefined ? p.roundFitSmaller(fit, tool) : undefined,
      }
    }
    if (shape.kind === 'rectangle') {
      const length = quantityOf(shape.length)?.canonical
      const width = quantityOf(shape.width)?.canonical
      const current = quantityOf(shape.cornerRadius)?.canonical ?? 0
      const max = length !== undefined && width !== undefined ? Math.min(length, width) / 2 : r
      const target = cornerRadiusFor(Math.max(r, current), max, ctx.units)
      if (target === undefined || target.mm <= current + 1e-9)
        return target?.limited ? { note: p.roundAtLargest(tool) } : undefined
      const { label, note } = text({ limited: target.limited, range: [target.mm, target.mm] })
      return {
        fix: {
          label,
          onApply: () =>
            ctx.send(updateArgs(op, 'shape.cornerRadius', target.source), 'shape.cornerRadius'),
        },
        ...(note === undefined ? {} : { note }),
      }
    }
    if (named === undefined || placement === undefined || actions === undefined) return undefined
    const points = cornerPoints(w).map((q) => unplacePoint(placement, q))
    const plan = roundCornerFixes(named, points, r, ctx.units)
    if (plan.fixes.length === 0) return plan.limited ? { note: p.roundAtLargest(tool) } : undefined
    const { label, note } = text(plan)
    return {
      fix: { label, onApply: () => actions.updateItems(named.id, plan.fixes) },
      ...(note === undefined ? {} : { note }),
    }
  }
  const messages: FieldMessage[] = [
    ...ctx.errors
      .filter(
        (e) => (e.path === 'shape' || e.path.startsWith('shape.')) && !FIELD_PATHS.has(e.path),
      )
      .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text })),
    ...ctx.warnings
      .filter(
        (w) =>
          w.parameter === 'shape' &&
          (shape.kind === 'named' || isCornerWarning(w) || isRotated(shape)),
      )
      .map((w, i): FieldMessage => {
        const corner = cornerFix(w)
        const fix = corner?.fix
        const base = dfmMessages.text(w, ctx.units, dfmNames(ctx.part.dto))
        const noFix =
          isCornerWarning(w) && corner === undefined && shape.kind === 'named' && !ctx.readOnly
        return {
          id: `${w.code}:${i}`,
          severity: dfmMessages.tier(w),
          text: noFix
            ? `${base} ${p.noRoundFix}`
            : corner?.note !== undefined
              ? `${base} ${corner.note}`
              : base,
          ...(fix ? { fix } : {}),
        }
      }),
  ]

  return (
    <>
      <Field label={p.label} messages={messages} readOnly={ctx.readOnly}>
        <Select
          options={options}
          value={pickerValue(shape)}
          disabled={ctx.readOnly}
          onValueChange={choose}
        />
      </Field>
      {actions && !ctx.readOnly ? (
        <div className={styles['pickerActions']}>
          {shape.kind === 'named' ? (
            <>
              <Button
                size="sm"
                icon={<Icon name="edit" />}
                onClick={() => actions.editShape(shape.shapeId)}
              >
                {p.editShape}
              </Button>
              {drawn === undefined ? null : (
                <Button
                  size="sm"
                  icon={<Icon name="move-to" />}
                  disabled={drawn.kind === 'oriented' || drawn.already}
                  title={
                    drawn.kind === 'oriented'
                      ? p.placeAsDrawnOriented
                      : drawn.already
                        ? p.placeAsDrawnAlready
                        : p.placeAsDrawnTip
                  }
                  onClick={() => drawn.kind === 'place' && actions.placeAsDrawn(drawn.center)}
                >
                  {p.placeAsDrawn}
                </Button>
              )}
            </>
          ) : (
            <Button size="sm" icon={<Icon name="shapes" />} onClick={actions.convert}>
              {p.convert}
            </Button>
          )}
        </div>
      ) : null}
    </>
  )
}

/** Radii as written by the fix: one value, or the smallest to the largest. */
function lengthRange(range: readonly [number, number], units: UnitSystem): string {
  const a = lengthSource(range[0], units, 'down')
  const b = lengthSource(range[1], units, 'down')
  return a === b ? a : `${a}–${b}`
}

/** A rectangle turned away from 0° (a general shape: its warnings name `shape`). */
export function isRotated(shape: {
  kind: string
  rotation?: { source: string } | undefined
}): boolean {
  if (shape.kind !== 'rectangle' || shape.rotation === undefined) return false
  const q = quantityOf(shape.rotation as Parameters<typeof quantityOf>[0])
  return q !== undefined && q.canonical !== 0
}
