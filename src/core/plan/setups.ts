/**
 * Several setups (v0.2): one setup per approach direction, the default setup order, split /
 * merge / move, and the checks across setups. Pure functions over plan DTOs.
 * Doc: docs/modes/plan-v0.2.md#setups-from-face-directions
 */
import { fail, Ok, type AppResult } from '../../shared/result'
import type { IdGenerator } from '../commands/context'
import type { Part } from '../design/operation'
import { DIRECTION, DIRECTION_LABEL, SETUP_ORDER, type Direction } from '../geometry/face'
import type { Region2dPort } from '../geometry/2d/port'
import type { Stock } from '../library/stock'
import type { PlanWarning } from './checks'
import { ALIGNMENT_POINTS_MAX } from './alignment.dto'
import {
  defaultOrder,
  edgeDependencies,
  onDependencies,
  operationDirections,
  orderFindings,
} from './order'
import type { PlanDTO, PlanOperationDTO, SetupDTO, SetupRotation } from './plan.dto'
import { holdsOnSurface } from './workholding/items'

/** Default setup order (decision 3), defined with the face model (design reads it too, DF50). */
export { SETUP_ORDER }

export const setupDirection = (s: Pick<SetupDTO, 'direction'>): Direction => s.direction ?? '+z'
export const setupRotation = (s: Pick<SetupDTO, 'rotation'>): SetupRotation => s.rotation ?? 0

