// Plan inspector (task 3.7): without a selection the plan (name, status, machine, all checks with a
// link to their operation); a selected plan operation: the tool picker (library tools that pass
// the checks, ranked, with their reasons: `plan.tool.suggest`), stickout and cutting preset, and
// the feeds-and-speeds card: one QuantityInput per field showing the resolved value and where it
// came from (preset, calculator, strategy default, or the user's override); the lock pins a value
// as an override, unlocking returns to the recommendation. Commits are one command each; checks
// show at their field, the rest under the fields. Read-only (desaturated, with the reason) in
// finalized, in-use and archived plans. Doc: docs/conventions/ui.md#plan-mode-task-37,
// docs/modes/plan-v0.1.md#tool-assignment-and-checks, #feeds-and-speeds
import { useEffect, useState } from 'react'
import type { PlanWarning } from '../../../../core/plan/checks'
import type { FeedField, PlanDTO, PlanOperationDTO } from '../../../../core/plan/plan.dto'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import type { Quantity } from '../../../../core/quantity/quantity'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { planMessages, sentence } from '../../messages/plan'
import { useReplica, useShell } from '../../shell/ShellContext'
import {
  ErrorMessage,
  Field,
  FieldIcon,
  FieldInput,
  PanelHeader,
  QuantityInput,
  Select,
  StatusChip,
  WarningList,
  type FieldIconName,
  type FieldMessage,
  type FieldSeverity,
  type WarningListLabels,
  type WarningTier,
  type WarningView,
} from '../../ui'
import { defaultUnit, quantityOf } from '../design/model'
import {
  editable,
  feedFields,
  feedQuantity,
  feedUnit,
  FEED_KIND,
  lengthText,
  planOperationName,
  snapshotName,
  type PlanOperationView,
} from './model'
import { usePlanCommand, usePlanData } from './plan-store'
import styles from './Plan.module.css'
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
const SEVERITY: Record<PlanWarning['severity'], FieldSeverity> = {
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
): WarningView {
  const op = plan.setups[0]?.operations.find((o) => o.id === w.planOperationId)
  return {
    id: `${w.code}:${w.planOperationId ?? ''}:${w.field ?? ''}:${w.rule}:${index}`,
    tier: TIER[w.severity],
    text: sentence(w.message),
    ...(op === undefined ? {} : { subject: planOperationName(plan, op.designOperationIds) }),
    ...(op !== undefined && onSelect ? { onSelect: () => onSelect(op.id) } : {}),
  }
}

const fieldMessages = (findings: readonly PlanWarning[], field: string): FieldMessage[] =>
  findings
    .filter((w) => w.field === field)
    .map((w, i) => ({
      id: `${w.code}:${w.rule}:${i}`,
      severity: SEVERITY[w.severity],
      text: sentence(w.message),
    }))

export function PlanInspector({ doc }: { doc: ProjectDoc }): React.JSX.Element {
  const [plan] = useChosenPlan(doc)
  const [selected] = usePlanSelection()
  const data = usePlanData(plan?.id)
  if (plan === undefined)
    return (
      <>
        <PanelHeader title={t.plan} />
        <p className={styles['note']}>{t.noSelection}</p>
      </>
    )
  const op = plan.setups[0]!.operations.find((o) => o.id === selected)
  const view = data?.operations?.find((o) => o.id === selected)
  return op === undefined ? (
    <PlanSummary plan={plan} warnings={data?.warnings ?? []} error={data?.error} />
  ) : (
    <OperationInspector
      key={op.id}
      plan={plan}
      op={op}
      view={view}
      units={doc.unitSystem}
      findings={findingsOf(data?.warnings ?? [], op.id)}
    />
  )
}

// ── plan ──────────────────────────────────────────────────────────────────────────────────

function PlanSummary({
  plan,
  warnings,
  error,
}: {
  plan: PlanDTO
  warnings: readonly PlanWarning[]
  error: AppErrorData | undefined
}): React.JSX.Element {
  const call = usePlanCommand()
  const [, select] = usePlanSelection()
  const [failed, setFailed] = useState<AppErrorData | undefined>(undefined)
  const ops = plan.setups[0]!.operations
  const machine = snapshotName(plan, plan.machine)
  return (
    <div className={styles['inspector']}>
      <PanelHeader title={t.plan} meta={t.summary(ops.length)} />
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
          {machine === undefined ? m.export.noMachine : `${m.machine.title}: ${machine}`}
        </p>
        <p className={styles['muted']}>{t.noSelection}</p>
        <section aria-label={m.warnings.title} className={styles['warnings']}>
          <h3 className={styles['groupTitle']}>{m.warnings.title}</h3>
          <WarningList
            labels={planWarningLabels}
            items={warnings.map((w, i) => planWarningView(w, plan, select, i))}
            empty={m.warnings.none}
          />
        </section>
      </div>
    </div>
  )
}

