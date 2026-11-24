// Plan inspector (task 3.7): without a selection the plan (name, status, machine, all checks with a
// link to their operation); a selected setup: SetupInspector.tsx (v0.2 F6); a selected plan operation: the tool picker (library tools that pass
// the checks, ranked, with their reasons: `plan.tool.suggest`), stickout and cutting preset, and
// "Part (plan copy)" (PlanCopyGroup.tsx, plan-only edits, v0.2), the strategy group
// (StrategyGroup.tsx, v0.2), the feeds-and-speeds card: one QuantityInput per
// field showing the resolved value and where it came from (preset, calculator, strategy default,
// or the user's override); the lock pins a value as an override, unlocking returns to the
// recommendation; "Show calculation" (FeedsCalculation.tsx). Commits are one command each; checks
// show at their field, the rest under the fields. Read-only (desaturated, with the reason) in
// finalized, in-use and archived plans. Doc: docs/conventions/ui.md#plan-mode-task-37,
// docs/modes/plan-v0.1.md#tool-assignment-and-checks, #feeds-and-speeds
import { useEffect, useState } from 'react'
import type { PlanWarning } from '../../../../core/plan/checks'
import type { FeedField, PlanDTO, PlanOperationDTO } from '../../../../core/plan/plan.dto'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import type { Quantity } from '../../../../core/quantity/quantity'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { applyMessages } from '../../messages/apply'
import { findingText, planMessages, sentence } from '../../messages/plan'
import { useReplica, useShell } from '../../shell/ShellContext'
import {
  ErrorMessage,
  Field,
  FieldIcon,
  FieldInput,
  PanelHeader,
  QuantityInput,
  useApplyOnEnter,
  Select,
  StatusChip,
  WarningList,
  type FieldIconName,
  type FieldMessage,
  type WarningListLabels,
  type WarningTier,
  type WarningView,
} from '../../ui'
import { defaultUnit, quantityOf } from '../design/model'
import {
  allPlanOperations,
  defaultPresetName,
  editable,
  feedFields,
  feedQuantity,
  feedUnit,
  FEED_KIND,
  lengthText,
  findingNames,
  planOperationName,
  snapshotName,
  type PlanOperationView,
} from './model'
import { FeedsCalculation } from './FeedsCalculation'
import { fieldMessages } from './fieldMessages'
import { LibraryLink } from '../../library/LibraryLink'
import { NewToolDialog } from '../../library/NewToolDialog'
import { PlanCopyGroup } from './PlanCopyGroup'
import { SetupInspector } from './SetupInspector'
import { useCancelGesture } from '../../shell/hooks'
import { usePlanCommand, usePlanData } from './plan-store'
import styles from './Plan.module.css'
import { shownStrategyFields, StrategyGroup } from './StrategyGroup'
import { findingsOf, useChosenPlan, usePlanSelection } from './usePlan'

const m = planMessages
const t = m.inspector

export const planWarningLabels: WarningListLabels = {
  list: m.warnings.title,
  dismiss: 'Dismiss',
  dismissed: (n: number) => `${n} dismissed`,
  show: 'Show',
  hide: 'Hide',
  tier: m.warnings.severity,
}

const TIER: Record<PlanWarning['severity'], WarningTier> = {
  error: 'error',
  warning: 'hard',
  info: 'soft',
}

/** View of one plan finding for the warning lists. */
export function planWarningView(
  w: PlanWarning,
  plan: PlanDTO,
  onSelect?: (planOperationId: string) => void,
  index = 0,
  units: UnitSystem = 'mm',
): WarningView {
  const op = allPlanOperations(plan).find((o) => o.id === w.planOperationId)
  return {
    id: `${w.code}:${w.planOperationId ?? ''}:${w.field ?? ''}:${w.rule}:${index}`,
    tier: TIER[w.severity],
    text: findingText(w, units, findingNames(plan)),
    ...(op === undefined ? {} : { subject: planOperationName(plan, op.designOperationIds) }),
    ...(op !== undefined && onSelect ? { onSelect: () => onSelect(op.id) } : {}),
  }
}

