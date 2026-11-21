// Design inspector (task 3.6): the selected operation's parameters, grouped as in the parameter
// tables of design.md (Shape, Position, Depth, Corners, Hole, Slot, Tabs), each a QuantityInput
// whose commit is one design command (one undo step); `on` and formula references can be picked
// in the viewport (pick mode) or chosen from a list. Without a selection: the part (name, stock,
// general tolerance) and all its warnings. Command errors show at their field (or at the top);
// DFM warnings at the blamed parameter, with "Apply" for a suggestion.
// Doc: docs/conventions/ui.md#panels-and-inspectors, #quantity-and-expression-input,
// #selection-and-picking, #errors, #warnings-and-dfm; docs/modes/design.md#operations-v01
import { Crosshair } from 'lucide-react'
import { useState } from 'react'
import type { FieldKind } from '../../../../core/design/operation'
import type { OperationDTO } from '../../../../core/design/part.dto'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { UnitSystem } from '../../../../core/project/document'
import type { QuantityKind } from '../../../../core/quantity/units'
import type { AppErrorData, Issue } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { dfmMessages } from '../../messages/dfm'
import { useCancelGesture } from '../../shell/hooks'
import { useUi } from '../../shell/ShellContext'
import {
  ErrorMessage,
  Field,
  FieldIcon,
  FieldInput,
  IconButton,
  PanelHeader,
  QuantityInput,
  SegmentedControl,
  Select,
  StatusChip,
  WarningList,
  type FieldIconName,
  type FieldMessage,
  type WarningView,
} from '../../ui'
import styles from './Design.module.css'
import {
  defaultUnit,
  quantityAt,
  quantityOf,
  shapeKindArgs,
  surfaceChoices,
  updateArgs,
  type DesignPart,
} from './model'
import {
  useCommand,
  useDesignEvaluation,
  useDesignSelection,
  useDesignWarnings,
  type DesignWarnings,
} from './useDesign'

const m = designMessages
const t = m.inspector

export const warningLabels = {
  list: dfmMessages.listTitle,
  dismiss: dfmMessages.dismiss,
  dismissed: dfmMessages.dismissed,
  show: dfmMessages.show,
  hide: dfmMessages.hide,
  tier: dfmMessages.severity,
}

const sentence = (s: string) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1))

/** The field a warning is shown at (a shape or center warning at its first field). */
function warningPath(w: DfmWarning, op: OperationDTO): string | undefined {
  const p = w.parameter
  if (p === undefined) return undefined
  if (p === 'center') return 'center.0'
  if (p === 'tabs') return 'tabs.count'
  if (p === 'shape' && 'shape' in op)
    return op.shape.kind === 'circle' ? 'shape.diameter' : 'shape.length'
  return p
}

/** View of one DFM warning for the warning lists. */
export function warningView(
  w: DfmWarning,
  part: DesignPart,
  apply: ((w: DfmWarning, source: string) => void) | undefined,
  onSelect?: (operationId: string) => void,
): WarningView {
  const name = (id: string) => part.dto.operations.find((o) => o.id === id)?.name ?? id
  const source = dfmMessages.suggestionSource(w, part.units)
  return {
    id: `${w.code}:${w.operation}:${w.parameter ?? ''}`,
    tier: dfmMessages.tier(w),
    text: dfmMessages.text(w, part.units, name),
    subject: name(w.operation),
    ...(onSelect && w.operation !== 'stock' ? { onSelect: () => onSelect(w.operation) } : {}),
    ...(apply && source !== undefined && w.suggestion
      ? {
          fix: {
            label: dfmMessages.apply(w.suggestion.relation, source),
            onApply: () => apply(w, source),
          },
        }
      : {}),
  }
}

