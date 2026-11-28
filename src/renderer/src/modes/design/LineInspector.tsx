// The Line inspector (engraved-patterns.md E1, E2, DF147): the `line` kind's groups inside
// OperationFields, so the Design inspector and the plan copy share it. Paths (`on`, the geometry
// mode Straight / Arc / Shape; Straight: start and end with the length, "Parallel to an edge"
// behind More; Arc: start, a point it passes through and end with radius and sweep; both offer
// "Convert to shape", which the Shape choice also runs; Shape: per path its shape, a Select of the
// part's shapes with New shape… / Edit shape…, and its centre on the face), Depth (a segmented choice
// Constant / Start → end / From SVG levels, then the fields; to Constant keeps the deeper end;
// levels: Min and Max, the depth legend, Blend behind More), then the tool group. Each commit is one
// `design.line.update` (one undo step).
// Doc: docs/modes/engraved-patterns.md#ui, docs/conventions/inspector-layout.md
import { useState } from 'react'
import { lineLegend } from '../../../../core/design/engraving/legend'
import { arcReadout } from '../../../../core/design/line-inline'
import { lineCutter } from '../../../../core/design/tool-choice'
import type { Quantity } from '../../../../core/quantity/quantity'
import type { OperationDTO } from '../../../../core/design/part.dto'
import { SHAPE_ID_PATTERN } from '../../../../core/design/shape.dto'
import { lineMessages } from '../../messages/line'
import { DEFAULTS } from '../../../../core/design/operation'
import type { UnitSystem } from '../../../../core/project/document'
import { useRegion2d } from '../../shell/ShellContext'
import {
  Button,
  Field,
  Icon,
  InspectorGroup,
  QuantityInput,
  SegmentedControl,
  Select,
} from '../../ui'
import { lengthSource } from '../../messages/dfm'
import styles from './Design.module.css'
import { DepthLegend } from './DepthLegend'
import {
  arcPoints,
  FACE_EDGES,
  geometryModeOf,
  lineAcross,
  parallelToEdge,
  parallelToWall,
  pathsForMode,
  segmentLength,
  type DistanceTo,
  type FaceEdge,
  type LineGeometryMode,
} from './line-geometry'
import { defaultUnit, linePathArgs, quantityAt } from './model'
import { surfaceFace } from './outline'
import { EDIT_SHAPE, NEW_SHAPE } from './operation-shape'
import { OnField, ParamField, type OperationFieldsContext } from './OperationFields'

const t = lineMessages

type LineDTO = Extract<OperationDTO, { kind: 'line' }>
type Mode = 'constant' | 'ramp' | 'levels' | 'through'

const modeOf = (op: LineDTO): Mode =>
  op.depth === 'through'
    ? 'through'
    : 'start' in op.depth
      ? 'ramp'
      : 'min' in op.depth
        ? 'levels'
        : 'constant'

export function LineInspector({
  ctx,
  level,
  tool,
}: {
  ctx: OperationFieldsContext
  level: 3 | 4
  tool: React.ReactNode
}): React.JSX.Element | null {
  const op = ctx.op
  if (op.kind !== 'line') return null
  const mode = modeOf(op)
  return (
    <>
      <InspectorGroup title={t.groups.paths} level={level}>
        <OnField ctx={ctx} />
        <GeometryFields ctx={ctx} op={op} />
      </InspectorGroup>
      <InspectorGroup title={t.groups.depth} level={level}>
        <Field label={t.depthMode} kind="toggle" readOnly={ctx.readOnly}>
          <SegmentedControl<Mode>
            label={t.depthMode}
            options={(['constant', 'ramp', 'levels', 'through'] as const)
              // DF147 SL3: through for one Straight / Arc only (a shape is cut out by a Profile)
              .filter(
                (m) => m !== 'through' || mode === 'through' || geometryModeOf(op) !== 'shape',
              )
              .map((m) => ({
                value: m,
                label: t.modes[m],
              }))}
            value={mode}
            disabled={ctx.readOnly}
            onValueChange={(m) => ctx.send({ depth: depthFor(op, m, ctx.units) }, 'depth')}
          />
        </Field>
        {mode === 'through' ? (
          <p className={styles['note']}>{t.throughDepth}</p>
        ) : mode === 'levels' ? (
          <>
            <ParamField
              ctx={ctx}
              path="depth.max"
              stepKind="depth"
              label={t.max}
              kind="length"
              icon="depth"
              info={t.levelsNote}
            />
            <ParamField
              ctx={ctx}
              path="depth.min"
              stepKind="depth"
              label={t.min}
              kind="length"
              icon="depth"
            />
            <LevelsLegend ctx={ctx} op={op} />
            <InspectorGroup.More fields={[t.blend]} rememberKey="line.depth.more">
              <ParamField
                ctx={ctx}
                path="blend"
                stepKind="small"
                label={t.blend}
                kind="length"
                icon="length"
                placeholder={DEFAULTS.lineBlend[ctx.units]}
                info={t.blendNote}
              />
            </InspectorGroup.More>
          </>
        ) : mode === 'ramp' ? (
          <>
            <ParamField
              ctx={ctx}
              path="depth.start"
              stepKind="depth"
              label={t.start}
              kind="length"
              icon="depth"
              info={t.rampNote}
            />
            <ParamField
              ctx={ctx}
              path="depth.end"
              stepKind="depth"
              label={t.end}
              kind="length"
              icon="depth"
            />
          </>
        ) : (
          <ParamField
            ctx={ctx}
            path="depth"
            stepKind="depth"
            label={t.depth}
            kind="length"
            icon="depth"
          />
        )}
      </InspectorGroup>
      {tool}
    </>
  )
}

