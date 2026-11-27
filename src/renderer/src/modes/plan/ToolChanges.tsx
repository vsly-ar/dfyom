// "Tool changes" of the setup inspector (hardening DF66): the setup's tool runs in machining order
// (tool with Ø and type, its plan operations, the estimated time less its lowered links' savings,
// DF64 L3) and the count of tool changes,
// the one at the setup start included unless the tool stays in the spindle from the setup before
// (DF65). In editable plans a run reorders as a block like the plan lists (`ui/Reorder`: grip
// drag, Alt+↑/↓ on the focused row, ↑/↓ between rows), one `plan.operation.move { count }` each;
// a refused move shakes the row back and says why under the list. DF69: each run's "Z from" (its
// Z reference surface and level; a default in the secondary colour, a choice in the primary) opens
// a menu of the eligible surfaces with "Default" on top (`plan.operation.update { zRef }` on the
// run's first operation); a `plan.zRef` finding of the run shows its icon beside it. Hovering
// "Z from" or focusing a row shows that run's reference in the viewport (`previewZRef`).
// DF130: each run's minimum stickout under its operations ("Needs ≥ 25.5 mm stickout"); DF132 H3:
// the clamp under the collet nut that decides it, or "Clamps not yet checked" while a toolpath is
// not current (docs/modes/tool-holder.md#minimum-stickout-gains-the-clamp-term).
// Doc: docs/conventions/ui.md#design-and-plan-controls-v02, docs/modes/plan-v0.4.md#tool-changes-per-setup-hardening-df66,
// docs/modes/z-reference.md#ui
import { useRef, useState, type KeyboardEvent } from 'react'
import type { ToolType } from '../../../../core/library/tool.dto'
import type { PlanDTO, PlanOperationDTO, SetupDTO } from '../../../../core/plan/plan.dto'
import {
  carriedTool,
  runLinkSavings,
  runStickoutNeeded,
  setupToolChanges,
  shownStickout,
  toolRuns,
} from '../../../../core/plan/tool-runs'
import type { UnitSystem } from '../../../../core/project/document'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import { TOOL_TYPE_ICON } from '../../library/toolTypeIcon'
import type { PlanWarning } from '../../../../core/plan/checks'
import { withoutOperationName } from '../../../../core/plan/labels'
import { lengthSource } from '../../messages/dfm'
import { libraryMessages } from '../../messages/library'
import { areaText, planMessages, sentence } from '../../messages/plan'
import {
  DragGrip,
  Icon,
  Menu,
  ReorderStatus,
  useReorder,
  type MenuEntry,
  InspectorGroup,
} from '../../ui'
import { quantityOf } from '../design/model'
import { allows, planOperationName, toolpathState, type ToolpathEntry } from './model'
import {
  usePlanCommand,
  usePlanState,
  usePlanStore,
  type LoweredLinkView,
  type ZRefCandidateView,
  type ZRefRunView,
} from './plan-store'
import styles from './ToolChanges.module.css'

const m = planMessages.toolChanges

interface ToolFacts {
  readonly name: string
  readonly meta: string
  readonly type: ToolType | undefined
}

/** The tool copy's name, "Ø 6 mm · Flat end mill" and type, from the plan's snapshot. */
function toolFacts(plan: PlanDTO, snapshotId: string | undefined, units: UnitSystem): ToolFacts {
  const v = plan.snapshots.find((s) => s.id === snapshotId)?.values as
    { name?: unknown; type?: unknown; diameter?: QuantityDTO } | undefined
  if (snapshotId === undefined || v === undefined)
    return { name: m.noTool, meta: '', type: undefined }
  const type =
    typeof v.type === 'string' && v.type in TOOL_TYPE_ICON ? (v.type as ToolType) : undefined
  const dc = v.diameter === undefined ? undefined : quantityOf(v.diameter)
  return {
    name: typeof v.name === 'string' ? v.name : m.noTool,
    meta: m.toolMeta(
      dc === undefined ? undefined : lengthSource(dc.canonical, units),
      type === undefined ? undefined : libraryMessages.tool.types[type],
    ),
    type,
  }
}

/**
 * The run's estimated seconds, or undefined while a toolpath is missing or outdated: its
 * toolpaths' estimates less what its lowered links save (DF64 L3, as `plan_get`'s tool runs).
 */
