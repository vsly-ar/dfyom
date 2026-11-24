/**
 * Plan findings of general shapes (v0.3 T1/T2 wiring): `plan.restMaterial` (warning) where the
 * plan's tool leaves material in a pocket's necks, and `plan.stepoverClamped` (info, T-H) where the
 * region generators clamp the stepover to the tool radius. They need the 2D port, so only
 * `plan.warning.list` (which has `services.region2d`) lists them; neither ever blocks.
 * Doc: docs/modes/plan-v0.3.md#wiring-t1-t2
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
import type { PlanWarning } from './checks'
import { evaluateOperation } from './evaluate'
import type { LoadedPlan } from './plan'

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
      if (g.kind !== 'pocket') continue
      // a pocket on the stock edge is cut as its open region (DF61): its rest inside the stock
      const R = tool.diameter / 2
      const face = localStock(g.direction ?? '+z', geometry.unwrap().stock)
      const own = pocketRegion(g).region
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