/** The geometry mode row and the fields of the chosen mode (DF147 SL2). */
function GeometryFields({
  ctx,
  op,
}: {
  ctx: OperationFieldsContext
  op: LineDTO
}): React.JSX.Element {
  const mode = geometryModeOf(op)
  const actions = ctx.readOnly ? undefined : ctx.lineShapeActions
  const face = faceSize(ctx, op)
  const choose = (m: LineGeometryMode) => {
    if (m === mode) return
    if (m === 'shape') return actions?.convert()
    const paths = mode === 'shape' ? [lineAcross(face, ctx.units)] : pathsForMode(op, m, ctx.units)
    if (paths !== undefined) ctx.send({ paths }, 'paths')
  }
  const convert =
    actions !== undefined && mode !== 'shape' ? (
      <div className={styles['pickerActions']}>
        <Button size="sm" icon={<Icon name="shapes" />} onClick={actions.convert}>
          {t.convert}
        </Button>
      </div>
    ) : null
  const point = (key: string, u: string, v: string, info?: string) => (
    <>
      <ParamField
        ctx={ctx}
        path={`paths.0.${key}.0`}
        stepKind="xy"
        label={u}
        kind="length"
        icon="positionX"
        {...(info !== undefined ? { info } : {})}
      />
      <ParamField
        ctx={ctx}
        path={`paths.0.${key}.1`}
        stepKind="xy"
        label={v}
        kind="length"
        icon="positionY"
      />
    </>
  )
  const length = segmentLength(op)
  const arc = arcPoints(op)
  const r = arc === undefined ? undefined : arcReadout(...arc)
  return (
    <>
      <Field label={t.geometry} kind="toggle" readOnly={ctx.readOnly}>
        <SegmentedControl<LineGeometryMode>
          label={t.geometry}
          options={(['straight', 'arc', 'shape'] as const).map((m) => ({
            value: m,
            label: t.geometryModes[m],
            // Shape converts the line, which the plan copy cannot
            ...(m === 'shape' && mode !== 'shape' && actions === undefined
              ? { disabled: true }
              : {}),
          }))}
          value={mode}
          disabled={ctx.readOnly}
          onValueChange={choose}
        />
      </Field>
      {mode === 'straight' ? (
        <>
          {point('segment.start', t.startU, t.startV, t.pointsNote)}
          {point('segment.end', t.endU, t.endV)}
          {length === undefined ? null : (
            <p className={styles['muted']} data-line-readout>
              {t.lengthReadout(lengthSource(Math.round(length * 1000) / 1000, ctx.units))}
            </p>
          )}
          {ctx.readOnly ? null : <ParallelToEdge ctx={ctx} op={op} face={face} />}
          {convert}
        </>
      ) : mode === 'arc' ? (
        <>
          {point('arc.start', t.startU, t.startV, t.pointsNote)}
          {point('arc.through', t.throughU, t.throughV, t.throughNote)}
          {point('arc.end', t.endU, t.endV)}
          {r === undefined ? null : (
            <p className={styles['muted']} data-line-readout>
              {t.arcReadout(
                lengthSource(Math.round(r.radius * 1000) / 1000, ctx.units),
                String(Math.round(r.sweep * 10) / 10),
              )}
            </p>
          )}
          {convert}
        </>
      ) : (
        op.paths.map((_, i) => <PathFields key={i} ctx={ctx} op={op} index={i} />)
      )}
    </>
  )
}

