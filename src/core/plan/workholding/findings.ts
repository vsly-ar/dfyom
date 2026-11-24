/**
 * Plan findings of workholding (WH-A–F): `plan.workholding.none` (info), `.clearanceLow` (error),
 * `.unmachined` (warning, needs the 2D port), and on a setup's current toolpaths `.collision`
 * (error), `.close` (warning) and `.breakthrough` (error). Errors block `plan.export` and
 * `run.job.start` of their setup (the export guard), never toolpath generation.
 * Doc: docs/modes/workholding.md#collision-check
 */
import type { Region2dPort } from '../../geometry/2d/port'
import type { Toolpath } from '../../toolpath/model'
import { toGeneratorInputs } from '../../toolpath/inputs'
import { setupWcs, toWcs, turnToolpath } from '../../toolpath/wcs'
import { setupZero } from '../alignment'
import type { PlanWarning } from '../checks'
import type { PlanOperationInput } from '../inputs'
import { planOperationLabel } from '../labels'
import type { LoadedPlan } from '../plan'
import type { SetupDTO } from '../plan.dto'
import { checkWorkholding, type CheckOperation, type Collision } from './check'
import { highestTop } from './obstacles'
import { setupWorkholding, type SetupWorkholding } from './setup'

/** Rounded for messages (params keep the exact value). */
const mm = (v: number): string => String(Math.round(v * 100) / 100)

const itemName = (h: SetupWorkholding, id: string) =>
  h.items.find((i) => i.id === id)?.name ?? 'an item'

/**
 * Findings that need no toolpath, per setup: `none` (no items) and `clearanceLow` (a clearance
 * height the user set below the highest item's top + margin).
 */
export function staticWorkholdingFindings(plan: LoadedPlan, setupId?: string): PlanWarning[] {
  const out: PlanWarning[] = []
  for (const setup of plan.setups) {
    if (setupId !== undefined && setup.id !== setupId) continue
    const h = setupWorkholding(setup, plan.stock)
    if (h.items.length === 0) {
      out.push({
        code: 'plan.workholding.none',
        severity: 'info',
        message: `No workholding in ${setup.name}: rapids are not checked against clamps (plan_workholding_set adds them)`,
        rule: 'none',
        params: { setupId: setup.id },
      })
      continue
    }
    const top = highestTop(h.prisms)
    if (top !== undefined && h.clearanceSet && h.clearance < top.zMax + h.margin - 1e-6)
      out.push({
        code: 'plan.workholding.clearanceLow',
        severity: 'error',
        message: `The clearance height of ${setup.name} (${mm(h.clearance)} mm) is below ${itemName(h, top.itemId)} (top ${mm(top.zMax)} mm + margin ${mm(h.margin)} mm): raise it to at least ${mm(top.zMax + h.margin)} mm or let it follow the workholding`,
        field: 'setup.clearanceHeight',
        rule: 'clearanceLow',
        params: {
          setupId: setup.id,
          itemId: top.itemId,
          clearanceHeight: h.clearance,
          needed: top.zMax + h.margin,
        },
      })
  }
  return out
}

/**
 * The check's view of a setup's toolpaths (with their inputs, in machining order), in the setup
 * frame of the items: the toolpaths are in the WCS, so a moved work zero (DF78,
 * docs/modes/alignment.md#frames) is added back to their moves.
 */
export function checkOperations(
  pairs: readonly { readonly input: PlanOperationInput; readonly toolpath: Toolpath }[],
  zero: readonly [number, number] = [0, 0],
): CheckOperation[] {
  const [zx, zy] = zero
  const back = (tp: Toolpath) =>
    zx === 0 && zy === 0 ? tp : turnToolpath(tp, { rotation: 0, size: [0, 0], zero: [-zx, -zy] })
  return pairs.map(({ input, toolpath }) => ({
    planOperationId: input.planOperationId,
    tool: {
      diameter: input.tool.diameter.canonical,
      ...(input.tool.shankDiameter.isSome()
        ? { shankDiameter: input.tool.shankDiameter.unwrap().canonical }
        : {}),
    },
    moves: back(toolpath).passes.flatMap((p) => p.moves),
  }))
}

const KIND_WORD: Readonly<Record<Collision['kind'], string>> = {
  rapid: 'a rapid',
  link: 'the link between operations',
  cut: 'a cut',
}

/**
 * The collision findings of one setup's program (`operations` in machining order, the final moves
 * of every operation of the setup, in the setup frame as `checkOperations` gives them). Their
 * X and Y (message and params) are in the WCS, what the operator reads on the machine: the check's
 * setup-frame point less the work `zero` (DF78 S12, as `unmachined`).
 */
