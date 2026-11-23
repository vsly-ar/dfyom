// The chamfer inspector (v0.4 task U4, D45): the `chamfer` kind's groups inside OperationFields, so
// the Design inspector, a countersink's read-only owned chamfer and the plan copy share it. Edge (a
// Select of the earlier drillings, circle pockets and inside circle profiles, "Drilling 2 · Ø 3.4
// mm", with pick mode tinting their surfaces in the viewport; `edgeOf`), then the section
// illustration of the edge with its cone above Width (the stored size, "1.5 × 45°"), Depth (the
// alternative: a commit sends `depth` and the core turns it into the width through the angle),
// Angle (60°–120°) and the derived Diameter at the face (read-only, "from the edge and the
// width"), then the tool field (where `dfm.chamferNoTool` shows with "New tool…", ToolField).
// The focused field's measured part is amber in the section; hovering a part of the section
// highlights its field's label and clicking it focuses the field. Each commit is one
// `design.chamfer.update` (one undo step); a new edge keeps the width.
// Doc: docs/conventions/ui.md#chamfer-inspector, #section-illustration;
// docs/modes/design-v0.4.md#chamfer-operation-v04-circular-edges
import { useRef, useState } from 'react'
import type { OperationDTO } from '../../../../core/design/part.dto'
import { chamferMessages } from '../../messages/chamfer'
import { dfmMessages, lengthSource } from '../../messages/dfm'
import { useUi } from '../../shell/ShellContext'
import { fieldContext } from '../../../../core/design/operation'
import { Quantity } from '../../../../core/quantity/quantity'
import {
  Field,
  FieldIcon,
  FieldInput,
  Icon,
  IconButton,
  QuantityInput,
  Select,
  type FieldMessage,
} from '../../ui'
import { chamferSection, coneDepth, type ChamferPart } from '../../viewport/chamfer-section'
import { SketchView } from '../../viewport/SketchView'
import { chamferDiameter, chamferSectionValues, edgeOptions } from './chamfer-view'
import { defaultUnit } from './model'
import styles from './Design.module.css'
import own from './ChamferInspector.module.css'
import { Group, ParamField, warningPath, type OperationFieldsContext } from './OperationFields'
import { useDesignEvaluation } from './useDesign'

const t = chamferMessages

type ChamferDTO = Extract<OperationDTO, { kind: 'chamfer' }>

/** The parts a hard finding or an error draws in `--danger` (at their field's path). */
function invalidParts(ctx: OperationFieldsContext): Set<string> {
  const parts = new Set<string>()
  for (const e of ctx.errors)
    if (['width', 'depth', 'angle', 'edgeOf'].includes(e.path)) parts.add(e.path)
  for (const w of ctx.warnings) {
    const at = warningPath(w, ctx.op)
    if (at === 'width' && dfmMessages.tier(w) !== 'soft') parts.add('width')
  }
  return parts
}

export function ChamferInspector({
  ctx,
  level,
  tool,
}: {
  ctx: OperationFieldsContext
  level: 3 | 4
  tool: React.ReactNode
}): React.JSX.Element | null {
  const op = ctx.op
  const [focused, setFocused] = useState<ChamferPart | undefined>(undefined)
  const [hovered, setHovered] = useState<string | null>(null)
  const fields = useRef(new Map<string, HTMLDivElement>())
  if (op.kind !== 'chamfer') return null
  const values = chamferSectionValues(ctx.part, op, invalidParts(ctx))
  const sketch = values === undefined ? undefined : chamferSection(values, ctx.units)

  /** One field of the section: reports focus (its part is amber) and takes hover and clicks. */
  const target = (part: ChamferPart, children: React.ReactNode) => (
    <div
      ref={(el) => {
        if (el === null) fields.current.delete(part)
        else fields.current.set(part, el)
      }}
      className={own['target']}
      data-hovered={hovered === part || undefined}
      onFocus={() => setFocused(part)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(undefined)
      }}
    >
      {children}
    </div>
  )
  const focusField = (part: string) =>
    fields.current.get(part)?.querySelector<HTMLElement>('input, button[role="combobox"]')?.focus()

  return (
    <>
      <Group title={t.groups.edge} level={level}>
        {target('edgeOf', <EdgeField ctx={ctx} op={op} />)}
      </Group>
      <Group title={t.groups.chamfer} level={level}>
        {sketch !== undefined ? (
          <div className={own['section']} data-readonly={ctx.readOnly || undefined}>
            <SketchView
              sketch={sketch}
              highlighted={focused}
              onPartHover={setHovered}
              onPartClick={focusField}
            />
          </div>
        ) : null}
        {target(
          'width',
          <ParamField ctx={ctx} path="width" label={t.width} kind="length" icon="length" />,
        )}
        {target('depth', <DepthField ctx={ctx} />)}
        {target(
          'angle',
          <ParamField ctx={ctx} path="angle" label={t.angle} kind="angle" icon="chamfer" />,
        )}
        {target('diameter', <DiameterField ctx={ctx} />)}
      </Group>
      {tool}
    </>
  )
}

