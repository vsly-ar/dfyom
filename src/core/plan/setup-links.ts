/**
 * A setup's safe links (hardening DF64) from its plan operation inputs and current toolpaths:
 * the settings from the setup record, the pauses from the machine, a small cache by the chain of
 * toolpath hashes and the link settings, the links summary of `plan.warning.list` / `plan_get` and
 * the findings `plan.links.clampHeightUnknown` and DF59's `clampsAboveClearance`.
 * Doc: docs/modes/safe-links.md#agent-api-and-settings
 */
import type { Holder } from '../library/holder'
import type { Machine } from '../library/machine'
import { Quantity } from '../quantity/quantity'
import type { Option } from '../../shared/result'
import type { ToolpathCache } from '../toolpath/cache'
import { toolpathTool } from '../toolpath/inputs'
import {
  planLinks,
  type LinkEdit,
  type LinkHolder,
  type LinkOperation,
  type LinkSettings,
  type LinksSummary,
  type Retraction,
  type SetupLinks,
} from '../toolpath/links'
import type { Toolpath, Vec3 } from '../toolpath/model'
import { STICKOUT_CLEARANCE, type PlanWarning } from './checks'
import type { PlanOperationInput } from './inputs'
import type { SetupDTO } from './plan.dto'
import { setupWorkholding } from './workholding/setup'
import { setupStockSize } from './setups'
import type { Stock } from '../library/stock'

/** The setup's retraction policy (absent = `minimum`). */
export const setupRetraction = (s: Pick<SetupDTO, 'retraction'>): Retraction =>
  s.retraction ?? 'minimum'

/** The setup's clamp height above the stock top (mm); undefined = unknown. */
export function setupClampHeight(s: Pick<SetupDTO, 'clampHeight'>): number | undefined {
  if (s.clampHeight === undefined) return undefined
  return Quantity.fromDTO(s.clampHeight).mapOr(undefined, (q) => q.canonical)
}

/**
 * The link settings of a setup (mm). With workholding items their obstacles bound the links and
 * the clamp height is ignored (it stays the fallback for a setup without items); with a holder on
 * the machine too, the nut and body stay above them (DF132 H4, `holderFloor`); a tool's own holder
 * rides on its link operation (H6, `linkOperations`).
 */
export function linkSettings(
  setup: SetupDTO,
  stock: Stock,
  machine: Option<Machine>,
): LinkSettings {
  const size = setupStockSize(stock, setup)
  const len = (q: SetupDTO['clearanceHeight']) => Quantity.fromDTO(q).mapOr(0, (v) => v.canonical)
  // workholding.md#links-and-safe-heights: modelled items are the floor in place of the clamp
  // height, and the clearance the program uses follows them
  const holding = setupWorkholding(setup, stock)
  const items = holding.prisms.length > 0
  const clampHeight = items ? undefined : setupClampHeight(setup)
  return {
    retraction: setupRetraction(setup),
    clearance: holding.clearance,
    margin: len(setup.retractHeight),
    ...(clampHeight === undefined ? {} : { clampHeight }),
    ...(items ? { obstacles: holding.obstacles } : {}),
    ...(items ? linkHolder(machine, holding.obstacles.margin) : {}),
    stock: [size.x[1], size.y[1], size.z[1]],
    ...machine.mapOr<{ rates?: Vec3 }>({}, (m) => ({
      rates: [
        m.maxFeedRate.x.canonical,
        m.maxFeedRate.y.canonical,
        m.maxFeedRate.z.canonical,
      ] as Vec3,
    })),
  }
}

/**
 * The machine's holder for the links (tool-holder.md § Implementation (H4)): its sizes in mm, and
 * the nut and body kept the workholding margin, at least `STICKOUT_CLEARANCE`, above the items.
 */
function linkHolder(machine: Option<Machine>, margin: number): { holder?: LinkHolder } {
  const h = machine.andThen((m) => m.holder)
  return h.isNone() ? {} : { holder: linkHolderOf(h.unwrap(), margin) }
}

function linkHolderOf(h: Holder, margin: number): LinkHolder {
  return {
    nutDiameter: h.nutDiameter.canonical,
    nutLength: h.nutLength.canonical,
    bodyDiameter: h.bodyDiameter.canonical,
    above: Math.max(margin, STICKOUT_CLEARANCE),
  }
}

/**
 * The link operations of a setup: one per plan operation in machining order; a tool change, or a
 * spindle speed change on a manual spindle (its `M0`), pauses before it. With the workholding
 * `margin` (items with prisms), a tool with its own holder (DF132 H6) carries it for the floor.
 */
export function linkOperations(
  inputs: readonly PlanOperationInput[],
  toolpaths: readonly Toolpath[],
  machine: Option<Machine>,
  margin?: number,
): LinkOperation[] {
  const manual = machine.mapOr(false, (m) => m.spindle.control === 'manual')
  return inputs.map((input, i) => {
    const tp = toolpaths[i]!
    const before = toolpaths[i - 1]
    return {
      toolpath: tp,
      tool: toolpathTool(input.tool, input.toolSnapshotId),
      stickout: input.stickout,
      ...(margin === undefined || input.tool.holder.isNone()
        ? {}
        : { holder: linkHolderOf(input.tool.holder.unwrap(), margin) }),
      pauseBefore:
        before === undefined ||
        before.tool !== tp.tool ||
        (manual && before.spindleSpeed !== tp.spindleSpeed),
    }
  })
}

// ── Cache ─────────────────────────────────────────────────────────────────────────────────

const CACHE_SIZE = 16
const cache = new Map<string, { toolpaths: readonly Toolpath[]; links: SetupLinks }>()

