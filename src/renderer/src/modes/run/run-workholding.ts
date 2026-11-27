// The setup's workholding and the holder in the Run scene (hardening DF133 RW1): how far the scene
// can vouch for where the items are (`workholdingTrust`: solid only when homed with a work zero
// set, Q184), the items as the Plan viewport draws them (outlined while not trusted, hidden while
// G54 was never set) and the tool the guard assumes in the spindle with its holder ghost at the
// tool marker (Q189: the tool-change wait's tool, else the last one seen in this connection, else
// the setup's first). Pure.
// Doc: docs/modes/run-workholding.md#trust-what-the-guard-knows, #scene, #implementation-rw1
import type { Tool } from '../../../../core/library/tool'
import { resolveHolder } from '../../../../core/library/holder'
import { stickoutOf } from '../../../../core/plan/evaluate'
import type { LoadedPlan } from '../../../../core/plan/plan'
import type { SetupDTO } from '../../../../core/plan/plan.dto'
import { toolEnvelope, type HolderSizes } from '../../../../core/plan/workholding/envelope'
import { holderSizes } from '../../../../core/plan/workholding/findings'
import type { SetupWorkholding } from '../../../../core/plan/workholding/setup'
import type { RunStatus } from '../../../../core/run/service'
import type { HolderGhostOverlay, WorkholdingOverlay } from '../../viewport'
import { bodyShown } from '../plan/holder-ghost'
import { shiftOverlay, workholdingOverlay } from '../plan/workholding-scene'
import { isConnected } from './machine-state'

/**
 * What the Run scene knows about the items' place (run-workholding.md § Trust):
 * `noItems` the setup has no clamps, vise, screws or blocks; `disconnected` and `notHomed` the
 * items outlined at the plan's zero; `zeroUnset` homed but G54 never set (0 0 0): hidden;
 * `trusted` homed with G54 set: solid.
 */
export type WorkholdingTrust = 'noItems' | 'disconnected' | 'notHomed' | 'zeroUnset' | 'trusted'

export function workholdingTrust(
  status: Pick<RunStatus, 'connection' | 'homed' | 'workZero'>,
  hasItems: boolean,
): WorkholdingTrust {
  if (!hasItems) return 'noItems'
  if (!isConnected(status as RunStatus)) return 'disconnected'
  if (!status.homed) return 'notHomed'
  if (status.workZero.every((v) => v === 0)) return 'zeroUnset'
  return 'trusted'
}

/**
 * The Run scene's items: the Plan viewport's overlay without selection, halo or collision hits
 * (read-only), shifted into the WCS by the setup's work `zero`; `outlined` unless trusted, none
 * while the zero is unset or the setup has no items.
 */
export function runWorkholdingOverlay(
  holding: SetupWorkholding,
  setupId: string,
  zero: readonly [number, number],
  trust: WorkholdingTrust,
): WorkholdingOverlay | undefined {
  if (trust === 'noItems' || trust === 'zeroUnset') return undefined
  const o = shiftOverlay(workholdingOverlay(holding, setupId, undefined, []), zero)
  if (o === undefined) return undefined
  return trust === 'trusted' ? o : { ...o, outlined: true }
}

/** The tool the guard assumes in the spindle (Q189), with what its envelope needs. */
export interface GuardTool {
  /** The tool number as the program has it (first use in the setup, 1-based). */
  readonly n: number
  readonly tool: Tool
  /** The planned stickout of its first operation in the setup (mm). */
  readonly stickout: number
  /** Its holder (H6: the tool's own, else the machine's); absent: the tool cylinder alone. */
  readonly holder?: HolderSizes
}

/**
 * Tool `n` of the setup's program (numbered by first use, as the program's tool changes are;
 * `resumePoints`), or the first when `n` is undefined or not in the setup.
 */
export function guardTool(
  plan: LoadedPlan,
  setup: SetupDTO,
  n: number | undefined,
): GuardTool | undefined {
  // the first operation of each tool, by first use; a copy that does not load keeps its number
  const firsts: { op: SetupDTO['operations'][number]; tool: Tool | undefined }[] = []
  const seen = new Set<string>()
  for (const op of setup.operations) {
    if (op.tool === undefined || seen.has(op.tool)) continue
    seen.add(op.tool)
    firsts.push({ op, tool: plan.tools.get(op.tool) })
  }
  const index = n !== undefined && n >= 1 && n <= firsts.length ? n - 1 : 0
  const hit = firsts[index]
  if (hit?.tool === undefined) return undefined
  const holder = resolveHolder(hit.tool, plan.machine).mapOr(undefined, holderSizes)
  return {
    n: index + 1,
    tool: hit.tool,
    stickout: stickoutOf(hit.op, hit.tool),
    ...(holder === undefined ? {} : { holder }),
  }
}

/**
 * The holder ghost at the tool marker (`tip`, WCS mm): tool, nut and body by the planned stickout
 * (the body broken off as in Plan, `bodyShown`); none without a holder (the tool marker alone).
 */
export function runHolderGhost(
  g: GuardTool | undefined,
  tip: readonly [number, number, number] | null,
  label: (g: GuardTool) => string,
): HolderGhostOverlay | undefined {
  if (g === undefined || g.holder === undefined || tip === null) return undefined
  const holder = g.holder
  const tool = {
    diameter: g.tool.diameter.canonical,
    ...g.tool.shankDiameter.mapOr<{ shankDiameter?: number }>({}, (q) => ({
      shankDiameter: q.canonical,
    })),
  }
  return {
    key: `T${g.n}:${tip.join(',')}`,
    tip,
    parts: toolEnvelope(tool, g.stickout, holder).map((s) => ({
      part: s.part,
      radius: s.radius,
      zFrom: s.zFrom,
      zTo: Number.isFinite(s.zTo) ? s.zTo : s.zFrom + bodyShown(holder),
    })),
    colliding: false,
    label: label(g),
  }
}
