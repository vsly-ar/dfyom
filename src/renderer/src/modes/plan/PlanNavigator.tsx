// Plan navigator (task 3.7; ui.md#app-shell: "Plan: plan picker, plan status, setup, plan
// operations in machining order"): create a plan of the part; pick, duplicate or remove plans
// (remove confirmed); the plan's status and its stale notices with rebuild / update from library;
// the machine; the setup's work zero and safe heights; the plan operations in machining order
// (select, move by buttons and Alt+↑/↓, tool, checks, toolpath state and stale badges); toolpath
// generation and the gCode export. Doc: docs/conventions/ui.md#plan-mode-task-37,
// docs/modes/plan-v0.1.md#commands-and-queries-v01
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Copy,
  Download,
  History,
  Lock,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Waypoints,
} from 'lucide-react'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import type { PlanDTO, PlanStatus } from '../../../../core/plan/plan.dto'
import type { ProjectDoc } from '../../../../core/project/document'
import type { AppErrorData, Issue } from '../../../../shared/errors/app-error'
import { planMessages, sentence } from '../../messages/plan'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorMessage,
  FieldIcon,
  IconButton,
  Menu,
  Progress,
  QuantityInput,
  Select,
  StatusChip,
  ToolIcon,
  type FieldMessage,
  type ToolIconName,
} from '../../ui'
import { defaultUnit, quantityOf } from '../design/model'
import { ExportDialog } from './ExportDialog'
import {
  allows,
  designStale,
  editable,
  isError,
  pickerPlans,
  planOperationKind,
  planOperationName,
  rowStale,
  snapshotName,
  statusChoices,
  toolpathState,
} from './model'
import {
  usePlanCommand,
  usePlanData,
  usePlanState,
  usePlanStore,
  type PlanData,
} from './plan-store'
import styles from './Plan.module.css'
import { findingsOf, useChosenPlan, useLibraryItems, usePlanSelection } from './usePlan'

const m = planMessages

export const KIND_ICON: Record<string, ToolIconName> = {
  facing: 'facing',
  pocket: 'pocket',
  drilling: 'drill',
  profile: 'profile',
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId()
  return (
    <section className={styles['section']} aria-labelledby={id}>
      <h3 id={id} className={styles['sectionTitle']}>
        {title}
      </h3>
      {children}
    </section>
  )
}

export function PlanNavigator({ doc }: { doc: ProjectDoc }): React.JSX.Element {
  const [plan, choose] = useChosenPlan(doc)
  const call = usePlanCommand()
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const machines = useLibraryItems('machine')
  const part = Object.values(doc.parts)[0]

  const create = async () => {
    if (part === undefined) return
    const machine = machines?.[0]
    const r = await call('plan.create', {
      partId: part.id,
      ...(machine === undefined ? {} : { machineLibraryItemId: machine.id }),
    })
    setError(r.ok ? undefined : r.error)
    if (r.ok) choose((r.value as { planId: string }).planId)
  }

  if (plan === undefined)
    return (
      <div className={styles['navigator']}>
        <div className={styles['emptyOps']}>
          <EmptyState
            icon={<Waypoints aria-hidden="true" />}
            title={m.empty.title}
            description={m.empty.description}
            action={{
              label: m.empty.action,
              icon: <Plus aria-hidden="true" />,
              onClick: () => void create(),
            }}
          />
          {error ? <ErrorMessage error={error} /> : null}
        </div>
      </div>
    )
  return <PlanView key={plan.id} doc={doc} plan={plan} choose={choose} onCreate={create} />
}

