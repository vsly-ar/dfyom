/**
 * A setup's safe links (hardening DF64) from its plan operation inputs and current toolpaths:
 * the settings from the setup record, the pauses from the machine, a small cache by the chain of
 * toolpath hashes and the link settings, the links summary of `plan.warning.list` / `plan_get` and
 * the findings `plan.links.clampHeightUnknown` and DF59's `clampsAboveClearance`.
 * Doc: docs/modes/safe-links.md#agent-api-and-settings
 */
import type { Machine } from '../library/machine'
import { Quantity } from '../quantity/quantity'
import type { Option } from '../../shared/result'
import type { ToolpathCache } from '../toolpath/cache'
import { toolpathTool } from '../toolpath/inputs'
import {
  planLinks,
  type LinkOperation,
  type LinkSettings,
  type LinksSummary,
  type Retraction,
  type SetupLinks,
} from '../toolpath/links'
import type { Toolpath, Vec3 } from '../toolpath/model'
import type { PlanWarning } from './checks'
import type { PlanOperationInput } from './inputs'
import type { SetupDTO } from './plan.dto'
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

/** The link settings of a setup (mm). */
export function linkSettings(
  setup: Pick<
    SetupDTO,
    'direction' | 'rotation' | 'retraction' | 'clampHeight' | 'clearanceHeight' | 'retractHeight'
  >,
  stock: Stock,
  machine: Option<Machine>,
): LinkSettings {
  const size = setupStockSize(stock, setup)
  const len = (q: SetupDTO['clearanceHeight']) => Quantity.fromDTO(q).mapOr(0, (v) => v.canonical)
  const clampHeight = setupClampHeight(setup)
  return {
    retraction: setupRetraction(setup),
    clearance: len(setup.clearanceHeight),
    margin: len(setup.retractHeight),
    ...(clampHeight === undefined ? {} : { clampHeight }),
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
 * The link operations of a setup: one per plan operation in machining order; a tool change, or a
 * spindle speed change on a manual spindle (its `M0`), pauses before it.
 */
export function linkOperations(
  inputs: readonly PlanOperationInput[],
  toolpaths: readonly Toolpath[],
  machine: Option<Machine>,
): LinkOperation[] {
  const manual = machine.mapOr(false, (m) => m.spindle.control === 'manual')
  return inputs.map((input, i) => {
    const tp = toolpaths[i]!
    const before = toolpaths[i - 1]
    return {
      toolpath: tp,
      tool: toolpathTool(input.tool, input.toolSnapshotId),
      stickout: input.stickout,
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
  const key = JSON.stringify([inputs.map((i) => i.inputHash), settings])
  const hit = cache.get(key)
  // the same toolpath objects too (the toolpath cache hands out one object per hash)
  if (hit !== undefined && hit.toolpaths.every((t, i) => t === toolpaths[i])) {
    cache.delete(key)
    cache.set(key, hit)
    return hit.links
  }
  const ops = machine === undefined ? [] : linkOperations(inputs, toolpaths, machine)
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
} {
  const s: LinksSummary = links.summary
  const r = (v: number) => Math.round(v * 10) / 10
  return {
    count: s.count,
    low: s.low,
    atClearance: s.atClearance,
    seconds: timed ? r(s.seconds) : null,
    savedSeconds: timed ? r(s.savedSeconds) : null,
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
 * must clear the clamps by the retract height (tool changes, start and end pass over them).
 */
export function clampFindings(setup: SetupDTO): PlanWarning[] {
  const clamp = setupClampHeight(setup)
  if (clamp === undefined) return []
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
