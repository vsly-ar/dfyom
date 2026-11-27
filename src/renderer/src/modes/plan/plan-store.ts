// Plan-mode state of one window (task 3.7): the chosen plan and setup (F6), the plan queries of the current
// revision (operations with resolved feeds, checks, stale list, toolpaths) shared by navigator,
// inspector, status bar and viewport, toolpath generation (a job, followed with `job.get`) and
// the gCode export, and the deviation panel's comparison (U4, a job like generation). Every change
// is a command over the bridge. One store per bridge.
// Doc: docs/conventions/ui.md#plan-mode-task-37, docs/modes/plan-v0.1.md#commands-and-queries-v01,
// docs/modes/deviation.md#implementation-u4
import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { AlignmentSourceDTO } from '../../../../core/plan/alignment.dto'
import type { PlanWarning } from '../../../../core/plan/checks'
import type { LinkEdit } from '../../../../core/toolpath/links'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { CallReply, PreloadApi } from '../../../../shared/preload-api'
import { useCall } from '../../shell/hooks'
import { useLibraryVersion, usePending, useReplica, useShell } from '../../shell/ShellContext'
import type { PlanOperationView, PlanStale, ToolpathEntry } from './model'
import type { Box } from '../../viewport'
import { focusBox } from './deviation-region'

/** Progress poll of the toolpath job (`job.get`): progress ticks are not pushed (ui.md#jobs). */
export const GENERATE_POLL_MS = 250

/** A Z reference surface with its touch-off spot (DF69, `plan.warning.list` `zRefs`). */
export interface ZRefCandidateView {
  readonly surface: string
  readonly label: string
  /** Setup-frame Z, mm (≤ 0). */
  readonly level: number
  readonly at: readonly [number, number]
  readonly area: number
  readonly small: boolean
  readonly top: boolean
}

/** A tool run's Z reference (DF69): docs/modes/z-reference.md#implementation-notes-df69. */
export interface ZRefRunView {
  readonly setupId: string
  readonly planOperationId: string
  readonly toolNumber: number
  readonly zRef: (ZRefCandidateView & { readonly chosen: boolean; readonly rule: string }) | null
  readonly candidates: readonly ZRefCandidateView[]
  /** The reference's flat patch and spot area for the viewport (setup WCS, mm); null without one. */
  readonly outline?: ZRefOutlineView | null
}

/** A region piece as polygons (setup WCS, mm). */
export interface ZRefPolygonView {
  readonly outer: readonly (readonly [number, number])[]
  readonly holes: readonly (readonly (readonly [number, number])[])[]
}

/** DF69: docs/modes/z-reference.md#implementation-notes-df69 (viewport outline). */
export interface ZRefOutlineView {
  readonly patch: readonly ZRefPolygonView[]
  /** Where the spot may lie (the patch eroded by the clearance radius). */
  readonly spotArea: readonly ZRefPolygonView[]
  readonly clearance: number
  readonly grid: number
}

/** A setup's links (DF64, `plan.warning.list` `links`): docs/modes/safe-links.md#agent-api-and-settings. */
export interface SetupLinksView {
  readonly setupId: string
  /** Null until every toolpath of the setup is current. */
  readonly links: {
    readonly count: number
    readonly low: number
    readonly atClearance: number
    /** Null without a machine (no rates). */
    readonly seconds: number | null
    readonly savedSeconds: number | null
    /** DF64 L3: the lowered links as moves (`linkedToolpaths`) and what each saves (s). */
    readonly lowered?: readonly LoweredLinkView[]
  } | null
}

/** A lowered link of `plan.warning.list` (core `LoweredLinkDTO`): safe-links.md#where-it-runs. */
export interface LoweredLinkView extends LinkEdit {
  readonly index: number
  readonly savedSeconds: number
}

/** DF78: a setup's work zero and alignment points (`plan.warning.list` `alignment`). */
export interface SetupAlignmentView {
  readonly setupId: string
  /** The work zero in the setup frame (mm from the front-left corner of the up face). */
  readonly zero: readonly [number, number]
  readonly zeroPoint?: string
  readonly points: readonly {
    readonly id: string
    readonly name: string
    readonly kind: 'point' | 'hole' | 'edge'
    /** Expected X, Y in the WCS (mm); null = its source is missing. */
    readonly wcs: readonly [number, number] | null
    /** A witness mark on a side wall: it checks this axis only (Q108). */
    readonly oneAxis?: 'x' | 'y'
  }[]
  /** Flip axes of registration holes, in the setup frame (mm; Q106). */
  readonly flipAxes?: readonly {
    readonly from: readonly [number, number]
    readonly to: readonly [number, number]
    readonly otherSetupId: string
  }[]
}