export function moveFindings(
  plan: LoadedPlan,
  setup: SetupDTO,
  operations: readonly CheckOperation[],
  zero: readonly [number, number] = [0, 0],
): PlanWarning[] {
  const h = setupWorkholding(setup, plan.stock)
  const plate = h.items.find((i) => i.kind === 'base' && i.type === 'fixturePlate')
  if (h.prisms.length === 0 && plate === undefined) return []
  const result = checkWorkholding({
    operations,
    prisms: h.prisms,
    margin: h.margin,
    clearanceZ: h.clearance,
    ...(plate === undefined
      ? {}
      : { fixturePlate: { itemId: plate.id, stockBottom: -h.stock.thickness } }),
  })
  const label = (id: string) => {
    const op = setup.operations.find((o) => o.id === id)
    return op === undefined
      ? 'An operation'
      : planOperationLabel(plan.dto.design.part, op.designOperationIds)
  }
  const x = (c: Collision) => c.at[0] - zero[0]
  const y = (c: Collision) => c.at[1] - zero[1]
  const params = (c: Collision) => ({
    setupId: setup.id,
    itemId: c.itemId,
    kind: c.kind,
    moveIndex: c.moveIndex,
    x: x(c),
    y: y(c),
    lowestZ: c.lowestZ,
    gap: c.gap,
  })
  const out: PlanWarning[] = []
  for (const c of result.collisions) {
    const name = itemName(h, c.itemId)
    const fix =
      c.kind === 'cut'
        ? 'move the item, or cut this in a second setup'
        : c.kind === 'link'
          ? 'let the clearance height follow the workholding'
          : `raise the retract height above Z${mm(maxTop(h, c.itemId) + h.margin)} or move the item`
    out.push({
      code: 'plan.workholding.collision',
      severity: 'error',
      message: `${label(c.planOperationId)}: ${KIND_WORD[c.kind]} at Z${mm(c.lowestZ)} hits ${name} near X${mm(x(c))} Y${mm(y(c))} (gap ${mm(c.gap)} mm, margin ${mm(h.margin)} mm): ${fix}`,
      planOperationId: c.planOperationId,
      rule: c.kind,
      params: params(c),
    })
  }
  for (const c of result.breakthrough)
    out.push({
      code: 'plan.workholding.breakthrough',
      severity: 'error',
      message: `${label(c.planOperationId)} cuts to Z${mm(c.lowestZ)}, below the stock bottom, into ${itemName(h, c.itemId)}: use a spoilboard or less breakthrough`,
      planOperationId: c.planOperationId,
      field: 'strategy.breakthrough',
      rule: 'breakthrough',
      params: params(c),
    })
  for (const c of result.close)
    out.push({
      code: 'plan.workholding.close',
      severity: 'warning',
      message: `${label(c.planOperationId)}: ${KIND_WORD[c.kind]} passes ${mm(c.gap)} mm from ${itemName(h, c.itemId)}`,
      planOperationId: c.planOperationId,
      rule: c.kind,
      params: params(c),
    })
  return out
}

const maxTop = (h: SetupWorkholding, itemId: string) =>
  Math.max(...h.prisms.filter((p) => p.itemId === itemId).map((p) => p.zMax))

/**
 * `plan.workholding.unmachined`: per facing or pocket and item, the material the keep-out leaves
 * (area and bounds in the setup's WCS). Needs the 2D port; a mapping failure is left to the
 * toolpath job.
 */
export function unmachinedFindings(
  plan: LoadedPlan,
  inputs: readonly PlanOperationInput[],
  port: Region2dPort,
): PlanWarning[] {
  const out: PlanWarning[] = []
  for (const input of inputs) {
    if (input.keepOut === undefined) continue
    const request = toGeneratorInputs(input, port)
    if (request.isErr()) continue
    const list = request.unwrap().unmachined
    if (list === undefined) continue
    const setup = plan.setups.find((s) => s.id === input.setup.id)
    if (setup === undefined) continue
    const h = setupWorkholding(setup, plan.stock)
    const wcs = setupWcs(
      input.setup.direction,
      input.setup.rotation,
      {
        length: input.stock.length.canonical,
        width: input.stock.width.canonical,
        thickness: input.stock.thickness.canonical,
      },
      input.setup.zero,
    )
    for (const u of list) {
      const corners = [u.bounds[0], u.bounds[1]].map((p) => (wcs === undefined ? p : toWcs(p, wcs)))
      const xs = corners.map((p) => p[0])
      const ys = corners.map((p) => p[1])
      const name = planOperationLabel(
        plan.dto.design.part,
        input.operations.map((o) => o.id),
      )
      out.push({
        code: 'plan.workholding.unmachined',
        severity: 'warning',
        message: `${name} leaves ${mm(u.area)} mm² uncut under ${itemName(h, u.itemId)} (X${mm(Math.min(...xs))}–${mm(Math.max(...xs))} Y${mm(Math.min(...ys))}–${mm(Math.max(...ys))})`,
        planOperationId: input.planOperationId,
        rule: 'unmachined',
        params: {
          setupId: input.setup.id,
          itemId: u.itemId,
          area: u.area,
          xMin: Math.min(...xs),
          xMax: Math.max(...xs),
          yMin: Math.min(...ys),
          yMax: Math.max(...ys),
        },
      })
    }
  }
  return out
}

/**
 * Every workholding finding of the plan (or one setup): the static ones, `unmachined` with the
 * port, and the move check of each setup whose toolpaths are all current (`current` returns the
 * cached toolpath of an input, or undefined).
 */
export function workholdingFindings(
  plan: LoadedPlan,
  inputs: readonly PlanOperationInput[] | undefined,
  current: (input: PlanOperationInput) => Toolpath | undefined,
  port?: Region2dPort,
  setupId?: string,
): PlanWarning[] {
  const out = staticWorkholdingFindings(plan, setupId)
  if (inputs === undefined) return out
  if (port !== undefined)
    out.push(
      ...unmachinedFindings(
        plan,
        inputs.filter((i) => setupId === undefined || i.setup.id === setupId),
        port,
      ),
    )
  for (const setup of plan.setups) {
    if (setupId !== undefined && setup.id !== setupId) continue
    const mine = inputs.filter((i) => i.setup.id === setup.id)
    if (mine.length === 0) continue
    // the items are in the setup frame, the toolpaths in the WCS (DF78, alignment.md#frames)
    const zero = setupZero(plan, setup, port)
    const pairs = mine.map((input) => ({ input, toolpath: current(input) }))
    if (pairs.some((p) => p.toolpath === undefined)) continue
    out.push(
      ...moveFindings(
        plan,
        setup,
        checkOperations(pairs as { input: PlanOperationInput; toolpath: Toolpath }[], zero),
        zero,
      ),
    )
  }
  return out
}