export function PlanInspector({ doc }: { doc: ProjectDoc }): React.JSX.Element {
  const [plan] = useChosenPlan(doc)
  const [selected] = usePlanSelection()
  const data = usePlanData(plan?.id)
  if (plan === undefined)
    return (
      <>
        <PanelHeader title={t.plan} />
        <p className={styles['note']}>{t.noPlan}</p>
      </>
    )
  const op = allPlanOperations(plan).find((o) => o.id === selected)
  const view = data?.operations?.find((o) => o.id === selected)
  // a setup selected in the setup panel (task F6)
  const setup = plan.setups.find((s) => s.id === selected)
  if (setup !== undefined)
    return (
      <SetupInspector
        key={setup.id}
        doc={doc}
        plan={plan}
        setup={setup}
        warnings={data?.warnings ?? []}
        toolpaths={data?.toolpaths ?? {}}
      />
    )
  return op === undefined ? (
    <PlanSummary
      plan={plan}
      units={doc.unitSystem}
      warnings={data?.warnings ?? []}
      error={data?.error}
      outdated={data?.pendingApply === true}
    />
  ) : (
    <OperationInspector
      key={op.id}
      plan={plan}
      doc={doc}
      op={op}
      view={view}
      units={doc.unitSystem}
      findings={findingsOf(data?.warnings ?? [], op.id)}
      designToolChanged={
        data?.stale?.operations.some(
          (s) => s.designToolChanged === true && op.designOperationIds.includes(s.operationId),
        ) ?? false
      }
    />
  )
}

// ── plan ──────────────────────────────────────────────────────────────────────────────────

function PlanSummary({
  plan,
  units,
  warnings,
  error,
  outdated,
}: {
  plan: PlanDTO
  units: UnitSystem
  warnings: readonly PlanWarning[]
  error: AppErrorData | undefined
  /** The plan's inputs wait for Apply: its checks are outdated (P3). */
  outdated: boolean
}): React.JSX.Element {
  const call = usePlanCommand()
  const [, select] = usePlanSelection()
  const [failed, setFailed] = useState<AppErrorData | undefined>(undefined)
  const ops = allPlanOperations(plan)
  const machine = snapshotName(plan, plan.machine)
  return (
    <div className={styles['inspector']}>
      <PanelHeader
        title={t.plan}
        meta={
          <span title={t.summaryTip(ops.length, plan.design.part.operations.length)}>
            {t.summary(ops.length)}
          </span>
        }
      />
      <div className={styles['fields']}>
        <NameField
          label={t.name}
          name={plan.name}
          readOnly={!editable(plan)}
          onCommit={(name) =>
            void call('plan.update', { planId: plan.id, name }).then((r) =>
              setFailed(r.ok ? undefined : r.error),
            )
          }
        />
        {failed ? <ErrorMessage error={failed} message={t.commandFailed} /> : null}
        {error ? <ErrorMessage error={error} /> : null}
        <p className={styles['muted']}>
          <StatusChip tone={plan.status === 'draft' ? 'neutral' : 'success'}>
            {m.statuses[plan.status]}
          </StatusChip>{' '}
          {machine === undefined ? m.machine.missing : `${m.machine.title}: ${machine}`}
        </p>
        <p className={styles['muted']}>{t.noSelection}</p>
        <section aria-label={m.warnings.title} className={styles['warnings']}>
          <h3 className={styles['groupTitle']}>{m.warnings.title}</h3>
          <WarningList
            labels={planWarningLabels}
            items={warnings.map((w, i) => planWarningView(w, plan, select, i, units))}
            empty={m.warnings.none}
            outdated={outdated ? applyMessages.checksOutdated : undefined}
          />
        </section>
      </div>
    </div>
  )
}

/** A text field committing on Enter or blur (Escape reverts). */
export function NameField({
  label,
  name,
  readOnly,
  onCommit,
}: {
  label: string
  name: string
  readOnly: boolean
  onCommit: (name: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(name)
  const [seen, setSeen] = useState(name)
  if (name !== seen) {
    setSeen(name)
    setDraft(name)
  }
  const applyOnEnter = useApplyOnEnter()
  const commit = () => {
    const v = draft.trim()
    if (v.length > 0 && v !== name) onCommit(v)
    else setDraft(name)
  }
  return (
    <Field label={label} readOnly={readOnly}>
      <FieldInput
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // commit and apply (apply.md#field-rule)
            e.preventDefault()
            commit()
            applyOnEnter?.()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(name)
          }
        }}
      />
    </Field>
  )
}

// ── plan operation ────────────────────────────────────────────────────────────────────────

interface Suggestion {
  readonly toolLibraryItemId: string
  readonly name: string
  readonly diameter: number
  readonly reasons: readonly string[]
}

/** `plan.tool.suggest` for the operation, re-read on every revision. */
function useSuggestions(planId: string, planOperationId: string): Suggestion[] | undefined {
  const { bridge } = useShell()
  const replica = useReplica()
  const revision = replica.status === 'open' ? replica.revision : -1
  const [tools, setTools] = useState<Suggestion[] | undefined>(undefined)
  useEffect(() => {
    let live = true
    void bridge.call('plan.tool.suggest', { planId, planOperationId }).then((r) => {
      if (live) setTools(r.ok ? (r.value as { tools: Suggestion[] }).tools : [])
    })
    return () => {
      live = false
    }
  }, [bridge, planId, planOperationId, revision])
  return tools
}

