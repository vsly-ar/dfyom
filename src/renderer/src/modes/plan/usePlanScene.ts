// The viewport's plan scene (task 3.7): the toolpaths of the window's setup in machining order
// (feeds, rapids and plunges in their colours) with the work zero marker, placed on the part by
// the setup's WCS (`setupFrame`, v0.2 task F6: a bottom or side setup lands on the part), drawn
// by the run layer without playback (nothing done, no tool marker). Current and outdated
// toolpaths are drawn, outdated ones (stale or waiting for Apply, task P3) dimmed; operations
// without one are left out. Snapshot scene (task E3b): the part drawn is the plan's part (its
// design snapshot with plan-only edits, evaluated as the plan's own subject) on the plan's stock
// copy, its edited operations tinted. `null` outside plan mode. DF69: the shown tool run's Z
// reference surface and touch-off spot (`RunScene.zRef`, z-spot.ts picks the run); dragging the
// spot snaps it to the grid inside the flat patch and commits one `plan.operation.update { zRef }`
// on release; the dropped spot is held until the plan re-reads it. DF78: the frame's origin is
// the setup's work zero, and its alignment points are drawn (`RunScene.alignment`), with the flip
// axis of registration holes dashed (`RunScene.flipAxes`, Q106). DF83: the setup's alignment
// aids as drag handles (`RunScene.aids`, aid-drag.ts snaps them); a drop commits one
// `plan.aid.set` and is held until the plan re-reads it, a click selects the aid. DF64 L3: with
// every toolpath current, the exported moves: the lowered links between operations as rapids
// (`linkedToolpaths` with `plan.warning.list`'s lowered links, docs/modes/safe-links.md#where-it-runs).
// Doc: docs/conventions/ui.md#plan-mode-task-37, docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene,
// docs/modes/z-reference.md#implementation-notes-df69. The setup's workholding (items, the open
// item's keep-out, collision hits; workholding-scene.ts, docs/modes/workholding.md#ui-summary);
// X2-6: toe clamps drag along their edge (`WorkholdingOverlay.clamps`, snapped by `snapClampAt`);
// a drop commits one `plan.workholding.set` with the whole list and is held until the plan
// re-reads it (docs/modes/workholding.md#toe-clamp-drag-x2-6). DF122: while an operation cut after
// its roughing, or that roughing, is selected, its rest region (`RunScene.rest`,
// docs/modes/roughing.md#plan-viewport-rest-shading). DF132 H5: the shown operation's holder ghost
// (`RunScene.holder`, holder-ghost.ts; docs/modes/tool-holder.md#implementation-h5). DF135 C5: the
// in-process stock while "Show in-process stock" is on (`RunScene.inProcessStock`,
// useInProcessStock.ts; docs/modes/cut-state.md#in-process-stock-display-c5).
import { useEffect, useMemo, useState } from 'react'
import type { EvaluationStatus } from '../../../../core/design/evaluation'
import type { AppMode } from '../../../../core/modes'
import type { PlanDTO, PlanOperationDTO, SetupDTO } from '../../../../core/plan/plan.dto'
import {
  acrossEdge,
  EDGE_WORD,
  edgeLength,
  lengthText as summaryLength,
} from '../../../../core/plan/workholding/items'
import { setupWorkholding } from '../../../../core/plan/workholding/setup'
import { resolveHolder } from '../../../../core/library/holder'
import { holderSizes } from '../../../../core/plan/workholding/findings'
import { runStickoutNeeded, toolRuns } from '../../../../core/plan/tool-runs'
import { cutIds, cutTest } from '../../../../core/plan/cut'
import { linkedToolpaths } from '../../../../core/toolpath/links'
import type { Toolpath } from '../../../../core/toolpath/model'
import { usePlanEvaluation, useReplica, useUi } from '../../shell/ShellContext'
import {
  toolpathLines,
  type AidOverlay,
  type AlignmentMarker,
  type AlignmentTarget,
  type Box,
  type ClampDrag,
  type FlipAxisLine,
  type RunScene,
  type ViewportMesh,
  type ZRefOverlay,
} from '../../viewport'
import { DIRECTION_LABEL, stockFaceDirection } from '../../../../core/geometry/face'
import { deviationMessages } from '../../messages/deviation'
import { lengthSource } from '../../messages/dfm'
import { planMessages } from '../../messages/plan'
import {
  allPlanOperations,
  allows,
  chosenPlan,
  currentSetup,
  editedOperations,
  loadedPlanOf,
  planPart,
  planStockSize,
  pointsWithAdded,
  setupPlacement,
  setupZeroOf,
  shownRest,
  lengthText,
} from './model'
import {
  useDeviationBasis,
  usePlanCommand,
  usePlanData,
  usePlanState,
  usePlanStore,
  type PlanData,
} from './plan-store'
import {
  clampAxis,
  moveClamp,
  shiftOverlay,
  snapClampAt,
  workholdingOverlay,
} from './workholding-scene'
import { useMeasuredFrom } from './workholding-from'
import { holderGhost } from './holder-ghost'
import { shownZRefRun, snapSpot } from './z-spot'
import { aidAnchor, movedAidArgs, snapAid } from './aid-drag'
import { usePlanSelection } from './usePlan'
import { useInProcessStock } from './useInProcessStock'