/**
 * Depth, the alternative size (D45): shows the depth the width and angle give; a commit sends
 * `depth` and the core stores the width it gives through the angle (one undo step).
 */
function DepthField({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element | null {
  const op = ctx.op
  if (op.kind !== 'chamfer') return null
  const v = chamferSectionValues(ctx.part, op)
  const depth = v === undefined ? undefined : coneDepth(v)
  const parsed =
    depth === undefined || !Number.isFinite(depth)
      ? undefined
      : Quantity.parse(lengthSource(depth, ctx.units), fieldContext('length', ctx.units))
  const value = parsed?.isOk() === true ? parsed.unwrap() : undefined
  const messages: FieldMessage[] = [
    ...ctx.errors
      .filter((e) => e.path === 'depth')
      .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text })),
    { id: 'derived', severity: 'note', text: t.depthNote },
  ]
  return (
    <QuantityInput
      label={t.depth}
      kind="length"
      defaultUnit={defaultUnit('length', ctx.units)}
      value={value}
      onCommit={(q, gesture) => ctx.send({ depth: q.source }, 'depth', gesture)}
      onCancelGesture={ctx.cancelGesture}
      illustration={<FieldIcon name="depth" />}
      messages={messages}
      readOnly={ctx.readOnly}
    />
  )
}

/** The diameter at the face: read-only, the edge's Ø + 2 × width. */
function DiameterField({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element | null {
  const op = ctx.op
  if (op.kind !== 'chamfer') return null
  const d = chamferDiameter(ctx.part.dto, op, ctx.units)
  return (
    <Field
      label={t.diameter}
      illustration={<FieldIcon name="diameter" />}
      readOnly
      messages={[{ id: 'derived', severity: 'note', text: t.diameterNote }]}
    >
      <FieldInput
        readOnly
        value={d === undefined ? '' : `Ø ${lengthSource(d.canonical, ctx.units)}`}
      />
    </Field>
  )
}

/**
 * `edgeOf`: the earlier drillings, circle pockets and inside circle profiles, or pick one in the viewport (its surfaces
 * are eligible; a picked surface's operation is the edge). Not re-pointed in a plan copy (the
 * plan's update has no `edgeOf`, design-v0.4.md § Implementation (C2)).
 */
function EdgeField({
  ctx,
  op,
}: {
  ctx: OperationFieldsContext
  op: ChamferDTO
}): React.JSX.Element {
  const pick = useUi((s) => s.pick)
  const setPick = useUi((s) => s.setPick)
  const evaluation = useDesignEvaluation(ctx.part)
  const options = edgeOptions(ctx.part.dto, op, ctx.units)
  const owner = `${op.id}:edgeOf`
  const picking = pick?.owner === owner
  const fixed = ctx.readOnly || !ctx.pickable
  const messages: FieldMessage[] = [
    ...ctx.errors
      .filter((e) => e.path === 'edgeOf')
      .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text })),
    ...ctx.warnings
      .filter((w) => warningPath(w, op) === 'edgeOf')
      .map((w): FieldMessage => ({
        id: w.code,
        severity: dfmMessages.tier(w),
        text: dfmMessages.text(w, ctx.units, (id) => id),
      })),
  ]
  const choose = (edgeOf: string) => {
    if (edgeOf !== op.edgeOf) ctx.send({ edgeOf }, 'edgeOf')
  }
  const eligible = (): Set<string> => {
    const ids = new Set(options.map((o) => o.value))
    const surfaces = evaluation?.mesh?.surfaces ?? []
    return new Set(surfaces.filter((s) => ids.has(s.slice(0, s.indexOf('.')))))
  }
  return (
    <div className={styles['onRow']}>
      <Field label={t.edge} messages={messages} readOnly={fixed}>
        <Select options={options} value={op.edgeOf} disabled={fixed} onValueChange={choose} />
      </Field>
      {ctx.pickable && !ctx.readOnly ? (
        <IconButton
          label={t.pickEdge}
          icon={<Icon name="pick" />}
          pressed={picking}
          className={styles['pickButton']}
          onClick={() =>
            picking
              ? setPick(null)
              : setPick({
                  owner,
                  field: t.pickEdgeField,
                  eligible: eligible(),
                  onPick: (surface) => choose(surface.slice(0, surface.indexOf('.'))),
                })
          }
        />
      ) : null}
    </div>
  )
}