const FEED_ICON: Record<FeedField, FieldIconName> = {
  spindleSpeed: 'spindle',
  feedRate: 'feed',
  plungeRate: 'plunge',
  stepdown: 'stepdown',
  stepover: 'stepover',
}

const DEFAULT_PRESET = '__default'
const AUTO = '__auto'
const SHOWN_FIELDS = new Set<string>(['tool', 'stickout', 'presetName'])

function OperationInspector({
  doc,
  plan,
  op,
  view,
  units,
  findings,
  designToolChanged = false,
}: {
  doc: ProjectDoc
  plan: PlanDTO
  op: PlanOperationDTO
  view: PlanOperationView | undefined
  units: UnitSystem
  findings: readonly PlanWarning[]
  /** The design's tool field differs from the plan's (`plan.stale.list`, E4). */
  designToolChanged?: boolean
}): React.JSX.Element {
  const call = usePlanCommand()
  const cancelGesture = useCancelGesture()
  const [failed, setFailed] = useState<AppErrorData | undefined>(undefined)
  const suggestions = useSuggestions(plan.id, op.id)
  const readOnly = !editable(plan)
  const name = planOperationName(plan, op.designOperationIds)
  const kind = view?.kind
  const fields = kind === undefined ? [] : feedFields(kind)

  const send = async (cmd: string, args: object, gesture?: string) => {
    const r = await call(
      cmd,
      { planId: plan.id, planOperationId: op.id, ...args },
      gesture === undefined ? undefined : { gesture },
    )
    setFailed(r.ok ? undefined : r.error)
  }
  /** `gesture` for a live adjust-panel step (one undo step per panel session). */
  const update = (args: object, gesture?: string) =>
    void send('plan.operation.update', args, gesture)

  // tool picker: the ranked suggestions, plus the current tool when it is not among them
  const current = view?.tool ?? null
  const toolOptions = (suggestions ?? []).map((s) => ({
    value: s.toolLibraryItemId,
    label: t.suggestion(s.name, lengthText(s.diameter, units)),
  }))
  if (current !== null && !toolOptions.some((o) => o.value === current.libraryItemId))
    toolOptions.push({ value: current.libraryItemId, label: t.otherTool(current.name) })
  const chosen = suggestions?.find((s) => s.toolLibraryItemId === current?.libraryItemId)
  const toolMessages: FieldMessage[] = [
    ...fieldMessages(findings, 'tool', units, findingNames(plan)),
    ...(suggestions !== undefined && suggestions.length === 0
      ? [{ id: 'noSuggestion', severity: 'info' as const, text: t.noSuggestion }]
      : []),
    ...(designToolChanged
      ? [
          {
            id: 'designToolChanged',
            severity: 'info' as const,
            text: t.designToolChanged(op.toolSource),
          },
        ]
      : []),
    // where the tool came from (E4's `toolSource`, shown since F5)
    ...(op.toolSource !== undefined && t.toolSource[op.toolSource] !== undefined
      ? [{ id: 'toolSource', severity: 'note' as const, text: t.toolSource[op.toolSource]! }]
      : []),
  ]

  // presets of the tool copy
  const toolCopy = plan.snapshots.find((s) => s.id === op.tool)
  const presets =
    (toolCopy?.values as { presets?: { name: string; recommended?: boolean }[] } | undefined)
      ?.presets ?? []
  const defaultPreset = defaultPresetName(plan, op.tool)
  const autoUnavailable =
    view !== undefined && typeof view.auto === 'object' ? view.auto.unavailable : undefined
  const presetMessages: FieldMessage[] = [
    ...fieldMessages(findings, 'presetName'),
    ...(autoUnavailable !== undefined
      ? [
          {
            id: 'autoUnavailable',
            severity: 'note' as const,
            text: t.autoUnavailable(autoUnavailable),
          },
        ]
      : []),
  ]

  const lengthUnit = defaultUnit('length', units)
  const stickoutValue: Quantity | undefined =
    op.stickout !== undefined
      ? quantityOf(op.stickout)
      : view?.stickout != null
        ? feedQuantity('stepdown', view.stickout, units)
        : undefined

  const strategyFields =
    current !== null && view !== undefined ? shownStrategyFields(plan, view) : new Set<string>()
  const rest = findings.filter(
    (w) =>
      w.field === undefined ||
      (!SHOWN_FIELDS.has(w.field) &&
        !strategyFields.has(w.field) &&
        !fields.includes(w.field as FeedField)),
  )

  return (
    <div className={styles['inspector']}>
      {/* the design operations' ids (as the design inspector shows them), not the internal plan id */}
      <PanelHeader title={name} itemId={op.designOperationIds.join(', ')} />
      <div className={styles['fields']}>
        {readOnly ? <p className={styles['muted']}>{m.readOnly(plan.status)}</p> : null}
        {failed ? <ErrorMessage error={failed} message={t.commandFailed} /> : null}

        <section className={styles['group']} aria-label={t.groups.tool}>
          <h3 className={styles['groupTitle']}>{t.groups.tool}</h3>
          <Field label={t.tool} messages={toolMessages} readOnly={readOnly}>
            <Select
              placeholder={t.toolPlaceholder}
              options={toolOptions}
              {...(current === null ? {} : { value: current.libraryItemId })}
              disabled={readOnly || toolOptions.length === 0}
              onValueChange={(id) => {
                if (id !== current?.libraryItemId)
                  void send('plan.tool.assign', { toolLibraryItemId: id })
              }}
            />
          </Field>
          <div className={styles['libraryActions']}>
            {current !== null ? (
              <LibraryLink target={{ kind: 'tool', itemId: current.libraryItemId }} />
            ) : null}
            {!readOnly ? (
              <NewToolDialog
                units={units}
                operationKind={kind}
                onAdded={async (id) => {
                  const r = await call('plan.tool.assign', {
                    planId: plan.id,
                    planOperationId: op.id,
                    toolLibraryItemId: id,
                  })
                  return r.ok ? undefined : r.error
                }}
              />
            ) : null}
          </div>
          {chosen !== undefined && chosen.reasons.length > 0 ? (
            <ul className={styles['reasons']} aria-label={t.reasons}>
              {chosen.reasons.map((r) => (
                <li key={r}>{sentence(r)}</li>
              ))}
            </ul>
          ) : null}
          {current !== null ? (
            <QuantityInput
              label={t.stickout}
              kind="length"
              defaultUnit={lengthUnit}
              value={stickoutValue}
              illustration={<FieldIcon name="stickout" />}
              readOnly={readOnly}
              messages={[
                ...fieldMessages(findings, 'stickout'),
                ...(op.stickout !== undefined
                  ? [
                      {
                        id: 'stickout.entered',
                        severity: 'note' as const,
                        text: t.source('override', null),
                        ...(readOnly
                          ? {}
                          : {
                              fix: {
                                label: t.useToolDefault,
                                onApply: () => update({ stickout: null }),
                              },
                            }),
                      },
                    ]
                  : []),
              ]}
              onCommit={(q, gesture) => update({ stickout: q.source }, gesture)}
              onCancelGesture={cancelGesture}
            />
          ) : null}
          {current !== null ? (
            <Field label={t.preset} messages={presetMessages} readOnly={readOnly}>
              <Select
                options={[
                  {
                    value: DEFAULT_PRESET,
                    label: t.presetDefault(defaultPreset, autoUnavailable === undefined),
                  },
                  { value: AUTO, label: t.presetAuto, disabled: autoUnavailable !== undefined },
                  ...presets.map((p) => ({
                    value: p.name,
                    label: p.name,
                    // library.md#recommended-presets
                    ...(p.recommended === true ? { description: t.presetFollows } : {}),
                  })),
                ]}
                value={op.auto === true ? AUTO : (op.presetName ?? DEFAULT_PRESET)}
                disabled={readOnly}
                onValueChange={(v) =>
                  update(
                    v === AUTO
                      ? { auto: true }
                      : v === DEFAULT_PRESET
                        ? { presetName: null, auto: false }
                        : { presetName: v },
                  )
                }
              />
            </Field>
          ) : null}
        </section>

        <PlanCopyGroup doc={doc} plan={plan} op={op} />

        {current !== null && view !== undefined ? (
          <StrategyGroup
            plan={plan}
            op={op}
            view={view}
            units={units}
            readOnly={readOnly}
            findings={findings}
            onUpdate={update}
            onCancelGesture={cancelGesture}
          />
        ) : null}

        {current !== null && view !== undefined ? (
          <section className={styles['group']} aria-label={t.groups.feeds}>
            <h3 className={styles['groupTitle']}>{t.groups.feeds}</h3>
            {fields.map((f) => (
              <FeedField
                key={f}
                field={f}
                op={op}
                view={view}
                units={units}
                readOnly={readOnly}
                findings={findings}
                onSet={(source, gesture) => update({ overrides: { [f]: source } }, gesture)}
                onCancelGesture={cancelGesture}
                onLock={(locked) => update({ locks: { [f]: locked } })}
              />
            ))}
            {view.chipLoad !== null ? (
              <p className={styles['muted']}>{t.chipLoad(lengthText(view.chipLoad, units))}</p>
            ) : null}
            <FeedsCalculation
              planId={plan.id}
              planOperationId={op.id}
              fields={fields}
              presetName={view.presetName}
            />
          </section>
        ) : null}

        {rest.length > 0 ? (
          <WarningList
            labels={planWarningLabels}
            items={rest.map((w, i) => planWarningView(w, plan, undefined, i, units))}
          />
        ) : null}
      </div>
    </div>
  )
}

