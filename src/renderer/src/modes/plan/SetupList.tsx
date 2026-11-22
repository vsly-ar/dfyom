// Setup panel (v0.2 task F6): the plan's setups in machining order, each row with its name, the
// direction (an icon of the stock with its up face shaded, plus the word), the WCS corner and the
// rotation; the plan operations nest under their setup (kind icon, name, tool, stale badge,
// toolpath state, error and warning counts). Setups move with buttons and Alt+↑/↓
// (`plan.setup.move`) and merge from their menu with setups of the same direction
// (`plan.setup.merge`); plan operations move with buttons and Alt+↑/↓ within their setup and
// across into a neighbouring setup of the same direction (`plan.operation.move`), and split off
// into a new setup or move to another setup of the same direction from their menu. ↑/↓ move the
// focus over every row. Selecting a setup opens it in the inspector; the selected setup (or the
// selected operation's) is the one previewed and exported. Doc: docs/conventions/ui.md#design-and-plan-controls-v02,
// docs/modes/plan-v0.2.md#merge-split-reorder
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Combine,
  History,
  MoreHorizontal,
  Split,
  TriangleAlert,
  CornerDownRight,
} from 'lucide-react'
import { useRef, useState, type KeyboardEvent } from 'react'
import { DIRECTION_LABEL } from '../../../../core/geometry/face'
import type { PlanDTO, PlanOperationDTO, SetupDTO } from '../../../../core/plan/plan.dto'
import type { ProjectDoc } from '../../../../core/project/document'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { planMessages } from '../../messages/plan'
import {
  ErrorMessage,
  IconButton,
  Menu,
  ToolIcon,
  type MenuEntry,
  type ToolIconName,
} from '../../ui'
import { DirectionIcon } from './DirectionIcon'
import {
  allows,
  directionOfSetup,
  isError,
  operationStep,
  planOperationKind,
  planOperationName,
  planStockSize,
  rowStale,
  sameDirectionSetups,
  setupCorner,
  snapshotName,
  toolpathState,
} from './model'
import { usePlanCommand, usePlanState, type PlanData } from './plan-store'
import styles from './Plan.module.css'
import { findingsOf, useCurrentSetup, usePlanSelection } from './usePlan'

const m = planMessages

export const KIND_ICON: Record<string, ToolIconName> = {
  facing: 'facing',
  pocket: 'pocket',
  drilling: 'drill',
  profile: 'profile',
}

/** One line of a setup row: "Bottom · G54 back left · 0°". */
export function setupMeta(doc: ProjectDoc, plan: PlanDTO, setup: SetupDTO): string {
  const stock = planStockSize(doc, plan)
  return m.setup.rowMeta(
    DIRECTION_LABEL[directionOfSetup(setup)],
    stock === undefined ? undefined : setupCorner(setup, stock),
    setup.rotation ?? 0,
  )
}