type P = readonly [number, number]

/** A dragged or dropped spot of run `run` (its first plan operation). */
interface HeldSpot {
  readonly run: string
  readonly at: P
  readonly dragging: boolean
}

/** A dragged or dropped aid (setup frame), with its distance off the flip axis (holes). */
interface HeldAid {
  readonly id: string
  readonly at: P
  readonly dragging: boolean
  readonly offAxis?: number | undefined
}

/** A dragged or dropped toe clamp: its centre along the edge (setup frame, mm). */
interface HeldClamp {
  readonly itemId: string
  readonly at: number
  readonly dragging: boolean
}

const same = (a: P, b: P) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6

/** The plan the plan scene shows, or undefined (another mode, no project or no plan). */
function useScenePlan(mode: AppMode): PlanDTO | undefined {
  const replica = useReplica()
  const planId = usePlanState((s) => s.planId)
  const doc = replica.status === 'open' ? replica.doc : undefined
  return mode !== 'plan' || doc === undefined ? undefined : chosenPlan(doc, planId)
}

export function usePlanScene(mode: AppMode): RunScene | null {
  const replica = useReplica()
  const plan = useScenePlan(mode)
  const data = usePlanData(plan?.id)
  const selected = useUi((s) => s.selection.plan)
  const last = usePlanState((s) => s.lastSelection)
  const preview = usePlanState((s) => s.zRefPreview)
  const focusedPoint = usePlanState((s) => s.alignmentPoint)
  const picking = usePlanState((s) => s.pickingAlignment)
  const openItem = usePlanState((s) => s.workholdingItem)
  const showCut = usePlanState((s) => s.showCutToolpaths)
  const showStock = usePlanState((s) => s.showInProcessStock)
  const call = usePlanCommand()
  const [held, setHeld] = useState<HeldSpot | null>(null)
  const [heldAid, setHeldAid] = useState<HeldAid | null>(null)
  const [heldClamp, setHeldClamp] = useState<HeldClamp | null>(null)
  const planStore = usePlanStore()
  const [, selectPlan] = usePlanSelection()
  const doc = replica.status === 'open' ? replica.doc : undefined
  const setup = plan === undefined ? undefined : currentSetup(plan, selected, last)
  // DF69: the shown run's reference, only in the window's setup (the scene draws only that one)
  const runId = plan === undefined ? undefined : shownZRefRun(plan, selected, preview)
  const zRun = data?.zRefs.find(
    (r) => r.planOperationId === runId && r.setupId === setup?.id && r.zRef !== null,
  )
  const storedAt = zRun?.zRef?.at
  // a dropped spot is held until the plan re-reads it (or another run is shown)
  useEffect(() => {
    if (held === null || held.dragging) return
    if (held.run !== runId || (storedAt !== undefined && same(storedAt, held.at))) setHeld(null)
  }, [held, runId, storedAt])
  const units = doc?.unitSystem ?? 'mm'
  const zRef = useMemo((): ZRefOverlay | undefined => {
    const z = zRun?.zRef
    const outline = zRun?.outline
    if (plan === undefined || zRun === undefined || z == null || outline == null) return undefined
    const run = zRun.planOperationId
    const at = held !== null && held.run === run ? held.at : z.at
    const stored = allPlanOperations(plan).find((o) => o.id === run)?.zRef
    const commit = async (to: P) => {
      setHeld({ run, at: to, dragging: false })
      const r = await call('plan.operation.update', {
        planId: plan.id,
        planOperationId: run,
        zRef: {
          ...(stored?.surface === undefined ? {} : { surface: stored.surface }),
          at: [`${to[0]} mm`, `${to[1]} mm`],
        },
      })
      if (!r.ok) setHeld(null)
    }
    return {
      key: `${run}:${z.surface}`,
      patch: outline.patch,
      level: z.level,
      at,
      clearance: outline.clearance,
      caption: planMessages.toolChanges.zSpotCaption(
        lengthSource(at[0], units),
        lengthSource(at[1], units),
      ),
      draggable: allows(plan, 'plan.operation.update'),
      dragging: held !== null && held.run === run && held.dragging,
      onDrag(phase, point) {
        if (phase === 'cancel') return setHeld(null)
        if (phase === 'start') return setHeld({ run, at, dragging: true })
        const to = snapSpot(point, outline.grid, outline.spotArea) ?? at
        if (phase === 'move') return setHeld({ run, at: to, dragging: true })
        if (same(to, z.at)) return setHeld(null)
        void commit(to)
      },
    }
  }, [zRun, plan, held, call, units])
  // DF78: the setup's zero (the frame's origin) and its alignment points
  const info = data?.alignment.find((a) => a.setupId === setup?.id)
  const alignment = useMemo((): AlignmentMarker[] => {
    if (info === undefined) return []
    const bad = new Set(
      (data?.warnings ?? [])
        .filter((w) => w.code === 'plan.alignment' && w.severity === 'error')
        .map((w) => w.params['alignmentPointId']),
    )
    return info.points.flatMap((p, i) =>
      p.wcs === null
        ? []
        : [
            {
              id: p.id,
              at: p.wcs,
              n: i + 1,
              name: p.name,
              error: bad.has(p.id),
              selected: p.id === focusedPoint,
            },
          ],
    )
  }, [info, data?.warnings, focusedPoint])
  // Q106 (assumed): the flip axes of registration holes, dashed, in the setup's WCS
  const flipAxes = useMemo((): FlipAxisLine[] => {
    if (info?.flipAxes === undefined || setup === undefined || plan === undefined) return []
    const zero = setupZeroOf(setup, info)
    return info.flipAxes.map((x) => ({
      key: x.otherSetupId,
      from: [x.from[0] - zero[0], x.from[1] - zero[1]],
      to: [x.to[0] - zero[0], x.to[1] - zero[1]],
      label: planMessages.setup.flipAxis(
        plan.setups.find((s) => s.id === x.otherSetupId)?.name ?? '',
      ),
    }))
  }, [info, setup, plan])
  // DF83: the setup's aids as drag handles (setup frame → WCS: less the zero)
  const aidOps = useMemo(
    () => (setup?.operations ?? []).filter((o) => o.aid !== undefined),
    [setup],
  )
  useEffect(() => {
    if (heldAid === null || heldAid.dragging) return
    const op = aidOps.find((o) => o.id === heldAid.id)
    if (op === undefined || same(aidAnchor(op.aid!), heldAid.at)) setHeldAid(null)
  }, [heldAid, aidOps])
  const aids = useMemo((): AidOverlay | undefined => {
    if (plan === undefined || setup === undefined || aidOps.length === 0) return undefined
    const zero = setupZeroOf(setup, info)
    const axes = info?.flipAxes ?? []
    const wcs = (p: P): P => [p[0] - zero[0], p[1] - zero[1]]
    const m = planMessages.aid
    return {
      draggable: allows(plan, 'plan.operation.update'),
      handles: aidOps.map((op) => {
        const aid = op.aid!
        const mine = heldAid?.id === op.id ? heldAid : undefined
        const anchor = mine?.at ?? aidAnchor(aid)
        const shift: P = [anchor[0] - aidAnchor(aid)[0], anchor[1] - aidAnchor(aid)[1]]
        const line = aid.kind === 'witnessMark' && 'from' in aid
        const off =
          mine?.offAxis ??
          (aid.kind === 'registrationHole' && axes.length > 0
            ? snapAid(aid, anchor, axes).offAxis
            : undefined)
        return {
          id: op.id,
          kind: aid.kind === 'registrationHole' ? 'hole' : line ? 'line' : 'spot',
          at: wcs(anchor),
          ...(line ? { to: wcs([aid.to[0] + shift[0], aid.to[1] + shift[1]]) } : {}),
          radius: aid.kind === 'registrationHole' ? aid.diameter / 2 : (aid.markDiameter ?? 1) / 2,
          caption: m.dragCaption(
            aid.name,
            lengthSource(anchor[0], units),
            lengthSource(anchor[1], units),
            off === undefined
              ? undefined
              : off < 0.05
                ? m.onAxis
                : m.offAxis(lengthSource(off, units)),
          ),
          selected: op.id === selected,
          dragging: mine?.dragging ?? false,
        }
      }),
      onSelect: (id) => selectPlan(id),
      onDrag(phase, id, point) {
        const op = aidOps.find((o) => o.id === id)
        if (op === undefined) return
        const aid = op.aid!
        if (phase === 'cancel') return setHeldAid(null)
        // back to the setup frame (the inspector's positions)
        const p: P = [point[0] + zero[0], point[1] + zero[1]]
        if (phase === 'start') return setHeldAid({ id, at: aidAnchor(aid), dragging: true })
        const snapped = snapAid(aid, p, axes)
        if (phase === 'move')
          return setHeldAid({ id, at: snapped.at, dragging: true, offAxis: snapped.offAxis })
        if (same(snapped.at, aidAnchor(aid))) return setHeldAid(null)
        setHeldAid({ id, at: snapped.at, dragging: false, offAxis: snapped.offAxis })
        void call('plan.aid.set', {
          planId: plan.id,
          planOperationId: id,
          aid: movedAidArgs(aid, snapped.at),
        }).then((r) => {
          if (!r.ok) setHeldAid(null)
        })
      },
    }
  }, [plan, setup, aidOps, info, heldAid, selected, units, call, selectPlan])
  // X2-6: the setup's toe clamps drag along their edge (setup frame → WCS: less the zero)
  const planStock =
    plan === undefined || doc === undefined ? undefined : planPart(doc, plan).loaded?.stock
  const holding =
    setup === undefined || planStock === undefined ? undefined : setupWorkholding(setup, planStock)
  useEffect(() => {
    if (heldClamp === null || heldClamp.dragging) return
    const item = holding?.items.find((i) => i.id === heldClamp.itemId)
    if (item?.kind !== 'toeClamp' || Math.abs(item.at - heldClamp.at) < 1e-6) setHeldClamp(null)
  }, [heldClamp, holding])
  // DF125: the chip reads the position as the inspector does (stock corner or work zero)
  const xyFrom = useMeasuredFrom().from.xy
  const clamps = useMemo((): ClampDrag | undefined => {
    if (plan === undefined || setup === undefined || holding === undefined) return undefined
    if (!allows(plan, 'plan.workholding.set')) return undefined
    const toe = holding.items.flatMap((i) => (i.kind === 'toeClamp' ? [i] : []))
    if (toe.length === 0) return undefined
    const zero = setupZeroOf(setup, info)
    const m = planMessages.workholding
    const s = holding.stock
    const commit = (itemId: string, at: number) => {
      setHeldClamp({ itemId, at, dragging: false })
      void call('plan.workholding.set', {
        planId: plan.id,
        setupId: setup.id,
        items: (setup.workholding ?? []).map((i) =>
          i.id === itemId ? { id: i.id, kind: i.kind, at: `${at} mm` } : { id: i.id, kind: i.kind },
        ),
      }).then((r) => {
        if (!r.ok) setHeldClamp(null)
      })
    }
    return {
      handles: toe.map((c) => {
        const axis = clampAxis(c.edge)
        const mine = heldClamp?.itemId === c.id ? heldClamp : undefined
        const at = mine?.at ?? c.at
        const half = Math.min(c.grip, acrossEdge(c.edge, s)) / 2
        const across =
          c.edge === 'vMin' || c.edge === 'uMin'
            ? half
            : (c.edge === 'vMax' ? s.width : s.length) - half
        const anchor: P = axis === 0 ? [at, across] : [across, at]
        const shown = at - (xyFrom === 'zero' ? zero[axis] : 0)
        const where = `${EDGE_WORD[c.edge]} ${axis === 0 ? 'X' : 'Y'}${summaryLength(shown, units === 'inch' ? 'in' : 'mm')}`
        return {
          itemId: c.id,
          axis,
          at: at - zero[axis],
          anchor: [anchor[0] - zero[0], anchor[1] - zero[1], c.top] as const,
          caption: m.clampCaption(c.name, where),
          label: m.clampLabel(c.name, where),
          dragging: mine?.dragging ?? false,
        }
      }),
      onSelect: (itemId) => planStore.getState().selectWorkholding({ setupId: setup.id, itemId }),
      onDrag(phase, itemId, wcsAt) {
        const c = toe.find((i) => i.id === itemId)
        if (c === undefined) return
        if (phase === 'cancel') return setHeldClamp(null)
        if (phase === 'start') return setHeldClamp({ itemId, at: c.at, dragging: true })
        const axis = clampAxis(c.edge)
        const at = snapClampAt(wcsAt + zero[axis], edgeLength(c.edge, s), c.width)
        if (phase === 'move') return setHeldClamp({ itemId, at, dragging: true })
        if (Math.abs(at - c.at) < 1e-6) return setHeldClamp(null)
        commit(itemId, at)
      },
      onNudge(itemId, mm) {
        const c = toe.find((i) => i.id === itemId)
        if (c === undefined) return
        const len = edgeLength(c.edge, s)
        const at = Math.min(len, Math.max(0, Math.round((c.at + mm) * 1000) / 1000))
        if (Math.abs(at - c.at) > 1e-6) commit(itemId, at)
      },
    }
  }, [plan, setup, holding, info, heldClamp, units, call, planStore, xyFrom])
  // S22: while picking, the setup's valid sources are targets; a click adds that point
  const targets = useMemo((): AlignmentTarget[] => {
    if (plan === undefined || setup === undefined || picking !== setup.id) return []
    const zero = setupZeroOf(setup, info)
    const sources = data?.alignmentSources.find((a) => a.setupId === setup.id)?.sources ?? []
    return sources.map((src) => {
      const at: P = [src.at[0] - zero[0], src.at[1] - zero[1]]
      return {
        key: JSON.stringify(src.source),
        at,
        label: planMessages.setup.pickTarget(
          src.name,
          lengthSource(at[0], units),
          lengthSource(at[1], units),
        ),
        onPick: () =>
          void call('plan.alignment.set', {
            planId: plan.id,
            setupId: setup.id,
            points: pointsWithAdded(setup, src.source),
          }),
      }
    })
  }, [plan, setup, picking, info, data?.alignmentSources, units, call])
  // DF135 C5: the material left after the cut operations, with the zeros the toolpaths were made at
  const zeros = useMemo(
    () =>
      plan === undefined
        ? undefined
        : Object.fromEntries(
            plan.setups.map((s) => [
              s.id,
              setupZeroOf(
                s,
                data?.alignment.find((a) => a.setupId === s.id),
              ),
            ]),
          ),
    [plan, data?.alignment],
  )
  const inProcessStock = useInProcessStock(plan, units, mode === 'plan' && showStock, zeros)
  return useMemo(() => {
    if (data === undefined || plan === undefined || setup === undefined || doc === undefined)
      return null
    // per-setup preview (task F6): only the window's setup, placed on the part by its WCS
    const drawn = setup.operations.flatMap((o) => {
      const entry = data.toolpaths[o.id]
      return entry?.toolpath ? [entry] : []
    })
    // outdated (stale, or the plan waits for Apply): dimmed until regenerated (P3)
    const outdated = drawn.map((e) => e.stale || e.pendingApply === true || data.pendingApply)
    // DF64 L3: the exported moves, the lowered links between operations as rapids, once every
    // toolpath of the setup is current (the links are computed from exactly those)
    const lowered = data.links.find((l) => l.setupId === setup.id)?.links?.lowered ?? []
    const generated = drawn.map((e) => e.toolpath as Toolpath)
    const linked =
      lowered.length > 0 && drawn.length === setup.operations.length && !outdated.some(Boolean)
        ? linkedToolpaths(generated, lowered)
        : generated
    // DF135: a cut operation's toolpath is hidden unless "Show cut toolpaths" is on
    const cut = cutIds(plan)
    const drawnIds = setup.operations.flatMap((o) => (data.toolpaths[o.id]?.toolpath ? [o.id] : []))
    const shown = (_: unknown, i: number) => showCut || !cut.has(drawnIds[i]!)
    const toolpaths = linked.filter(shown)
    const shownOutdated = outdated.filter(shown)
    const stock = planStockSize(doc, plan)
    // workholding.md#ui-summary: the setup's items, the open item's keep-out, collision hits;
    // a dragged clamp drawn where it is held (X2-6)
    const overlay =
      holding === undefined
        ? undefined
        : workholdingOverlay(
            holding,
            setup.id,
            openItem?.setupId === setup.id ? openItem.itemId : undefined,
            data.warnings,
            // design review R8 (D75): an operation or an open item is selected; the setup itself
            // selected (its Workholding group in view) keeps every clamp drawn and draggable
            (selected !== null && selected !== setup.id) || openItem?.setupId === setup.id,
          )
    const heldItem = holding?.items.find((i) => i.id === heldClamp?.itemId)
    const moved =
      overlay === undefined || heldClamp === null || heldItem?.kind !== 'toeClamp'
        ? overlay
        : moveClamp(overlay, heldItem.id, clampAxis(heldItem.edge), heldClamp.at - heldItem.at)
    const shifted = shiftOverlay(moved, setupZeroOf(setup, info))
    const workholding =
      shifted === undefined ? undefined : clamps === undefined ? shifted : { ...shifted, clamps }
    // DF122: the selected owner's (or its roughing's) rest region
    const rest = shownRest(plan, setup, selected, data.toolpaths)
    // DF132 H5: the shown operation's holder ghost
    const ghostOp = shownHolderOperation(setup, selected, preview, data, cutTest(plan.design.part))
    const loaded = ghostOp === undefined ? undefined : loadedPlanOf(doc, plan)
    const tool = ghostOp?.tool === undefined ? undefined : loaded?.tools.get(ghostOp.tool)
    // H6: the tool's own holder, else the machine's
    const holder =
      loaded === undefined
        ? undefined
        : resolveHolder(tool, loaded.machine).mapOr(undefined, holderSizes)
    const entry = ghostOp === undefined ? undefined : data.toolpaths[ghostOp.id]
    const current =
      entry?.toolpath != null && !entry.stale && entry.pendingApply !== true && !data.pendingApply
        ? (entry.toolpath as Toolpath)
        : undefined
    const ghost = holderGhost({
      op: data.operations?.find((o) => o.id === ghostOp?.id),
      holder,
      tool:
        tool === undefined
          ? undefined
          : {
              diameter: tool.diameter.canonical,
              ...tool.shankDiameter.mapOr<{ shankDiameter?: number }>({}, (q) => ({
                shankDiameter: q.canonical,
              })),
            },
      toolpath: current,
      warnings: data.warnings,
      label: (stickout, needed) =>
        planMessages.toolChanges.holderGhost(
          lengthSource(stickout, units),
          lengthSource(needed, units, 'up'),
        ),
    })
    return {
      lines: toolpaths.length === 0 ? null : toolpathLines(toolpaths),
      done: 0,
      tool: null,
      ...(shownOutdated.some(Boolean) ? { outdated: shownOutdated } : {}),
      ...(stock === undefined
        ? {}
        : { frame: setupPlacement(setup, stock, setupZeroOf(setup, info)) }),
      ...(zRef === undefined ? {} : { zRef }),
      ...(alignment.length === 0 ? {} : { alignment }),
      ...(targets.length === 0 ? {} : { alignmentTargets: targets }),
      ...(flipAxes.length === 0 ? {} : { flipAxes }),
      ...(aids === undefined ? {} : { aids }),
      ...(workholding === undefined ? {} : { workholding }),
      ...(rest === undefined ? {} : { rest: { patch: rest.patch, level: rest.level } }),
      ...(ghost === undefined ? {} : { holder: ghost }),
      ...(inProcessStock === undefined ? {} : { inProcessStock }),
    }
  }, [
    inProcessStock,
    preview,
    units,
    data,
    plan,
    setup,
    doc,
    zRef,
    info,
    alignment,
    targets,
    flipAxes,
    aids,
    openItem,
    selected,
    holding,
    heldClamp,
    clamps,
    showCut,
  ])
}