function runSeconds(
  ops: readonly PlanOperationDTO[],
  setup: SetupDTO,
  toolpaths: Readonly<Record<string, ToolpathEntry>>,
  lowered: readonly LoweredLinkView[],
): number | undefined {
  let sum = 0
  for (const op of ops) {
    const e = toolpaths[op.id]
    if (e === undefined || e.toolpath === null || toolpathState(e, undefined) !== 'ready')
      return undefined
    sum += e.toolpath.stats.estimatedSeconds
  }
  const indices = ops.map((o) => setup.operations.findIndex((x) => x.id === o.id))
  return Math.max(0, sum - runLinkSavings(lowered, indices))
}

/** "Facing 1 floor · −0.5 mm" (a typographic minus, as the plan lists write levels). */
const zValue = (c: ZRefCandidateView, units: UnitSystem): string =>
  m.zValue(c.label, lengthSource(c.level, units).replace(/^-/, '−'))

const NO_LINKS: readonly LoweredLinkView[] = []

/** "25.5 mm" or '1.01"' as `lengthSource` writes lengths (already rounded up, DF130). */
const stickoutText = (v: number, inch: boolean): string => (inch ? `${v}"` : `${v} mm`)

const SEVERITY_RANK: Readonly<Record<string, number>> = { error: 3, warning: 2, info: 1 }

/**
 * DF69: the run's Z reference as a button opening the menu of its eligible surfaces ("Default" on
 * top), or as text when it cannot change. Shared by the tool-change row and the operation
 * inspector. `storedSurface`: the surface stored on the run's first operation (checked).
 */
export function ZRefButton({
  planId,
  run,
  tool,
  units,
  editable,
  storedSurface,
  onRefused,
  readOnly: _readOnly,
  ...control
}: {
  planId: string
  run: ZRefRunView
  tool: string
  units: UnitSystem
  editable: boolean
  storedSurface: string | undefined
  onRefused: (message: string | undefined) => void
  /** Field-injected (FieldControlProps): `readOnly` is `editable`'s business here. */
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
  readOnly?: boolean
}): React.JSX.Element {
  const call = usePlanCommand()
  const z = run.zRef
  const value = z === null ? m.zNone : zValue(z, units)
  const chosen = z?.chosen === true
  const choose = async (zRef: { surface: string } | null) => {
    const r = await call('plan.operation.update', {
      planId,
      planOperationId: run.planOperationId,
      zRef,
    })
    onRefused(r.ok ? undefined : m.zRefused(sentence(r.error.message)))
  }
  const spot = (c: ZRefCandidateView) =>
    `(${lengthSource(c.at[0], units)}, ${lengthSource(c.at[1], units)})`
  const items: MenuEntry[] = [
    {
      label: m.zDefault(chosen ? undefined : z === null ? undefined : zValue(z, units)),
      description: m.zDefaultHint,
      icon: storedSurface !== undefined ? undefined : <Icon name="check" />,
      onSelect: () => void choose(null),
    },
    ...(run.candidates.length > 0
      ? [
          {
            group: m.zSurfaces,
            items: run.candidates.map((c) => ({
              label: zValue(c, units),
              description: m.zCandidate(areaText(c.area, units), spot(c), c.small),
              icon: storedSurface === c.surface ? <Icon name="check" /> : undefined,
              onSelect: () => void choose({ surface: c.surface }),
            })),
          },
        ]
      : []),
  ]
  return editable && (run.candidates.length > 0 || chosen) ? (
    <Menu items={items}>
      <button
        type="button"
        {...control}
        className={styles['zValue']}
        data-chosen={chosen ? '' : undefined}
        aria-label={m.zButton(tool, value, chosen)}
      >
        {value}
      </button>
    </Menu>
  ) : (
    <span {...control} className={styles['zValue']} data-chosen={chosen ? '' : undefined}>
      {value}
    </span>
  )
}

