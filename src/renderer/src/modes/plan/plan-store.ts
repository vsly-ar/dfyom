// Plan-mode state of one window (task 3.7): the chosen plan and setup (F6), the plan queries of the current
// revision (operations with resolved feeds, checks, stale list, toolpaths) shared by navigator,
// inspector, status bar and viewport, toolpath generation (a job, followed with `job.get`) and
// the gCode export. Every change is a command over the bridge. One store per bridge.
// Doc: docs/conventions/ui.md#plan-mode-task-37, docs/modes/plan-v0.1.md#commands-and-queries-v01
import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { PlanWarning } from '../../../../core/plan/checks'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { CallReply, PreloadApi } from '../../../../shared/preload-api'
import { useCall } from '../../shell/hooks'
import { usePending, useReplica, useShell } from '../../shell/ShellContext'
import type { PlanOperationView, PlanStale, ToolpathEntry } from './model'

/** Progress poll of the toolpath job (`job.get`): progress ticks are not pushed (ui.md#jobs). */
export const GENERATE_POLL_MS = 250

/** The plan queries of one revision. */
export interface PlanData {
  readonly planId: string
  /** `undefined` while loading or when the plan does not load (`error`). */
  readonly operations: readonly PlanOperationView[] | undefined
  readonly error?: AppErrorData | undefined
  readonly warnings: readonly PlanWarning[]
  readonly stale: PlanStale | undefined
  readonly toolpaths: Readonly<Record<string, ToolpathEntry>>
  /** Its inputs have changes not applied yet (P3: notice, checks outdated, toolpaths dimmed). */
  readonly pendingApply: boolean
}

export interface PlanExportResult {
  readonly filePath: string
  readonly lines: number
  readonly stats: { estimatedSeconds: number; toolChanges: number }
  readonly warnings: readonly PlanWarning[]
  readonly softLimitChecked: boolean
  readonly regenerated: readonly string[]
}

export interface PlanState {
  /** The plan the window shows (picker); undefined = the first one. */
  readonly planId: string | undefined
  /**
   * The setup or plan operation selected last (task F6): its setup is previewed and exported
   * while nothing is selected; undefined = the first setup (`currentSetup` in model.ts).
   */
  readonly lastSelection: string | undefined
  readonly data: PlanData | undefined
  /** Toolpath generation of this window. */
  readonly generating: { readonly planId: string; readonly jobId: string } | undefined
  readonly progress: { done: number; total?: number | undefined } | undefined
  /** Why the last generation failed as a whole (`plan.check` …), or undefined. */
  readonly generateError: AppErrorData | undefined
  /** Plan operations whose toolpath failed in the last generation, with the error. */
  readonly failures: Readonly<Record<string, AppErrorData>>
  readonly exporting: boolean
  /** The export dialog shows this result, or the error. */
  readonly exported:
    | { readonly ok: true; readonly result: PlanExportResult; readonly setup?: string }
    | { readonly ok: false; readonly error: AppErrorData }
    | undefined
  choose(planId: string | undefined): void
  remember(selection: string): void
  /** Loads the plan queries for `tag` (key, plan, revision, generation) once. */
  want(tag: string, planId: string): void
  generate(planId: string): Promise<void>
  /**
   * Exports one program: the whole plan when it has one setup, else `setup` (`setupId` and a
   * label for the outcome dialog; docs/modes/plan-v0.2.md#implementation-task-e2).
   */
  exportPlan(
    planId: string,
    name: string,
    setup?: { readonly id: string; readonly label: string },
  ): Promise<void>
  closeExport(): void
  /**
   * Re-reads the plan: toolpaths changed without a revision (an apply job finished, P3). `seq`:
   * the action-log event that says so; each event reloads once, however many hooks see it.
   */
  reload(seq: number): void
}

export type PlanStore = StoreApi<PlanState>

interface JobInfo {
  readonly state: string
  readonly progress?: { done: number; total?: number }
  readonly outcome?: { ok: true; value: unknown } | { ok: false; error: AppErrorData }
}