/** DF78: a source a setup may add as a point (`plan.warning.list` `alignmentSources`). */
export interface AlignmentSourceView {
  readonly source: AlignmentSourceDTO
  readonly name: string
  readonly kind: 'point' | 'hole' | 'edge'
  /** X, Y in the setup frame (mm). */
  readonly at: readonly [number, number]
}

/** The plan queries of one revision. */
export interface PlanData {
  readonly planId: string
  /** `undefined` while loading or when the plan does not load (`error`). */
  readonly operations: readonly PlanOperationView[] | undefined
  readonly error?: AppErrorData | undefined
  readonly warnings: readonly PlanWarning[]
  /** DF69: the Z reference per tool run, by its first plan operation. */
  readonly zRefs: readonly ZRefRunView[]
  /** DF64: the links per setup. */
  readonly links: readonly SetupLinksView[]
  /** DF78: the setups with a work zero or alignment points. */
  readonly alignment: readonly SetupAlignmentView[]
  /** DF78: per setup, the sources its add menu offers. */
  readonly alignmentSources: readonly {
    readonly setupId: string
    readonly sources: readonly AlignmentSourceView[]
  }[]
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
  /** DF64: present when links run low (minimum retraction): the air-pass advice. */
  readonly linksNote?: string
}

/** A region of the plan's simulated cut (`design.reference.compare`, source plan; V3). */
export interface DeviationRegionView {
  /** The stock face looked from (`stock.top`). */
  readonly face: string
  readonly bounds: readonly [readonly [number, number], readonly [number, number]]
  readonly area: number
  readonly volume: number
  readonly maxDev: number
  readonly sign: 'overcut' | 'undercut'
  readonly depthRange: readonly [number, number]
  readonly cause?: 'toolRadius' | 'workholding' | 'holeMouth' | 'drillPoint' | 'tab'
  /** The plan operation that cut most of it. */
  readonly operationId?: string
}

/** |dev| statistics (mm, areas mm²): docs/modes/deviation.md#implementation-v3. */
export interface DeviationStatsView {
  readonly cells: number
  readonly mean: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly overcutMax: number
  readonly undercutMax: number
  readonly areaOver: number
}

/** The job's result for `source: plan` (V3). */
export interface DeviationResultView {
  readonly source: 'plan'
  readonly method: 'heightmap'
  readonly cell: number
  readonly threshold: number
  readonly stats: DeviationStatsView
  readonly faces: readonly (DeviationStatsView & { readonly face: string })[]
  readonly excluded: { readonly outsidePart: number; readonly edgeBand: number }
  readonly regions: readonly DeviationRegionView[]
  readonly more?: number
  readonly unexplained: number
  readonly planId: string
}

/**
 * The deviation panel's run of one plan (U4, docs/modes/deviation.md#implementation-u4): the job
 * under way, the last result and what it was computed from (`basis`), the chosen region.
 */
export interface DeviationRun {
  readonly planId: string
  /** A job is under way (its id once started). */
  readonly running?: { readonly jobId?: string; readonly progress?: JobProgress }
  readonly result?: DeviationResultView
  /** The plan inputs the result belongs to (revision, pending set, library): stale when changed. */
  readonly basis?: string
  readonly error?: AppErrorData
  /** The region row chosen last (its operation, if any, was selected). */
  readonly chosen?: number
  /**
   * The chosen region's marker in the Plan viewport and the framing request (U4 follow-up,
   * docs/modes/deviation.md#region-marker-u4-follow-up): a new request per choice.
   */
  readonly marked?: {
    readonly box: Box
    readonly sign: DeviationRegionView['sign']
    readonly focus: { readonly box: Box; readonly seq: number }
  }
}

export interface JobProgress {
  readonly done: number
  readonly total?: number | undefined
}

/** Regions the deviation panel asks for (the command's cap). */
export const DEVIATION_REGIONS = 20

