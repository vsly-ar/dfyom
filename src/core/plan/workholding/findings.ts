/**
 * Plan findings of workholding (WH-A–F): `plan.workholding.none` (info), `.clearanceLow` (error),
 * `.unmachined` (warning, one per operation, needs the 2D port), `.inPart` and `.partLoose` (warnings, W5,
 * `held.ts`), and on a setup's current toolpaths `.collision` (error), `.close` (warning) and
 * `.breakthrough` (error; DF132 H2: kind `holder` for the collet nut or spindle body), and
 * `plan.holder.unknown` (info: items, no holder on the machine and a tool without its own, H6).
 * Errors block `plan.export` and `run.job.start` of their setup (the export guard), never
 * toolpath generation.
 * Doc: docs/modes/workholding.md#collision-check
 */
import type { Region2dPort } from '../../geometry/2d/port'
import type { Toolpath } from '../../toolpath/model'
import { toGeneratorInputs } from '../../toolpath/inputs'
import { setupWcs, toWcs, turnToolpath } from '../../toolpath/wcs'
import { setupZero } from '../alignment'
import { STICKOUT_CLEARANCE, tooShortText, usableStickout, type PlanWarning } from '../checks'
import { HOLDER_PRESET_NAMES, resolveHolder, type Holder } from '../../library/holder'
import type { Option } from '../../../shared/result'
import type { PlanOperationInput } from '../inputs'
import { aidName, planOpLabel } from '../labels'
import type { LoadedPlan } from '../plan'
import type { PlanOperationDTO, SetupDTO } from '../plan.dto'
import { checkWorkholding, type CheckOperation, type Collision } from './check'
import type { HolderSizes } from './envelope'
import { heldFindings } from './held'
import { rangeFindings } from './devices'
import { highestTop } from './obstacles'
import { setupWorkholding, type SetupWorkholding } from './setup'
import { clampTerms, stickoutNeed } from './stickout'

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
    // WL2: an item placed from a library device outside the device's range (warning)
    out.push(...rangeFindings(plan.dto, setup, h.stock))
    // DF132 Q181: the clamps are checked against the tool only while the machine has no holder;
    // H6: unless every tool of the setup carries its own
    if (
      h.prisms.length > 0 &&
      plan.machine.mapOr(false, (m) => m.holder.isNone()) &&
      (setup.operations.length === 0 ||
        setup.operations.some((op) => operationHolder(plan, op).isNone()))
    )
      out.push({
        code: 'plan.holder.unknown',
        severity: 'info',
        message: `The machine has no collet nut size: ${setup.name}'s workholding is checked against the tool only. Enter the collet nut size (machine holder) to check it against the clamps`,
        field: 'machine.holder',
        rule: 'unknown',
        params: { setupId: setup.id },
      })
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
  return pairs.map(({ input, toolpath }) => {
    // DF132 H2: the holder (H6: the tool's own, else the machine's) and the operation's stickout
    // make the stepped envelope
    const holder = resolveHolder(input.tool, input.machine)
    return {
      planOperationId: input.planOperationId,
      tool: {
        diameter: input.tool.diameter.canonical,
        ...(input.tool.shankDiameter.isSome()
          ? { shankDiameter: input.tool.shankDiameter.unwrap().canonical }
          : {}),
        ...(holder.isSome()
          ? { stickout: input.stickout, holder: holderSizes(holder.unwrap()) }
          : {}),
        usable: usableStickout(input.tool),
      },
      moves: back(toolpath).passes.flatMap((p) => p.moves),
      ...(input.stickoutNeeded === undefined ? {} : { stickoutNeeded: input.stickoutNeeded }),
    }
  })
}

/**
 * The holder a plan operation's tool runs in (DF132 H6, `resolveHolder`): the tool copy's own
 * override, else the plan machine's; none without a tool on the operation and on the machine.
 */