export function DesignInspector({ part }: { part: DesignPart | undefined }): React.JSX.Element {
  const [selected] = useDesignSelection()
  const warnings = useDesignWarnings(part)
  if (part === undefined)
    return (
      <>
        <PanelHeader title={t.part} />
        <p className={styles['note']}>{t.noPart}</p>
      </>
    )
  const op = part.dto.operations.find((o) => o.id === selected)
  return op === undefined ? (
    <PartInspector part={part} warnings={warnings} />
  ) : (
    <OperationInspector key={op.id} part={part} op={op} warnings={warnings} />
  )
}

// ── part ──────────────────────────────────────────────────────────────────────────────────

function PartInspector({
  part,
  warnings,
}: {
  part: DesignPart
  warnings: DesignWarnings
}): React.JSX.Element {
  const call = useCommand()
  const [, select] = useDesignSelection()
  const evaluation = useDesignEvaluation(part)
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const stock = part.loaded?.stock
  const tolerance = part.dto.generalTolerance?.length
  const cancelGesture = useCancelGesture()
  const updatePart = async (args: object, gesture?: string) => {
    const r = await call(
      'design.part.update',
      { partId: part.dto.id, ...args },
      gesture === undefined ? undefined : { gesture },
    )
    setError(r.ok ? undefined : r.error)
  }
  const apply = (w: DfmWarning, source: string) => void applyWarning(call, part, w, source)
  return (
    <div className={styles['inspector']}>
      <PanelHeader title={t.part} meta={t.partSummary(part.dto.operations.length)} />
      <div className={styles['fields']}>
        <NameField
          label={t.name}
          name={part.dto.name}
          onCommit={(name) => void updatePart({ name })}
        />
        {stock ? (
          <p className={styles['muted']}>
            {m.stock.title}:{' '}
            {m.stock.summary(stock.length.source, stock.width.source, stock.thickness.source)} ·{' '}
            {m.stock.material_(stock.material.name)}
          </p>
        ) : null}
        <QuantityInput
          label={t.generalTolerance}
          kind="length"
          defaultUnit={defaultUnit('length', part.units)}
          value={tolerance === undefined ? undefined : quantityOf(tolerance)}
          onCommit={(q, gesture) =>
            void updatePart({ generalTolerance: { length: q.source } }, gesture)
          }
          onCancelGesture={cancelGesture}
        />
        {error ? <ErrorMessage error={error} /> : null}
        <EvaluationLine status={evaluation?.status} />
        <section aria-label={dfmMessages.listTitle} className={styles['warnings']}>
          <h3 className={styles['groupTitle']}>{dfmMessages.listTitle}</h3>
          <WarningList
            labels={warningLabels}
            items={warnings.warnings.map((w) => warningView(w, part, apply, select))}
            empty={dfmMessages.none}
            {...(warnings.evaluation === 'pending' ? { note: dfmMessages.checksPending } : {})}
          />
        </section>
      </div>
    </div>
  )
}

function EvaluationLine({ status }: { status: string | undefined }): React.JSX.Element | null {
  if (status === undefined) return null
  const s = status as 'done' | 'pending' | 'failed'
  return (
    <StatusChip tone={s === 'failed' ? 'danger' : s === 'pending' ? 'busy' : 'success'}>
      {m.evaluation.status(s)}
    </StatusChip>
  )
}

async function applyWarning(
  call: ReturnType<typeof useCommand>,
  part: DesignPart,
  w: DfmWarning,
  source: string,
): Promise<void> {
  const op = part.dto.operations.find((o) => o.id === w.operation)
  if (op === undefined || w.parameter === undefined) return
  await call(`design.${op.kind}.update`, {
    partId: part.dto.id,
    operationId: op.id,
    ...updateArgs(op, w.parameter, source),
  })
}