export interface DeviationRequest {
  readonly planId: string
  readonly partId: string
  readonly referenceId?: string | undefined
  /** mm */
  readonly threshold: number
  readonly basis: string
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
  /**
   * A navigator row's error or warning count was clicked (DF67): the plan operation whose
   * inspector focuses its Checks block, once (`findingsShown` clears it).
   */
  readonly findingsRequest: string | undefined
  /**
   * A plan finding with a field was chosen (the plan's checks list, S5): the plan operation's
   * inspector reveals that field (its tab, accordion or More row) and focuses it, once.
   */
  readonly fieldRequest: { readonly planOperationId: string; readonly field: string } | undefined
  /**
   * DF69: the tool run (its first plan operation) whose tool-change row is hovered or focused, or
   * whose "Z from" is hovered: the viewport shows its Z reference instead of the selection's.
   */
  readonly zRefPreview: string | undefined
  /** DF78: the alignment point focused in the setup inspector (drawn larger in the viewport). */
  readonly alignmentPoint: string | undefined
  /**
   * DF135: the toolpaths of already-cut operations are drawn (hidden by default,
   * docs/modes/cut-state.md#what-a-cut-operation-means-in-its-plan).
   */
  readonly showCutToolpaths: boolean
  /**
   * DF78 S22: the setup whose alignment points are being picked in the viewport (its valid
   * sources are drawn as targets); undefined: not picking.
   */
  readonly pickingAlignment: string | undefined
  /**
   * The workholding item open in the setup inspector (workholding.md#ui-summary): the viewport
   * shows its keep-out zone.
   */
  readonly workholdingItem: { readonly setupId: string; readonly itemId: string } | undefined
  /** The deviation panel's last run (U4), of the plan it names. */
  readonly deviation: DeviationRun | undefined
  /** The export dialog shows this result, or the error. */
  readonly exported:
    | { readonly ok: true; readonly result: PlanExportResult; readonly setup?: string }
    | { readonly ok: false; readonly error: AppErrorData }
    | undefined
  choose(planId: string | undefined): void
  remember(selection: string): void
  /** Asks the plan operation's inspector to focus its findings (DF67). */
  revealFindings(planOperationId: string): void
  /** The inspector focused them. */
  findingsShown(): void
  /** Asks the plan operation's inspector to reveal and focus `field` (S5). */
  revealField(planOperationId: string, field: string): void
  /** The inspector focused it. */
  fieldShown(): void
  /** Shows run `planOperationId`'s Z reference in the viewport; undefined: the selection's. */
  previewZRef(planOperationId: string | undefined): void
  /** Marks an alignment point in the viewport; undefined: none. */
  focusAlignmentPoint(id: string | undefined): void
  /** DF135: "Show cut toolpaths". */
  setShowCutToolpaths(show: boolean): void
  /** Starts (a setup id) or ends (undefined) picking alignment points in the viewport. */
  pickAlignment(setupId: string | undefined): void
  /** Opens a workholding item in the setup inspector; undefined closes it. */
  selectWorkholding(item: { readonly setupId: string; readonly itemId: string } | undefined): void
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
   * Compares the plan's simulated cut with the part's reference (U4): a job, followed with
   * `job.get`; a running one is not started twice.
   */
  compareDeviation(request: DeviationRequest): Promise<void>
  /** Aborts the running comparison; the previous result comes back. */
  cancelDeviation(): void
  /** A region row was chosen. */
  chooseDeviationRegion(index: number, box?: Box): void
  /**
   * Re-reads the plan: toolpaths changed without a revision (an apply job finished, P3). `seq`:
   * the action-log event that says so; each event reloads once, however many hooks see it.
   */
  reload(seq: number): void
}

export type PlanStore = StoreApi<PlanState>

interface JobInfo {
  readonly state: string
  readonly progress?: JobProgress
  readonly outcome?: { ok: true; value: unknown } | { ok: false; error: AppErrorData }
}