function PlanView({
  doc,
  plan,
  choose,
  onCreate,
}: {
  doc: ProjectDoc
  plan: PlanDTO
  choose: (planId: string) => void
  onCreate: () => Promise<void>
}): React.JSX.Element {
  const call = usePlanCommand()
  const data = usePlanData(plan.id)
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const [removeOpen, setRemoveOpen] = useState(false)
  const plans = pickerPlans(doc)
  const canEdit = editable(plan)

  const send = async (name: string, args: object) => {
    const r = await call(name, { planId: plan.id, ...args })
    setError(r.ok ? undefined : r.error)
    return r
  }

  return (
    <div className={styles['navigator']}>
      <Section title={m.picker.label}>
        <div className={styles['pickerRow']}>
          <Select
            aria-label={m.picker.label}
            options={plans.map((p) => ({
              value: p.id,
              label: p.status === 'archived' ? `${p.name} (${m.statuses.archived})` : p.name,
            }))}
            value={plan.id}
            onValueChange={choose}
          />
          <Menu
            label={m.picker.actions}
            items={[
              {
                label: m.picker.create,
                icon: <Plus aria-hidden="true" />,
                onSelect: () => void onCreate(),
              },
              {
                label: m.picker.duplicate,
                icon: <Copy aria-hidden="true" />,
                onSelect: () =>
                  void send('plan.duplicate', {}).then((r) => {
                    if (r.ok) choose((r.value as { planId: string }).planId)
                  }),
              },
              'separator',
              {
                label: m.picker.remove,
                icon: <Trash2 aria-hidden="true" />,
                danger: true,
                disabled: !allows(plan, 'plan.remove'),
                onSelect: () => setRemoveOpen(true),
              },
            ]}
          >
            <IconButton label={m.picker.actions} icon={<MoreHorizontal aria-hidden="true" />} />
          </Menu>
        </div>
        <div className={styles['pickerRow']}>
          <Select<PlanStatus | 'unarchive'>
            aria-label={m.statusLabel}
            options={[
              ...statusChoices(plan).map((s) => ({ value: s, label: m.statuses[s] })),
              ...(plan.status === 'archived'
                ? [{ value: 'unarchive' as const, label: m.unarchive }]
                : []),
            ]}
            value={plan.status}
            onValueChange={(s) => {
              if (s === plan.status) return
              void send('plan.status.set', s === 'unarchive' ? {} : { status: s })
            }}
          />
          <StatusChip tone={plan.status === 'draft' ? 'neutral' : 'success'}>
            {m.statuses[plan.status]}
          </StatusChip>
        </div>
        {!canEdit ? (
          <p className={styles['why']}>
            <Lock aria-hidden="true" width={12} height={12} /> {m.readOnly(plan.status)}
          </p>
        ) : null}
        {error ? <ErrorMessage error={error} message={m.inspector.commandFailed} /> : null}
        <StaleNotices plan={plan} data={data} send={send} />
      </Section>

      <MachineSection plan={plan} send={send} />
      <SetupSection doc={doc} plan={plan} />
      <OperationList plan={plan} data={data} />
      <ToolpathSection plan={plan} data={data} />

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={m.picker.removeTitle(plan.name)}
        description={m.picker.removeDescription}
        confirmLabel={m.picker.removeAction}
        cancelLabel={m.picker.cancel}
        destructive
        onConfirm={() => void send('plan.remove', { confirm: true })}
      />
      <ExportDialog />
    </div>
  )
}

// ── stale ─────────────────────────────────────────────────────────────────────────────────