/** DF69: the run's "Z from" with the menu of its eligible surfaces and its worst finding. */
function ZFrom({
  findings,
  ...props
}: Parameters<typeof ZRefButton>[0] & { findings: readonly PlanWarning[] }): React.JSX.Element {
  const store = usePlanStore()
  const worst = findings.reduce<PlanWarning | undefined>(
    (w, f) => ((SEVERITY_RANK[f.severity] ?? 0) > (SEVERITY_RANK[w?.severity ?? ''] ?? 0) ? f : w),
    undefined,
  )
  const id = props.run.planOperationId
  const icon =
    worst === undefined ? null : (
      <span
        className={styles['zFinding']}
        data-severity={worst.severity}
        title={sentence(withoutOperationName(worst.message, worst.planOperationId))}
      >
        <Icon
          name={
            worst.severity === 'error' ? 'error' : worst.severity === 'warning' ? 'warning' : 'info'
          }
          label={sentence(withoutOperationName(worst.message, worst.planOperationId))}
        />
      </span>
    )
  return (
    <span
      className={styles['zFrom']}
      onPointerEnter={() => store.getState().previewZRef(id)}
      onPointerLeave={() => {
        if (store.getState().zRefPreview === id) store.getState().previewZRef(undefined)
      }}
    >
      <span className={styles['zLabel']}>{m.zFrom}</span>
      <ZRefButton {...props} />
      {icon}
    </span>
  )
}