export function SetupList({
  doc,
  plan,
  data,
}: {
  doc: ProjectDoc
  plan: PlanDTO
  data: PlanData | undefined
}): React.JSX.Element {
  const command = usePlanCommand()
  /** Why the last move, split or merge was refused (`plan.order`, …). */
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const call = async (name: string, args: object) => {
    const r = await command(name, args)
    setError(r.ok ? undefined : r.error)
    return r
  }
  const [selected, select] = usePlanSelection()
  const current = useCurrentSetup(plan)
  const failures = usePlanState((s) => s.failures)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const canMove = allows(plan, 'plan.operation.move')
  const several = plan.setups.length > 1
  /** Every row in the order shown, for ↑/↓. */
  const order = plan.setups.flatMap((s) => [s.id, ...s.operations.map((o) => o.id)])
  const focus = (id: string) => rows.current.get(id)?.focus()

  const moveSetup = async (setup: SetupDTO, by: -1 | 1) => {
    const to = plan.setups.findIndex((s) => s.id === setup.id) + by
    if (to < 0 || to >= plan.setups.length) return
    const r = await call('plan.setup.move', { planId: plan.id, setupId: setup.id, toIndex: to })
    if (r.ok) focus(setup.id)
  }
  const moveOperation = async (id: string, by: -1 | 1) => {
    const step = operationStep(plan, id, by)
    if (step === undefined) return
    const r = await call('plan.operation.move', { planId: plan.id, planOperationId: id, ...step })
    if (r.ok) focus(id)
  }
  const onKey = (e: KeyboardEvent, id: string, move: (by: -1 | 1) => void) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const by = e.key === 'ArrowUp' ? -1 : 1
    if (e.altKey) {
      if (canMove) move(by)
      return
    }
    const next = order[order.indexOf(id) + by]
    if (next !== undefined) focus(next)
  }
  const ref = (id: string) => (el: HTMLButtonElement | null) => {
    if (el) rows.current.set(id, el)
    else rows.current.delete(id)
  }

  return (
    <>
      <ol className={styles['setups']} aria-label={m.setup.listLabel}>
        {plan.setups.map((setup, si) => {
          const name = setup.name
          const merges = sameDirectionSetups(plan, setup)
          const isCurrent = several && setup.id === current.id
          return (
            <li key={setup.id} className={styles['setup']}>
              <div
                className={styles['op']}
                data-selected={selected === setup.id ? '' : undefined}
                data-current={isCurrent ? '' : undefined}
              >
                <button
                  type="button"
                  ref={ref(setup.id)}
                  className={`${styles['opSelect']} ${styles['setupSelect']}`}
                  aria-pressed={selected === setup.id}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  onClick={() => select(selected === setup.id ? null : setup.id)}
                  onKeyDown={(e) => onKey(e, setup.id, (by) => void moveSetup(setup, by))}
                >
                  <DirectionIcon
                    direction={directionOfSetup(setup)}
                    className={styles['dirIcon']}
                  />
                  <span className={styles['opText']}>
                    <span className={styles['setupName']}>
                      {several ? `${si + 1}. ${name}` : name}
                    </span>
                    <span className={styles['opMeta']}>
                      <span className={styles['opTool']}>{setupMeta(doc, plan, setup)}</span>
                    </span>
                  </span>
                  {isCurrent ? <span className={styles['srOnly']}>{m.setup.shown}</span> : null}
                </button>
                {canMove ? (
                  <span className={styles['opActions']}>
                    {several ? (
                      <>
                        <IconButton
                          label={m.setup.moveUp(name)}
                          icon={<ArrowUp aria-hidden="true" />}
                          shortcut="Alt+↑"
                          disabled={si === 0}
                          onClick={() => void moveSetup(setup, -1)}
                        />
                        <IconButton
                          label={m.setup.moveDown(name)}
                          icon={<ArrowDown aria-hidden="true" />}
                          shortcut="Alt+↓"
                          disabled={si === plan.setups.length - 1}
                          onClick={() => void moveSetup(setup, 1)}
                        />
                      </>
                    ) : null}
                    <Menu
                      label={m.setup.actions(name)}
                      align="end"
                      items={
                        merges.length === 0
                          ? [{ label: m.setup.noMerge, disabled: true, onSelect: () => {} }]
                          : merges.map((other) => ({
                              label: m.setup.merge(other.name),
                              icon: <Combine aria-hidden="true" />,
                              onSelect: () =>
                                void call('plan.setup.merge', {
                                  planId: plan.id,
                                  setupIds: [setup.id, other.id],
                                }),
                            }))
                      }
                    >
                      <IconButton
                        label={m.setup.actions(name)}
                        icon={<MoreHorizontal aria-hidden="true" />}
                        className={styles['opMenu']}
                      />
                    </Menu>
                  </span>
                ) : null}
              </div>
              <ol
                className={styles['ops']}
                aria-label={several ? m.operations.setupListLabel(name) : m.operations.listLabel}
              >
                {setup.operations.map((op) => (
                  <OperationRow
                    key={op.id}
                    plan={plan}
                    setup={setup}
                    op={op}
                    data={data}
                    failure={failures[op.id]}
                    selected={selected === op.id}
                    canMove={canMove}
                    rowRef={ref(op.id)}
                    onSelect={() => select(selected === op.id ? null : op.id)}
                    onKeyDown={(e) => onKey(e, op.id, (by) => void moveOperation(op.id, by))}
                    onMove={(by) => void moveOperation(op.id, by)}
                    onSplit={() =>
                      void call('plan.setup.split', {
                        planId: plan.id,
                        setupId: setup.id,
                        planOperationIds: [op.id],
                      })
                    }
                    onMoveTo={(target) =>
                      void call('plan.operation.move', {
                        planId: plan.id,
                        planOperationId: op.id,
                        toSetupId: target.id,
                        toIndex: target.operations.length,
                      })
                    }
                  />
                ))}
              </ol>
            </li>
          )
        })}
      </ol>
      {error ? <ErrorMessage error={error} message={m.inspector.commandFailed} /> : null}
    </>
  )
}