/**
 * One feeds-and-speeds field: the resolved value and where it comes from. In auto mode a field
 * is Recommended, Entered (with "Use <recommendation>") or Locked; the lock is shown only where
 * the list offers one (docs/modes/plan-v0.1.md#locks-and-auto-mode). Typing never locks.
 */
function FeedField({
  field,
  op,
  view,
  units,
  readOnly,
  findings,
  onSet,
  onLock,
  onCancelGesture,
}: {
  field: FeedField
  op: PlanOperationDTO
  view: PlanOperationView
  units: UnitSystem
  readOnly: boolean
  findings: readonly PlanWarning[]
  onSet: (source: string | null, gesture?: string) => void
  onLock: (locked: boolean) => void
  onCancelGesture: (gesture: string) => Promise<boolean>
}): React.JSX.Element {
  const override = op.overrides[field]
  const resolved = view.feeds[field]
  const value =
    override !== undefined
      ? quantityOf(override)
      : resolved !== null
        ? feedQuantity(field, resolved.value, units)
        : undefined
  const source = override !== undefined ? 'override' : resolved?.source
  const locked = resolved?.locked ?? false
  const recommended =
    resolved?.recommended != null
      ? feedQuantity(field, resolved.recommended.value, units)?.source
      : undefined
  const sourceMessage = (): FieldMessage => {
    if (source === undefined) return { id: 'source', severity: 'note', text: t.unresolved }
    if (locked) return { id: 'source', severity: 'note', text: t.locked }
    if (source !== 'override')
      return { id: 'source', severity: 'note', text: t.source(source, view.presetName) }
    // entered: back to the recommendation (auto mode) or to the preset/strategy value
    const clear = () => onSet(null)
    return recommended !== undefined
      ? {
          id: 'source',
          severity: 'note',
          text: t.entered(recommended),
          ...(readOnly ? {} : { fix: { label: t.useRecommended(recommended), onApply: clear } }),
        }
      : {
          id: 'source',
          severity: 'note',
          text: t.source('override', view.presetName),
          ...(readOnly ? {} : { fix: { label: t.reset, onApply: clear } }),
        }
  }
  const fromFindings: FieldMessage[] = fieldMessages(findings, field, units).map((m) =>
    m.id.startsWith('feeds.lockInactive:') && !readOnly
      ? { ...m, fix: { label: t.unlock, onApply: () => onLock(false) } }
      : m,
  )
  const note = sourceMessage()
  // Only the top message shows its fix: a warning about the entered value (chip load, power)
  // carries the way back ("Use …", "Reset") when it has no fix of its own.
  const host = note.fix
    ? fromFindings.findIndex((m) => m.fix === undefined && m.severity !== 'error')
    : -1
  const messages: FieldMessage[] =
    host < 0
      ? [...fromFindings, note]
      : [
          ...fromFindings.map((m, i) => (i === host ? { ...m, fix: note.fix! } : m)),
          { id: note.id, severity: note.severity, text: note.text },
        ]
  const lock = resolved?.lock
  return (
    <QuantityInput
      label={t.feeds[field]}
      kind={FEED_KIND[field]}
      defaultUnit={feedUnit(field, units)}
      value={value}
      illustration={<FieldIcon name={FEED_ICON[field]} />}
      readOnly={readOnly}
      messages={messages}
      {...(lock !== undefined && lock.state !== 'hidden' && !readOnly
        ? {
            lock: {
              locked,
              onLockedChange: onLock,
              name: `Lock ${t.feeds[field]}`,
              // a pressed lock can always be released; only pressing it can be refused
              disabledReason: lock.state === 'unavailable' && !locked ? lock.reason : undefined,
            },
          }
        : {})}
      onCommit={(q, gesture) => onSet(q.source, gesture)}
      onCancelGesture={onCancelGesture}
    />
  )
}