/** A text field committing on Enter or blur (Escape reverts). */
function NameField({
  label,
  name,
  onCommit,
}: {
  label: string
  name: string
  onCommit: (name: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(name)
  // the stored name changed (commit, undo, agent): follow it
  const [seen, setSeen] = useState(name)
  if (name !== seen) {
    setSeen(name)
    setDraft(name)
  }
  const commit = () => {
    const v = draft.trim()
    if (v.length > 0 && v !== name) onCommit(v)
    else setDraft(name)
  }
  return (
    <Field label={label}>
      <FieldInput
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(name)
          }
        }}
      />
    </Field>
  )
}

// ── operation ─────────────────────────────────────────────────────────────────────────────

interface FieldError {
  readonly path: string
  readonly text: string
}

interface OperationContext {
  readonly part: DesignPart
  readonly op: OperationDTO
  readonly index: number
  readonly units: UnitSystem
  readonly warnings: readonly DfmWarning[]
  readonly errors: readonly FieldError[]
  /** One update command; `gesture` for a live adjust-popover step. */
  commit(path: string, source: string, gesture?: string): void
  cancelGesture(gesture: string): Promise<boolean>
}

const QUANTITY_KIND: Record<FieldKind, QuantityKind> = {
  length: 'length',
  angle: 'angle',
  scalar: 'scalar',
}

