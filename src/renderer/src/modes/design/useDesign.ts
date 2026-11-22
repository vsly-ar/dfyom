// Design mode hooks over the shell: the part from the replica, its warnings (`design.warning.list`,
// re-read after each revision and evaluation change, shared by navigator, inspector, status bar
// and viewport), its evaluation (mesh push), the selection and its reference models (task R3). Doc: docs/modes/design.md#dfm-checks,
// docs/conventions/ui.md#evaluation-status-pending-outdated-failed
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { EvaluationStatus } from '../../../../core/design/evaluation'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { PreloadApi } from '../../../../shared/preload-api'
import { useCall } from '../../shell/hooks'
import { useReplica, useShell, usePartEvaluation, useUi } from '../../shell/ShellContext'
import type { ReferenceDTO } from '../../../../core/design/reference.dto'
import type { PartEvaluationEntry } from '../../state/evaluations'
import type { ReferenceMeshEntry } from '../../state/reference-meshes'
import { designPart, type DesignPart } from './model'
import { partReferences } from './reference-view'

/** The design part of the window's project, or undefined (no project or no part yet). */
export function useDesignPart(): DesignPart | undefined {
  const replica = useReplica()
  const doc = replica.status === 'open' ? replica.doc : undefined
  return useMemo(() => (doc === undefined ? undefined : designPart(doc)), [doc])
}

export interface DesignWarnings {
  readonly warnings: readonly DfmWarning[]
  /** Whether the geometry warnings are in (`done`); pending and failed have parameter ones only. */
  readonly evaluation: EvaluationStatus
  readonly error?: AppErrorData
}

const NO_WARNINGS: DesignWarnings = { warnings: [], evaluation: 'pending' }

/** One shared `design.warning.list` result per bridge (window), re-read when its tag changes. */
interface WarningsStore {
  get(): DesignWarnings
  subscribe(l: () => void): () => void
  want(tag: string, partId: string): void
}

const stores = new WeakMap<object, WarningsStore>()

function warningsStore(bridge: Pick<PreloadApi, 'call'>): WarningsStore {
  const hit = stores.get(bridge)
  if (hit !== undefined) return hit
  let value: DesignWarnings = NO_WARNINGS
  let current: string | undefined
  const listeners = new Set<() => void>()
  const store: WarningsStore = {
    get: () => value,
    subscribe(l) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    want(tag, partId) {
      if (tag === current) return
      current = tag
      void bridge.call('design.warning.list', { partId }).then((r) => {
        if (current !== tag || !r.ok) return
        value = r.value as DesignWarnings
        for (const l of [...listeners]) l()
      })
    },
  }
  stores.set(bridge, store)
  return store
}

/** The part's DFM warnings for the current revision and evaluation. */
export function useDesignWarnings(part: DesignPart | undefined): DesignWarnings {
  const { bridge } = useShell()
  const replica = useReplica()
  const evaluation = usePartEvaluation(part?.dto.id)
  const store = warningsStore(bridge)
  const value = useSyncExternalStore(store.subscribe, store.get)
  const key = replica.status === 'open' ? replica.key : ''
  const revision = replica.status === 'open' ? replica.revision : -1
  const tag =
    part === undefined
      ? undefined
      : `${key}:${part.dto.id}:${revision}:${evaluation?.status ?? '-'}:${evaluation?.inputHash ?? ''}`
  useEffect(() => {
    if (tag !== undefined && part !== undefined) store.want(tag, part.dto.id)
  }, [store, tag, part])
  return part === undefined ? NO_WARNINGS : value
}

/** The part's evaluation (status, last good mesh). */
export function useDesignEvaluation(part: DesignPart | undefined): PartEvaluationEntry | undefined {
  return usePartEvaluation(part?.dto.id)
}

/** Sends one command through the window's session (`useCall`: one gesture = one undo step). */
export const useCommand = useCall

/** The design selection (an operation id or null) and its setter. */
export function useDesignSelection(): [string | null, (id: string | null) => void] {
  const selected = useUi((s) => s.selection.design)
  const select = useUi((s) => s.select)
  return [selected, useCallback((id: string | null) => select('design', id), [select])]
}

/** One reference of the part as design mode shows it (task R3). */
export interface DesignReference {
  readonly ref: ReferenceDTO
  /** Per-window visibility (decision D17). */
  readonly visible: boolean
  /** The ghost's triangles: requested while visible, kept per asset. */
  readonly mesh: ReferenceMeshEntry | undefined
}

/**
 * The part's references with their visibility and ghost meshes. Visible references' meshes are
 * requested once per asset; assets no reference uses any more are dropped.
 */
export function useDesignReferences(part: DesignPart | undefined): readonly DesignReference[] {
  const { referenceMeshes: meshes } = useShell()
  const hidden = useUi((s) => s.hiddenReferences)
  const version = useSyncExternalStore(meshes.subscribe, meshes.version)
  const refs = useMemo(
    () => (part === undefined ? [] : partReferences(part.doc, part.dto.id)),
    [part],
  )
  useEffect(() => {
    meshes.retain(new Set(refs.map((r) => r.asset.sha256)))
    for (const r of refs) if (!hidden.has(r.id)) meshes.request(r.asset.sha256, r.id)
  }, [meshes, refs, hidden])
  return useMemo(
    () =>
      refs.map((ref) => ({
        ref,
        visible: !hidden.has(ref.id),
        mesh: meshes.get(ref.asset.sha256),
      })),
    [refs, hidden, meshes, version], // `version` changes with every mesh entry
  )
}
