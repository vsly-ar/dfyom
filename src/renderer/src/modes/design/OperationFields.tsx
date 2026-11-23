// The per-kind parameter fields of one design operation, grouped as in the parameter tables of
// design.md (Shape, Position, Depth, Corners, Hole, Slot, Tabs): each a QuantityInput (or a
// choice) whose commit is one update command through `ctx.send`, with its warnings and errors at
// the field. Shared by the Design inspector (`design.<kind>.update`) and the plan inspector's
// "Part (plan copy)" group (`plan.design.operation.update`, task E3b), never copied. The tool
// field (task F5, design only) comes in as `tool`, shown as the group after the one with `on`.
// Doc: docs/conventions/ui.md#quantity-and-expression-input, #selection-and-picking,
// #design-and-plan-controls-v02; docs/modes/design.md#operations-v01
import type { FieldKind } from '../../../../core/design/operation'
import type { OperationDTO } from '../../../../core/design/part.dto'
import { STOCK_FACE } from '../../../../core/geometry/face'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { UnitSystem } from '../../../../core/project/document'
import type { QuantityKind } from '../../../../core/quantity/units'
import type { AppErrorData, Issue } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { dfmMessages } from '../../messages/dfm'
import { useShell, useUi } from '../../shell/ShellContext'
import {
  Icon,
  AnchorPicker,
  Field,
  FieldIcon,
  IconButton,
  QuantityInput,
  SegmentedControl,
  Select,
  Switch,
  type FieldIconName,
  type FieldMessage,
} from '../../ui'
import { ChamferInspector } from './ChamferInspector'
import { isOpenNamed } from './operation-shape'
import { isRotated, ShapePicker, type ShapeActions } from './ShapePicker'
import { TabPositions } from './TabsFields'
import styles from './Design.module.css'
import {
  axisNames,
  defaultUnit,
  isFormula,
  onChoices,
  quantityAt,
  quantityOf,
  referenceChoices,
  surfaceDirection,
  shapeArgs,
  updateArgs,
  type DesignPart,
} from './model'

const t = designMessages.inspector

const sentence = (s: string) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1))

export interface FieldError {
  readonly path: string
  readonly text: string
}

export interface OperationFieldsContext {
  readonly part: DesignPart
  readonly op: OperationDTO
  readonly units: UnitSystem
  readonly warnings: readonly DfmWarning[]
  readonly errors: readonly FieldError[]
  /** Shown, never committed (a plan copy outside settled design). */
  readonly readOnly: boolean
  /**
   * Whether references can be picked in the viewport (the design scene handles pick mode); without
   * it they are chosen from the field's list only.
   */
  readonly pickable: boolean
  /** One update command with these args; `path` is where its errors show, `gesture` a live step. */
  send(args: Record<string, unknown>, path: string, gesture?: string): void
  cancelGesture(gesture: string): Promise<boolean>
  /** The shape picker's design-only actions (task U2): New shape…, Edit shape, Convert, fixes. */
  readonly shapeActions?: ShapeActions | undefined
  /**
   * Read-only fields of an owned operation (v0.4 task U1): a finding with a suggestion offers this
   * fix instead of "Use …" ("Fix in Hole 1": select the feature, focus the mapped field).
   */
  readonly fixElsewhere?: ((w: DfmWarning) => { label: string; onApply: () => void }) | undefined
  /**
   * Recommended values by parameter path (the facing's depth down to the reference, DF4): the
   * field's pencil offers "Use …" (QuantityInput `recommended`); never on read-only fields.
   */
  readonly recommended?: Readonly<Record<string, { source: string; text: string }>> | undefined
}

/**
 * A failed update's issues: those at a field of the operation show there, the rest at the top
 * (ui.md#errors); `summary` is set when something is left for the top.
 */
export function placeErrors(
  error: AppErrorData,
  path: string | undefined,
): { errors: FieldError[]; summary: AppErrorData | undefined } {
  const mine: FieldError[] = []
  const rest: Issue[] = []
  for (const issue of error.issues) {
    const p = issue.path.join('.')
    const at = p.length > 0 && !p.startsWith('operations.') ? p : path
    if (at !== undefined && issue.path[0] !== 'operations')
      mine.push({ path: at, text: sentence(issue.message) })
    else rest.push(issue)
  }
  return { errors: mine, summary: mine.length === 0 || rest.length > 0 ? error : undefined }
}

/**
 * The field a warning is shown at (a shape or center warning at its first field; a general
 * shape's warnings and the corner warnings at the shape picker, path `shape`; tab warnings at the
 * positions while they are entered).
 */
