/**
 * Plan findings of general shapes (v0.3 T1/T2 wiring): `plan.restMaterial` (warning) where the
 * plan's tool leaves material in a pocket's necks, and `plan.stepoverClamped` (info, T-H) where the
 * region generators clamp the stepover to the tool radius. They need the 2D port, so only
 * `plan.warning.list` (which has `services.region2d`) lists them; neither ever blocks.
 * Heatsink presets H2 (Q208): `plan.thinWallFinish` (info, at Finish stepdown) on a pattern pocket
 * whose finishing ring runs round a web (inverted: island) of at most `THIN_WALL` in levels deeper
 * than `THIN_WALL`; its fix sets the finish stepdown to `THIN_WALL`.
 * Doc: docs/modes/plan-v0.3.md#wiring-t1-t2, docs/modes/pattern-presets.md#implementation-h2
 */
import { toGeometryInput } from '../design/geometry-input'
import { isGeneralShape, type Operation } from '../design/operation'
import type { Region2dPort } from '../geometry/2d/port'
import { isAnalyticOperation, type OperationGeometry } from '../geometry/model'
import { pocketRegion } from '../geometry/outline'
import { localStock } from '../geometry/face'
import { openReach, openRegion, opensStock } from '../geometry/open-sides'
import type { Region } from '../geometry/2d/model'
import { Ok, type AppResult } from '../../shared/result'
import { toolpathTool } from '../toolpath/inputs'
import { clearingStep, stepoverClamped } from '../toolpath/region-pocket'
import { profileStep, profileStepClamped } from '../toolpath/region-profile'
import { findRestMaterial } from '../geometry/2d/rest-material'
import { slotSplit } from '../geometry/slots'
import { patternWebUnder } from '../design/pattern/pattern'
import type { PlanWarning } from './checks'
import { evaluateOperation } from './evaluate'
import type { LoadedPlan } from './plan'

/**
 * Q208: a web this thin or thinner is finished in levels of at most this much (mm): a free-standing
 * aluminium wall under 3 mm bends when one full-height finishing level loads it.
 */
export const THIN_WALL = 3

/** Rounded for messages (params keep the exact value). */
const mm = (v: number): string => String(Math.round(v * 1000) / 1000)

/**
 * The shape findings of the plan's pocket and profile operations with their tool and resolved
 * stepover. Plain v0.1 rectangles and circles keep the v0.1 generators and get none. A geometry
 * mapping failure is left to the toolpath job, which reports it.
 */