function OperationRow({
  plan,
  setup,
  op,
  data,
  failure,
  selected,
  canMove,
  rowRef,
  onSelect,
  onKeyDown,
  onMove,
  onSplit,
  onMoveTo,
}: {
  plan: PlanDTO
  setup: SetupDTO
  op: PlanOperationDTO
  data: PlanData | undefined
  failure: AppErrorData | undefined
  selected: boolean
  canMove: boolean
  rowRef: (el: HTMLButtonElement | null) => void
  onSelect: () => void
  onKeyDown: (e: KeyboardEvent) => void
  onMove: (by: -1 | 1) => void
  onSplit: () => void
  onMoveTo: (setup: SetupDTO) => void
}): React.JSX.Element {
  const name = planOperationName(plan, op.designOperationIds)
  const kind = planOperationKind(plan, op.designOperationIds) ?? 'facing'
  const findings = findingsOf(data?.warnings ?? [], op.id)
  const errors = findings.filter(isError).length
  const warnings = findings.length - errors
  const state = toolpathState(data?.toolpaths[op.id], failure)
  const stale = rowStale(data?.stale, op.designOperationIds)
  const tool = snapshotName(plan, op.tool)
  const others = sameDirectionSetups(plan, setup)
  const menu: MenuEntry[] = [
    {
      label: m.operations.split,
      icon: <Split aria-hidden="true" />,
      disabled: setup.operations.length < 2,
      onSelect: onSplit,
    },
    ...others.map((s) => ({
      label: m.operations.moveTo(s.name),
      icon: <CornerDownRight aria-hidden="true" />,
      onSelect: () => onMoveTo(s),
    })),
  ]
  return (
    <li className={styles['op']} data-selected={selected ? '' : undefined}>
      <button
        type="button"
        ref={rowRef}
        className={`${styles['opSelect']} ${styles['planRow']}`}
        aria-pressed={selected}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onClick={onSelect}
        onKeyDown={onKeyDown}
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
        <span className={styles['opState']} data-state={state} title={m.toolpaths.state[state]}>
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
            disabled={operationStep(plan, op.id, -1) === undefined}
            onClick={() => onMove(-1)}
          />
          <IconButton
            label={m.operations.moveDown(name)}
            icon={<ArrowDown aria-hidden="true" />}
            shortcut="Alt+↓"
            disabled={operationStep(plan, op.id, 1) === undefined}
            onClick={() => onMove(1)}
          />
          <Menu label={m.operations.actions(name)} align="end" items={menu}>
            <IconButton
              label={m.operations.actions(name)}
              icon={<MoreHorizontal aria-hidden="true" />}
              className={styles['opMenu']}
            />
          </Menu>
        </span>
      ) : null}
    </li>
  )
}

const staleText = (s: 'removed' | 'changed' | 'edited') =>
  s === 'removed' ? m.stale.rowRemoved : s === 'changed' ? m.stale.rowChanged : m.stale.rowEdited