export function createPlanStore(bridge: Pick<PreloadApi, 'call' | 'files'>): PlanStore {
  let tag: string | undefined
  /** Bumped when toolpaths may have changed without a revision (generation, export). */
  let round = 0
  /** The last event `reload` acted on. */
  let reloaded = -1
  const store = createStore<PlanState>()((set, get) => ({
    planId: undefined,
    lastSelection: undefined,
    data: undefined,
    generating: undefined,
    progress: undefined,
    generateError: undefined,
    failures: {},
    exporting: false,
    exported: undefined,
    choose: (planId) =>
      set({ planId, lastSelection: undefined, generateError: undefined, failures: {} }),
    remember: (lastSelection) => set({ lastSelection }),
    want(next, planId) {
      const t = `${next}:${round}`
      if (t === tag) return
      tag = t
      void load(planId).then((data) => {
        if (tag === t) set({ data })
      })
    },
    async generate(planId) {
      if (get().generating !== undefined) return
      set({ generateError: undefined, failures: {}, progress: undefined })
      const r = await bridge.call('plan.toolpath.generate', { planId })
      if (!r.ok) {
        set({ generateError: r.error })
        return
      }
      const { jobId } = r.value as { jobId: string }
      set({ generating: { planId, jobId } })
      for (;;) {
        const info = await bridge.call('job.get', { jobId })
        if (!info.ok) break
        const job = info.value as JobInfo
        if (job.progress) set({ progress: job.progress })
        if (job.state === 'finished' && job.outcome !== undefined) {
          const o = job.outcome
          if (!o.ok) {
            if (o.error.code !== 'op.aborted') set({ generateError: o.error })
          } else {
            const ops = (
              o.value as {
                operations: { planOperationId: string; status: string; error?: AppErrorData }[]
              }
            ).operations
            const failures: Record<string, AppErrorData> = {}
            for (const op of ops)
              if (op.status === 'failed' && op.error) failures[op.planOperationId] = op.error
            set({ failures })
          }
          break
        }
        await new Promise((resolve) => setTimeout(resolve, GENERATE_POLL_MS))
      }
      round++
      set({ generating: undefined, progress: undefined })
      refresh()
    },
    async exportPlan(planId, name, setup) {
      if (get().exporting) return
      const target = await bridge.files.chooseExport(name)
      if (target === null) return
      set({ exporting: true })
      // the OS dialog already asked before replacing a file (as Save as, ui.md#project-files)
      const r = await bridge.call('plan.export', {
        planId,
        ...(setup === undefined ? {} : { setupId: setup.id }),
        target,
        confirm: true,
      })
      round++
      set({
        exporting: false,
        exported: r.ok
          ? {
              ok: true,
              result: r.value as PlanExportResult,
              ...(setup === undefined ? {} : { setup: setup.label }),
            }
          : { ok: false, error: r.error },
      })
      refresh()
    },
    closeExport: () => set({ exported: undefined }),
    reload(seq) {
      if (seq <= reloaded) return
      reloaded = seq
      round++
      refresh()
    },
  }))

  /** Re-reads the current plan after a generation or export (toolpaths changed, revision not). */
  const refresh = () => {
    const data = store.getState().data
    if (data === undefined || tag === undefined) return
    const base = tag.slice(0, tag.lastIndexOf(':'))
    store.getState().want(base, data.planId)
  }

  const value = <T>(r: CallReply): T | undefined => (r.ok ? (r.value as T) : undefined)

  async function load(planId: string): Promise<PlanData> {
    const [ops, warnings, stale] = await Promise.all([
      bridge.call('plan.operation.list', { planId }),
      bridge.call('plan.warning.list', { planId }),
      bridge.call('plan.stale.list', { planId }),
    ])
    const operations = value<{ operations: PlanOperationView[] }>(ops)?.operations
    const toolpaths: Record<string, ToolpathEntry> = {}
    if (operations !== undefined)
      await Promise.all(
        operations.map(async (op) => {
          const r = await bridge.call('plan.toolpath.get', { planId, planOperationId: op.id })
          const v = value<ToolpathEntry>(r)
          if (v !== undefined) toolpaths[op.id] = v
        }),
      )
    return {
      planId,
      operations,
      error: ops.ok ? undefined : ops.error,
      warnings: value<{ warnings: PlanWarning[] }>(warnings)?.warnings ?? [],
      stale: value<PlanStale>(stale),
      toolpaths,
      pendingApply:
        value<{ pendingApply?: boolean }>(warnings)?.pendingApply === true ||
        value<PlanStale>(stale)?.pendingApply === true,
    }
  }

  return store
}

const stores = new WeakMap<object, PlanStore>()

export function usePlanStore(): PlanStore {
  const { bridge } = useShell()
  let store = stores.get(bridge)
  if (store === undefined) {
    store = createPlanStore(bridge)
    stores.set(bridge, store)
  }
  return store
}

export function usePlanState<T>(selector: (s: PlanState) => T): T {
  return useStore(usePlanStore(), selector)
}

/** The plan queries of `planId` at the current revision (undefined while the first one loads). */
export function usePlanData(planId: string | undefined): PlanData | undefined {
  const store = usePlanStore()
  const { replica: events } = useShell()
  const replica = useReplica()
  const data = useStore(store, (s) => s.data)
  const key = replica.status === 'open' ? replica.key : ''
  const revision = replica.status === 'open' ? replica.revision : -1
  // `pendingApply` changes with the pending set, also by an Apply without a new revision
  const pending = usePending().version
  useEffect(() => {
    if (planId !== undefined)
      store.getState().want(`${key}:${planId}:${revision}:${pending}`, planId)
  }, [store, key, planId, revision, pending])
  // toolpaths regenerated by an apply job (or another window) change without a revision
  useEffect(
    () =>
      events.onEvent((e) => {
        if (e.type === 'job' && e.name === 'plan.toolpath.generate' && e.state === 'finished')
          store.getState().reload(e.seq)
      }),
    [events, store],
  )
  return data !== undefined && data.planId === planId ? data : undefined
}

/** Sends one command through the window's session (`useCall`: one gesture = one undo step). */
export const usePlanCommand = useCall
