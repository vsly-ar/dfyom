// Plan mode hooks over the shell: the chosen plan (the run mode follows an explicit choice), the
// plan-operation (or setup) selection, the window's setup (F6), the library items a picker
// offers, and the plan's checks per operation. Doc: docs/conventions/ui.md#plan-mode-task-37
import { useCallback, useEffect, useState } from 'react'
import type { PlanWarning } from '../../../../core/plan/checks'
import type { PlanDTO, SetupDTO } from '../../../../core/plan/plan.dto'
import type { ProjectDoc } from '../../../../core/project/document'
import { useLibraryVersion, useShell, useUi } from '../../shell/ShellContext'
import { activeJob } from '../run/machine-state'
import { useRunStore } from '../run/run-store'
import { chosenPlan, currentSetup } from './model'
import { usePlanState, usePlanStore } from './plan-store'

/** The plan the window shows, and a setter for an explicit choice (also run mode's plan). */
export function useChosenPlan(doc: ProjectDoc): [PlanDTO | undefined, (planId: string) => void] {
  const planId = usePlanState((s) => s.planId)
  const store = usePlanStore()
  const run = useRunStore()
  const [, select] = usePlanSelection()
  const plan = chosenPlan(doc, planId)
  const choose = useCallback(
    (id: string) => {
      store.getState().choose(id)
      select(null)
      // run mode runs the plan chosen here, unless a run is going (run-v0.1.md)
      if (activeJob(run.getState().status) === undefined) run.getState().setPlan(id)
    },
    [store, run, select],
  )
  return [plan, choose]
}

/**
 * The plan-mode selection (a plan operation id, a setup id since F6, or null) and its setter.
 * Selecting a setup or a plan operation also makes its setup the window's setup (preview and
 * export), which stays when the selection is cleared.
 */
export function usePlanSelection(): [string | null, (id: string | null) => void] {
  const selected = useUi((s) => s.selection.plan)
  const select = useUi((s) => s.select)
  const store = usePlanStore()
  return [
    selected,
    useCallback(
      (id: string | null) => {
        select('plan', id)
        if (id !== null) store.getState().remember(id)
      },
      [select, store],
    ),
  ]
}

/** The setup the window previews and exports (`currentSetup`). */
export function useCurrentSetup(plan: PlanDTO): SetupDTO {
  const selected = useUi((s) => s.selection.plan)
  const last = usePlanState((s) => s.lastSelection)
  return currentSetup(plan, selected, last)
}

/** A library item as `library.<kind>.list` returns it (meta and values flat). */
export interface LibraryEntry {
  readonly id: string
  readonly name: string
  readonly [field: string]: unknown
}

/** The library's items of a kind, read when the component mounts (and when `refresh` changes). */
export function useLibraryItems(
  kind: 'tool' | 'machine',
  refresh: unknown = undefined,
): LibraryEntry[] | undefined {
  const { bridge } = useShell()
  const library = useLibraryVersion()
  const [items, setItems] = useState<LibraryEntry[] | undefined>(undefined)
  useEffect(() => {
    let live = true
    void bridge.call(`library.${kind}.list`, {}).then((r) => {
      if (live) setItems(r.ok ? (r.value as { items: LibraryEntry[] }).items : [])
    })
    return () => {
      live = false
    }
  }, [bridge, kind, refresh, library])
  return items
}

/** Checks of one plan operation (or of the plan as a whole with `null`). */
export function findingsOf(
  warnings: readonly PlanWarning[],
  planOperationId: string | null,
): PlanWarning[] {
  return warnings.filter((w) => (w.planOperationId ?? null) === planOperationId)
}