export function ToolChanges({
  plan,
  setup,
  units,
  toolpaths,
}: {
  plan: PlanDTO
  setup: SetupDTO
  units: UnitSystem
  toolpaths: Readonly<Record<string, ToolpathEntry>>
}): React.JSX.Element | null {
  const call = usePlanCommand()
  const index = plan.setups.findIndex((s) => s.id === setup.id)
  const runs = toolRuns(setup.operations)
  const carried = carriedTool(plan.setups, index)
  const before = plan.setups[index - 1]
  const canMove = allows(plan, 'plan.operation.move') && runs.length > 1
  const [announcement, setAnnouncement] = useState('')
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const rows = useRef(new Map<number, HTMLLIElement>())
  const store = usePlanStore()
  const zRefs = usePlanState((s) => s.data?.zRefs)
  const warnings = usePlanState((s) => s.data?.warnings)
  const opRows = usePlanState((s) => s.data?.operations)
  const lowered = usePlanState(
    (s) => s.data?.links.find((l) => l.setupId === setup.id)?.links?.lowered,
  )
  const canZ = allows(plan, 'plan.operation.update')

  /** Run `from` to run position `to` (after the move): one block move; false: refused. */
  const runTo = async (from: number, to: number) => {
    const run = runs[from]
    if (run === undefined || to === from || to < 0 || to >= runs.length) return false
    const others = runs.filter((_, i) => i !== from)
    const toIndex = others.slice(0, to).reduce((n, r) => n + r.operations.length, 0)
    const r = await call('plan.operation.move', {
      planId: plan.id,
      planOperationId: run.operations[0]!.id,
      count: run.operations.length,
      toIndex,
    })
    if (!r.ok) {
      setRefusal(m.refused(sentence(r.error.message)))
      return false
    }
    setRefusal(undefined)
    const name = toolFacts(plan, run.tool, units).name
    setAnnouncement(planMessages.reorder.moved(name, to + 1, runs.length))
    rows.current.get(to)?.focus()
    return true
  }
  const reorder = useReorder({
    count: runs.length,
    order: runs.map((r) => r.operations.map((o) => o.id).join('+')).join(' '),
    onMove: runTo,
  })
  const { attachList } = reorder
  const rowRef = (i: number) => (el: HTMLLIElement | null) => {
    if (el) rows.current.set(i, el)
    else rows.current.delete(i)
  }
  const step = async (i: number, by: -1 | 1) => {
    const to = i + by
    if (to < 0 || to >= runs.length) return
    reorder.glide(i, to)
    if (!(await runTo(i, to))) reorder.shake(i)
  }
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.target !== e.currentTarget) return
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const by = e.key === 'ArrowUp' ? -1 : 1
    if (e.altKey) void step(i, by)
    else rows.current.get(i + by)?.focus()
  }

  const zRun = (id: string) =>
    zRefs?.find((r) => r.setupId === setup.id && r.planOperationId === id)
  if (runs.length === 0) return null
  const count = setupToolChanges(plan.setups, index)
  return (
    <InspectorGroup title={m.title} meta={m.count(count)} className={styles['section']}>
      <ol
        ref={attachList}
        className={`${styles['runs']} ${canMove ? styles['gripped'] : ''} ${reorder.listClass}`}
        aria-label={m.listLabel(setup.name)}
        {...reorder.listProps}
      >
        {runs.map((run, i) => {
          const tool = toolFacts(plan, run.tool, units)
          const seconds = runSeconds(run.operations, setup, toolpaths, lowered ?? NO_LINKS)
          const names = run.operations.map((o) => planOperationName(plan, o))
          const isCarried = i === 0 && carried !== undefined && before !== undefined
          // DF130: the run's minimum stickout, rounded up as the program writes it
          const rowsOf = run.operations.map((o) => opRows?.find((r) => r.id === o.id))
          const needed =
            run.tool === undefined
              ? undefined
              : runStickoutNeeded(rowsOf.map((r) => r?.stickoutNeeded))
          // DF132 H3: what decides it (the first operation with the run's number)
          const reason = rowsOf.find(
            (r) => needed !== undefined && r?.stickoutNeeded === needed,
          )?.stickoutReason
          const pending = rowsOf.some((r) => r?.stickoutReason?.clamps === 'pending')
          const shown = (mm: number) =>
            stickoutText(shownStickout(mm, units === 'inch'), units === 'inch')
          const clamp =
            reason?.kind === 'workholding'
              ? { part: reason.part ?? 'nut', item: reason.itemName ?? '' }
              : undefined
          return (
            <li
              key={run.operations.map((o) => o.id).join('+')}
              {...reorder.itemProps(i)}
              ref={rowRef(i)}
              className={styles['run']}
              tabIndex={canMove ? 0 : undefined}
              aria-keyshortcuts={canMove ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
              onKeyDown={canMove ? (e) => onKey(e, i) : undefined}
              onFocus={() => store.getState().previewZRef(run.operations[0]!.id)}
              onBlur={(e) => {
                // focus left for nothing (a press in the viewport, to drag the spot): keep it
                if (e.relatedTarget === null) return
                if (e.currentTarget.contains(e.relatedTarget as Node)) return
                if (store.getState().zRefPreview === run.operations[0]!.id)
                  store.getState().previewZRef(undefined)
              }}
            >
              {canMove ? (
                <DragGrip
                  title={planMessages.reorder.grip}
                  className={styles['grip']}
                  {...reorder.gripProps(i)}
                />
              ) : null}
              <span className={styles['number']}>{i + 1}</span>
              <span className={styles['icon']} aria-hidden="true">
                {tool.type !== undefined ? <Icon name={TOOL_TYPE_ICON[tool.type]} /> : null}
              </span>
              <span className={styles['body']}>
                <span className={styles['toolLine']}>
                  <span className={styles['tool']}>{tool.name}</span>
                  {tool.meta !== '' ? <span className={styles['meta']}>{tool.meta}</span> : null}
                </span>
                <span className={styles['ops']}>{names.join(', ')}</span>
                {needed === undefined ? null : (
                  <span
                    className={styles['stickout']}
                    title={
                      clamp !== undefined
                        ? m.stickoutClampTitle(clamp.part, clamp.item)
                        : pending
                          ? m.stickoutPendingTitle
                          : m.stickoutTitle
                    }
                  >
                    {clamp !== undefined
                      ? m.stickoutClamp(shown(needed), clamp.part, clamp.item)
                      : pending
                        ? m.stickoutPending(shown(needed))
                        : m.stickout(shown(needed))}
                  </span>
                )}
                {zRun(run.operations[0]!.id) === undefined ? null : (
                  <ZFrom
                    planId={plan.id}
                    run={zRun(run.operations[0]!.id)!}
                    tool={tool.name}
                    units={units}
                    editable={canZ}
                    storedSurface={run.operations[0]!.zRef?.surface}
                    findings={(warnings ?? []).filter(
                      (w) => w.code === 'plan.zRef' && w.planOperationId === run.operations[0]!.id,
                    )}
                    onRefused={setRefusal}
                  />
                )}
                {isCarried ? (
                  <span className={styles['carried']}>{m.carried(before.name)}</span>
                ) : null}
              </span>
              <span
                className={styles['time']}
                title={seconds === undefined ? m.noTime : m.timeTitle}
                data-unknown={seconds === undefined ? '' : undefined}
              >
                {seconds === undefined ? (
                  <>
                    <span aria-hidden="true">–</span>
                    <span className={styles['srOnly']}>{m.noTime}</span>
                  </>
                ) : (
                  m.time(seconds)
                )}
              </span>
            </li>
          )
        })}
      </ol>
      <ReorderStatus refusal={refusal} announcement={announcement} />
    </InspectorGroup>
  )
}
