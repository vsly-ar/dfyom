// The Line inspector (engraved-patterns.md E1, E2): the `line` kind's groups inside
// OperationFields, so the Design inspector and the plan copy share it. Paths (`on`, then per path
// its shape, a Select of the part's shapes, and its centre on the face), Depth (a segmented choice
// Constant / Start → end / From SVG levels, then the fields; to Constant keeps the deeper end;
// levels: Min and Max, the depth legend, Blend behind More), then the tool group. Each commit is one
// `design.line.update` (one undo step).
// Doc: docs/modes/engraved-patterns.md#ui, docs/conventions/inspector-layout.md
import { lineLegend } from '../../../../core/design/engraving/legend'
import type { OperationDTO } from '../../../../core/design/part.dto'
import { SHAPE_ID_PATTERN } from '../../../../core/design/shape.dto'
import { lineMessages } from '../../messages/line'
import { DEFAULTS } from '../../../../core/design/operation'
import type { UnitSystem } from '../../../../core/project/document'
import { useRegion2d } from '../../shell/ShellContext'
import { Button, Field, Icon, InspectorGroup, SegmentedControl, Select } from '../../ui'
import styles from './Design.module.css'
import { DepthLegend } from './DepthLegend'
import { linePathArgs, quantityAt } from './model'
import { EDIT_SHAPE, NEW_SHAPE } from './operation-shape'
import { OnField, ParamField, type OperationFieldsContext } from './OperationFields'

const t = lineMessages

type LineDTO = Extract<OperationDTO, { kind: 'line' }>
type Mode = 'constant' | 'ramp' | 'levels'

const modeOf = (op: LineDTO): Mode =>
  'start' in op.depth ? 'ramp' : 'min' in op.depth ? 'levels' : 'constant'

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
        {op.paths.map((_, i) => (
          <PathFields key={i} ctx={ctx} op={op} index={i} />
        ))}
      </InspectorGroup>
      <InspectorGroup title={t.groups.depth} level={level}>
        <Field label={t.depthMode} kind="toggle" readOnly={ctx.readOnly}>
          <SegmentedControl<Mode>
            label={t.depthMode}
            options={(['constant', 'ramp', 'levels'] as const).map((m) => ({
              value: m,
              label: t.modes[m],
            }))}
            value={mode}
            disabled={ctx.readOnly}
            onValueChange={(m) => ctx.send({ depth: depthFor(op, m, ctx.units) }, 'depth')}
          />
        </Field>
        {mode === 'levels' ? (
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
    op.paths.map((p) => p.shapeId),
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
  const id = op.paths[index]!.shapeId
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