function OperationInspector({
  part,
  op,
  warnings,
}: {
  part: DesignPart
  op: OperationDTO
  warnings: DesignWarnings
}): React.JSX.Element {
  const call = useCommand()
  const cancelGesture = useCancelGesture()
  const [errors, setErrors] = useState<readonly FieldError[]>([])
  const [summary, setSummary] = useState<AppErrorData | undefined>(undefined)
  const index = part.dto.operations.indexOf(op)
  const opWarnings = warnings.warnings.filter((w) => w.operation === op.id)

  const send = async (
    args: Record<string, unknown>,
    path: string | undefined,
    gesture?: string,
  ) => {
    const r = await call(
      `design.${op.kind}.update`,
      { partId: part.dto.id, operationId: op.id, ...args },
      gesture === undefined ? undefined : { gesture },
    )
    if (r.ok) {
      setErrors([])
      setSummary(undefined)
      return
    }
    // issues at a field of this operation show there; the rest at the top (ui.md#errors)
    const mine: FieldError[] = []
    const rest: Issue[] = []
    for (const issue of r.error.issues) {
      const p = issue.path.join('.')
      const at = p.length > 0 && !p.startsWith('operations.') ? p : path
      if (at !== undefined && issue.path[0] !== 'operations')
        mine.push({ path: at, text: sentence(issue.message) })
      else rest.push(issue)
    }
    setErrors(mine)
    setSummary(mine.length === 0 || rest.length > 0 ? r.error : undefined)
  }
  const ctx: OperationContext = {
    part,
    op,
    index,
    units: part.units,
    warnings: opWarnings,
    errors,
    commit: (path, source, gesture) => void send(updateArgs(op, path, source), path, gesture),
    cancelGesture,
  }
  const unplaced = opWarnings.filter((w) => warningPath(w, op) === undefined)

  return (
    <div className={styles['inspector']}>
      <PanelHeader title={op.name} meta={op.id} />
      <div className={styles['fields']}>
        {summary ? <ErrorMessage error={summary} message={t.commandFailed} /> : null}
        <NameField label={t.name} name={op.name} onCommit={(name) => void send({ name }, 'name')} />
        {op.kind === 'facing' ? (
          <Group title={t.groups.depth}>
            <ParamField ctx={ctx} path="depth" label={t.depth} kind="length" icon="depth" />
          </Group>
        ) : null}
        {op.kind === 'pocket' ? (
          <>
            <ShapeGroup ctx={ctx} send={send} />
            <Group title={t.groups.depth}>
              <OnField ctx={ctx} />
              <ParamField ctx={ctx} path="depth" label={t.depth} kind="length" icon="depth" />
            </Group>
            <Group title={t.groups.corners}>
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
            </Group>
          </>
        ) : null}
        {op.kind === 'drilling' ? (
          <>
            <Group title={t.groups.position}>
              <ParamField ctx={ctx} path="center.0" label={t.centerX} kind="length" icon="length" />
              <ParamField ctx={ctx} path="center.1" label={t.centerY} kind="length" icon="width" />
              <OnField ctx={ctx} />
            </Group>
            <Group title={t.groups.hole}>
              <ParamField ctx={ctx} path="diameter" label={t.diameter} kind="length" icon="width" />
              <Field label={t.bottom}>
                <Select
                  options={(['through', 'flat', 'drillPoint'] as const).map((b) => ({
                    value: b,
                    label: t.bottoms[b],
                  }))}
                  value={op.bottom}
                  onValueChange={(bottom) =>
                    void send(
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
            </Group>
          </>
        ) : null}
        {op.kind === 'profile' ? (
          <>
            <ShapeGroup ctx={ctx} send={send}>
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
                  onValueChange={(side) => void send({ side }, 'side')}
                />
              </div>
            </ShapeGroup>
            <Group title={t.groups.slot}>
              <ParamField
                ctx={ctx}
                path="slotWidth"
                label={t.slotWidth}
                kind="length"
                icon="width"
              />
            </Group>
            <Group title={t.groups.tabs}>
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
            </Group>
          </>
        ) : null}
        {unplaced.length > 0 ? (
          <WarningList
            labels={warningLabels}
            items={unplaced.map((w) => warningView(w, part, undefined))}
          />
        ) : null}
      </div>
    </div>
  )
}

function Group({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className={styles['group']} aria-label={title}>
      <h3 className={styles['groupTitle']}>{title}</h3>
      {children}
    </section>
  )
}

function ShapeGroup({
  ctx,
  send,
  children,
}: {
  ctx: OperationContext
  send: (args: Record<string, unknown>, path: string) => Promise<void>
  children?: React.ReactNode
}): React.JSX.Element | null {
  const op = ctx.op
  if (!('shape' in op)) return null
  const shape = op.shape
  return (
    <Group title={t.groups.shape}>
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
          onValueChange={(kind) => {
            if (kind !== shape.kind) void send({ shape: shapeKindArgs(shape, kind) }, 'shape')
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

/** One quantity parameter: stored value, commit = one update command, warnings and errors here. */
function ParamField({
  ctx,
  path,
  label,
  kind,
  icon,
}: {
  ctx: OperationContext
  path: string
  label: string
  kind: FieldKind
  icon: FieldIconName
}): React.JSX.Element {
  const pick = useUi((s) => s.pick)
  const setPick = useUi((s) => s.setPick)
  const { part, op, index } = ctx
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
          ...(source !== undefined && w.suggestion && w.parameter === path
            ? {
                fix: {
                  label: dfmMessages.apply(w.suggestion.relation, source),
                  onApply: () => ctx.commit(path, source),
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
      onCommit={(q, gesture) => ctx.commit(path, q.source, gesture)}
      onCancelGesture={ctx.cancelGesture}
      illustration={<FieldIcon name={icon} />}
      messages={messages}
      references={references}
      picking={pick?.owner === fieldId}
      {...(table ? { resolver: table.resolver(index) } : {})}
      {...(table && kind === 'length'
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
function OnField({ ctx }: { ctx: OperationContext }): React.JSX.Element | null {
  const pick = useUi((s) => s.pick)
  const setPick = useUi((s) => s.setPick)
  const { part, op, index } = ctx
  if (!('on' in op) || part.table === undefined) return null
  const choices = surfaceChoices(part.dto, part.table, index, true)
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
      <Field label={t.on} messages={messages}>
        <Select
          options={choices.map((c) => ({ value: c.id, label: t.surface(c.id, c.label) }))}
          value={op.on}
          onValueChange={(on) => ctx.commit('on', on)}
        />
      </Field>
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
                onPick: (surface) => ctx.commit('on', surface),
              })
        }
      />
    </div>
  )
}
