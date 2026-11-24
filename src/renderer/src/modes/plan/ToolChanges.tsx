// "Tool changes" of the setup inspector (hardening DF66): the setup's tool runs in machining order
// (tool with Ø and type, its plan operations, the estimated time) and the count of tool changes,
// the one at the setup start included unless the tool stays in the spindle from the setup before
// (DF65). In editable plans a run reorders as a block like the plan lists (`ui/Reorder`: grip
// drag, Alt+↑/↓ on the focused row, ↑/↓ between rows), one `plan.operation.move { count }` each;
// a refused move shakes the row back and says why under the list.
// Doc: docs/conventions/ui.md#design-and-plan-controls-v02, docs/modes/plan-v0.4.md#tool-changes-per-setup-hardening-df66
import { useRef, useState, type KeyboardEvent } from 'react'
import type { ToolType } from '../../../../core/library/tool.dto'
import type { PlanDTO, PlanOperationDTO, SetupDTO } from '../../../../core/plan/plan.dto'
import { carriedTool, setupToolChanges, toolRuns } from '../../../../core/plan/tool-runs'
import type { UnitSystem } from '../../../../core/project/document'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import { TOOL_TYPE_ICON } from '../../library/toolTypeIcon'
import { lengthSource } from '../../messages/dfm'
import { libraryMessages } from '../../messages/library'
import { planMessages, sentence } from '../../messages/plan'
import { DragGrip, Icon, ReorderStatus, useReorder } from '../../ui'
import { quantityOf } from '../design/model'
import { allows, planOperationName, toolpathState, type ToolpathEntry } from './model'
import { usePlanCommand } from './plan-store'
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

/** The run's estimated seconds, or undefined while a toolpath is missing or outdated. */
function runSeconds(
  ops: readonly PlanOperationDTO[],
  toolpaths: Readonly<Record<string, ToolpathEntry>>,
): number | undefined {
  let sum = 0
  for (const op of ops) {
    const e = toolpaths[op.id]
    if (e === undefined || e.toolpath === null || toolpathState(e, undefined) !== 'ready')
      return undefined
    sum += e.toolpath.stats.estimatedSeconds
  }
  return sum
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

  if (runs.length === 0) return null
  const count = setupToolChanges(plan.setups, index)
  return (
    <section aria-labelledby={`tool-changes-${setup.id}`} className={styles['section']}>
      <h3 id={`tool-changes-${setup.id}`} className={styles['title']}>
        <span>{m.title}</span>
        <span className={styles['count']}>{m.count(count)}</span>
      </h3>
      <ol
        ref={attachList}
        className={`${styles['runs']} ${canMove ? styles['gripped'] : ''} ${reorder.listClass}`}
        aria-label={m.listLabel(setup.name)}
        {...reorder.listProps}
      >
        {runs.map((run, i) => {
          const tool = toolFacts(plan, run.tool, units)
          const seconds = runSeconds(run.operations, toolpaths)
          const names = run.operations.map((o) => planOperationName(plan, o.designOperationIds))
          const isCarried = i === 0 && carried !== undefined && before !== undefined
          return (
            <li
              key={run.operations.map((o) => o.id).join('+')}
              {...reorder.itemProps(i)}
              ref={rowRef(i)}
              className={styles['run']}
              tabIndex={canMove ? 0 : undefined}
              aria-keyshortcuts={canMove ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
              onKeyDown={canMove ? (e) => onKey(e, i) : undefined}
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
    </section>
  )
}