export function warningPath(w: DfmWarning, op: OperationDTO): string | undefined {
  // v0.4 U4: "no library tool fits the chamfer" shows at the tool field, with "New tool…"
  if (w.code === 'dfm.chamferNoTool') return 'tool'
  const p = w.parameter
  if (p === undefined) return undefined
  if (p === 'center') return 'center.0'
  if (p === 'tabs')
    return op.kind === 'profile' && op.tabs.positions !== undefined
      ? 'tabs.positions'
      : 'tabs.count'
  if (p === 'shape' && 'shape' in op) {
    if (op.shape.kind === 'named' || isRotated(op.shape) || w.params['at'] !== undefined)
      return 'shape'
    return op.shape.kind === 'circle' ? 'shape.diameter' : 'shape.length'
  }
  return p
}

const QUANTITY_KIND: Record<FieldKind, QuantityKind> = {
  length: 'length',
  angle: 'angle',
  scalar: 'scalar',
}

/** One edited parameter as an update command. */
const commit = (ctx: OperationFieldsContext, path: string, source: string, gesture?: string) =>
  ctx.send(updateArgs(ctx.op, path, source), path, gesture)

/** The operation's parameter groups (its name and warnings not included). */
export function OperationFields({
  ctx,
  level = 3,
  tool,
}: {
  ctx: OperationFieldsContext
  /** Heading level of the group titles (4 when nested in another group). */
  level?: 3 | 4
  /** The tool field (Design inspector only), placed as the first group after `on`'s. */
  tool?: React.ReactNode
}): React.JSX.Element | null {
  const op = ctx.op
  const g = (title: string, children: React.ReactNode) => (
    <Group title={title} level={level}>
      {children}
    </Group>
  )
  const toolGroup = tool === undefined ? null : g(t.groups.tool, tool)
  switch (op.kind) {
    case 'facing':
      return (
        <>
          {g(
            t.groups.depth,
            <>
              <OnField ctx={ctx} />
              <ParamField ctx={ctx} path="depth" label={t.depth} kind="length" icon="depth" />
            </>,
          )}
          {toolGroup}
        </>
      )
    case 'pocket':
      return (
        <>
          <ShapeGroup ctx={ctx} level={level} />
          {g(
            t.groups.depth,
            <>
              <OnField ctx={ctx} />
              <ParamField ctx={ctx} path="depth" label={t.depth} kind="length" icon="depth" />
            </>,
          )}
          {toolGroup}
          {g(
            t.groups.corners,
            <>
              {op.shape.kind === 'rectangle' ? (
                <ParamField
                  ctx={ctx}
                  path="shape.cornerRadius"
                  label={t.cornerRadius}
                  kind="length"
                  icon="corner"
                />
              ) : null}
              <ParamField
                ctx={ctx}
                path="floorRadius"
                label={t.floorRadius}
                kind="length"
                icon="corner"
              />
            </>,
          )}
        </>
      )
    case 'drilling':
      return (
        <>
          {g(
            t.groups.position,
            <>
              <ParamField
                ctx={ctx}
                path="center.0"
                label={t.position('Center', axes(ctx).u)}
                kind="length"
                icon="length"
              />
              <ParamField
                ctx={ctx}
                path="center.1"
                label={t.position('Center', axes(ctx).v)}
                kind="length"
                icon="width"
              />
              <OnField ctx={ctx} />
            </>,
          )}
          {toolGroup}
          {g(
            t.groups.hole,
            <>
              <ParamField ctx={ctx} path="diameter" label={t.diameter} kind="length" icon="width" />
              <Field label={t.bottom} readOnly={ctx.readOnly}>
                <Select
                  options={(['through', 'flat', 'drillPoint'] as const).map((b) => ({
                    value: b,
                    label: t.bottoms[b],
                  }))}
                  value={op.bottom}
                  disabled={ctx.readOnly}
                  onValueChange={(bottom) =>
                    ctx.send(
                      {
                        bottom,
                        ...(bottom !== 'through' && op.depth === undefined
                          ? { depth: op.diameter.source }
                          : {}),
                      },
                      'bottom',
                    )
                  }
                />
              </Field>
              {op.bottom !== 'through' ? (
                <ParamField ctx={ctx} path="depth" label={t.depth} kind="length" icon="depth" />
              ) : null}
              {op.bottom === 'drillPoint' ? (
                <ParamField
                  ctx={ctx}
                  path="pointAngle"
                  label={t.pointAngle}
                  kind="angle"
                  icon="chamfer"
                />
              ) : null}
            </>,
          )}
        </>
      )
    case 'profile': {
      const named = op.shape.kind === 'named' ? op.shape.shapeId : undefined
      const open = isOpenNamed(ctx.part.dto.shapes?.find((x) => x.id === named))
      const sideMessages: FieldMessage[] = [
        ...ctx.errors
          .filter((e) => e.path === 'side')
          .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text })),
        ...(open
          ? [
              op.side !== 'on'
                ? {
                    id: 'openNeedsOn',
                    severity: 'error' as const,
                    text: t.openNeedsOn,
                    ...(ctx.readOnly
                      ? {}
                      : {
                          fix: {
                            label: t.useSideOn,
                            onApply: () => ctx.send({ side: 'on' }, 'side'),
                          },
                        }),
                  }
                : { id: 'openNote', severity: 'note' as const, text: t.openNeedsOn },
            ]
          : []),
      ]
      return (
        <>
          <ShapeGroup ctx={ctx} level={level}>
            <OnField ctx={ctx} />
            <Field label={t.side} kind="toggle" messages={sideMessages} readOnly={ctx.readOnly}>
              <SegmentedControl<'outside' | 'inside' | 'on'>
                label={t.side}
                options={(['outside', 'inside', 'on'] as const).map((s) => ({
                  value: s,
                  label: t.sides[s],
                  disabled: open && s !== 'on',
                }))}
                value={op.side}
                disabled={ctx.readOnly}
                onValueChange={(side) => ctx.send({ side }, 'side')}
              />
            </Field>
            {op.side === 'on' ? <GrooveDepthField ctx={ctx} /> : null}
          </ShapeGroup>
          {toolGroup}
          {g(
            t.groups.slot,
            <ParamField
              ctx={ctx}
              path="slotWidth"
              label={t.slotWidth}
              kind="length"
              icon="width"
            />,
          )}
          {g(
            t.groups.tabs,
            <>
              {op.tabs.positions === undefined ? (
                <ParamField
                  ctx={ctx}
                  path="tabs.count"
                  label={t.tabsCount}
                  kind="scalar"
                  icon="tabs"
                />
              ) : null}
              <ParamField
                ctx={ctx}
                path="tabs.width"
                label={t.tabsWidth}
                kind="length"
                icon="length"
              />
              <ParamField
                ctx={ctx}
                path="tabs.thickness"
                label={t.tabsThickness}
                kind="length"
                icon="depth"
              />
              <TabPositions ctx={ctx} />
            </>,
          )}
        </>
      )
    }
    case 'chamfer':
      return <ChamferInspector ctx={ctx} level={level} tool={toolGroup} />
    default:
      return null
  }
}