function StaleNotices({
  plan,
  data,
  send,
}: {
  plan: PlanDTO
  data: PlanData | undefined
  send: (name: string, args: object) => Promise<unknown>
}): React.JSX.Element | null {
  const stale = data?.stale
  if (stale === undefined) return null
  const design = designStale(stale)
  const copies = stale.libraryCopies
  if (!design && stale.rebuildBlocked === null && copies.length === 0) return null
  const canRebuild = allows(plan, 'plan.rebuild')
  return (
    <div className={styles['banner']} role="status">
      {stale.rebuildBlocked !== null ? <span>{m.stale.blocked(stale.rebuildBlocked)}</span> : null}
      {design ? (
        <>
          <span>{stale.partRemoved ? m.stale.partRemoved : m.stale.design}</span>
          {canRebuild && !stale.partRemoved ? (
            <Button
              size="sm"
              icon={<RefreshCw aria-hidden="true" />}
              onClick={() => void send('plan.rebuild', {})}
            >
              {m.stale.rebuild}
            </Button>
          ) : null}
        </>
      ) : null}
      {copies.map((c) => {
        const name = snapshotName(plan, c.snapshotId) ?? c.libraryItemId
        const kind = m.stale.kinds[c.kind] ?? c.kind
        const text =
          c.status === 'libraryChanged'
            ? m.stale.library(kind, name)
            : c.status === 'libraryRemoved'
              ? m.stale.libraryRemoved(kind, name)
              : m.stale.libraryUnreadable(kind, name)
        return (
          <span key={c.snapshotId} className={styles['actions']}>
            <span>{text}</span>
            {c.blocked !== null ? (
              <span className={styles['why']}>{sentence(c.blocked)}</span>
            ) : null}
            {c.status === 'libraryChanged' &&
            c.blocked === null &&
            allows(plan, 'plan.libraryItem.update') ? (
              <Button
                size="sm"
                icon={<History aria-hidden="true" />}
                onClick={() => void send('plan.libraryItem.update', { snapshotId: c.snapshotId })}
              >
                {m.stale.update}
              </Button>
            ) : null}
          </span>
        )
      })}
    </div>
  )
}

// ── machine and setup ─────────────────────────────────────────────────────────────────────

function MachineSection({
  plan,
  send,
}: {
  plan: PlanDTO
  send: (name: string, args: object) => Promise<unknown>
}): React.JSX.Element {
  const machines = useLibraryItems('machine', plan.machine)
  const copy = plan.snapshots.find((s) => s.id === plan.machine)
  const options = (machines ?? []).map((i) => ({ value: i.id, label: i.name }))
  if (copy !== undefined && !options.some((o) => o.value === copy.libraryItemId))
    options.push({
      value: copy.libraryItemId,
      label: snapshotName(plan, copy.id) ?? copy.libraryItemId,
    })
  return (
    <Section title={m.machine.title}>
      {options.length === 0 && machines !== undefined ? (
        <p className={styles['why']}>{m.machine.empty}</p>
      ) : (
        <Select
          aria-label={m.machine.label}
          placeholder={m.machine.placeholder}
          options={options}
          {...(copy === undefined ? {} : { value: copy.libraryItemId })}
          disabled={!allows(plan, 'plan.machine.set')}
          onValueChange={(id) => void send('plan.machine.set', { machineLibraryItemId: id })}
        />
      )}
    </Section>
  )
}

function SetupSection({ doc, plan }: { doc: ProjectDoc; plan: PlanDTO }): React.JSX.Element {
  const call = usePlanCommand()
  const setup = plan.setups[0]!
  const [errors, setErrors] = useState<readonly Issue[]>([])
  const units = doc.unitSystem
  const readOnly = !allows(plan, 'plan.setup.update')
  const commit = async (key: 'clearanceHeight' | 'retractHeight', source: string) => {
    const r = await call('plan.setup.update', { planId: plan.id, setupId: setup.id, [key]: source })
    setErrors(r.ok ? [] : r.error.issues)
  }
  const messages = (key: string): FieldMessage[] =>
    errors
      .filter((i) => i.path[0] === key)
      .map((i, n) => ({ id: `${key}-${n}`, severity: 'error', text: sentence(i.message) }))
  return (
    <Section title={m.setup.title}>
      <p className={styles['muted']}>
        {m.setup.workOffset}: {m.setup.workOffsetValue}
      </p>
      <QuantityInput
        label={m.setup.clearanceHeight}
        kind="length"
        defaultUnit={defaultUnit('length', units)}
        value={quantityOf(setup.clearanceHeight)}
        illustration={<FieldIcon name="depth" />}
        readOnly={readOnly}
        messages={messages('clearanceHeight')}
        onCommit={(q) => void commit('clearanceHeight', q.source)}
      />
      <QuantityInput
        label={m.setup.retractHeight}
        kind="length"
        defaultUnit={defaultUnit('length', units)}
        value={quantityOf(setup.retractHeight)}
        illustration={<FieldIcon name="depth" />}
        readOnly={readOnly}
        messages={messages('retractHeight')}
        onCommit={(q) => void commit('retractHeight', q.source)}
      />
    </Section>
  )
}

