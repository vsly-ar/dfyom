// Plan navigator (task 3.7; ui.md#app-shell: "Plan: plan picker, plan status, setup, plan
// operations in machining order"): create a plan of the part; pick, duplicate or remove plans
// (remove confirmed); the plan's status and its stale notices with rebuild / update from library
// (a rebuild or back to draft that discards plan-only edits is confirmed, naming their count),
// or, while its inputs wait for Apply, the pending notice with "Apply now" (task P3);
// the machine; the setup panel (SetupList.tsx, v0.2 F6: setups with their plan operations in
// machining order); toolpath generation and the gCode export (of the window's setup when the plan
// has several). Doc: docs/conventions/ui.md#plan-mode-task-37,
// docs/modes/plan-v0.1.md#commands-and-queries-v01
import { useId, useState } from 'react'
import { cutIds } from '../../../../core/plan/cut'
import type { PlanDTO, PlanStatus } from '../../../../core/plan/plan.dto'
import type { ProjectDoc } from '../../../../core/project/document'
import { gcodeFileStem } from '../../../../core/post/file-name'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { applyMessages } from '../../messages/apply'
import { planMessages, sentence } from '../../messages/plan'
import { usePending, useShell } from '../../shell/ShellContext'
import {
  Icon,
  Button,
  ConfirmDialog,
  ErrorMessage,
  IconButton,
  Menu,
  Progress,
  Select,
  Switch,
  type IconName,
} from '../../ui'
import { ExportDialog } from './ExportDialog'
import { LibraryLink } from '../../library/LibraryLink'
import { NewMachineDialog } from '../../library/NewMachineDialog'
import {
  allPlanOperations,
  allows,
  designStale,
  editable,
  isError,
  pickerPlans,
  planEditCount,
  planLabel,
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

function Section({
  title,
  icon,
  children,
}: {
  title: string
  /** The section's concept icon (B22), decorative. */
  icon?: IconName
  children: React.ReactNode
}) {
  const id = useId()
  return (
    <section className={styles['section']} aria-labelledby={id}>
      <h3 id={id} className={styles['sectionTitle']}>
        {icon !== undefined ? <Icon name={icon} size="sm" /> : null}
        {title}
      </h3>
      {children}
    </section>
  )
}

export function PlanNavigator({ doc }: { doc: ProjectDoc }): React.JSX.Element {
  const [plan, choose] = useChosenPlan(doc)
  const call = usePlanCommand()
  const machines = useLibraryItems('machine')

  // a new plan of the given part (split parts S0: the plan menu asks for it when there are several)
  const create = async (partId: string) => {
    const machine = machines?.[0]
    const r = await call('plan.create', {
      partId,
      ...(machine === undefined ? {} : { machineLibraryItemId: machine.id }),
    })
    if (r.ok) choose((r.value as { planId: string }).planId)
  }

  // no plan yet: "Plan the part" is a card over the view (DF29, PlanStart.tsx)
  if (plan === undefined)
    return (
      <div className={styles['navigator']}>
        <p className={styles['emptyNote']}>{m.empty.navigator}</p>
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
  onCreate: (partId: string) => Promise<void>
}): React.JSX.Element {
  const call = usePlanCommand()
  const data = usePlanData(plan.id)
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const [removeOpen, setRemoveOpen] = useState(false)
  /** A rebuild (or back to draft) that would discard plan-only edits, waiting for the user. */
  const [discard, setDiscard] = useState<'rebuild' | 'draft' | null>(null)
  const edits = planEditCount(plan)
  const plans = pickerPlans(doc)
  const parts = Object.values(doc.parts)
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
              label:
                p.status === 'archived'
                  ? `${planLabel(doc, p)} (${m.statuses.archived})`
                  : planLabel(doc, p),
            }))}
            value={plan.id}
            onValueChange={choose}
          />
          <Menu
            label={m.picker.actions}
            items={[
              // one part: New plan plans it (the shown plan's part); several: a group naming each
              parts.length > 1
                ? {
                    group: m.picker.createFor,
                    items: parts.map((p) => ({
                      id: p.id,
                      label: p.name,
                      icon: <Icon name="add" />,
                      onSelect: () => void onCreate(p.id),
                    })),
                  }
                : {
                    label: m.picker.create,
                    icon: <Icon name="add" />,
                    onSelect: () => void onCreate(parts[0]?.id ?? plan.design.partId),
                  },
              {
                label: m.picker.duplicate,
                icon: <Icon name="copy" />,
                onSelect: () =>
                  void send('plan.duplicate', {}).then((r) => {
                    if (r.ok) choose((r.value as { planId: string }).planId)
                  }),
              },
              'separator',
              {
                label: m.picker.remove,
                icon: <Icon name="delete" />,
                danger: true,
                disabled: !allows(plan, 'plan.remove'),
                onSelect: () => setRemoveOpen(true),
              },
            ]}
          >
            <IconButton label={m.picker.actions} icon={<Icon name="more" />} />
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
        </div>
        {!canEdit ? (
          <p className={styles['why']}>
            <Icon name="lock" size="sm" /> {m.readOnly(plan.status)}
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
      <Section title={m.setup.title} icon="setups">
        <SetupList doc={doc} plan={plan} data={data} />
      </Section>
      <ToolpathSection doc={doc} plan={plan} data={data} />

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
  const pending = usePending()
  const { pending: applyStore } = useShell()
  const stale = data?.stale
  if (stale === undefined) return null
  // the plan follows on Apply: its notice replaces the stale one (apply.md#stale-derived-results)
  const waits = data?.pendingApply === true
  const design = designStale(stale) && !(waits && plan.status === 'draft')
  const copies = waits && plan.status === 'draft' ? [] : stale.libraryCopies
  if (!waits && !design && stale.rebuildBlocked === null && copies.length === 0) return null
  const canRebuild = allows(plan, 'plan.rebuild')
  return (
    <div className={styles['banner']} role="status">
      {waits ? (
        <span className={styles['actions']}>
          <span>
            {plan.status === 'draft' ? applyMessages.planPending : applyMessages.planInputsPending}
          </span>
          <Button
            size="sm"
            icon={<Icon name="check-all" />}
            disabled={pending.sending}
            onClick={() => void applyStore.apply()}
          >
            {applyMessages.applyNow}
          </Button>
        </span>
      ) : null}
      {stale.rebuildBlocked !== null ? <span>{m.stale.blocked(stale.rebuildBlocked)}</span> : null}
      {design ? (
        <>
          <span>{stale.partRemoved ? m.stale.partRemoved : m.stale.design}</span>
          {canRebuild && !stale.partRemoved ? (
            <Button size="sm" icon={<Icon name="refresh" />} onClick={onRebuild}>
              {m.stale.rebuild}
            </Button>
          ) : null}
        </>
      ) : null}
      {copies.map((c) => {
        const name = snapshotName(plan, c.snapshotId) ?? m.stale.unnamed
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
                icon={<Icon name="history" />}
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
  // the machine chosen here is the Plan start card's next preselection (DF45, `lastMachine`)
  const { settings } = useShell()
  const remember = (id: string) => settings.getState().update({ lastMachine: id })
  const canSet = allows(plan, 'plan.machine.set')
  const machines = useLibraryItems('machine', plan.machine)
  // machine copies always come from the library (only a part's stock may be its own, DF13)
  const found = plan.snapshots.find((s) => s.id === plan.machine)
  const copy =
    found?.libraryItemId === undefined
      ? undefined
      : { id: found.id, libraryItemId: found.libraryItemId }
  const options = (machines ?? []).map((i) => ({ value: i.id, label: i.name }))
  if (copy !== undefined && !options.some((o) => o.value === copy.libraryItemId))
    options.push({
      value: copy.libraryItemId,
      label: snapshotName(plan, copy.id) ?? m.machine.unnamed,
    })
  return (
    <Section title={m.machine.title} icon="machine">
      {options.length === 0 && machines !== undefined ? (
        <p className={styles['why']}>{m.machine.empty}</p>
      ) : (
        <Select
          aria-label={m.machine.label}
          placeholder={m.machine.placeholder}
          options={options}
          {...(copy === undefined ? {} : { value: copy.libraryItemId })}
          disabled={!canSet}
          onValueChange={(id) => {
            remember(id)
            void send('plan.machine.set', { machineLibraryItemId: id })
          }}
        />
      )}
      <div className={styles['libraryActions']}>
        {copy !== undefined ? (
          <LibraryLink target={{ kind: 'machine', itemId: copy.libraryItemId }} />
        ) : null}
        {canSet ? (
          <NewMachineDialog
            units={units}
            onAdded={async (id) => {
              const r = await call('plan.machine.set', {
                planId: plan.id,
                machineLibraryItemId: id,
              })
              if (r.ok) remember(id)
              return r.ok ? undefined : r.error
            }}
          />
        ) : null}
      </div>
    </Section>
  )
}

// ── toolpaths and export ──────────────────────────────────────────────────────────────────

function ToolpathSection({
  doc,
  plan,
  data,
}: {
  doc: ProjectDoc
  plan: PlanDTO
  data: PlanData | undefined
}): React.JSX.Element {
  const store = usePlanStore()
  const generating = usePlanState((s) => s.generating)
  const progress = usePlanState((s) => s.progress)
  const generateError = usePlanState((s) => s.generateError)
  const failures = usePlanState((s) => s.failures)
  const exporting = usePlanState((s) => s.exporting)
  const showCut = usePlanState((s) => s.showCutToolpaths)
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
  // DF45: the next step is the primary – Generate until every toolpath is up to date, then
  // Export. Export regenerates missing and outdated toolpaths itself, so it stays enabled and
  // its hint says so.
  const allReady = ready === ops.length
  const exportNote =
    exportWhy ?? (allReady || busy ? null : m.export.generatesFirst(ops.length - ready))
  const exportLabel = exporting
    ? m.export.busy
    : several
      ? m.export.actionSetup(setup.name)
      : m.export.action

  return (
    <Section title={m.toolpaths.title} icon="toolpath">
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
      {/* DF135: already-cut operations' toolpaths are hidden unless shown (cut-state.md) */}
      {cutIds(plan).size > 0 ? (
        <Switch
          label={m.cut.showToolpaths}
          checked={showCut}
          onCheckedChange={(on) => store.getState().setShowCutToolpaths(on)}
        />
      ) : null}
      <div className={styles['actions']}>
        <Button
          variant={allReady ? 'default' : 'primary'}
          icon={<Icon name="refresh" />}
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
          variant={allReady ? 'primary' : 'default'}
          icon={<Icon name="export-gcode" />}
          className={styles['fitButton']}
          disabled={exporting || busy || exportWhy !== null}
          {...(exportNote === null ? {} : { 'aria-describedby': ids.export })}
          onClick={() =>
            void store.getState().exportPlan(
              plan.id,
              gcodeFileStem(doc, plan.id, setup.id),
              several
                ? {
                    id: setup.id,
                    label: m.export.setup(setup.name, index + 1, plan.setups.length),
                  }
                : undefined,
            )
          }
        >
          {/* DF103: a long setup name ends in "…"; the label's title (not the button's, which
              would become its description) has the whole label */}
          <span className={styles['fitLabel']} title={exportLabel}>
            {exportLabel}
          </span>
        </Button>
        {exportNote !== null ? (
          <p id={ids.export} className={styles['why']}>
            {exportNote}
          </p>
        ) : null}
      </div>
    </Section>
  )
}