export function Group({
  title,
  level,
  children,
}: {
  title: string
  level: 3 | 4
  children: React.ReactNode
}): React.JSX.Element {
  const Heading = level === 3 ? 'h3' : 'h4'
  return (
    <section className={styles['group']} aria-label={title}>
      <Heading className={styles['groupTitle']}>{title}</Heading>
      {children}
    </section>
  )
}

function ShapeGroup({
  ctx,
  level,
  children,
}: {
  ctx: OperationFieldsContext
  level: 3 | 4
  children?: React.ReactNode
}): React.JSX.Element | null {
  const op = ctx.op
  if (!('shape' in op)) return null
  const shape = op.shape
  const names = axes(ctx)
  return (
    <Group title={t.groups.shape} level={level}>
      <ShapePicker ctx={ctx} actions={ctx.shapeActions} />
      {children}
      <AnchorField ctx={ctx} />
      <ParamField
        ctx={ctx}
        path="shape.center.0"
        label={t.position('Position', names.u)}
        kind="length"
        icon="length"
      />
      <ParamField
        ctx={ctx}
        path="shape.center.1"
        label={t.position('Position', names.v)}
        kind="length"
        icon="width"
      />
      {shape.kind === 'rectangle' ? (
        <>
          <ParamField
            ctx={ctx}
            path="shape.length"
            label={t.lengthAlong(names.u)}
            kind="length"
            icon="length"
          />
          <ParamField
            ctx={ctx}
            path="shape.width"
            label={t.widthAlong(names.v)}
            kind="length"
            icon="width"
          />
        </>
      ) : shape.kind === 'circle' ? (
        <ParamField ctx={ctx} path="shape.diameter" label={t.diameter} kind="length" icon="width" />
      ) : null}
      {op.kind === 'profile' && shape.kind === 'rectangle' ? (
        <ParamField
          ctx={ctx}
          path="shape.cornerRadius"
          label={t.cornerRadius}
          kind="length"
          icon="corner"
        />
      ) : null}
      {shape.kind !== 'circle' ? <RotationField ctx={ctx} /> : null}
      {shape.kind === 'named' ? (
        <Switch
          label={t.picker.mirror}
          checked={shape.mirror === true}
          disabled={ctx.readOnly}
          onCheckedChange={(mirror) => {
            const { mirror: _was, ...rest } = shapeArgs(shape)
            ctx.send({ shape: mirror ? { ...rest, mirror: true } : rest }, 'shape.mirror')
          }}
        />
      ) : null}
    </Group>
  )
}