export function operationHolder(plan: LoadedPlan, op: PlanOperationDTO): Option<Holder> {
  return resolveHolder(op.tool === undefined ? undefined : plan.tools.get(op.tool), plan.machine)
}

/** Whether any plan operation's tool runs in a holder (H6: its own or the machine's). */
export function planHasHolder(plan: LoadedPlan): boolean {
  return plan.operations.some((op) => operationHolder(plan, op).isSome())
}

/** A holder's sizes in mm and its short name for messages (tool-holder.md § Checks). */
export function holderSizes(h: Holder): HolderSizes {
  return {
    nutDiameter: h.nutDiameter.canonical,
    nutLength: h.nutLength.canonical,
    bodyDiameter: h.bodyDiameter.canonical,
    ...(h.preset.isSome() ? { name: HOLDER_PRESET_NAMES[h.preset.unwrap()] } : {}),
  }
}

const KIND_WORD: Readonly<Record<Collision['kind'], string>> = {
  rapid: 'a rapid',
  link: 'the link between operations',
  cut: 'a cut',
  holder: 'the holder',
}

const PART_WORD = { nut: 'collet nut', body: 'spindle body' } as const

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
    return op === undefined ? 'An operation' : planOpLabel(plan.dto.design.part, op)
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
    ...(c.part === undefined ? {} : { part: c.part }),
    ...(c.partZ === undefined ? {} : { partZ: c.partZ }),
    ...(c.needed === undefined ? {} : { neededStickout: c.needed }),
  })
  const out: PlanWarning[] = []
  const holderOf = (id: string) => operations.find((o) => o.planOperationId === id)?.tool.holder
  // DF138 F2: a stickout remedy beyond the tool's usable length is replaced by moving the item
  // or a longer tool
  const remedy = (id: string, needed: number, at: number) => {
    const usable = operations.find((o) => o.planOperationId === id)?.tool.usable
    return usable !== undefined && needed > usable.max + 1e-6
      ? `${tooShortText(usable)}: move the item further from the cut or use a longer tool`
      : `chuck the tool with at least ${at} mm out or move the item`
  }
  // DF132 H3: the minimum stickout with the clamp term names the stickout that clears the holder
  const needs = stickoutsOf(h, operations, zero)
  const shown = (v: number) => Math.ceil(v * 10 - 1e-6) / 10
  for (const c of result.collisions) {
    const name = itemName(h, c.itemId)
    if (c.kind === 'holder' && c.part !== undefined) {
      // DF132 H2: the nut or body hits where the tool clears (tool-holder.md § Checks)
      const holder = holderOf(c.planOperationId)
      const size = c.part === 'nut' ? holder?.nutDiameter : holder?.bodyDiameter
      const what = [holder?.name, size === undefined ? undefined : `Ø${mm(size)}`]
        .filter((x) => x !== undefined)
        .join(', ')
      const part = PART_WORD[c.part]
      const needed = Math.max(c.needed ?? 0, needs?.get(c.planOperationId)?.needed ?? 0)
      const at = shown(needed)
      out.push({
        code: 'plan.workholding.collision',
        severity: 'error',
        message: `${label(c.planOperationId)}: the ${part}${what === '' ? '' : ` (${what})`} at Z${mm(c.partZ ?? 0)} hits ${name} near X${mm(x(c))} Y${mm(y(c))} (tip Z${mm(c.lowestZ)}, ${name} top Z${mm(maxTop(h, c.itemId))}, margin ${mm(h.margin)} mm): ${remedy(c.planOperationId, needed, at)}`,
        planOperationId: c.planOperationId,
        field: 'stickout',
        rule: 'holder',
        params: { ...params(c), neededStickout: needed },
      })
      continue
    }
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
  // DF132 H3: `shortStickout` when the clamp term decides and the nut or body clears the item
  // only by less than STICKOUT_CLEARANCE (inside the margin it is the collision above)
  const collided = new Set(result.collisions.map((c) => c.planOperationId))
  for (const o of operations) {
    const need = needs?.get(o.planOperationId)
    const stickout = o.tool.stickout
    if (need === undefined || need.reason.kind !== 'workholding' || stickout === undefined) continue
    if (collided.has(o.planOperationId) || stickout >= need.needed - 1e-6) continue
    const { itemId, part } = need.reason
    const word = PART_WORD[part ?? 'nut']
    const at = shown(need.needed)
    out.push({
      code: 'plan.check',
      severity: 'warning',
      message: `stickout ${mm(stickout)} mm is shorter than the ${at} mm ${itemName(h, itemId ?? '')} needs under the ${word}: the ${word} passes within ${STICKOUT_CLEARANCE} mm of its top; ${
        o.tool.usable !== undefined && need.needed > o.tool.usable.max + 1e-6
          ? `${tooShortText(o.tool.usable)}: move the item further from the cut or use a longer tool`
          : `chuck the tool with at least ${at} mm out`
      }`,
      planOperationId: o.planOperationId,
      field: 'stickout',
      rule: 'shortStickout',
      params: {
        setupId: setup.id,
        stickout,
        needed: need.needed,
        itemId: itemId ?? '',
        part: part ?? 'nut',
        x: need.reason.x ?? 0,
        y: need.reason.y ?? 0,
      },
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
 * What decides a minimum stickout (DF132 H3, `plan_get`'s `toolRuns[].stickoutReason`): the
 * deepest cut (DF130) or a workholding item under the collet nut or spindle body, with the
 * deciding move's point in the WCS.
 * Doc: docs/modes/tool-holder.md#minimum-stickout-gains-the-clamp-term
 */
export interface StickoutReason {
  readonly kind: 'cut' | 'workholding'
  readonly planOperationId: string
  readonly itemId?: string
  readonly itemName?: string
  readonly part?: 'nut' | 'body'
  readonly x?: number
  readonly y?: number
  /** The tool tip's Z at the deciding move (its lowest Z; WCS, mm): where H5's ghost stands. */
  readonly z?: number
}

/** An operation's minimum stickout (mm, not rounded) with the clamp term, and its reason. */
export interface OperationStickout {
  readonly needed: number
  readonly reason: StickoutReason
}

/**
 * The minimum stickout of each operation (with DF130's `stickoutNeeded`) of one setup's program
 * with the clamp term; undefined when nothing is checked: no item with a prism, or no operation
 * whose tool has a holder (the read-out is DF130's then).
 */
function stickoutsOf(
  h: SetupWorkholding,
  operations: readonly CheckOperation[],
  zero: readonly [number, number],
): Map<string, OperationStickout> | undefined {
  if (h.prisms.length === 0 || operations.every((o) => o.tool.holder === undefined))
    return undefined
  const terms = clampTerms({ operations, prisms: h.prisms, margin: h.margin })
  const out = new Map<string, OperationStickout>()
  for (const o of operations) {
    if (o.stickoutNeeded === undefined) continue
    const need = stickoutNeed(o.stickoutNeeded, terms.get(o.planOperationId))
    const c = need.clamp
    out.set(o.planOperationId, {
      needed: need.needed,
      reason:
        c === undefined
          ? { kind: 'cut', planOperationId: o.planOperationId }
          : {
              kind: 'workholding',
              planOperationId: o.planOperationId,
              itemId: c.itemId,
              itemName: itemName(h, c.itemId),
              part: c.part,
              x: c.at[0] - zero[0],
              y: c.at[1] - zero[1],
              z: c.at[2],
            },
    })
  }
  return out
}

/**
 * `stickoutsOf` for one setup's program (`operations` as `checkOperations` gives them, in the
 * setup frame; the reason's X and Y in the WCS, less the work `zero`).
 */
export function setupStickouts(
  plan: LoadedPlan,
  setup: SetupDTO,
  operations: readonly CheckOperation[],
  zero: readonly [number, number] = [0, 0],
): Map<string, OperationStickout> | undefined {
  return stickoutsOf(setupWorkholding(setup, plan.stock), operations, zero)
}

/** The read-out's minimum stickout of one plan operation (`planStickouts`). */
export type PlanStickout =
  ({ readonly clamps: 'checked' } & OperationStickout) | { readonly clamps: 'pending' }

/**
 * The read-out's minimum stickout per plan operation (DF132 H3) over the cached toolpaths:
 * `checked` with the clamp term where the operation's toolpath is current; `pending` (the caller
 * keeps DF130's value: "clamps not yet checked") where it is missing or stale, in a setup that has
 * items with a prism on a machine with a holder. Operations not listed: DF130's value, nothing to
 * check.
 */
export function planStickouts(
  plan: LoadedPlan,
  inputs: readonly PlanOperationInput[] | undefined,
  current: (input: PlanOperationInput) => Toolpath | undefined,
  port?: Region2dPort,
): Map<string, PlanStickout> {
  const out = new Map<string, PlanStickout>()
  if (!planHasHolder(plan)) return out
  for (const setup of plan.setups) {
    if (setupWorkholding(setup, plan.stock).prisms.length === 0) continue
    const ready = (inputs ?? []).flatMap((input) => {
      const toolpath = input.setup.id === setup.id ? current(input) : undefined
      return toolpath === undefined ? [] : [{ input, toolpath }]
    })
    const zero = setupZero(plan, setup, port)
    const needs = setupStickouts(plan, setup, checkOperations(ready, zero), zero)
    for (const op of setup.operations) {
      // H6: an operation whose tool runs in no holder keeps DF130's number (nothing to check)
      if (operationHolder(plan, op).isNone()) continue
      const need = needs?.get(op.id)
      out.set(op.id, need === undefined ? { clamps: 'pending' } : { ...need, clamps: 'checked' })
    }
  }
  return out
}

/**
 * `plan.workholding.unmachined`: per facing or pocket, one finding for the material the keep-out
 * leaves under every item it goes around (design review R13, D75: one per item read as if an
 * automatic arrangement failed). The message names each item with its area and bounds in the
 * setup's WCS; `params` carry the total `area`, the union bounds, `itemIds` (comma-separated, in
 * the keep-out's order) and, with one item, `itemId`. Needs the 2D port; a mapping failure is left
 * to the toolpath job.
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
    if (list === undefined || list.length === 0) continue
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
    const parts = list.map((u) => {
      const corners = [u.bounds[0], u.bounds[1]].map((p) => (wcs === undefined ? p : toWcs(p, wcs)))
      const xs = corners.map((p) => p[0])
      const ys = corners.map((p) => p[1])
      return {
        itemId: u.itemId,
        area: u.area,
        xMin: Math.min(...xs),
        xMax: Math.max(...xs),
        yMin: Math.min(...ys),
        yMax: Math.max(...ys),
      }
    })
    const name = planOpLabel(plan.dto.design.part, {
      designOperationIds: input.operations.map((o) => o.id),
      ...aidName(plan.dto, input.planOperationId),
    })
    const box = (p: (typeof parts)[number]) =>
      `X${mm(p.xMin)}–${mm(p.xMax)} Y${mm(p.yMin)}–${mm(p.yMax)}`
    const area = parts.reduce((a, p) => a + p.area, 0)
    const one = parts.length === 1 ? parts[0] : undefined
    const each = parts.map((p) => `${itemName(h, p.itemId)} (${mm(p.area)} mm², ${box(p)})`)
    const under =
      one !== undefined
        ? `${itemName(h, one.itemId)} (${box(one)})`
        : `${each.slice(0, -1).join(', ')} and ${each[each.length - 1]!}`
    out.push({
      code: 'plan.workholding.unmachined',
      severity: 'warning',
      message: `${name} leaves ${mm(area)} mm² uncut under ${under}`,
      planOperationId: input.planOperationId,
      rule: 'unmachined',
      params: {
        setupId: input.setup.id,
        ...(one === undefined ? {} : { itemId: one.itemId }),
        itemIds: parts.map((p) => p.itemId).join(','),
        area,
        xMin: Math.min(...parts.map((p) => p.xMin)),
        xMax: Math.max(...parts.map((p) => p.xMax)),
        yMin: Math.min(...parts.map((p) => p.yMin)),
        yMax: Math.max(...parts.map((p) => p.yMax)),
      },
    })
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
  return checkedWorkholdingFindings(plan, inputs, current, port, setupId, false).findings
}

/**
 * `workholdingFindings`, and with `partial` (`plan.workholding.set` answers at once, DF90) the
 * move check also of a setup whose toolpaths are only partly current: the current ones are
 * checked whole; an operation without keep-out (a profile, a drilling: its cuts do not depend on
 * the items, only its retracts on the clearance they raise) by the cuts of its `last` toolpath;
 * the others are listed in `unchecked` (a facing or pocket keeps out of the items and
 * regenerates; `plan.warning.list` and the export check them once generated).
 */
export function checkedWorkholdingFindings(
  plan: LoadedPlan,
  inputs: readonly PlanOperationInput[] | undefined,
  current: (input: PlanOperationInput) => Toolpath | undefined,
  port: Region2dPort | undefined,
  setupId: string | undefined,
  partial: boolean,
  last: (input: PlanOperationInput) => Toolpath | undefined = () => undefined,
): { findings: PlanWarning[]; unchecked: PlanOperationInput[] } {
  // W5: held pieces and screws in the part need no toolpath
  const out = [...staticWorkholdingFindings(plan, setupId), ...heldFindings(plan, setupId, port)]
  const unchecked: PlanOperationInput[] = []
  if (inputs === undefined) return { findings: out, unchecked }
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
    type Pair = { input: PlanOperationInput; toolpath: Toolpath }
    const ready = pairs.filter((p): p is Pair => p.toolpath !== undefined)
    if (!partial) {
      if (ready.length === pairs.length)
        out.push(...moveFindings(plan, setup, checkOperations(ready, zero), zero))
      else unchecked.push(...pairs.filter((p) => p.toolpath === undefined).map((p) => p.input))
      continue
    }
    const earlier: Pair[] = []
    for (const p of pairs) {
      if (p.toolpath !== undefined) continue
      const tp = p.input.keepOut === undefined ? last(p.input) : undefined
      if (tp === undefined) unchecked.push(p.input)
      else earlier.push({ input: p.input, toolpath: tp })
    }
    if (ready.length > 0) out.push(...moveFindings(plan, setup, checkOperations(ready, zero), zero))
    if (earlier.length > 0)
      out.push(
        ...moveFindings(plan, setup, checkOperations(earlier, zero), zero).filter(
          (f) => f.rule === 'cut' || f.code === 'plan.workholding.breakthrough',
        ),
      )
  }
  return { findings: out, unchecked }
}

/**
 * DF132 H3: one `shortStickout` per operation. Where the clamp term decides (the workholding
 * check's finding, with `params.itemId`), DF130's deepest-cut finding of the same operation is
 * dropped: the clamp's number is the larger. In place.
 * Doc: docs/modes/tool-holder.md#minimum-stickout-gains-the-clamp-term
 */
export function dropShadowedShortStickout(findings: PlanWarning[]): void {
  const short = (f: PlanWarning) => f.code === 'plan.check' && f.rule === 'shortStickout'
  const clamped = new Set(
    findings.filter((f) => short(f) && 'itemId' in f.params).map((f) => f.planOperationId),
  )
  if (clamped.size === 0) return
  const keep = findings.filter(
    (f) => !(short(f) && !('itemId' in f.params) && clamped.has(f.planOperationId)),
  )
  findings.splice(0, findings.length, ...keep)
}
