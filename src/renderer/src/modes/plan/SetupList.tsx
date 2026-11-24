// Setup panel (v0.2 task F6): the plan's setups in machining order, each row with its name, the
// direction (an icon of the stock with its up face shaded, plus the word), the WCS corner and the
// rotation; the plan operations nest under their setup (kind icon, name, tool, stale badge,
// toolpath state, error and warning counts). Setups move from their menu and with Alt+↑/↓
// (`plan.setup.move`) and merge from their menu with setups of the same direction
// (`plan.setup.merge`); plan operations move from their menu and with Alt+↑/↓ within their setup
// and across into a neighbouring setup of the same direction (`plan.operation.move`), and split
// off into a new setup or move to another setup of the same direction from their menu. Setups, and
// plan operations within their setup, also reorder by dragging their grip in the row's start gutter
// (hardening U3, `ui/Reorder`, as the design operation list); every move is announced. ↑/↓ move
// the focus over every row. Each row's actions are its context menu (DF67, as the design list's
// row menu: right-click, Shift+F10 / the Menu key), so rows have no action button and names,
// subtitles and status icons keep the row's width and never move; clicking an error or warning
// count selects the operation and focuses its inspector's Checks block. Selecting a setup opens
// it in the inspector; the selected setup (or the selected operation's) is the one previewed and
// exported.
// Doc: docs/conventions/ui.md#design-and-plan-controls-v02,
// docs/modes/plan-v0.2.md#merge-split-reorder, docs/conventions/ui.md#reordering-lists-d45
import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import { DIRECTION_LABEL } from '../../../../core/geometry/face'
import type { PlanDTO, PlanOperationDTO, SetupDTO } from '../../../../core/plan/plan.dto'
import type { ProjectDoc } from '../../../../core/project/document'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { formatHeight, planMessages } from '../../messages/plan'
import {
  ContextMenu,
  DragGrip,
  ErrorMessage,
  Icon,
  isContextMenuKey,
  openContextMenu,
  ReorderStatus,
  useReorder,
  type MenuEntry,
  type IconName,
  type Reorder,
} from '../../ui'
import { partOperationIcon } from '../design/operation-icon'
import { DirectionIcon } from './DirectionIcon'
import {
  allows,
  directionOfSetup,
  isError,
  isWarning,
  operationStep,
  planOperationName,
  planStockSize,
  rowStale,
  sameDirectionSetups,
  setupZeroWords,
  type SetupAlignmentInfo,
  snapshotName,
  toolpathState,
} from './model'
import { usePlanCommand, usePlanState, usePlanStore, type PlanData } from './plan-store'
import styles from './Plan.module.css'
import { findingsOf, useCurrentSetup, usePlanSelection } from './usePlan'

const m = planMessages

/**
 * A plan operation's row icon: its first design operation's, as the design navigator shows it
 * (DF44: a countersink or chamfer never reads as a facing, a counterbore never as a pocket).
 */
export function planOperationIcon(
  plan: PlanDTO,
  designOperationIds: readonly string[],
  aid?: { readonly kind: string } | undefined,
): IconName {
  // alignment aids (S13): a witness mark is a V-bit's, a registration hole a drill's
  if (aid !== undefined) return aid.kind === 'witnessMark' ? 'chamfer-mill' : 'drill'
  const part = plan.design.part
  const op = part.operations.find((o) => o.id === designOperationIds[0])
  return op === undefined ? 'facing' : partOperationIcon(part, op)
}

/**
 * One line of a setup row: "Bottom · G54 back left · 0°" ("G54 X 40 mm Y 25 mm", "G54 on Hole 1"
 * when the zero moved, DF78); without the face when the name is the face.
 */