/** A text field committing on Enter or blur (Escape reverts). */
function NameField({
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
  spindleSpeed: 'corner',
  feedRate: 'length',
  plungeRate: 'depth',
  stepdown: 'depth',
  stepover: 'width',
}

const DEFAULT_PRESET = '__default'
const SHOWN_FIELDS = new Set<string>(['tool', 'stickout', 'presetName'])

function OperationInspector({
  plan,
  op,
  view,
  units,
  findings,
}: {
  plan: PlanDTO
  op: PlanOperationDTO
  view: PlanOperationView | undefined
  units: UnitSystem
  findings: readonly PlanWarning[]
}): React.JSX.Element {
  const call = usePlanCommand()
  const [failed, setFailed] = useState<AppErrorData | undefined>(undefined)
  const suggestions = useSuggestions(plan.id, op.id)
  const readOnly = !editable(plan)
  const name = planOperationName(plan, op.designOperationIds)
  const kind = view?.kind
  const fields = kind === undefined ? [] : feedFields(kind)

  const send = async (cmd: string, args: object) => {
    const r = await call(cmd, { planId: plan.id, planOperationId: op.id, ...args })
    setFailed(r.ok ? undefined : r.error)
  }
  const update = (args: object) => void send('plan.operation.update', args)

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
    ...fieldMessages(findings, 'tool'),
    ...(suggestions !== undefined && suggestions.length === 0
      ? [{ id: 'noSuggestion', severity: 'info' as const, text: t.noSuggestion }]
      : []),
  ]

  // presets of the tool copy
  const toolCopy = plan.snapshots.find((s) => s.id === op.tool)
  const presets = (
    (toolCopy?.values as { presets?: { name: string }[] } | undefined)?.presets ?? []
  ).map((p) => p.name)
  const defaultPreset = op.presetName === undefined ? (view?.presetName ?? null) : null

  const lengthUnit = defaultUnit('length', units)
  const stickoutValue: Quantity | undefined =
    op.stickout !== undefined
      ? quantityOf(op.stickout)
      : view?.stickout != null
        ? feedQuantity('stepdown', view.stickout, units)
        : undefined

  const rest = findings.filter(
    (w) =>
      w.field === undefined ||
      (!SHOWN_FIELDS.has(w.field) && !fields.includes(w.field as FeedField)),
  )

  return (
    <div className={styles['inspector']}>
      <PanelHeader title={name} meta={op.id} />
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
              illustration={<FieldIcon name="depth" />}
              readOnly={readOnly}
              messages={fieldMessages(findings, 'stickout')}
              lock={{
                locked: op.stickout !== undefined,
                onLockedChange: (locked) =>
                  update({ stickout: locked ? (stickoutValue?.source ?? null) : null }),
              }}
              onCommit={(q) => update({ stickout: q.source })}
            />
          ) : null}
          {current !== null ? (
            <Field
              label={t.preset}
              messages={fieldMessages(findings, 'presetName')}
              readOnly={readOnly}
            >
              <Select
                options={[
                  { value: DEFAULT_PRESET, label: t.presetDefault(defaultPreset) },
                  ...presets.map((p) => ({ value: p, label: p })),
                ]}
                value={op.presetName ?? DEFAULT_PRESET}
                disabled={readOnly}
                onValueChange={(v) => update({ presetName: v === DEFAULT_PRESET ? null : v })}
              />
            </Field>
          ) : null}
        </section>

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
                onSet={(source) => update({ overrides: { [f]: source } })}
              />
            ))}
            {view.chipLoad !== null ? (
              <p className={styles['muted']}>{t.chipLoad(lengthText(view.chipLoad, units))}</p>
            ) : null}
          </section>
        ) : null}

        {rest.length > 0 ? (
          <WarningList
            labels={planWarningLabels}
            items={rest.map((w, i) => planWarningView(w, plan, undefined, i))}
          />
        ) : null}
      </div>
    </div>
  )
}

/** One feeds-and-speeds field: the resolved value with its source; the lock pins an override. */
function FeedField({
  field,
  op,
  view,
  units,
  readOnly,
  findings,
  onSet,
}: {
  field: FeedField
  op: PlanOperationDTO
  view: PlanOperationView
  units: UnitSystem
  readOnly: boolean
  findings: readonly PlanWarning[]
  onSet: (source: string | null) => void
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
  const messages: FieldMessage[] = [
    ...fieldMessages(findings, field),
    source !== undefined
      ? { id: 'source', severity: 'note', text: t.source(source, view.presetName) }
      : { id: 'source', severity: 'note', text: t.unresolved },
  ]
  return (
    <QuantityInput
      label={t.feeds[field]}
      kind={FEED_KIND[field]}
      defaultUnit={feedUnit(field, units)}
      value={value}
      illustration={<FieldIcon name={FEED_ICON[field]} />}
      readOnly={readOnly}
      messages={messages}
      lock={{
        locked: override !== undefined,
        onLockedChange: (locked) => onSet(locked ? (value?.source ?? null) : null),
      }}
      onCommit={(q) => onSet(q.source)}
    />
  )
}
