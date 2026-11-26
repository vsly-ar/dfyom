// Design inspector (task 3.6): the selected operation's parameters (OperationFields.tsx, shared
// with the plan copy), grouped as in the parameter tables of design.md (Shape, Position, Depth,
// Corners, Hole, Slot, Tabs), each a QuantityInput whose commit is one design command (one undo
// step); `on` and formula references can be picked
// in the viewport (pick mode) or chosen from a list. Without a selection: the part (name, stock,
// general tolerance) and all its warnings. Command errors show at their field (or at the top);
// DFM warnings at the blamed parameter, with "Use …" for a suggestion. While the toolbar's
// Reference toggle is pressed the Reference panel shows instead (ReferencePanel.tsx, dogfood DF3;
// the R3 reference inspector until then); shapes are edited in the Shape Editor window (DF94,
// ShapeEditorWindow.tsx), never here; a Clones feature, its instances and the Make Clones… draft their
// own (ClonesInspector.tsx, v0.4 task U3).
// Doc: docs/conventions/ui.md#panels-and-inspectors, #quantity-and-expression-input,
// #selection-and-picking, #errors, #warnings-and-dfm; docs/modes/design.md#operations-v01
import { useEffect, useState } from 'react'
import type { OperationDTO } from '../../../../core/design/part.dto'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { SPLIT_CODE } from '../../../../core/design/split/pieces'
import { applyMessages } from '../../messages/apply'
import { designMessages } from '../../messages/design'
import { dfmMessages } from '../../messages/dfm'
import { useCancelGesture } from '../../shell/hooks'
import { useShell, useUi } from '../../shell/ShellContext'
import {
  Button,
  ErrorMessage,
  Icon,
  Menu,
  newGestureId,
  PanelHeader,
  QuantityInput,
  StatusChip,
  WarningList,
  type WarningView,
  type FieldMessage,
  StepScaleProvider,
  stockStepScale,
  InspectorGroup,
} from '../../ui'
import styles from './Design.module.css'
import { featureOfWarning, operationUnits, ownerFeature } from './feature-view'
import { FeatureInspector, OwnedOperationInspector, useFixIn, type FixIn } from './FeatureInspector'
import { CloneInstanceInspector, ClonesDraft, ClonesInspector } from './ClonesInspector'
import { parseInstanceId } from './clones-view'
import { HoleInspector } from './HoleInspector'
import { PatternInspector } from './PatternInspector'
import { EngravingInspector } from './EngravingInspector'
import { FaceInspector } from './FaceInspector'
import { selectedFace } from './face-selection'
import { NameField } from './NameField'
import { currentTolerancePreset, TOLERANCE_PRESETS } from './tolerance-presets'
import { ReferencePanel } from './ReferencePanel'
import { useOpenShape } from './useOpenShape'
import { PieceInspector, PieceOperationNote, SplitSection } from './SplitSection'
import { ToolField } from './ToolField'
import { RoughingGroup, RoughingInspector, roughingOwnerOf } from './RoughingGroup'
import {
  pocketRoughing,
  profileRoughing,
  roughingOperationOf,
  takesRoughing,
} from './roughing-view'
import {
  defaultUnit,
  pendingApply,
  quantityOf,
  shapeArgs,
  quantityAt,
  updateArgs,
  type DesignPart,
  dfmNames,
} from './model'
import { newItemArgs } from './shape-model'
import type { ShapeActions } from './ShapePicker'
import { useSvgImport } from './ShapeList'
import { adjustedNote } from './RoundField'
import { isOpenNamed, shapeChoiceArgs } from './operation-shape'
import type { ShapeDTO } from '../../../../core/design/shape.dto'
import {
  OperationFields,
  placeErrors,
  refusalText,
  warningPath,
  type FieldError,
  type OperationFieldsContext,
} from './OperationFields'
import {
  useCommand,
  useDesignEvaluation,
  useDesignReferences,
  useDesignSelection,
  useDesignWarnings,
  type DesignWarnings,
} from './useDesign'
import { facingDepthSuggestion } from './facing-depth'

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
  /** v0.4 (U1): the fix of a finding on a feature or an owned operation ("Fix in Hole 1"). */
  fixIn?: FixIn,
): WarningView {
  // a finding names an operation, or a feature (F5: Clones notes carry the feature id)
  const names = dfmNames(part.dto)
  const split = w.code === SPLIT_CODE
  const source = dfmMessages.suggestionSource(w, part.units)
  const elsewhere = fixIn?.(w)
  if (elsewhere !== undefined || featureOfWarning(part, w) !== undefined) apply = undefined // an owned operation is fixed in its feature, never directly
  return {
    id: `${w.code}:${w.operation}:${w.parameter ?? ''}`,
    tier: pendingApply(w) ? 'soft' : dfmMessages.tier(w),
    ...(pendingApply(w) ? { pendingApply: applyMessages.warningPending } : {}),
    text: dfmMessages.text(w, part.units, names),
    // a split finding names the split, not an operation (design review U9: was "Unknown operation")
    subject: split ? designMessages.split.title : names.item(w.operation),
    ...(onSelect && w.operation !== 'stock' && !split
      ? { onSelect: () => onSelect(w.operation) }
      : {}),
    ...(apply && source !== undefined && w.suggestion
      ? {
          fix: {
            label: dfmMessages.useValue(w.suggestion.relation, source),
            onApply: () => apply(w, source),
          },
        }
      : elsewhere !== undefined
        ? { fix: elsewhere }
        : {}),
  }
}