/**
 * Rotation in degrees (rectangles and named shapes); while it has focus the viewport draws the
 * placed, rotated bounding box the anchor uses (ui store `rotationGuide`).
 */
function RotationField({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element {
  const { ui } = useShell()
  const id = ctx.op.id
  return (
    <div
      onFocus={() => ui.getState().setRotationGuide(id)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          ui.getState().setRotationGuide(null)
      }}
    >
      <ParamField
        ctx={ctx}
        path="shape.rotation"
        label={t.picker.rotation}
        kind="angle"
        icon="chamfer"
        placeholder={t.picker.rotationNone}
      />
    </div>
  )
}

/** A groove's blind depth below `on` (side On only); empty = through (`depth: null`). */
function GrooveDepthField({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element | null {
  const op = ctx.op
  if (op.kind !== 'profile') return null
  const messages: FieldMessage[] = ctx.errors
    .filter((e) => e.path === 'depth')
    .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text }))
  return (
    <QuantityInput
      label={t.grooveDepth}
      kind="length"
      defaultUnit={defaultUnit('length', ctx.units)}
      value={op.depth === undefined ? undefined : quantityOf(op.depth)}
      placeholder={t.grooveThrough}
      optional
      illustration={<FieldIcon name="depth" />}
      messages={messages}
      readOnly={ctx.readOnly}
      onCommit={(q, gesture) => ctx.send({ depth: q?.source ?? null }, 'depth', gesture)}
      onCancelGesture={ctx.cancelGesture}
    />
  )
}

/** The operation's index in its part (the surface table's resolver position). */
const indexOf = (ctx: OperationFieldsContext) =>
  ctx.part.dto.operations.findIndex((o) => o.id === ctx.op.id)

/** Direction of the operation's `on` face. */
const directionOf = (ctx: OperationFieldsContext) => surfaceDirection(ctx.part.table, onOf(ctx.op))

/** The operation's `on` (absent on a facing or profile = the stock top, design-v0.2.md). */
const onOf = (op: OperationDTO): string => op.on ?? STOCK_FACE['+z']

/** Axis names of the operation's face frame in labels (X/Y on the top, u/v elsewhere). */
const axes = (ctx: OperationFieldsContext) => axisNames(directionOf(ctx))

/**
 * The placement anchor (task F2): which of the nine points of the shape's bounding box the
 * position fields give, beside them. Choosing re-anchors without moving the feature (one
 * `anchor` update, one undo step). Disabled with its reason while a coordinate is a formula.
 */
function AnchorField({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element | null {
  const { op } = ctx
  if (!('shape' in op)) return null
  const shape = op.shape
  const direction = directionOf(ctx)
  const value = shape.anchor ?? { u: 'centre' as const, v: 'centre' as const }
  const formula = isFormula(shape.center[0]) || isFormula(shape.center[1])
  const name = designMessages.anchorPoint
  const messages: FieldMessage[] = [
    ...ctx.errors
      .filter((e) => e.path === 'anchor')
      .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text })),
    ...(formula && !ctx.readOnly
      ? [{ id: 'formula', severity: 'note' as const, text: t.anchorFormula }]
      : []),
  ]
  return (
    <Field label={t.anchor} kind="toggle" messages={messages} readOnly={ctx.readOnly}>
      <AnchorPicker
        label={t.anchor}
        value={value}
        shape={shape.kind === 'circle' ? 'circle' : 'rectangle'}

        disabled={ctx.readOnly || formula}
        caption={name(direction, value)}
        pointLabel={(p) => name(direction, p)}
        onValueChange={(anchor) => ctx.send({ anchor }, 'anchor')}
      />
    </Field>
  )
}

