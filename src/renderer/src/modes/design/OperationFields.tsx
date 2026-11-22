// The per-kind parameter fields of one design operation, grouped as in the parameter tables of
// design.md (Shape, Position, Depth, Corners, Hole, Slot, Tabs): each a QuantityInput (or a
// choice) whose commit is one update command through `ctx.send`, with its warnings and errors at
// the field. Shared by the Design inspector (`design.<kind>.update`) and the plan inspector's
// "Part (plan copy)" group (`plan.design.operation.update`, task E3b), never copied.
// Doc: docs/conventions/ui.md#quantity-and-expression-input, #selection-and-picking,
// #design-and-plan-controls-v02; docs/modes/design.md#operations-v01
import { Crosshair } from 'lucide-react'
import type { FieldKind } from '../../../../core/design/operation'
import type { OperationDTO } from '../../../../core/design/part.dto'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { UnitSystem } from '../../../../core/project/document'
import type { QuantityKind } from '../../../../core/quantity/units'
import type { AppErrorData, Issue } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { dfmMessages } from '../../messages/dfm'
import { useUi } from '../../shell/ShellContext'
import {
  Field,
  FieldIcon,
  IconButton,
  QuantityInput,
  SegmentedControl,
  Select,
  type FieldIconName,
  type FieldMessage,
} from '../../ui'
import styles from './Design.module.css'
import {
  defaultUnit,
  quantityAt,
  shapeKindArgs,
  surfaceChoices,
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

/** The field a warning is shown at (a shape or center warning at its first field). */
export function warningPath(w: DfmWarning, op: OperationDTO): string | undefined {
  const p = w.parameter
  if (p === undefined) return undefined
  if (p === 'center') return 'center.0'
  if (p === 'tabs') return 'tabs.count'
  if (p === 'shape' && 'shape' in op)
    return op.shape.kind === 'circle' ? 'shape.diameter' : 'shape.length'
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
}: {
  ctx: OperationFieldsContext
  /** Heading level of the group titles (4 when nested in another group). */
  level?: 3 | 4
}): React.JSX.Element | null {
  const op = ctx.op
  const g = (title: string, children: React.ReactNode) => (
    <Group title={title} level={level}>
      {children}
    </Group>
  )
  switch (op.kind) {
    case 'facing':
      return g(
        t.groups.depth,
        <ParamField ctx={ctx} path="depth" label={t.depth} kind="length" icon="depth" />,
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
              <ParamField ctx={ctx} path="center.0" label={t.centerX} kind="length" icon="length" />
              <ParamField ctx={ctx} path="center.1" label={t.centerY} kind="length" icon="width" />
              <OnField ctx={ctx} />
            </>,
          )}
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
    case 'profile':
      return (
        <>
          <ShapeGroup ctx={ctx} level={level}>
            <div className={styles['choice']}>
              <span className={styles['caption']} aria-hidden="true">
                {t.side}
              </span>
              <SegmentedControl<'outside' | 'inside'>
                label={t.side}
                options={(['outside', 'inside'] as const).map((s) => ({
                  value: s,
                  label: t.sides[s],
                }))}
                value={op.side}
                disabled={ctx.readOnly}
                onValueChange={(side) => ctx.send({ side }, 'side')}
              />
            </div>
          </ShapeGroup>
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
              <ParamField
                ctx={ctx}
                path="tabs.count"
                label={t.tabsCount}
                kind="scalar"
                icon="tabs"
              />
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
            </>,
          )}
        </>
      )
    default:
      return null
  }
}

function Group({
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
  return (
    <Group title={t.groups.shape} level={level}>
      {children}
      <div className={styles['choice']}>
        <span className={styles['caption']} aria-hidden="true">
          {t.shapeKind}
        </span>
        <SegmentedControl<'rectangle' | 'circle'>
          label={t.shapeKind}
          options={(['rectangle', 'circle'] as const).map((k) => ({
            value: k,
            label: t.shapes[k],
          }))}
          value={shape.kind}
          disabled={ctx.readOnly}
          onValueChange={(kind) => {
            if (kind !== shape.kind) ctx.send({ shape: shapeKindArgs(shape, kind) }, 'shape')
          }}
        />
      </div>
      <ParamField ctx={ctx} path="shape.center.0" label={t.centerX} kind="length" icon="length" />
      <ParamField ctx={ctx} path="shape.center.1" label={t.centerY} kind="length" icon="width" />
      {shape.kind === 'rectangle' ? (
        <>
          <ParamField ctx={ctx} path="shape.length" label={t.length} kind="length" icon="length" />
          <ParamField ctx={ctx} path="shape.width" label={t.width} kind="length" icon="width" />
        </>
      ) : (
        <ParamField ctx={ctx} path="shape.diameter" label={t.diameter} kind="length" icon="width" />
      )}
      {op.kind === 'profile' && shape.kind === 'rectangle' ? (
        <ParamField
          ctx={ctx}
          path="shape.cornerRadius"
          label={t.cornerRadius}
          kind="length"
          icon="corner"
        />
      ) : null}
    </Group>
  )
}

/** The operation's index in its part (the surface table's resolver position). */
const indexOf = (ctx: OperationFieldsContext) =>
  ctx.part.dto.operations.findIndex((o) => o.id === ctx.op.id)

/** One quantity parameter: stored value, commit = one update command, warnings and errors here. */
function ParamField({
  ctx,
  path,
  label,
  kind,
  icon,
}: {
  ctx: OperationFieldsContext
  path: string
  label: string
  kind: FieldKind
  icon: FieldIconName
}): React.JSX.Element {
  const pick = useUi((s) => s.pick)
  const setPick = useUi((s) => s.setPick)
  const { part, op } = ctx
  const index = indexOf(ctx)
  const table = part.table
  const references = table
    ? surfaceChoices(part.dto, table, index, false).map((c) => ({
        id: `${c.id}.z`,
        label: c.label,
      }))
    : []
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
            : {}),
        }
      }),
  ]
  const fieldId = `${op.id}:${path}`
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
      references={references}
      readOnly={ctx.readOnly}
      picking={ctx.pickable && pick?.owner === fieldId}
      {...(table ? { resolver: table.resolver(index) } : {})}
      {...(table && kind === 'length' && ctx.pickable && !ctx.readOnly
        ? {
            onPick: (insert: (reference: string) => void) => {
              setPick({
                owner: fieldId,
                field: label,
                eligible: new Set(references.map((r) => r.id.slice(0, -2))),
                onPick: (surface) => insert(`${surface}.z`),
              })
            },
          }
        : {})}
    />
  )
}

/** `on`: the surface the operation starts from – a list of eligible surfaces, or pick it. */
function OnField({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element | null {
  const pick = useUi((s) => s.pick)
  const setPick = useUi((s) => s.setPick)
  const { part, op } = ctx
  // the `on` of a facing or profile (a stock face) gets its control with face picking (task F1)
  if ((op.kind !== 'pocket' && op.kind !== 'drilling') || part.table === undefined) return null
  const choices = surfaceChoices(part.dto, part.table, indexOf(ctx), true)
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
          options={choices.map((c) => ({ value: c.id, label: t.surface(c.id, c.label) }))}
          value={op.on}
          disabled={ctx.readOnly}
          onValueChange={(on) => commit(ctx, 'on', on)}
        />
      </Field>
      {ctx.pickable && !ctx.readOnly ? (
        <IconButton
          label={t.pickOn}
          shortcut="Alt+P"
          icon={<Crosshair aria-hidden="true" />}
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