/**
 * The Design inspector; value fields scale their adjust steps to the shown part's stock
 * (docs/conventions/inspector-layout.md#field-step-model-df104 rule 5).
 */
export function DesignInspector({ part }: { part: DesignPart | undefined }): React.JSX.Element {
  return (
    <StepScaleProvider scale={stockStepScale(part?.loaded?.stock)}>
      <DesignInspectorBody part={part} />
    </StepScaleProvider>
  )
}

function DesignInspectorBody({ part }: { part: DesignPart | undefined }): React.JSX.Element {
  const [selected] = useDesignSelection()
  const warnings = useDesignWarnings(part)
  const draft = useUi((s) => s.clonesDraft)
  const referencePanel = useUi((s) => s.referencePanel)
  const setDraft = useUi((s) => s.setClonesDraft)
  // the Make Clones… draft belongs to what was selected when it opened (ui.md § Clones)
  const stale = draft !== null && (draft.openedFor !== selected || draft.partId !== part?.dto.id)
  useEffect(() => {
    if (stale) setDraft(null)
  }, [stale, setDraft])
  if (referencePanel) return <ReferencePanel part={part} />
  if (part === undefined)
    return (
      <>
        <PanelHeader title={t.part} />
        <p className={styles['note']}>{t.noPart}</p>
      </>
    )
  if (draft !== null && !stale) return <ClonesDraft part={part} draft={draft} />
  const feature = part.dto.features?.find((f) => f.id === selected)
  if (feature?.kind === 'hole')
    return <HoleInspector key={feature.id} part={part} feature={feature} warnings={warnings} />
  if (feature?.kind === 'clones')
    return <ClonesInspector key={feature.id} part={part} feature={feature} warnings={warnings} />
  if (feature?.kind === 'pattern')
    return <PatternInspector key={feature.id} part={part} feature={feature} warnings={warnings} />
  if (feature?.kind === 'engraving')
    return <EngravingInspector key={feature.id} part={part} feature={feature} warnings={warnings} />
  if (feature !== undefined)
    return <FeatureInspector key={feature.id} part={part} feature={feature} warnings={warnings} />
  const instance = parseInstanceId(part, selected)
  if (instance !== undefined)
    return (
      <CloneInstanceInspector
        key={selected}
        part={part}
        feature={instance.feature}
        n={instance.n}
      />
    )
  // a selected face (DF22): Add puts operations on it
  const face = selectedFace(part, selected)
  if (face !== undefined) return <FaceInspector key={face.id} part={part} face={face} />
  const op = part.dto.operations.find((o) => o.id === selected)
  // a split piece is read-only: its source is edited (split parts 4a)
  if (part.dto.derivedFrom !== undefined)
    return op === undefined ? (
      <PieceInspector
        part={part}
        warnings={warnings}
        warningItems={(w) => warningView(w, part, undefined)}
        labels={warningLabels}
      />
    ) : (
      <PieceOperationNote key={op.id} part={part} operationId={op.id} />
    )
  if (op === undefined) return <PartInspector part={part} warnings={warnings} />
  // DF122: a roughing pocket's short inspector (its own or a pattern's; roughing.md § UI)
  const rough = roughingOwnerOf(part, op)
  if (rough !== undefined)
    return (
      <RoughingInspector
        key={op.id}
        part={part}
        op={op}
        owner={rough.owner}
        margins={rough.margins}
        warnings={warnings}
      />
    )
  const owner = ownerFeature(part.dto, op)
  return owner !== undefined ? (
    <OwnedOperationInspector key={op.id} part={part} op={op} feature={owner} warnings={warnings} />
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
  const fixIn = useFixIn(part)
  return (
    <div className={styles['inspector']}>
      <PanelHeader
        title={t.part}
        meta={
          <span
            title={m.navigator.countTip(operationUnits(part).length, part.dto.operations.length)}
          >
            {t.partSummary(part.dto.operations.length)}
          </span>
        }
      />
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
          stepKind="tolerance"
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
        {/* DF97: common general tolerances, one command each (one undo step) */}
        <div className={styles['setupButtons']}>
          <Menu
            label={t.tolerancePresets}
            items={[
              ...TOLERANCE_PRESETS[part.units].map((p) => ({
                label: t.tolerancePreset(p.source, part.units),
                description: t.toleranceUse[p.use],
                checked: currentTolerancePreset(part.units, tolerance)?.source === p.source,
                onSelect: () => void updatePart({ generalTolerance: { length: p.source } }),
              })),
              'separator' as const,
              {
                label: t.generalToleranceNone,
                checked: tolerance === undefined,
                onSelect: () => void updatePart({ generalTolerance: { length: null } }),
              },
            ]}
          >
            <Button size="sm" icon={<Icon name="chevron-down" />}>
              {t.tolerancePresets}
            </Button>
          </Menu>
        </div>
        {error ? <ErrorMessage error={error} /> : null}
        <EvaluationLine status={evaluation?.status} />
        {/* how operations get onto a face (DF22) */}
        <p className={styles['muted']}>{m.face.emptyHint}</p>
        <SplitSection part={part} warnings={warnings.warnings} />
        <InspectorGroup title={dfmMessages.listTitle}>
          <WarningList
            labels={warningLabels}
            items={warnings.warnings.map((w) => warningView(w, part, apply, select, fixIn))}
            empty={dfmMessages.none}
            {...(warnings.evaluation === 'pending' ? { note: dfmMessages.checksPending } : {})}
          />
        </InspectorGroup>
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
  // owned operations are changed through their feature (design.featureOwned)
  if (op === undefined || op.featureId !== undefined || w.parameter === undefined) return
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
  const openShapeIn = useOpenShape()
  // DF117: refused field texts survive selecting another operation (ui.md "Not applied")
  const draftKey = `${part.dto.id}:${op.id}`
  const saved = useUi((s) => s.fieldDrafts[draftKey])
  const [errors, setErrors] = useState<readonly FieldError[]>(() => saved?.errors ?? [])
  const [summary, setSummary] = useState<AppErrorData | undefined>(undefined)
  /** Keeps (`text`) or drops (undefined) the refused text at `path`, with the errors now shown. */
  const keepDraft = (
    path: string | undefined,
    text: string | undefined,
    shown: readonly FieldError[],
  ) => {
    const now = ui.getState().fieldDrafts[draftKey]
    const values = { ...now?.values }
    if (path !== undefined && text === undefined) delete values[path]
    else if (path !== undefined && text !== undefined) values[path] = text
    ui.getState().setFieldDrafts(
      draftKey,
      Object.keys(values).length === 0 ? null : { values, errors: shown },
    )
  }
  // a kept text the stored value has caught up with (undo, an agent edit) is no longer a draft
  const drafts = Object.fromEntries(
    Object.entries(saved?.values ?? {}).filter(
      ([path, text]) => quantityAt(op, path)?.source !== text,
    ),
  )
  const opWarnings = warnings.warnings.filter((w) => w.operation === op.id)
  // a facing's depth down to the reference model (DF4), offered as the Depth field's recommended value
  const references = useDesignReferences(part)
  const facingDepth =
    op.kind === 'facing' ? facingDepthSuggestion(part, references, op.on) : undefined
  const facingReference =
    facingDepth === undefined ? undefined : part.doc.references[facingDepth.referenceId]?.name

  const send = async (
    args: Record<string, unknown>,
    path: string | undefined,
    gesture?: string,
    draft?: string,
  ) => {
    const r = await call(
      `design.${op.kind}.update`,
      { partId: part.dto.id, operationId: op.id, ...args },
      gesture === undefined ? undefined : { gesture },
    )
    const placed = r.ok ? undefined : placeErrors(r.error, path)
    setErrors(placed?.errors ?? [])
    setSummary(placed?.summary)
    // DF120: a radius too large for the rectangle applied as Round; say so, with Undo
    const note = adjustedNote(r)
    if (note !== undefined) ui.getState().setRemovedToast(note, { edit: true })
    // DF117: a typed value the command refused stays as "not applied"; an accepted one ends it
    if (path !== undefined && draft !== undefined && gesture === undefined)
      keepDraft(path, r.ok ? undefined : draft, placed?.errors ?? [])
    else if (saved !== undefined) keepDraft(undefined, undefined, placed?.errors ?? [])
  }
  // the Shape Editor window on the shape (DF94)
  const openShape = (shapeId: string) => openShapeIn(part.dto.id, shapeId)
  const failed = (r: { ok: boolean; error?: AppErrorData }) => {
    if (r.ok || r.error === undefined) return false
    const placed = placeErrors(r.error, 'shape')
    setErrors(placed.errors)
    setSummary(placed.summary)
    return true
  }
  // the picker's "Import SVG…" (DF49): the first imported shape is used here, in the import's
  // gesture (one undo step); a profile cutting Outside or Inside switches to On for an open path
  const svg = useSvgImport(part, {
    onImported: async (shapeIds, gesture) => {
      const shapeId = shapeIds[0]
      if (shapeId === undefined || (op.kind !== 'pocket' && op.kind !== 'profile')) return undefined
      const got = await bridge.call('design.shape.get', { partId: part.dto.id, shapeId })
      const shape = got.ok ? (got.value as { shape: ShapeDTO }).shape : undefined
      const name = shape?.name ?? shapeId
      const on = op.kind === 'profile' && op.side !== 'on' && isOpenNamed(shape)
      const r = await call(
        `design.${op.kind}.update`,
        {
          partId: part.dto.id,
          operationId: op.id,
          shape: shapeChoiceArgs(op.shape, `named:${shapeId}`, undefined, part.units),
          ...(on ? { side: 'on' } : {}),
        },
        { gesture },
      )
      if (failed(r)) return t.picker.importNotUsed(op.name, name)
      setErrors([])
      setSummary(undefined)
      const used = t.picker.importUsed(op.name, name)
      return on ? `${used} ${t.picker.sideSetOn}` : used
    },
  })
  // the shape picker's actions (task U2, ui.md#shape-in-the-operation-inspector)
  const shapeActions: ShapeActions | undefined =
    op.kind === 'pocket' || op.kind === 'profile'
      ? {
          newShape: () =>
            void (async () => {
              // two commands, one compound gesture, one undo step (U4): the shape, then its use here
              const gesture = { gesture: newGestureId() }
              const added = await call(
                'design.shape.add',
                { partId: part.dto.id, items: [newItemArgs('rectangle', part.units)] },
                gesture,
              )
              if (failed(added) || !added.ok) return
              const shapeId = (added.value as { shapeId: string }).shapeId
              const center = shapeArgs(op.shape)['center']
              const used = await call(
                `design.${op.kind}.update`,
                {
                  partId: part.dto.id,
                  operationId: op.id,
                  shape: { kind: 'named', shapeId, center },
                },
                gesture,
              )
              failed(used)
              openShape(shapeId)
            })(),
          importSvg: svg.start,
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
              ui.getState().setRemovedToast(
                got.ok
                  ? t.picker.converted((got.value as { shape: { name: string } }).shape.name)
                  : t.picker.convertedUnnamed,
              )
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
          // X2-2: re-anchor to min/min (no move), then the position; one gesture, one undo step
          placeAsDrawn: (center) =>
            void (async () => {
              const gesture = { gesture: newGestureId() }
              const args = { partId: part.dto.id, operationId: op.id }
              const a = op.shape.anchor
              if (a?.u !== 'min' || a.v !== 'min') {
                const r = await call(
                  `design.${op.kind}.update`,
                  { ...args, anchor: { u: 'min', v: 'min' } },
                  gesture,
                )
                if (failed(r)) return
              }
              const at = center.map((c) => `${c} mm`)
              const r = await call(
                `design.${op.kind}.update`,
                { ...args, shape: { ...shapeArgs(op.shape), center: at } },
                gesture,
              )
              if (failed(r)) return
              setErrors([])
              setSummary(undefined)
            })(),
          pickOnLine: (shape) =>
            void (async () => {
              const r = await call(`design.${op.kind}.update`, {
                partId: part.dto.id,
                operationId: op.id,
                shape,
                side: 'on',
              })
              if (failed(r)) return
              setErrors([])
              setSummary(undefined)
              ui.getState().setRemovedToast(t.picker.sideSetOn)
            })(),
        }
      : undefined
  const ctx: OperationFieldsContext = {
    part,
    op,
    units: part.units,
    warnings: opWarnings,
    construction: warnings.construction,
    errors,
    readOnly: false,
    pickable: true,
    send: (args, path, gesture, draft) => void send(args, path, gesture, draft),
    drafts,
    revertDraft: (path) => {
      keepDraft(path, undefined, [])
      setErrors([])
      setSummary(undefined)
    },
    cancelGesture,
    shapeActions,
    ...(facingDepth !== undefined
      ? {
          recommended: {
            depth: {
              source: facingDepth.source,
              text: t.facingToReference(facingDepth.source, facingReference ?? t.referenceModel),
            },
          },
        }
      : {}),
  }
  const unplaced = opWarnings.filter((w) => warningPath(w, op) === undefined)

  return (
    <div className={styles['inspector']}>
      <PanelHeader title={op.name} itemId={op.id} />
      <div className={styles['fields']}>
        {summary ? <ErrorMessage error={summary} message={refusalText(summary, part.dto)} /> : null}
        <NameField label={t.name} name={op.name} onCommit={(name) => void send({ name }, 'name')} />
        <OperationFields
          ctx={ctx}
          tool={<ToolField part={part} op={op} warnings={opWarnings} />}
          roughing={
            takesRoughing(op) ? (
              <RoughingGroup
                part={part}
                owner={op}
                margins={op.kind === 'pocket' ? pocketRoughing(op) : profileRoughing(op)}
                roughingOp={roughingOperationOf(part, op)}
                warnings={warnings.warnings}
                messagesAt={(path) =>
                  errors
                    .filter((e) => e.path === path)
                    .map((e, i): FieldMessage => ({
                      id: `error-${i}`,
                      severity: 'error',
                      text: e.text,
                    }))
                }
                send={(roughing, path, gesture) => void send({ roughing }, path, gesture)}
                rememberKey={op.kind}
                info={designMessages.roughing.groupInfo}
              />
            ) : undefined
          }
        />
        {unplaced.length > 0 ? (
          <WarningList
            labels={warningLabels}
            items={unplaced.map((w) => warningView(w, part, undefined))}
          />
        ) : null}
      </div>
      {svg.dialog}
    </div>
  )
}