/** The `on` face's size in its frame (mm): u from 0 to `length`, v from 0 to `width`. */
function faceSize(ctx: OperationFieldsContext, op: LineDTO): { length: number; width: number } {
  const stock = ctx.part.loaded?.stock
  const table = ctx.part.table
  if (stock === undefined || table === undefined) return { length: 100, width: 60 }
  const f = surfaceFace(op.on, stock, table)
  return { length: f.local.length, width: f.local.width }
}

/**
 * "Parallel to an edge" (DF147 SL2): an edge and a distance; committing the distance places a
 * straight line across the whole face that far from the edge (one update).
 */
function ParallelToEdge({
  ctx,
  op,
  face,
}: {
  ctx: OperationFieldsContext
  op: LineDTO
  face: { length: number; width: number }
}): React.JSX.Element {
  const [edge, setEdge] = useState<FaceEdge>('front')
  const [distance, setDistance] = useState<Quantity | undefined>(undefined)
  // DF156: with a side kept (a one-sided chamfer), the distance may name the part's wall
  const wall = keptWall(ctx, op)
  const [to, setTo] = useState<DistanceTo>('wall')
  const measuredTo: DistanceTo = wall === undefined ? 'centreline' : to
  const place = (e: FaceEdge, d: Quantity | undefined, m: DistanceTo) => {
    if (d === undefined) return
    const path =
      wall === undefined
        ? parallelToEdge(e, d.canonical, face, ctx.units)
        : parallelToWall(
            op,
            e,
            d.canonical,
            m === 'wall' ? wall.slot : 0,
            wall.kept,
            face,
            ctx.units,
          )
    if (path !== undefined) ctx.send({ paths: [path] }, 'paths')
  }
  return (
    <InspectorGroup.More fields={[t.parallel]} rememberKey="line.parallel.more">
      <Field label={t.parallel}>
        <Select
          options={FACE_EDGES.map((e) => ({ value: e, label: t.edges[e] }))}
          value={edge}
          onValueChange={(e) => {
            setEdge(e as FaceEdge)
            place(e as FaceEdge, distance, measuredTo)
          }}
        />
      </Field>
      {wall === undefined ? null : (
        <Field label={t.distanceTo} kind="toggle">
          <SegmentedControl<DistanceTo>
            label={t.distanceTo}
            options={(['wall', 'centreline'] as const).map((m) => ({
              value: m,
              label: t.distanceTos[m],
            }))}
            value={to}
            onValueChange={(m) => {
              setTo(m)
              place(edge, distance, m)
            }}
          />
        </Field>
      )}
      <QuantityInput
        label={t.distance}
        kind="length"
        stepKind="xy"
        defaultUnit={defaultUnit('length', ctx.units)}
        value={distance}
        info={
          wall !== undefined && measuredTo === 'wall'
            ? t.wallNote(lengthSource(wall.slot, ctx.units))
            : t.parallelNote
        }
        onCommit={(q) => {
          setDistance(q)
          place(edge, q, measuredTo)
        }}
      />
    </InspectorGroup.More>
  )
}

/**
 * DF156: the side a one-sided chamfer of the Line keeps and the slot's width (the Line's cutter:
 * its flat end mill, else the Ø6 the design draws); undefined without such a chamfer.
 */
function keptWall(
  ctx: OperationFieldsContext,
  op: LineDTO,
): { kept: 'left' | 'right'; slot: number } | undefined {
  const chamfer = ctx.part.dto.operations.find(
    (o) => o.kind === 'chamfer' && o.edgeOf === op.id && o.edgeSide !== undefined,
  )
  const kept = chamfer?.kind === 'chamfer' ? chamfer.edgeSide : undefined
  const line = ctx.part.loaded?.part.operations.find((o) => o.id === op.id)
  if (kept === undefined || line === undefined) return undefined
  return { kept, slot: lineCutter(line, ctx.part.doc.snapshots, true).diameter }
}