export function shapeFindings(plan: LoadedPlan, port: Region2dPort): PlanWarning[] {
  const general = plan.operations
    .map((op) => evaluateOperation(plan, op))
    .filter((e) => (e.kind === 'pocket' || e.kind === 'profile') && e.tool.isSome())
  if (general.length === 0) return []
  // only parts with a general shape pay for the geometry mapping
  const isGeneral = (o: Operation) =>
    (o.kind === 'pocket' || o.kind === 'profile') &&
    (isGeneralShape(o.shape) ||
      (o.kind === 'profile' && (o.side === 'on' || o.depth.isSome() || o.tabs.positions.isSome())))
  if (!general.some((e) => e.ops.some(isGeneral))) return []
  const geometry = toGeometryInput(plan.part, plan.stock, port)
  if (geometry.isErr()) return []
  const byId = new Map<string, OperationGeometry>(
    geometry.unwrap().operations.map((g) => [g.id, g]),
  )
  const out: PlanWarning[] = []
  for (const e of general) {
    const tool = toolpathTool(e.tool.unwrap(), e.planOperation.tool ?? '')
    const stepover = e.feeds.andThen((f) => f.fields.stepover).map((v) => v.value)
    const planOperationId = e.planOperation.id
    for (const o of e.ops) {
      const g = byId.get(o.id)
      if (g === undefined || (g.kind !== 'pocket' && g.kind !== 'profile')) continue
      if (isAnalyticOperation(g)) continue
      const blind = g.kind === 'profile' && g.depth !== undefined
      if (stepover.isSome()) {
        const asked = stepover.unwrap()
        const clamped =
          g.kind === 'pocket'
            ? stepoverClamped(tool, asked)
            : profileStepClamped(tool, asked, blind)
        if (clamped) {
          const effective =
            g.kind === 'pocket' ? clearingStep(tool, asked) : profileStep(tool, asked, blind)
          const half = tool.cornerRadius === 0 || (g.kind === 'profile' && !blind)
          out.push({
            code: 'plan.stepoverClamped',
            severity: 'info',
            planOperationId,
            field: 'stepover',
            rule: 'offsetClearing',
            message: `stepover clamped to ${mm(effective)} mm (${half ? 'half the tool' : 'the flat radius'}) for offset clearing of ${g.id}`,
            params: { operation: g.id, stepover: asked, effective },
          })
        }
      }
      // DF108: a pattern's roughing leaves rest on purpose (its pocket cuts it)
      if (g.kind !== 'pocket' || g.roughing === true) continue
      out.push(...thinWallFinish(plan, port, o, g, e.strategy, tool.diameter, planOperationId))
      // a pocket on the stock edge is cut as its open region (DF61): its rest inside the stock
      const R = tool.diameter / 2
      const face = localStock(g.direction ?? '+z', geometry.unwrap().stock)
      // H3: the slot rule's slots (as wide as the tool) leave nothing: taken out first, as the
      // DFM's rest check does (shape-measure.ts); a closed one's round ends are the tool's own
      const own = slotSplit(
        pocketRegion(g).region,
        tool.diameter,
        'finishAllowance' in e.strategy ? e.strategy.finishAllowance : 0,
        face,
      ).region
      const inFace = (p: readonly number[]) =>
        p[0]! >= 0 && p[0]! <= face.length && p[1]! >= 0 && p[1]! <= face.width
      const open = opensStock(port, own, face)
      const region: AppResult<Region> = open
        ? openRegion(port, own, face, openReach(R, 0))
        : Ok(own)
      const rest = region
        .andThen((region) => findRestMaterial(port, region, R))
        .map((pieces) => (open ? pieces.filter((p) => inFace(p.at)) : pieces))
      if (rest.isErr()) continue
      for (const piece of rest.unwrap())
        out.push({
          code: 'plan.restMaterial',
          severity: 'warning',
          planOperationId,
          field: 'tool',
          rule: 'restMaterial',
          message: `${mm(piece.area)} mm² of ${g.id} near (${mm(piece.at[0])}, ${mm(piece.at[1])}) stays uncut: a neck is narrower than the tool`,
          params: { operation: g.id, area: piece.area, u: piece.at[0], v: piece.at[1] },
        })
    }
  }
  return out
}

/**
 * Q208's hint: a pattern pocket (`<feature>_pocket`) with a finishing ring (an allowance, and a
 * piece the slot rule does not take) whose narrowest web or island is at most `THIN_WALL`, finished
 * in levels deeper than `THIN_WALL`: "finish in steps of at most 3 mm" at Finish stepdown.
 */
function thinWallFinish(
  plan: LoadedPlan,
  port: Region2dPort,
  o: Operation,
  g: Extract<OperationGeometry, { kind: 'pocket' }>,
  strategy: ReturnType<typeof evaluateOperation>['strategy'],
  diameter: number,
  planOperationId: string,
): PlanWarning[] {
  if (strategy.kind !== 'pocket' || o.owner.isNone()) return []
  const { featureId, role } = o.owner.unwrap()
  if (role !== 'pocket' || strategy.finishAllowance <= 0) return []
  const steps = strategy.finishStepdown
  if (steps <= THIN_WALL + 1e-9) return []
  // the slot rule's slots have no finishing ring (H1)
  const own = pocketRegion(g).region
  if (slotSplit(own, diameter, strategy.finishAllowance).region.pieces.length === 0) return []
  // a web of exactly 3 mm counts (the web is bisected to 0.01 mm)
  const web = patternWebUnder(featureId, plan.dto.design.part.shapes ?? [], port, THIN_WALL + 0.01)
  if (web === undefined || web.width <= 0) return []
  const what = web.island ? 'pins' : 'webs'
  return [
    {
      code: 'plan.thinWallFinish',
      severity: 'info',
      planOperationId,
      field: 'strategy.finishStepdown',
      rule: 'thinWallFinish',
      message: `${featureId}: ${what} of ${mm(web.width)} mm are finished in levels of ${mm(steps)} mm; finish thin walls in steps of at most ${THIN_WALL} mm (finishStepdown)`,
      params: {
        feature: featureId,
        web: web.width,
        what,
        finishStepdown: steps,
        suggested: THIN_WALL,
      },
    },
  ]
}