// ── operations ────────────────────────────────────────────────────────────────────────────

function OperationList({
  plan,
  data,
}: {
  plan: PlanDTO
  data: PlanData | undefined
}): React.JSX.Element {
  const call = usePlanCommand()
  const [selected, select] = usePlanSelection()
  const failures = usePlanState((s) => s.failures)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const ops = plan.setups[0]!.operations
  const canMove = allows(plan, 'plan.operation.move')

  const move = async (id: string, by: -1 | 1) => {
    const to = ops.findIndex((o) => o.id === id) + by
    if (to < 0 || to >= ops.length) return
    const r = await call('plan.operation.move', {
      planId: plan.id,
      planOperationId: id,
      toIndex: to,
    })
    if (r.ok) rows.current.get(id)?.focus()
  }
  const onKey = (e: KeyboardEvent, id: string, index: number) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const by = e.key === 'ArrowUp' ? -1 : 1
    if (e.altKey) {
      if (canMove) void move(id, by)
      return
    }
    const next = ops[index + by]
    if (next) rows.current.get(next.id)?.focus()
  }

  return (
    <Section title={m.operations.title}>
      <ol className={styles['ops']} aria-label={m.operations.listLabel}>
        {ops.map((op, i) => {
          const name = planOperationName(plan, op.designOperationIds)
          const kind = planOperationKind(plan, op.designOperationIds) ?? 'facing'
          const findings = findingsOf(data?.warnings ?? [], op.id)
          const errors = findings.filter(isError).length
          const warnings = findings.length - errors
          const state = toolpathState(data?.toolpaths[op.id], failures[op.id])
          const stale = rowStale(data?.stale, op.designOperationIds)
          const tool = snapshotName(plan, op.tool)
          return (
            <li
              key={op.id}
              className={styles['op']}
              data-selected={selected === op.id ? '' : undefined}
            >
              <button
                type="button"
                ref={(el) => {
                  if (el) rows.current.set(op.id, el)
                  else rows.current.delete(op.id)
                }}
                className={`${styles['opSelect']} ${styles['planRow']}`}
                aria-pressed={selected === op.id}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                onClick={() => select(selected === op.id ? null : op.id)}
                onKeyDown={(e) => onKey(e, op.id, i)}
              >
                <ToolIcon name={KIND_ICON[kind] ?? 'facing'} />
                <span className={styles['opText']}>
                  <span className={styles['opName']}>{name}</span>
                  <span className={styles['opMeta']}>
                    <span className={styles['opTool']}>{tool ?? m.operations.noTool}</span>
                  </span>
                </span>
                {stale !== undefined ? (
                  <span className={styles['opStale']} title={staleText(stale)}>
                    <History aria-hidden="true" />
                    <span className={styles['srOnly']}>{staleText(stale)}</span>
                  </span>
                ) : (
                  <span />
                )}
                <span
                  className={styles['opState']}
                  data-state={state}
                  title={m.toolpaths.state[state]}
                >
                  {state === 'ready' ? (
                    <CircleCheck aria-hidden="true" />
                  ) : state === 'failed' ? (
                    <CircleAlert aria-hidden="true" />
                  ) : (
                    <CircleDashed aria-hidden="true" />
                  )}
                  <span className={styles['srOnly']}>{m.toolpaths.state[state]}</span>
                </span>
                {errors > 0 ? (
                  <span className={styles['opFailed']}>
                    <CircleAlert aria-hidden="true" />
                    <span aria-hidden="true">{errors}</span>
                    <span className={styles['srOnly']}>{m.operations.errors(errors)}</span>
                  </span>
                ) : (
                  <span />
                )}
                {warnings > 0 ? (
                  <span className={styles['opBadge']}>
                    <TriangleAlert aria-hidden="true" />
                    <span aria-hidden="true">{warnings}</span>
                    <span className={styles['srOnly']}>{m.operations.warnings(warnings)}</span>
                  </span>
                ) : (
                  <span />
                )}
              </button>
              {canMove ? (
                <span className={styles['opActions']}>
                  <IconButton
                    label={m.operations.moveUp(name)}
                    icon={<ArrowUp aria-hidden="true" />}
                    shortcut="Alt+↑"
                    disabled={i === 0}
                    onClick={() => void move(op.id, -1)}
                  />
                  <IconButton
                    label={m.operations.moveDown(name)}
                    icon={<ArrowDown aria-hidden="true" />}
                    shortcut="Alt+↓"
                    disabled={i === ops.length - 1}
                    onClick={() => void move(op.id, 1)}
                  />
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>
    </Section>
  )
}

const staleText = (s: 'removed' | 'changed' | 'edited') =>
  s === 'removed' ? m.stale.rowRemoved : s === 'changed' ? m.stale.rowChanged : m.stale.rowEdited

// ── toolpaths and export ──────────────────────────────────────────────────────────────────

function ToolpathSection({
  plan,
  data,
}: {
  plan: PlanDTO
  data: PlanData | undefined
}): React.JSX.Element {
  const store = usePlanStore()
  const generating = usePlanState((s) => s.generating)
  const progress = usePlanState((s) => s.progress)
  const generateError = usePlanState((s) => s.generateError)
  const failures = usePlanState((s) => s.failures)
  const exporting = usePlanState((s) => s.exporting)
  const ids = { generate: useId(), export: useId() }
  const ops = plan.setups[0]!.operations
  const ready = ops.filter(
    (o) => toolpathState(data?.toolpaths[o.id], failures[o.id]) === 'ready',
  ).length
  const blocked = (data?.warnings ?? []).some(isError)
  const failed = Object.keys(failures).length
  const busy = generating !== undefined
  const generateWhy = blocked ? m.toolpaths.blocked : null
  const exportWhy =
    plan.status === 'archived'
      ? m.export.archived
      : plan.machine === undefined
        ? m.export.noMachine
        : blocked
          ? m.export.blocked
          : null

  return (
    <Section title={m.toolpaths.title}>
      {data !== undefined ? (
        <p className={styles['why']} aria-live="polite">
          {busy ? m.toolpaths.generating : m.toolpaths.summary(ready, ops.length)}
        </p>
      ) : null}
      {busy ? (
        <Progress
          label={m.toolpaths.progress}
          value={progress?.total === undefined ? null : progress.done}
          {...(progress?.total === undefined ? {} : { max: progress.total })}
        />
      ) : null}
      {generateError ? <ErrorMessage error={generateError} message={m.toolpaths.failed} /> : null}
      {failed > 0 && !busy ? (
        <p className={styles['why']}>{m.toolpaths.someFailed(failed)}</p>
      ) : null}
      <div className={styles['actions']}>
        <Button
          icon={<RefreshCw aria-hidden="true" />}
          disabled={busy || generateWhy !== null}
          {...(generateWhy === null ? {} : { 'aria-describedby': ids.generate })}
          onClick={() => void store.getState().generate(plan.id)}
        >
          {m.toolpaths.generate}
        </Button>
        {generateWhy !== null ? (
          <p id={ids.generate} className={styles['why']}>
            {generateWhy}
          </p>
        ) : null}
        <Button
          variant="primary"
          icon={<Download aria-hidden="true" />}
          disabled={exporting || busy || exportWhy !== null}
          {...(exportWhy === null ? {} : { 'aria-describedby': ids.export })}
          onClick={() => void store.getState().exportPlan(plan.id, plan.name)}
        >
          {exporting ? m.export.busy : m.export.action}
        </Button>
        {exportWhy !== null ? (
          <p id={ids.export} className={styles['why']}>
            {exportWhy}
          </p>
        ) : null}
      </div>
    </Section>
  )
}