/** The depth legend of a Line with levels: its paths' levels between Shallowest and Deepest. */
function LevelsLegend({
  ctx,
  op,
}: {
  ctx: OperationFieldsContext
  op: LineDTO
}): React.JSX.Element | null {
  const port = useRegion2d()
  const min = quantityAt(op, 'depth.min')?.canonical
  const max = quantityAt(op, 'depth.max')?.canonical
  if (min === undefined || max === undefined) return null
  const legend = lineLegend(
    op.paths.flatMap((p) => ('shapeId' in p ? [p.shapeId] : [])),
    ctx.part.dto.shapes ?? [],
    port,
  )
  return <DepthLegend min={min} max={max} legend={legend} units={ctx.units} />
}

/**
 * The depth arg when the mode changes: a ramp starts flat; a constant keeps the deeper end; levels
 * keep the deepest as `max` and take the shallower ramp end, else the default, as `min`.
 */
export function depthFor(op: LineDTO, mode: Mode, units: UnitSystem): unknown {
  if (mode === 'through') return 'through'
  // from through (DF147 SL3): the default depth
  if (op.depth === 'through')
    return mode === 'constant'
      ? DEFAULTS.lineDepth[units]
      : mode === 'ramp'
        ? { start: DEFAULTS.lineDepth[units], end: DEFAULTS.lineDepth[units] }
        : { min: DEFAULTS.lineLevelMin[units], max: DEFAULTS.lineLevelMax[units] }
  const d = op.depth
  const deeper = (a: string, b: string, sa: string, sb: string): [string, string] => {
    const x = quantityAt(op, a)?.canonical ?? 0
    const y = quantityAt(op, b)?.canonical ?? 0
    return y >= x ? [sb, sa] : [sa, sb]
  }
  if (mode === 'levels') {
    if ('min' in d) return { min: d.min.source, max: d.max.source }
    if ('start' in d) {
      const [max, min] = deeper('depth.start', 'depth.end', d.start.source, d.end.source)
      return { min, max }
    }
    return { min: DEFAULTS.lineLevelMin[units], max: d.source }
  }
  if (mode === 'ramp') {
    if ('start' in d) return { start: d.start.source, end: d.end.source }
    if ('min' in d) return { start: d.max.source, end: d.min.source }
    return { start: d.source, end: d.source }
  }
  if ('min' in d) return d.max.source
  if (!('start' in d)) return d.source
  return deeper('depth.start', 'depth.end', d.start.source, d.end.source)[0]
}

function PathFields({
  ctx,
  op,
  index,
}: {
  ctx: OperationFieldsContext
  op: LineDTO
  index: number
}): React.JSX.Element {
  const shapes = (ctx.part.dto.shapes ?? []).filter((s) => SHAPE_ID_PATTERN.test(s.id))
  const path = op.paths[index]!
  const id = 'shapeId' in path ? path.shapeId : ''
  const actions = ctx.readOnly ? undefined : ctx.lineShapeActions
  const known = shapes.some((s) => s.id === id)
  const options: { value: string; label: string; group?: string }[] = shapes.map((s) => ({
    value: s.id,
    label: s.name,
  }))
  if (!known) options.push({ value: id, label: t.shapeMissing })
  // DF147 SL1: the Shape Editor from the picker (engraved-patterns.md § Simple Line)
  if (actions !== undefined) {
    options.push({ value: NEW_SHAPE, label: t.newShape, group: t.editor })
    if (known) options.push({ value: EDIT_SHAPE, label: t.editShapeEntry, group: t.editor })
  }
  const choose = (shapeId: string) => {
    if (shapeId === NEW_SHAPE) return actions?.newShape(index)
    if (shapeId === EDIT_SHAPE) return actions?.editShape(id)
    if (shapeId === id) return
    const paths = linePathArgs(op)
    paths[index] = { ...paths[index]!, shapeId }
    ctx.send({ paths }, `paths.${index}.shapeId`)
  }
  return (
    <>
      <Field label={t.path(index + 1)} readOnly={ctx.readOnly}>
        <Select options={options} value={id} disabled={ctx.readOnly} onValueChange={choose} />
      </Field>
      {actions !== undefined && known ? (
        <div className={styles['pickerActions']}>
          <Button size="sm" icon={<Icon name="edit" />} onClick={() => actions.editShape(id)}>
            {t.editInEditor}
          </Button>
        </div>
      ) : null}
      <ParamField
        ctx={ctx}
        path={`paths.${index}.center.0`}
        stepKind="xy"
        label={t.pathU}
        kind="length"
        icon="length"
        info={t.pathNote}
      />
      <ParamField
        ctx={ctx}
        path={`paths.${index}.center.1`}
        stepKind="xy"
        label={t.pathV}
        kind="length"
        icon="length"
      />
    </>
  )
}