/**
 * The operation whose holder ghost the plan scene shows (DF132 H5, tool-holder.md § Viewport): the
 * tool run whose tool-change row is hovered or focused (`preview`, its first operation's id) by
 * the operation that decides the run's minimum stickout (one with a `holder` collision first);
 * else the selected plan operation; only in the scene's setup.
 */
export function shownHolderOperation(
  setup: SetupDTO,
  selected: string | null,
  preview: string | undefined,
  data: Pick<PlanData, 'operations' | 'warnings'>,
  /** DF135: already-cut operations are in no tool run. */
  isCut: (op: PlanOperationDTO) => boolean = () => false,
): PlanOperationDTO | undefined {
  const run =
    preview === undefined
      ? undefined
      : toolRuns(setup.operations, isCut).find((r) => r.operations[0]?.id === preview)
  if (run === undefined) return setup.operations.find((o) => o.id === selected)
  const colliding = run.operations.find((o) =>
    data.warnings.some(
      (w) =>
        w.code === 'plan.workholding.collision' &&
        w.rule === 'holder' &&
        w.planOperationId === o.id,
    ),
  )
  if (colliding !== undefined) return colliding
  const rows = run.operations.map((o) => data.operations?.find((r) => r.id === o.id))
  const needed = runStickoutNeeded(rows.map((r) => r?.stickoutNeeded))
  return run.operations.find((_, i) => needed !== undefined && rows[i]?.stickoutNeeded === needed)
}

