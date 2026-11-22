// Plan navigator (task 3.7; ui.md#app-shell: "Plan: plan picker, plan status, setup, plan
// operations in machining order"): create a plan of the part; pick, duplicate or remove plans
// (remove confirmed); the plan's status and its stale notices with rebuild / update from library
// (a rebuild or back to draft that discards plan-only edits is confirmed, naming their count);
// the machine; the setup panel (SetupList.tsx, v0.2 F6: setups with their plan operations in
// machining order); toolpath generation and the gCode export (of the window's setup when the plan
// has several). Doc: docs/conventions/ui.md#plan-mode-task-37,
// docs/modes/plan-v0.1.md#commands-and-queries-v01
import {
  Copy,
  Download,
  History,
  Lock,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  Waypoints,
} from 'lucide-react'
import { useId, useState } from 'react'
import type { PlanDTO, PlanStatus } from '../../../../core/plan/plan.dto'
import type { ProjectDoc } from '../../../../core/project/document'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { planMessages, sentence } from '../../messages/plan'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorMessage,
  IconButton,
  Menu,
  Progress,
  Select,
  StatusChip,
} from '../../ui'
import { ExportDialog } from './ExportDialog'
import { NewMachineDialog } from './NewMachineDialog'
import {
  allPlanOperations,
  allows,
  designStale,
  editable,
  isError,
  pickerPlans,
  planEditCount,
  setupExportBlocked,
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
import { SetupList } from './SetupList'
import { useChosenPlan, useCurrentSetup, useLibraryItems } from './usePlan'

const m = planMessages

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
  const [machinesAdded, setMachinesAdded] = useState(0)
  const machines = useLibraryItems('machine', machinesAdded)
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
          {machines?.length === 0 ? (
            <>
              <p className={styles['why']}>{m.machine.empty}</p>
              <NewMachineDialog
                units={doc.unitSystem}
                onAdded={async () => {
                  setMachinesAdded((n) => n + 1)
                  return undefined
                }}
              />
            </>
          ) : null}
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
  /** A rebuild (or back to draft) that would discard plan-only edits, waiting for the user. */
  const [discard, setDiscard] = useState<'rebuild' | 'draft' | null>(null)
  const edits = planEditCount(plan)
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
              if (s === 'draft' && edits > 0) setDiscard('draft')
              else void send('plan.status.set', s === 'unarchive' ? {} : { status: s })
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
        <StaleNotices
          plan={plan}
          data={data}
          send={send}
          onRebuild={() => (edits > 0 ? setDiscard('rebuild') : void send('plan.rebuild', {}))}
        />
      </Section>

      <MachineSection plan={plan} send={send} units={doc.unitSystem} />
      <Section title={m.setup.title}>
        <SetupList doc={doc} plan={plan} data={data} />
      </Section>
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
      <ConfirmDialog
        open={discard !== null}
        onOpenChange={(open) => {
          if (!open) setDiscard(null)
        }}
        title={discard === 'draft' ? m.stale.discardDraftTitle(edits) : m.stale.discardTitle(edits)}
        description={m.stale.discardDescription}
        confirmLabel={discard === 'draft' ? m.stale.discardDraftAction : m.stale.rebuild}
        cancelLabel={m.stale.discardCancel}
        destructive
        onConfirm={() =>
          void (discard === 'draft'
            ? send('plan.status.set', { status: 'draft', discardPlanEdits: true })
            : send('plan.rebuild', { discardPlanEdits: true }))
        }
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
  onRebuild,
}: {
  plan: PlanDTO
  data: PlanData | undefined
  send: (name: string, args: object) => Promise<unknown>
  /** Rebuild, confirmed first when it discards plan-only edits. */
  onRebuild: () => void
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
            <Button size="sm" icon={<RefreshCw aria-hidden="true" />} onClick={onRebuild}>
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

// ── machine ────────────────────────────────────────────────────────────────────────────

function MachineSection({
  plan,
  send,
  units,
}: {
  plan: PlanDTO
  send: (name: string, args: object) => Promise<unknown>
  units: ProjectDoc['unitSystem']
}): React.JSX.Element {
  const call = usePlanCommand()
  const canSet = allows(plan, 'plan.machine.set')
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
          disabled={!canSet}
          onValueChange={(id) => void send('plan.machine.set', { machineLibraryItemId: id })}
        />
      )}
      {canSet ? (
        <NewMachineDialog
          units={units}
          onAdded={async (id) => {
            const r = await call('plan.machine.set', { planId: plan.id, machineLibraryItemId: id })
            return r.ok ? undefined : r.error
          }}
        />
      ) : null}
    </Section>
  )
}

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
  const ops = allPlanOperations(plan)
  const ready = ops.filter(
    (o) => toolpathState(data?.toolpaths[o.id], failures[o.id]) === 'ready',
  ).length
  const blocked = (data?.warnings ?? []).some(isError)
  // one program per setup (task F6): with several setups the window's setup is exported
  const setup = useCurrentSetup(plan)
  const several = plan.setups.length > 1
  const index = plan.setups.indexOf(setup)
  const failed = Object.keys(failures).length
  const busy = generating !== undefined
  const generateWhy = blocked ? m.toolpaths.blocked : null
  const exportWhy =
    plan.status === 'archived'
      ? m.export.archived
      : plan.machine === undefined
        ? m.export.noMachine
        : (several ? setupExportBlocked(data?.warnings ?? [], setup) : blocked)
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
          onClick={() =>
            void store.getState().exportPlan(
              plan.id,
              several ? `${plan.name} ${setup.name}` : plan.name,
              several
                ? {
                    id: setup.id,
                    label: m.export.setup(setup.name, index + 1, plan.setups.length),
                  }
                : undefined,
            )
          }
        >
          {exporting ? m.export.busy : several ? m.export.actionSetup(setup.name) : m.export.action}
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