/** "Top", "Bottom", …; a further setup of one direction "Top 2", "Top 3". */
export function defaultSetupName(direction: Direction, setups: readonly SetupDTO[]): string {
  const label = DIRECTION_LABEL[direction]
  const base = label.charAt(0).toUpperCase() + label.slice(1)
  const names = new Set(setups.map((s) => s.name))
  if (!names.has(base)) return base
  let n = 2
  while (names.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/** A new setup record; `direction` is left out for `+z` (as v0.1 records). */
export function newSetup(
  id: string,
  direction: Direction,
  heights: Pick<SetupDTO, 'clearanceHeight' | 'retractHeight'>,
  setups: readonly SetupDTO[],
  name?: string,
): SetupDTO {
  return {
    id,
    name: name ?? defaultSetupName(direction, setups),
    ...(direction === '+z' ? {} : { direction }),
    workOffset: 'G54',
    clearanceHeight: { ...heights.clearanceHeight },
    retractHeight: { ...heights.retractHeight },
    operations: [],
  }
}

/** Index at which a new setup of `direction` goes: before the first setup ranked later. */
export function defaultSetupIndex(setups: readonly SetupDTO[], direction: Direction): number {
  const rank = SETUP_ORDER.indexOf(direction)
  const at = setups.findIndex((s) => SETUP_ORDER.indexOf(setupDirection(s)) > rank)
  return at < 0 ? setups.length : at
}

/**
 * Setups of `plan.create`: one per direction in use, in the default setup order, each in the
 * default machining order (`port`: general shapes in the freeing test), a setup after the first
 * preferring the last tool of the one before (DF65). No operations: one `+z` setup.
 */
export function deriveSetups(
  planOps: readonly PlanOperationDTO[],
  part: Part,
  make: (direction: Direction, setups: readonly SetupDTO[]) => SetupDTO,
  port?: Region2dPort,
): SetupDTO[] {
  const dir = operationDirections(planOps, part)
  const cross = crossSetupDependencies(planOps, part, dir)
  const setups: SetupDTO[] = []
  for (const d of SETUP_ORDER) {
    const ops = planOps.filter((p) => dir.get(p.id) === d && !cross.has(p.id))
    if (ops.length === 0) continue
    const s = make(d, setups)
    // DF65: start with the tool still in the spindle when that costs no tool run
    s.operations = defaultOrder(ops, part, port, setups.at(-1)?.operations.at(-1)?.tool)
    setups.push(s)
  }
  // E4b: an operation that needs one of another direction (a bottom chamfer's through profile)
  // goes to a setup of its direction after it: "Bottom 2" after the top when the bottom was
  // faced first, the flip back to the bottom
  for (const d of SETUP_ORDER) {
    const ops = planOps.filter((p) => dir.get(p.id) === d && cross.has(p.id))
    if (ops.length === 0) continue
    const deps = new Set(ops.flatMap((p) => cross.get(p.id) ?? []))
    const after = setups.findLastIndex((s) => s.operations.some((q) => deps.has(q.id)))
    const s = make(d, setups)
    const tool = setups[after]?.operations.at(-1)?.tool
    s.operations = defaultOrder(ops, part, port, tool)
    setups.splice(after + 1, 0, s)
  }
  if (setups.length === 0) setups.push(make('+z', setups))
  return setups
}

/**
 * Plan operations that depend on a plan operation of another face direction (E4b: a bottom
 * chamfer on a through profile cut from the top), with those plan operations' ids.
 */
export function crossSetupDependencies(
  planOps: readonly PlanOperationDTO[],
  part: Part,
  dir: ReadonlyMap<string, Direction> = operationDirections(planOps, part),
): Map<string, string[]> {
  const owner = new Map<string, string>()
  for (const p of planOps) for (const d of p.designOperationIds) owner.set(d, p.id)
  const byId = new Map(part.operations.map((o) => [o.id, o]))
  const out = new Map<string, string[]>()
  for (const p of planOps) {
    const deps = p.designOperationIds.flatMap((id) => {
      const o = byId.get(id)
      return o === undefined ? [] : [...onDependencies(o), ...edgeDependencies(o)]
    })
    const other = [
      ...new Set(
        deps.flatMap((d) => owner.get(d) ?? []).filter((q) => dir.get(q) !== dir.get(p.id)),
      ),
    ]
    if (other.length > 0) out.set(p.id, other)
  }
  return out
}

/** Every plan operation in machining order: the setups in order, each in its order. */
export const allOperations = (setups: readonly SetupDTO[]): PlanOperationDTO[] =>
  setups.flatMap((s) => s.operations)

export function unknownSetup(setupId: string, path: string, where: string): AppResult<never> {
  return fail('input.malformed', `setup ${setupId} does not exist`, {
    issues: [{ path: [path], rule: 'unknownSetup', message: 'no such setup' }],
    where,
  })
}

/**
 * The setup a per-setup command works on (`plan.export`, `run.job.start`, task E2): `setupId`, or
 * the only setup when it is left out. A plan with several setups needs it (`plan.setup`, rule
 * `setupRequired`: one program per setup, never one across a re-fixture); an unknown id fails
 * with `input.malformed` (`unknownSetup`). `next` is the setup after it in machining order.
 * Doc: docs/modes/plan-v0.2.md#implementation-task-e2
 */
export function chooseSetup(
  setups: readonly SetupDTO[],
  setupId: string | undefined,
  where: string,
): AppResult<{ readonly setup: SetupDTO; readonly next: SetupDTO | undefined }> {
  if (setupId === undefined) {
    if (setups.length > 1)
      return fail('plan.setup', `the plan has ${setups.length} setups; name one with setupId`, {
        issues: [
          {
            path: ['setupId'],
            rule: 'setupRequired',
            message: 'one program per setup: name the setup',
            params: { setupIds: setups.map((s) => s.id) },
          },
        ],
        where,
      })
    const only = setups[0]
    // a plan always has a setup (v0.1 invariant; a rebuild keeps one)
    if (only === undefined) return fail('internal.unexpected', 'plan without a setup', { where })
    return Ok({ setup: only, next: undefined })
  }
  const index = setups.findIndex((s) => s.id === setupId)
  if (index < 0) return unknownSetup(setupId, 'setupId', where)
  return Ok({ setup: setups[index]!, next: setups[index + 1] })
}

/** `plan.setup`: setups of different directions cannot share one setup. */
export function directionMismatch(
  a: Direction,
  b: Direction,
  path: string,
  where: string,
): AppResult<never> {
  return fail(
    'plan.setup',
    `a ${a} and a ${b} setup cannot be joined: one approach direction per setup`,
    {
      issues: [
        {
          path: [path],
          rule: 'sameDirection',
          message: 'not the same direction',
          params: { a, b },
        },
      ],
      where,
    },
  )
}

/**
 * `plan.order` when the reordered setups add an order violation (an operation before the one whose
 * surface it starts from) that the plan did not have before; existing ones are left to the checks.
 */
export function checkNoNewOrderViolation(
  before: readonly SetupDTO[],
  after: readonly SetupDTO[],
  part: Part,
  path: string,
  where: string,
): AppResult<void> {
  const key = (w: PlanWarning) => `${w.planOperationId}>${String(w.params['dependsOn'])}`
  const violations = (setups: readonly SetupDTO[]) =>
    orderFindings(allOperations(setups), part).filter((w) => w.code === 'plan.order')
  const had = new Set(violations(before).map(key))
  const added = violations(after).filter((w) => !had.has(key(w)))
  if (added.length === 0) return Ok(undefined)
  return fail('plan.order', added.map((w) => w.message).join('; '), {
    issues: added.map((w) => ({
      path: [path],
      rule: w.rule,
      message: w.message,
      params: w.params,
    })),
    where,
  })
}

/** Split: the chosen operations (in their order) into a new setup of the same direction after it. */
export function splitSetup(
  plan: PlanDTO,
  args: { setupId: string; planOperationIds: readonly string[]; name?: string | undefined },
  ids: IdGenerator,
  where: string,
): AppResult<SetupDTO[]> {
  const at = plan.setups.findIndex((s) => s.id === args.setupId)
  const source = plan.setups[at]
  if (source === undefined) return unknownSetup(args.setupId, 'setupId', where)
  const chosen = new Set(args.planOperationIds)
  const foreign = [...chosen].filter((id) => !source.operations.some((o) => o.id === id))
  if (foreign.length > 0)
    return fail('input.malformed', `${foreign.join(', ')} not in setup ${source.id}`, {
      issues: foreign.map((id) => ({
        path: ['planOperationIds', id],
        rule: 'notInSetup',
        message: 'not an operation of this setup',
      })),
      where,
    })
  if (chosen.size === source.operations.length)
    return fail('input.malformed', 'a split must leave operations in the setup', {
      issues: [
        { path: ['planOperationIds'], rule: 'allOperations', message: 'leave at least one' },
      ],
      where,
    })
  const created = newSetup(
    ids.next('setup'),
    setupDirection(source),
    source,
    plan.setups,
    args.name,
  )
  if (source.rotation !== undefined) created.rotation = source.rotation
  created.operations = source.operations.filter((o) => chosen.has(o.id))
  const setups = [...plan.setups]
  setups[at] = { ...source, operations: source.operations.filter((o) => !chosen.has(o.id)) }
  setups.splice(at + 1, 0, created)
  return Ok(setups)
}

/** Merge: setups of one direction into the first of them in machining order. */
export function mergeSetups(
  plan: PlanDTO,
  setupIds: readonly string[],
  where: string,
): AppResult<SetupDTO[]> {
  for (const id of setupIds)
    if (!plan.setups.some((s) => s.id === id)) return unknownSetup(id, 'setupIds', where)
  const merged = plan.setups.filter((s) => setupIds.includes(s.id))
  const into = merged[0]!
  for (const s of merged.slice(1))
    if (setupDirection(s) !== setupDirection(into))
      return directionMismatch(setupDirection(into), setupDirection(s), 'setupIds', where)
  // alignment phase 1: the points of all, the first setup's zero (docs/modes/plan-v0.2.md#alignment-phase-1)
  const alignment = merged.flatMap((s) => s.alignment ?? []).slice(0, ALIGNMENT_POINTS_MAX)
  return Ok(
    plan.setups.flatMap((s) =>
      s === into
        ? [
            {
              ...s,
              operations: allOperations(merged),
              ...(alignment.length === 0 ? {} : { alignment }),
            },
          ]
        : setupIds.includes(s.id)
          ? []
          : [s],
    ),
  )
}

/**
 * The machine findings per setup (docs/modes/plan-v0.2.md#setups-from-face-directions): the
 * stock's extent along `u`, `v`, `n` of the setup's direction (`u`/`v` swapped by a 90°/270°
 * rotation) on machine X, Y, Z. For `+z` without rotation: length, width, thickness.
 */
export function setupStockSize(
  stock: Stock,
  setup: Pick<SetupDTO, 'direction' | 'rotation'>,
): { x: [string, number]; y: [string, number]; z: [string, number] } {
  const info = DIRECTION[setupDirection(setup)]
  const size = (d: 'length' | 'width' | 'thickness'): [string, number] => [d, stock[d].canonical]
  const u = size(info.uSize)
  const v = size(info.vSize)
  const turned = setupRotation(setup) % 180 !== 0
  return { x: turned ? v : u, y: turned ? u : v, z: size(info.extent) }
}

/**
 * A profile that cuts through (every v0.1/v0.2 profile; v0.3 `on` without `depth`); a roughing
 * profile (DF122 R4) leaves a skin.
 */
const isThroughProfile = (op: Part['operations'][number] | undefined): boolean =>
  op?.kind === 'profile' && op.depth.isNone() && op.roughing !== true

/**
 * `plan.cutoutBeforeSetup` (warning): a through profile in a setup before another setup; the part
 * (or the slug) is held only by its tabs while it is re-fixtured. A blind `on` groove (v0.3)
 * frees nothing; a setup held on a surface (tape, vacuum, glue; W5,
 * docs/modes/workholding.md#held-pieces-and-screws-in-the-part-w5) keeps its pieces held.
 */
export function setupFindings(setups: readonly SetupDTO[], part: Part): PlanWarning[] {
  const out: PlanWarning[] = []
  const byId = new Map(part.operations.map((o) => [o.id, o]))
  setups.forEach((s, i) => {
    const next = setups[i + 1]
    if (next === undefined || holdsOnSurface(s)) return
    for (const op of s.operations)
      for (const d of op.designOperationIds)
        if (isThroughProfile(byId.get(d)))
          out.push({
            code: 'plan.cutoutBeforeSetup',
            severity: 'warning',
            message: `${d} cuts through in setup ${s.name} before setup ${next.name}: held only by its tabs while re-fixtured`,
            planOperationId: op.id,
            rule: 'cutoutLast',
            params: { profile: d, setupId: s.id, nextSetupId: next.id },
          })
  })
  return out
}
