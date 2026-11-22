// The shape picker of a pocket or profile (task U2): one Select with the inline kinds (Rectangle,
// Circle) and the part's named shapes (mini outline, "Used by n"), plus "New shape…"; under it
// "Edit shape" for a named shape or "Convert to shape" for an inline one, and the shape's issues
// and corner warnings with "Round corners to ≥ r". The placement fields (rotation, mirror) follow
// the anchor and position in the Shape group (OperationFields.tsx). A choice is one command on
// `shape`.
// Doc: docs/conventions/ui.md#shape-in-the-operation-inspector, docs/modes/design-v0.3.md#dfm-checks-for-shapes
import { Combine, PenLine } from 'lucide-react'
import { useMemo } from 'react'
import { resolveShape } from '../../../../core/design/shape'
import type { ShapeDTO } from '../../../../core/design/shape.dto'
import { chainBounds, type Element } from '../../../../core/geometry/2d/model'
import type { Region2dPort } from '../../../../core/geometry/2d/port'
import type { DfmWarning } from '../../../../core/geometry/model'
import { designMessages } from '../../messages/design'
import { dfmMessages, lengthSource } from '../../messages/dfm'
import { useRegion2d } from '../../shell/ShellContext'
import { Button, Field, Select, type FieldMessage } from '../../ui'
import { chainPath, fitView, unplacePoint } from '../../viewport/flat-view'
import styles from './Design.module.css'
import { quantityOf, updateArgs } from './model'
import {
  cornerPoints,
  isCornerWarning,
  NEW_SHAPE,
  pickerValue,
  roundCornerFixes,
  shapeChoiceArgs,
  shapePlacement,
  type ItemFix,
  type PickerValue,
} from './operation-shape'
import type { OperationFieldsContext } from './OperationFields'
import { definitionNumbers } from './shape-model'

const t = designMessages.inspector
const p = t.picker

/** Design-only actions of the picker (the plan copy has none). */
export interface ShapeActions {
  /** Adds a shape, references it here and opens the Shape Editor. */
  newShape(): void
  /** Selects the shape's row (the Shape Editor). */
  editShape(shapeId: string): void
  /** `design.shape.convert` of the inline shape. */
  convert(): void
  /** Item updates of a named shape (the corner fix). */
  updateItems(shapeId: string, fixes: readonly ItemFix[]): void
}

/** A named shape's loops resolved by the renderer's port (shape frame, mm). */
export function shapeLoops(
  port: Region2dPort | undefined,
  shape: ShapeDTO,
): { elements: readonly Element[]; closed: boolean }[] {
  if (port === undefined) return []
  const def = definitionNumbers(shape.items)
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
  const shapes = useMemo(() => ctx.part.dto.shapes ?? [], [ctx.part])
  const outlines = useMemo(
    () => new Map(shapes.map((s) => [s.id, shapeLoops(port, s)])),
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
    const choice = value as PickerValue
    if (choice === pickerValue(shape)) return
    const id = choice.startsWith('named:')
      ? choice.slice(6)
      : shape.kind === 'named'
        ? shape.shapeId
        : undefined
    const loops = id === undefined ? [] : (outlines.get(id) ?? [])
    const bounds = chainBounds(loops.flatMap((l) => l.elements))
    ctx.send({ shape: shapeChoiceArgs(shape, choice, bounds, ctx.units) }, 'shape')
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
    ...(actions && !ctx.readOnly ? [{ value: NEW_SHAPE, label: p.newShape, group: p.named }] : []),
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
  const cornerFix = (w: DfmWarning): FieldMessage['fix'] | undefined => {
    if (ctx.readOnly || !isCornerWarning(w) || w.suggestion === undefined) return undefined
    const r = w.suggestion.value
    const label = p.roundCorners(lengthSource(r, ctx.units, 'up'))
    if (shape.kind === 'rectangle') {
      const source = lengthSource(
        Math.max(r, quantityOf(shape.cornerRadius)?.canonical ?? 0),
        ctx.units,
        'up',
      )
      return {
        label,
        onApply: () => ctx.send(updateArgs(op, 'shape.cornerRadius', source), 'shape.cornerRadius'),
      }
    }
    if (named === undefined || placement === undefined || actions === undefined) return undefined
    const points = cornerPoints(w).map((q) => unplacePoint(placement, q))
    const fixes = roundCornerFixes(named, points, r, ctx.units)
    if (fixes.length === 0) return undefined
    return { label, onApply: () => actions.updateItems(named.id, fixes) }
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
        const fix = cornerFix(w)
        const noFix =
          isCornerWarning(w) && fix === undefined && shape.kind === 'named' && !ctx.readOnly
        return {
          id: `${w.code}:${i}`,
          severity: dfmMessages.tier(w),
          text: noFix
            ? `${dfmMessages.text(w, ctx.units, (id) => id)} ${p.noRoundFix}`
            : dfmMessages.text(w, ctx.units, (id) => id),
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
            <Button
              size="sm"
              icon={<PenLine aria-hidden="true" />}
              onClick={() => actions.editShape(shape.shapeId)}
            >
              {p.editShape}
            </Button>
          ) : (
            <Button size="sm" icon={<Combine aria-hidden="true" />} onClick={actions.convert}>
              {p.convert}
            </Button>
          )}
        </div>
      ) : null}
    </>
  )
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