/** The deviation panel's chosen region in the plan scene (U4 follow-up). */
export interface PlanDeviationScene {
  readonly regionMarker?: {
    readonly box: Box
    readonly sign: 'overcut' | 'undercut'
    readonly label: string
  }
  readonly focus?: { readonly box: Box; readonly seq: number }
}

/**
 * The deviation panel's chosen region marked and framed (docs/modes/deviation.md#region-marker-u4-follow-up):
 * only for the plan the window shows, and only while its result is current (an edit, an Apply or
 * a library change since the run drops the marker).
 */
export function usePlanDeviationScene(mode: AppMode): PlanDeviationScene {
  const plan = useScenePlan(mode)
  const replica = useReplica()
  const doc = replica.status === 'open' ? replica.doc : undefined
  const run = usePlanState((s) => s.deviation)
  const basis = useDeviationBasis(plan?.id ?? '')
  const marked = run?.marked
  if (plan === undefined || run?.planId !== plan.id || marked === undefined) return {}
  const region = run.chosen === undefined ? undefined : run.result?.regions[run.chosen]
  if (run.basis !== basis || region === undefined) return {}
  const units = doc?.unitSystem ?? 'mm'
  const face = stockFaceDirection(region.face)
  const label = deviationMessages.marked(
    deviationMessages.region(region.sign, lengthText(region.maxDev, units), undefined),
    face === undefined ? region.face : DIRECTION_LABEL[face],
  )
  return { regionMarker: { box: marked.box, sign: marked.sign, label }, focus: marked.focus }
}