export function setupMeta(
  doc: ProjectDoc,
  plan: PlanDTO,
  setup: SetupDTO,
  info?: SetupAlignmentInfo,
): string {
  const stock = planStockSize(doc, plan)
  return m.setup.rowMeta(
    DIRECTION_LABEL[directionOfSetup(setup)],
    stock === undefined
      ? undefined
      : m.setup.rowZero(
          setupZeroWords(setup, stock, info, (mm) => formatHeight(mm, doc.unitSystem)),
        ),
    setup.rotation ?? 0,
    setup.name,
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
  const store = usePlanStore()
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const canMove = allows(plan, 'plan.operation.move')
  // rows with a menu are described by one hint (DF70, ui.md decision 27)
  const hintId = useId()
  const menuKeys = canMove
    ? { 'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown Shift+F10', 'aria-describedby': hintId }
    : { 'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown' }
  const several = plan.setups.length > 1
  /** Every row in the order shown, for ↑/↓. */
  const order = plan.setups.flatMap((s) => [s.id, ...s.operations.map((o) => o.id)])
  const focus = (id: string) => rows.current.get(id)?.focus()
  const [announcement, setAnnouncement] = useState('')

  /** Setup `from` to index `to` (a drop or Alt+↑/↓): one `plan.setup.move`; false: refused. */
  const setupTo = async (from: number, to: number) => {
    const setup = plan.setups[from]
    if (setup === undefined || to < 0 || to >= plan.setups.length || to === from) return false
    const r = await call('plan.setup.move', { planId: plan.id, setupId: setup.id, toIndex: to })
    if (!r.ok) return false
    setAnnouncement(m.reorder.moved(setup.name, to + 1, plan.setups.length))
    focus(setup.id)
    return true
  }
  const setupReorder = useReorder({
    count: plan.setups.length,
    order: plan.setups.map((s) => s.id).join(' '),
    onMove: setupTo,
  })
  const { attachList: attachSetups } = setupReorder
  const moveSetup = async (setup: SetupDTO, by: -1 | 1) => {
    const from = plan.setups.findIndex((s) => s.id === setup.id)
    const to = from + by
    if (to < 0 || to >= plan.setups.length) return
    setupReorder.glide(from, to)
    if (!(await setupTo(from, to))) setupReorder.shake(from)
  }
  /** Plan operation `id` to index `toIndex` of its setup or of `toSetupId`; false: refused. */
  const operationTo = async (id: string, step: { toIndex: number; toSetupId?: string }) => {
    const r = await call('plan.operation.move', { planId: plan.id, planOperationId: id, ...step })
    if (!r.ok) return false
    const name = planOperationName(plan, planOperationOf(plan, id) ?? { designOperationIds: [] })
    const target = plan.setups.find((s) =>
      step.toSetupId === undefined
        ? s.operations.some((o) => o.id === id)
        : s.id === step.toSetupId,
    )
    const of = (target?.operations.length ?? 0) + (step.toSetupId === undefined ? 0 : 1)
    setAnnouncement(m.reorder.moved(name, step.toIndex + 1, of))
    focus(id)
    return true
  }
  const moveOperation = async (id: string, by: -1 | 1) => {
    const step = operationStep(plan, id, by)
    if (step === undefined) return
    await operationTo(id, step)
  }
  const onKey = (e: KeyboardEvent, id: string, move: (by: -1 | 1) => void) => {
    // Shift+F10 / the Menu key: the row's menu, at the row (as the design list, DF16)
    if (isContextMenuKey(e)) {
      const el = e.currentTarget.closest('[data-row-menu]')
      if (el === null) return
      e.preventDefault()
      return openContextMenu(el)
    }
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
      <ol
        ref={attachSetups}
        className={`${styles['setups']} ${canMove ? styles['gripped'] : ''} ${setupReorder.listClass}`}
        aria-label={m.setup.listLabel}
        {...setupReorder.listProps}
      >
        {plan.setups.map((setup, si) => {
          const name = setup.name
          const merges = sameDirectionSetups(plan, setup)
          const isCurrent = several && setup.id === current.id
          const meta = setupMeta(
            doc,
            plan,
            setup,
            data?.alignment.find((a) => a.setupId === setup.id),
          )
          return (
            <li key={setup.id} {...setupReorder.itemProps(si)} className={styles['setupItem']}>
              <RowMenu
                enabled={canMove}
                label={m.setup.actions(name)}
                onClose={() => focus(setup.id)}
                items={[
                  ...(several
                    ? ([
                        {
                          label: m.setup.moveUpItem,
                          icon: <Icon name="arrow-up" />,
                          shortcut: 'Alt+↑',
                          disabled: si === 0,
                          onSelect: () => void moveSetup(setup, -1),
                        },
                        {
                          label: m.setup.moveDownItem,
                          icon: <Icon name="arrow-down" />,
                          shortcut: 'Alt+↓',
                          disabled: si === plan.setups.length - 1,
                          onSelect: () => void moveSetup(setup, 1),
                        },
                        'separator',
                      ] satisfies MenuEntry[])
                    : []),
                  ...(merges.length === 0
                    ? [{ label: m.setup.noMerge, disabled: true, onSelect: () => {} }]
                    : merges.map((other) => ({
                        label: m.setup.merge(other.name),
                        icon: <Icon name="merge" />,
                        onSelect: () =>
                          void call('plan.setup.merge', {
                            planId: plan.id,
                            setupIds: [setup.id, other.id],
                          }),
                      }))),
                ]}
              >
                <div
                  className={`${styles['op']} ${styles['setupRow']}`}
                  data-row-menu={canMove ? '' : undefined}
                  data-selected={selected === setup.id ? '' : undefined}
                  data-current={isCurrent ? '' : undefined}
                >
                  {canMove && several ? <RowGrip grip={setupReorder.gripProps(si)} /> : null}
                  <button
                    type="button"
                    ref={ref(setup.id)}
                    className={`${styles['opSelect']} ${styles['setupSelect']}`}
                    aria-pressed={selected === setup.id}
                    {...menuKeys}
                    onClick={() => select(selected === setup.id ? null : setup.id)}
                    onKeyDown={(e) => onKey(e, setup.id, (by) => void moveSetup(setup, by))}
                  >
                    <DirectionIcon
                      direction={directionOfSetup(setup)}
                      className={styles['dirIcon']}
                    />
                    <span className={styles['opText']}>
                      <span className={styles['setupName']} title={name}>
                        {several ? `${si + 1}. ${name}` : name}
                      </span>
                      <span className={styles['opMeta']}>
                        <span className={styles['opTool']} title={meta}>
                          {meta}
                        </span>
                      </span>
                    </span>
                    {isCurrent ? <span className={styles['srOnly']}>{m.setup.shown}</span> : null}
                  </button>
                </div>
              </RowMenu>
              <SetupOperations
                label={several ? m.operations.setupListLabel(name) : m.operations.listLabel}
                setup={setup}
                canMove={canMove}
                onMove={(id, to) => operationTo(id, { toIndex: to })}
              >
                {(op, reorder, i) => (
                  <OperationRow
                    key={op.id}
                    plan={plan}
                    setup={setup}
                    op={op}
                    data={data}
                    failure={failures[op.id]}
                    selected={selected === op.id}
                    canMove={canMove}
                    menuKeys={menuKeys}
                    reorder={reorder}
                    index={i}
                    rowRef={ref(op.id)}
                    onMenuClose={() => focus(op.id)}
                    onSelect={() => select(selected === op.id ? null : op.id)}
                    onShowFindings={(e) => {
                      e.stopPropagation()
                      select(op.id)
                      store.getState().revealFindings(op.id)
                    }}
                    onKeyDown={(e) =>
                      onKey(e, op.id, (by) => {
                        // a step within the setup glides; one into a neighbouring setup does not
                        const to = i + by
                        if (to >= 0 && to < setup.operations.length) reorder.glide(i, to)
                        void moveOperation(op.id, by)
                      })
                    }
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
                )}
              </SetupOperations>
            </li>
          )
        })}
      </ol>
      {canMove ? (
        <p id={hintId} className={styles['srOnly']}>
          {m.rowMenuHint}
        </p>
      ) : null}
      <ReorderStatus refusal={undefined} announcement={announcement} />
      {error ? <ErrorMessage error={error} message={m.inspector.commandFailed} /> : null}
    </>
  )
}

/** The plan operation's DTO by id, in any setup. */
function planOperationOf(plan: PlanDTO, id: string): PlanOperationDTO | undefined {
  for (const s of plan.setups) for (const o of s.operations) if (o.id === id) return o
  return undefined
}

/**
 * A row's actions as its context menu (DF67, as the design list's DF16): right-click, or
 * Shift+F10 / the Menu key on the focused row; none in read-only plans. Focus returns to the row.
 */
function RowMenu({
  enabled,
  label,
  items,
  onClose,
  children,
}: {
  enabled: boolean
  label: string
  items: readonly MenuEntry[]
  onClose: () => void
  children: React.JSX.Element
}): React.JSX.Element {
  if (!enabled) return children
  return (
    <ContextMenu
      label={label}
      items={items}
      onCloseAutoFocus={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      {children}
    </ContextMenu>
  )
}

/** The grip in a row's start gutter (as the design operation list, DF24). */
function RowGrip({ grip }: { grip: { onPointerDown(e: PointerEvent): void } }): React.JSX.Element {
  return <DragGrip title={m.reorder.grip} className={styles['rowGrip']} {...grip} />
}

/** A setup's plan operations: their own reorderable list (a drag stays within the setup). */
function SetupOperations({
  label,
  setup,
  canMove,
  onMove,
  children,
}: {
  label: string
  setup: SetupDTO
  canMove: boolean
  onMove(id: string, to: number): Promise<boolean>
  children: (op: PlanOperationDTO, reorder: Reorder, index: number) => React.JSX.Element
}): React.JSX.Element {
  const reorder = useReorder({
    count: setup.operations.length,
    order: setup.operations.map((o) => o.id).join(' '),
    onMove: (from, to) => {
      const op = setup.operations[from]
      return op === undefined || to === from ? false : onMove(op.id, to)
    },
  })
  const { attachList } = reorder
  return (
    <ol
      ref={attachList}
      className={`${styles['ops']} ${canMove ? styles['gripped'] : ''} ${reorder.listClass}`}
      aria-label={label}
      {...reorder.listProps}
    >
      {setup.operations.map((op, i) => children(op, reorder, i))}
    </ol>
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
  menuKeys,
  reorder,
  index,
  rowRef,
  onSelect,
  onMenuClose,
  onShowFindings,
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
  /** The row button's keys and the row menu hint (DF70). */
  menuKeys: { 'aria-keyshortcuts': string; 'aria-describedby'?: string }
  /** The setup's operation list reorder (its grip and row props). */
  reorder: Reorder
  index: number
  rowRef: (el: HTMLButtonElement | null) => void
  onSelect: () => void
  /** The row menu closed: the focus goes back to the row. */
  onMenuClose: () => void
  /**
   * A click on the error or warning count (DF67): select the operation (never off) and focus
   * its inspector's Checks block. A pointer shortcut inside the row's button, not a tab stop.
   */
  onShowFindings: (e: MouseEvent) => void
  onKeyDown: (e: KeyboardEvent) => void
  onMove: (by: -1 | 1) => void
  onSplit: () => void
  onMoveTo: (setup: SetupDTO) => void
}): React.JSX.Element {
  const name = planOperationName(plan, op)
  const findings = findingsOf(data?.warnings ?? [], op.id)
  const errors = findings.filter(isError).length
  const warnings = findings.filter(isWarning).length
  const state = toolpathState(data?.toolpaths[op.id], failure)
  const stale = rowStale(data?.stale, op.designOperationIds)
  const tool = snapshotName(plan, op.tool)
  const others = sameDirectionSetups(plan, setup)
  const menu: MenuEntry[] = [
    {
      label: m.operations.moveUpItem,
      icon: <Icon name="arrow-up" />,
      shortcut: 'Alt+↑',
      disabled: operationStep(plan, op.id, -1) === undefined,
      onSelect: () => onMove(-1),
    },
    {
      label: m.operations.moveDownItem,
      icon: <Icon name="arrow-down" />,
      shortcut: 'Alt+↓',
      disabled: operationStep(plan, op.id, 1) === undefined,
      onSelect: () => onMove(1),
    },
    'separator',
    {
      label: m.operations.split,
      icon: <Icon name="split" />,
      disabled: setup.operations.length < 2,
      onSelect: onSplit,
    },
    ...others.map((s) => ({
      label: m.operations.moveTo(s.name),
      icon: <Icon name="move-to" />,
      onSelect: () => onMoveTo(s),
    })),
  ]
  return (
    <RowMenu
      enabled={canMove}
      label={m.operations.actions(name)}
      onClose={onMenuClose}
      items={menu}
    >
      <li
        {...reorder.itemProps(index)}
        className={styles['op']}
        data-row-menu={canMove ? '' : undefined}
        data-selected={selected ? '' : undefined}
        data-aid={op.aid === undefined ? undefined : op.aid.kind}
      >
        {canMove && setup.operations.length > 1 ? (
          <RowGrip grip={reorder.gripProps(index)} />
        ) : null}
        <button
          type="button"
          ref={rowRef}
          className={`${styles['opSelect']} ${styles['planRow']}`}
          aria-pressed={selected}
          {...menuKeys}
          onClick={onSelect}
          onKeyDown={onKeyDown}
        >
          <Icon name={planOperationIcon(plan, op.designOperationIds, op.aid)} />
          <span className={styles['opText']}>
            <span className={styles['opName']} title={name}>
              <NameWords name={name} />
            </span>
            <span className={styles['opMeta']}>
              <span className={styles['opTool']}>{tool ?? m.operations.noTool}</span>
            </span>
          </span>
          <span className={styles['opStatus']}>
            {stale !== undefined ? (
              <span className={styles['opStale']} title={staleText(stale)}>
                <Icon name="history" />
                <span className={styles['srOnly']}>{staleText(stale)}</span>
              </span>
            ) : null}
            <span className={styles['opState']} data-state={state} title={m.toolpaths.state[state]}>
              {state === 'ready' ? (
                <Icon name="success" />
              ) : state === 'failed' ? (
                <Icon name="error" />
              ) : (
                <Icon name="not-started" />
              )}
              <span className={styles['srOnly']}>{m.toolpaths.state[state]}</span>
            </span>
            {errors > 0 ? (
              <span
                className={`${styles['opFailed']} ${styles['opFindings']}`}
                title={m.operations.findingsTip(m.operations.errors(errors))}
                onClick={onShowFindings}
              >
                <Icon name="error" />
                <span aria-hidden="true">{errors}</span>
                <span className={styles['srOnly']}>{m.operations.errors(errors)}</span>
              </span>
            ) : null}
            {warnings > 0 ? (
              <span
                className={`${styles['opBadge']} ${styles['opFindings']}`}
                title={m.operations.findingsTip(m.operations.warnings(warnings))}
                onClick={onShowFindings}
              >
                <Icon name="warning" />
                <span aria-hidden="true">{warnings}</span>
                <span className={styles['srOnly']}>{m.operations.warnings(warnings)}</span>
              </span>
            ) : null}
          </span>
        </button>
      </li>
    </RowMenu>
  )
}

/**
 * A plan operation's name for its row: a count or instance number stays with its sign when the
 * name wraps ("Bolt hole 2 · drill × 6", never "× / 6"; DF44). The text is unchanged.
 */
function NameWords({ name }: { name: string }): React.JSX.Element {
  const parts = name.split(/( (?:×|·) \d+)(?=,|$)/)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className={styles['nowrap']}>
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  )
}

const staleText = (s: 'removed' | 'changed' | 'edited') =>
  s === 'removed' ? m.stale.rowRemoved : s === 'changed' ? m.stale.rowChanged : m.stale.rowEdited
