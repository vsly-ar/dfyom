// Design inspector (task 3.6): the selected operation's parameters (OperationFields.tsx, shared
// with the plan copy), grouped as in the parameter tables of design.md (Shape, Position, Depth,
// Corners, Hole, Slot, Tabs), each a QuantityInput whose commit is one design command (one undo
// step); `on` and formula references can be picked
// in the viewport (pick mode) or chosen from a list. Without a selection: the part (name, stock,
// general tolerance) and all its warnings. Command errors show at their field (or at the top);
// DFM warnings at the blamed parameter, with "Use …" for a suggestion. A selected reference model
// shows its own inspector (ReferenceInspector.tsx, task R3), a selected shape the Shape Editor's
// (ShapeInspector.tsx, task U1).
// Doc: docs/conventions/ui.md#panels-and-inspectors, #quantity-and-expression-input,
// #selection-and-picking, #errors, #warnings-and-dfm; docs/modes/design.md#operations-v01
import { useState } from 'react'
import type { OperationDTO } from '../../../../core/design/part.dto'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { applyMessages } from '../../messages/apply'
import { designMessages } from '../../messages/design'
import { dfmMessages } from '../../messages/dfm'
import { useCancelGesture } from '../../shell/hooks'
import { useShell } from '../../shell/ShellContext'
import {
  ErrorMessage,
  PanelHeader,
  QuantityInput,
  StatusChip,
  WarningList,
  type WarningView,
} from '../../ui'
import styles from './Design.module.css'
import { NameField } from './NameField'
import { ReferenceInspector } from './ReferenceInspector'
import { ShapeInspector } from './ShapeInspector'
import { ToolField } from './ToolField'
import {
  defaultUnit,
  pendingApply,
  quantityOf,
  shapeArgs,
  updateArgs,
  type DesignPart,
} from './model'
import { newItemArgs } from './shape-model'
import type { ShapeActions } from './ShapePicker'
import {
  OperationFields,
  placeErrors,
  warningPath,
  type FieldError,
  type OperationFieldsContext,
} from './OperationFields'
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

/** View of one DFM warning for the warning lists (soft with a clock while Apply may change it). */
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
    tier: pendingApply(w) ? 'soft' : dfmMessages.tier(w),
    ...(pendingApply(w) ? { pendingApply: applyMessages.warningPending } : {}),
    text: dfmMessages.text(w, part.units, name),
    subject: name(w.operation),
    ...(onSelect && w.operation !== 'stock' ? { onSelect: () => onSelect(w.operation) } : {}),
    ...(apply && source !== undefined && w.suggestion
      ? {
          fix: {
            label: dfmMessages.useValue(w.suggestion.relation, source),
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
  const ref = Object.hasOwn(part.doc.references, selected ?? '')
    ? part.doc.references[selected!]
    : undefined
  if (ref !== undefined && ref.partId === part.dto.id)
    return <ReferenceInspector key={ref.id} part={part} reference={ref} />
  const shape = part.dto.shapes?.find((s) => s.id === selected)
  if (shape !== undefined) return <ShapeInspector key={shape.id} part={part} shape={shape} />
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
          placeholder={t.generalToleranceNone}
          optional
          onCommit={(q, gesture) =>
            void updatePart({ generalTolerance: { length: q?.source ?? null } }, gesture)
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

// ── operation ─────────────────────────────────────────────────────────────────────────────

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
  const { ui, bridge } = useShell()
  const [, select] = useDesignSelection()
  const [errors, setErrors] = useState<readonly FieldError[]>([])
  const [summary, setSummary] = useState<AppErrorData | undefined>(undefined)
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
    const placed = r.ok ? undefined : placeErrors(r.error, path)
    setErrors(placed?.errors ?? [])
    setSummary(placed?.summary)
  }
  const openShape = (shapeId: string) => {
    ui.getState().selectShapeItem(shapeId, 0)
    select(shapeId)
  }
  const failed = (r: { ok: boolean; error?: AppErrorData }) => {
    if (r.ok || r.error === undefined) return false
    const placed = placeErrors(r.error, 'shape')
    setErrors(placed.errors)
    setSummary(placed.summary)
    return true
  }
  // the shape picker's actions (task U2, ui.md#shape-in-the-operation-inspector)
  const shapeActions: ShapeActions | undefined =
    op.kind === 'pocket' || op.kind === 'profile'
      ? {
          newShape: () =>
            void (async () => {
              // two commands, two undo steps: the shape, then its use here
              const added = await call('design.shape.add', {
                partId: part.dto.id,
                items: [newItemArgs('rectangle', part.units)],
              })
              if (failed(added) || !added.ok) return
              const shapeId = (added.value as { shapeId: string }).shapeId
              const center = shapeArgs(op.shape)['center']
              const used = await call(`design.${op.kind}.update`, {
                partId: part.dto.id,
                operationId: op.id,
                shape: { kind: 'named', shapeId, center },
              })
              failed(used)
              openShape(shapeId)
            })(),
          editShape: openShape,
          convert: () =>
            void (async () => {
              const r = await call('design.shape.convert', {
                partId: part.dto.id,
                operationId: op.id,
              })
              if (failed(r) || !r.ok) return
              const id = (r.value as { shapeId: string }).shapeId
              const got = await bridge.call('design.shape.get', {
                partId: part.dto.id,
                shapeId: id,
              })
              const name = got.ok ? (got.value as { shape: { name: string } }).shape.name : id
              ui.getState().setRemovedToast(t.picker.converted(name))
            })(),
          updateItems: (shapeId, fixes) =>
            void (async () => {
              for (const f of fixes) {
                const r = await call('design.shape.item.update', {
                  partId: part.dto.id,
                  shapeId,
                  index: f.index,
                  ...f.fields,
                })
                if (r.ok) continue
                // the item's issues name fields of the shape (`fillets.0.radius`), which this
                // inspector does not show: a fillet that does not fit says so at the picker (X2)
                const tooLarge = r.error.issues.some((i) => i.rule === 'filletTooLarge')
                setErrors(tooLarge ? [{ path: 'shape', text: t.picker.roundTooLarge }] : [])
                setSummary(tooLarge ? undefined : r.error)
                return
              }
              setErrors([])
              setSummary(undefined)
            })(),
        }
      : undefined
  const ctx: OperationFieldsContext = {
    part,
    op,
    units: part.units,
    warnings: opWarnings,
    errors,
    readOnly: false,
    pickable: true,
    send: (args, path, gesture) => void send(args, path, gesture),
    cancelGesture,
    shapeActions,
  }
  const unplaced = opWarnings.filter((w) => warningPath(w, op) === undefined)

  return (
    <div className={styles['inspector']}>
      <PanelHeader title={op.name} meta={op.id} />
      <div className={styles['fields']}>
        {summary ? <ErrorMessage error={summary} message={t.commandFailed} /> : null}
        <NameField label={t.name} name={op.name} onCommit={(name) => void send({ name }, 'name')} />
        <OperationFields ctx={ctx} tool={<ToolField part={part} op={op} warnings={opWarnings} />} />
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
