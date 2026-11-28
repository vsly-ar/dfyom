// The in-process stock of a plan for the Plan and Run scenes (hardening DF135, cut-state slice
// C5): the window reads its already-cut operations' toolpaths (`plan.toolpath.get`, again after a
// generation), runs the simulated cut of those alone (`inProcessStockInput`, `simulateHeightmap`)
// and builds the solid (`inProcessStockMesh`), off the render, cached by the input's key (the
// same cut toolpaths, stock and zeros give the same solid; switching modes or setups does not
// recompute). Nothing while the plan has no cut operation or one of them has no toolpath yet.
// A recut unit's as-cut regions are stamped into the maps (C4 follow-up, `asCutStamps`, with the
// window's 2D port).
// Doc: docs/modes/cut-state.md#in-process-stock-display-c5
import { useEffect, useMemo, useState } from 'react'
import type { Vec2 } from '../../../../core/geometry/model'
import { recutUnits } from '../../../../core/design/already-cut'
import {
  asCutStamps,
  inProcessStockInput,
  inProcessStockMesh,
  stampAsCut,
  type CutToolpathEntry,
} from '../../../../core/plan/in-process-stock'
import { cutIds } from '../../../../core/plan/cut'
import { loadPlanDTO } from '../../../../core/plan/plan'
import type { PlanDTO } from '../../../../core/plan/plan.dto'
import type { UnitSystem } from '../../../../core/project/document'
import { simulateHeightmap } from '../../../../core/toolpath/simulate'
import { useRegion2d, useShell } from '../../shell/ShellContext'
import type { InProcessStockView } from '../../viewport'

/** Solids by input key; a few plans' worth (each is a few MB of vertices). */
const cache = new Map<string, InProcessStockView>()
const CACHE_MAX = 4

function remember(key: string, view: InProcessStockView): void {
  cache.delete(key)
  cache.set(key, view)
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
}

/**
 * The plan's in-process stock while `active`, else undefined. `zeros`: the setups' work zeros as
 * the window knows them (Plan: the plan's alignment answer), else the core's own.
 */
export function useInProcessStock(
  plan: PlanDTO | undefined,
  units: UnitSystem,
  active: boolean,
  zeros?: Readonly<Record<string, Vec2>>,
): InProcessStockView | undefined {
  const { bridge, replica: events } = useShell()
  const [view, setView] = useState<InProcessStockView | undefined>(undefined)
  // a generation (Plan, the run's own, another window) writes toolpaths without a revision
  const [generated, setGenerated] = useState(0)
  useEffect(
    () =>
      events.onEvent((e) => {
        if (e.type === 'job' && e.name === 'plan.toolpath.generate' && e.state === 'finished')
          setGenerated((n) => n + 1)
      }),
    [events],
  )
  const port = useRegion2d()
  const cut = useMemo(() => (plan === undefined ? [] : [...cutIds(plan)]), [plan])
  const recut = useMemo(() => (plan === undefined ? 0 : recutUnits(plan.design.part).size), [plan])
  const zeroKey = zeros === undefined ? '' : JSON.stringify(zeros)
  useEffect(() => {
    if (!active || plan === undefined || (cut.length === 0 && recut === 0)) {
      setView(undefined)
      return
    }
    let live = true
    void (async () => {
      const read = await Promise.all(
        cut.map((planOperationId) =>
          bridge.call('plan.toolpath.get', { planId: plan.id, planOperationId }),
        ),
      )
      if (!live) return
      const entries = new Map<string, CutToolpathEntry>()
      read.forEach((r, i) => r.ok && entries.set(cut[i]!, r.value as CutToolpathEntry))
      const loaded = loadPlanDTO(plan, units, 'in-process stock')
      if (loaded.isErr()) return setView(undefined)
      const given = zeroKey === '' ? undefined : (JSON.parse(zeroKey) as Record<string, Vec2>)
      const input = inProcessStockInput(
        loaded.unwrap(),
        (id) => entries.get(id),
        given === undefined ? undefined : (s) => given[s.id] ?? [0, 0],
        asCutStamps(loaded.unwrap(), port),
      )
      if (input.kind !== 'ready') return setView(undefined)
      const hit = cache.get(input.key)
      if (hit !== undefined) return setView(hit)
      const maps = simulateHeightmap(input.simulate)
      if (maps.isErr()) return setView(undefined)
      const stamped = stampAsCut(maps.unwrap(), input.stamps, input.simulate.stock)
      const made = {
        mesh: inProcessStockMesh(stamped, input.simulate.stock),
        operations: input.operations.length + input.recut.length,
      }
      remember(input.key, made)
      setView(made)
    })()
    return () => {
      live = false
    }
  }, [active, plan, cut, recut, units, zeroKey, generated, bridge, port])
  return active ? view : undefined
}