export function createPlanStore(bridge: Pick<PreloadApi, 'call' | 'files'>): PlanStore {
  let tag: string | undefined
  /** Bumped when toolpaths may have changed without a revision (generation, export). */
  let round = 0
  /** The last event `reload` acted on. */
  let reloaded = -1
  /** Cancel was pressed before the comparison's job id came back. */
  let cancelDeviation = false
  const store = createStore<PlanState>()((set, get) => ({
    planId: undefined,
    lastSelection: undefined,
    data: undefined,
    generating: undefined,
    progress: undefined,
    generateError: undefined,
    failures: {},
    exporting: false,
    findingsRequest: undefined,
    fieldRequest: undefined,
    zRefPreview: undefined,
    alignmentPoint: undefined,
    showCutToolpaths: false,
    pickingAlignment: undefined,
    workholdingItem: undefined,
    exported: undefined,
    deviation: undefined,
    choose: (planId) =>
      set({
        planId,
        lastSelection: undefined,
        generateError: undefined,
        failures: {},
        pickingAlignment: undefined,
      }),
    remember: (lastSelection) => set({ lastSelection }),
    revealFindings: (findingsRequest) => set({ findingsRequest }),
    findingsShown: () => set({ findingsRequest: undefined }),
    revealField: (planOperationId, field) => set({ fieldRequest: { planOperationId, field } }),
    fieldShown: () => set({ fieldRequest: undefined }),
    setShowCutToolpaths: (showCutToolpaths) => set({ showCutToolpaths }),
    focusAlignmentPoint: (alignmentPoint) => {
      if (get().alignmentPoint !== alignmentPoint) set({ alignmentPoint })
    },
    pickAlignment: (pickingAlignment) => {
      if (get().pickingAlignment !== pickingAlignment) set({ pickingAlignment })
    },
    previewZRef: (zRefPreview) => {
      if (get().zRefPreview !== zRefPreview) set({ zRefPreview })
    },
    selectWorkholding: (workholdingItem) => {
      const was = get().workholdingItem
      if (was?.setupId !== workholdingItem?.setupId || was?.itemId !== workholdingItem?.itemId)
        set({ workholdingItem })
    },
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
    async compareDeviation({ planId, partId, referenceId, threshold, basis }) {
      const was = get().deviation
      if (was?.running !== undefined) return
      // the last result of this plan stays on screen while the new one runs, and after a cancel
      const kept: DeviationRun = {
        planId,
        ...(was?.planId === planId && was.result !== undefined
          ? {
              result: was.result,
              ...(was.basis === undefined ? {} : { basis: was.basis }),
              ...(was.chosen === undefined ? {} : { chosen: was.chosen }),
              ...(was.marked === undefined ? {} : { marked: was.marked }),
            }
          : {}),
      }
      cancelDeviation = false
      set({ deviation: { ...kept, running: {} } })
      const r = await bridge.call('design.reference.compare', {
        partId,
        ...(referenceId === undefined ? {} : { referenceId }),
        source: { kind: 'plan', planId },
        threshold,
        limit: DEVIATION_REGIONS,
      })
      // the current run without its job (a row chosen meanwhile is kept)
      const settled = (): DeviationRun => {
        const { running: _, error: __, ...rest } = get().deviation ?? kept
        return rest
      }
      if (!r.ok) {
        set({ deviation: { ...settled(), error: r.error } })
        return
      }
      const { jobId } = r.value as { jobId: string }
      set({ deviation: { ...settled(), running: { jobId } } })
      if (cancelDeviation) void bridge.call('job.abort', { jobId })
      for (;;) {
        const info = await bridge.call('job.get', { jobId })
        if (!info.ok) {
          set({ deviation: { ...settled(), error: info.error } })
          return
        }
        const job = info.value as JobInfo
        if (job.state === 'finished' && job.outcome !== undefined) {
          const o = job.outcome
          // the comparison generated the missing toolpaths into the cache: re-read them
          round++
          refresh()
          set({
            deviation: o.ok
              ? { planId, result: o.value as DeviationResultView, basis }
              : o.error.code === 'op.aborted'
                ? settled()
                : { ...settled(), error: o.error },
          })
          return
        }
        if (job.progress !== undefined)
          set({ deviation: { ...settled(), running: { jobId, progress: job.progress } } })
        await new Promise((resolve) => setTimeout(resolve, GENERATE_POLL_MS))
      }
    },
    cancelDeviation() {
      const running = get().deviation?.running
      if (running === undefined) return
      cancelDeviation = true
      if (running.jobId !== undefined) void bridge.call('job.abort', { jobId: running.jobId })
    },
    chooseDeviationRegion(chosen, box) {
      const d = get().deviation
      const region = d?.result?.regions[chosen]
      if (d === undefined || region === undefined) return
      // every choice is a new framing request, also of the row chosen already
      const { marked: was, ...rest } = d
      set({
        deviation: {
          ...rest,
          chosen,
          ...(box === undefined
            ? {}
            : {
                marked: {
                  box,
                  sign: region.sign,
                  focus: { box: focusBox(box), seq: (was?.focus.seq ?? 0) + 1 },
                },
              }),
        },
      })
    },
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
      zRefs: value<{ zRefs?: ZRefRunView[] }>(warnings)?.zRefs ?? [],
      links: value<{ links?: SetupLinksView[] }>(warnings)?.links ?? [],
      alignment: value<{ alignment?: SetupAlignmentView[] }>(warnings)?.alignment ?? [],
      alignmentSources:
        value<{ alignmentSources?: PlanData['alignmentSources'] }>(warnings)?.alignmentSources ??
        [],
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
  // library writes change stale notices and checks without a revision (Library window, task L1)
  const library = useLibraryVersion()
  useEffect(() => {
    if (planId !== undefined)
      store.getState().want(`${key}:${planId}:${revision}:${pending}:${library}`, planId)
  }, [store, key, planId, revision, pending, library])
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

/**
 * The plan inputs a deviation result depends on (U4): an edit, an Apply or a library write makes
 * it outdated (the panel's note; the viewport drops the region marker).
 */
export function useDeviationBasis(planId: string): string {
  const replica = useReplica()
  const pending = usePending().version
  const library = useLibraryVersion()
  const revision = replica.status === 'open' ? `${replica.key}:${replica.revision}` : ''
  return `${planId}:${revision}:${pending}:${library}`
}