/** The plan's part as the plan scene draws it. */
export interface PlanPartScene {
  /** The last good mesh of the plan's part; null before its first evaluation. */
  readonly mesh: ViewportMesh | null
  readonly stock: Box | null
  readonly status: EvaluationStatus
  /** Design operations edited in the plan (tinted); null when none. */
  readonly tinted: ReadonlySet<string> | null
}

/** The snapshot scene's part, or null (not in plan mode, or no plan). */
export function usePlanPartScene(mode: AppMode): PlanPartScene | null {
  const replica = useReplica()
  const plan = useScenePlan(mode)
  const evaluation = usePlanEvaluation(plan?.id)
  const doc = replica.status === 'open' ? replica.doc : undefined
  const shape = useMemo(() => {
    if (plan === undefined || doc === undefined) return undefined
    const s = planPart(doc, plan).loaded?.stock
    const edited = editedOperations(plan)
    return {
      stock:
        s === undefined
          ? null
          : {
              min: [0, 0, -s.thickness.canonical] as const,
              max: [s.length.canonical, s.width.canonical, 0] as const,
            },
      tinted: edited.size === 0 ? null : edited,
    }
  }, [plan, doc])
  if (plan === undefined || shape === undefined) return null
  return {
    mesh: evaluation?.mesh ?? null,
    stock: shape.stock,
    status: evaluation?.status ?? 'pending',
    tinted: shape.tinted,
  }
}