/**
 * `planLinks` for a setup, cached by the chain of input hashes (they cover the toolpaths) and the
 * link settings: an edit elsewhere recomputes only its own setup's links.
 */
export function cachedSetupLinks(
  inputs: readonly PlanOperationInput[],
  toolpaths: readonly Toolpath[],
  settings: LinkSettings,
): SetupLinks {
  const machine = inputs[0]?.machine
  // the toolpaths are in the WCS: a moved work zero (alignment DF78) moves the stock and items
  const zero = inputs[0]?.setup.zero
  if (zero !== undefined) settings = { ...settings, zero: [zero[0], zero[1]] }
  const key = JSON.stringify([inputs.map((i) => i.inputHash), settings])
  const hit = cache.get(key)
  // the same toolpath objects too (the toolpath cache hands out one object per hash)
  if (hit !== undefined && hit.toolpaths.every((t, i) => t === toolpaths[i])) {
    cache.delete(key)
    cache.set(key, hit)
    return hit.links
  }
  const ops =
    machine === undefined
      ? []
      : linkOperations(inputs, toolpaths, machine, settings.obstacles?.margin)
  const links = planLinks(ops, settings)
  cache.delete(key)
  cache.set(key, { toolpaths: [...toolpaths], links })
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return links
}

/**
 * The links of a setup from the toolpath cache; undefined until every toolpath of the setup is
 * current (like `overreach`).
 */
export function currentSetupLinks(
  inputs: readonly PlanOperationInput[],
  toolpaths: ToolpathCache,
  setup: SetupDTO,
  stock: Stock,
  machine: Option<Machine>,
): SetupLinks | undefined {
  const own = inputs.filter((i) => i.setup.id === setup.id)
  if (own.length === 0 || own.length !== setup.operations.length) return undefined
  const current: Toolpath[] = []
  for (const i of own) {
    const tp = toolpaths.get(i.inputHash)
    if (tp === undefined) return undefined
    current.push(tp)
  }
  return cachedSetupLinks(own, current, linkSettings(setup, stock, machine))
}

/**
 * A lowered link as `plan.warning.list` returns it for the scenes (DF64 L3): its edit of the
 * generated toolpaths (`linkedToolpaths`) and the time it saves (s; 0 without a machine).
 * `index`: the later operation's position in the setup.
 */
export interface LoweredLinkDTO {
  index: number
  trim: LinkEdit['trim']
  tail: [number, number, number][]
  head: [number, number, number][]
  savedSeconds: number
}

/** The summary as `plan.warning.list` returns it; times null without a machine. */
export function linksSummaryDTO(
  links: SetupLinks,
  timed: boolean,
): {
  count: number
  low: number
  atClearance: number
  seconds: number | null
  savedSeconds: number | null
  lowered: LoweredLinkDTO[]
} {
  const s: LinksSummary = links.summary
  const r = (v: number) => Math.round(v * 10) / 10
  const p = (v: Vec3): [number, number, number] => [v[0], v[1], v[2]]
  return {
    count: s.count,
    low: s.low,
    atClearance: s.atClearance,
    seconds: timed ? r(s.seconds) : null,
    savedSeconds: timed ? r(s.savedSeconds) : null,
    lowered: links.links.flatMap((l) =>
      l.edit === undefined
        ? []
        : [
            {
              index: l.index,
              trim: l.edit.trim,
              tail: l.edit.tail.map(p),
              head: l.edit.head.map(p),
              savedSeconds: timed ? l.fullSeconds - l.seconds : 0,
            },
          ],
    ),
  }
}

/**
 * Info `plan.links.clampHeightUnknown`: links stayed at the clearance height only because they
 * cross outside the cleared footprint and the clamp height is unknown.
 */
export function linksFindings(setupId: string, links: SetupLinks, timed: boolean): PlanWarning[] {
  const u = links.clampHeightUnknown
  if (u === undefined) return []
  const seconds = Math.round(u.savedSeconds)
  const about = timed && seconds > 0 ? `, about ${seconds} s` : ''
  return [
    {
      code: 'plan.links.clampHeightUnknown',
      severity: 'info',
      message: `Enter the clamp height to lower ${u.links} link${u.links === 1 ? '' : 's'} between operations${about}`,
      field: 'setup.clampHeight',
      rule: 'clampHeightUnknown',
      params: { setupId, links: u.links, ...(timed ? { seconds } : {}) },
    },
  ]
}

/**
 * DF59's remaining warning (safe-links.md#clamps, Q96): with a clamp height, the clearance height
 * must clear the clamps by the retract height (tool changes, start and end pass over them). Only
 * for a setup without workholding items.
 */
export function clampFindings(setup: SetupDTO, stock: Stock): PlanWarning[] {
  const clamp = setupClampHeight(setup)
  // with modelled items, workholding.md's own clearance finding replaces this one
  if (clamp === undefined || setupWorkholding(setup, stock).prisms.length > 0) return []
  const len = (q: SetupDTO['clearanceHeight']) => Quantity.fromDTO(q).mapOr(0, (v) => v.canonical)
  const clearance = len(setup.clearanceHeight)
  const margin = len(setup.retractHeight)
  if (clearance >= clamp + margin - 1e-9) return []
  return [
    {
      code: 'plan.check',
      severity: 'warning',
      message: `the clearance height is less than the retract height above the clamps: raise it to at least ${Math.round((clamp + margin) * 1000) / 1000} mm or lower the clamps`,
      field: 'setup.clearanceHeight',
      rule: 'clampsAboveClearance',
      params: {
        setupId: setup.id,
        clearanceHeight: clearance,
        clampHeight: clamp,
        needed: clamp + margin,
      },
    },
  ]
}