/** One quantity parameter: stored value, commit = one update command, warnings and errors here. */
export function ParamField({
  ctx,
  path,
  label,
  kind,
  icon,
  placeholder,
}: {
  ctx: OperationFieldsContext
  path: string
  label: string
  kind: FieldKind
  icon: FieldIconName
  placeholder?: string
}): React.JSX.Element {
  const pick = useUi((s) => s.pick)
  const setPick = useUi((s) => s.setPick)
  const { part, op } = ctx
  const index = indexOf(ctx)
  const table = part.table
  const choices = table ? referenceChoices(part.dto, table, index) : []
  const references = choices.map((c) => ({ id: c.id, label: c.label }))
  const name = (id: string) => part.dto.operations.find((o) => o.id === id)?.name ?? id
  const messages: FieldMessage[] = [
    ...ctx.errors
      .filter((e) => e.path === path)
      .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text })),
    ...ctx.warnings
      .filter((w) => warningPath(w, op) === path)
      .map((w): FieldMessage => {
        const source = dfmMessages.suggestionSource(w, part.units)
        return {
          id: `${w.code}:${w.parameter ?? ''}`,
          severity: dfmMessages.tier(w),
          text: dfmMessages.text(w, part.units, name),
          ...(source !== undefined && w.suggestion && w.parameter === path && !ctx.readOnly
            ? {
                fix: {
                  label: dfmMessages.useValue(w.suggestion.relation, source),
                  onApply: () => commit(ctx, path, source),
                },
              }
            : w.suggestion && ctx.readOnly && ctx.fixElsewhere
              ? { fix: ctx.fixElsewhere(w) }
              : {}),
        }
      }),
  ]
  const fieldId = `${op.id}:${path}`
  const recommended = ctx.recommended?.[path]
  return (
    <QuantityInput
      label={label}
      kind={QUANTITY_KIND[kind]}
      defaultUnit={defaultUnit(kind, ctx.units)}
      value={quantityAt(op, path)}
      onCommit={(q, gesture) => commit(ctx, path, q.source, gesture)}
      onCancelGesture={ctx.cancelGesture}
      illustration={<FieldIcon name={icon} />}
      messages={messages}
      {...(placeholder !== undefined ? { placeholder } : {})}
      references={references}
      readOnly={ctx.readOnly}
      {...(recommended !== undefined && !ctx.readOnly ? { recommended } : {})}
      picking={ctx.pickable && pick?.owner === fieldId}
      {...(table ? { resolver: table.resolver(index) } : {})}
      {...(table && kind === 'length' && ctx.pickable && !ctx.readOnly
        ? {
            onPick: (insert: (reference: string) => void) => {
              setPick({
                owner: fieldId,
                field: label,
                eligible: new Set(choices.map((c) => c.surface)),
                onPick: (surface) => {
                  const c = choices.find((x) => x.surface === surface)
                  if (c) insert(c.id)
                },
              })
            },
            onPickCancel: () => setPick(null),
          }
        : {})}
    />
  )
}

/**
 * `on`: the face the operation starts from – a list of its face targets grouped by direction, or
 * pick it in the viewport (every direction, with a normal glyph; task F1).
 */
function OnField({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element | null {
  const pick = useUi((s) => s.pick)
  const setPick = useUi((s) => s.setPick)
  const { part, op } = ctx
  if (part.table === undefined) return null
  const choices = onChoices(part.dto, part.table, indexOf(ctx), op.kind)
  const owner = `${op.id}:on`
  const picking = pick?.owner === owner
  const messages: FieldMessage[] = [
    ...ctx.errors
      .filter((e) => e.path === 'on')
      .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text })),
    ...ctx.warnings
      .filter((w) => w.parameter === 'on')
      .map((w): FieldMessage => ({
        id: w.code,
        severity: dfmMessages.tier(w),
        text: dfmMessages.text(w, part.units, (id) => id),
      })),
  ]
  return (
    <div className={styles['onRow']}>
      <Field label={t.on} messages={messages} readOnly={ctx.readOnly}>
        <Select
          options={choices.map((c) => ({
            value: c.id,
            label: t.surface(c.id, c.label),
            group: c.group,
          }))}
          value={onOf(op)}
          disabled={ctx.readOnly}
          onValueChange={(on) => commit(ctx, 'on', on)}
        />
      </Field>
      {ctx.pickable && !ctx.readOnly ? (
        <IconButton
          label={t.pickOn}
          shortcut="Alt+P"
          icon={<Icon name="pick" />}
          pressed={picking}
          className={styles['pickButton']}
          onClick={() =>
            picking
              ? setPick(null)
              : setPick({
                  owner,
                  field: t.on,
                  eligible: new Set(choices.map((c) => c.id)),
                  onPick: (surface) => commit(ctx, 'on', surface),
                })
          }
        />
      ) : null}
    </div>
  )
}
