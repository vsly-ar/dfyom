// The shell's per-window state behind one context: the bridge (`window.dfyom`, a fake in tests),
// the document replica, the settings mirror and the UI store. Doc: docs/conventions/ui.md#app-shell
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { useStore } from 'zustand'
import type { Region2dPort } from '../../../core/geometry/2d/port'
import type { PreloadApi } from '../../../shared/preload-api'
import type { AppResult } from '../../../shared/result'
import {
  createEvaluations,
  planSubject,
  type Evaluations,
  type PartEvaluationEntry,
} from '../state/evaluations'
import { createLibraryChanges, type LibraryChanges } from '../state/library-changes'
import { createPending, type PendingState, type PendingStore } from '../state/pending'
import { createReferenceMeshes, type ReferenceMeshes } from '../state/reference-meshes'
import { createReplica, type Replica, type ReplicaState } from '../state/replica'
import { createSettingsStore, type SettingsState, type SettingsStore } from '../state/settings'
import { createUiStore, type UiState, type UiStore } from '../state/ui-store'
import {
  inspectorMemory,
  InspectorMemoryProvider,
  type InspectorMemory,
} from '../ui/InspectorGroup/memory'
import { StepMemoryProvider, type StepMemory } from '../ui/QuantityInput/StepContext'
import { createProjectFiles, type ProjectFiles } from './project/files'

export interface Shell {
  readonly bridge: PreloadApi
  readonly replica: Replica
  readonly settings: SettingsStore
  readonly ui: UiStore
  /** Part evaluations of the bound project (mesh and status, task 3.6). */
  readonly evaluations: Evaluations
  /** New / Open / Save and their dialogs (task 3.6). */
  readonly files: ProjectFiles
  /** Pending changes and Apply (task P3, docs/architecture/apply.md#ui). */
  readonly pending: PendingStore
  /** The reference ghosts' triangles, per asset (task R3). */
  readonly referenceMeshes: ReferenceMeshes
  /** Library writes by anyone (task L1): views of library data re-read on each. */
  readonly libraryChanges: LibraryChanges
  /**
   * The renderer's 2D port (live shape outlines, task U1), loading asynchronously at window start
   * (docs/architecture/shapes.md#where-the-2d-layer-runs); absent in hosts without one.
   */
  readonly region2d: Promise<AppResult<Region2dPort>> | undefined
}

export interface ShellOptions {
  /** The window's 2D port (`rendererRegion2d` in the app; the Node host in tests). */
  readonly region2d?: Promise<AppResult<Region2dPort>>
}

export function createShell(bridge: PreloadApi, opts: ShellOptions = {}): Shell {
  const replica = createReplica(bridge)
  return {
    region2d: opts.region2d,
    bridge,
    replica,
    settings: createSettingsStore(bridge),
    ui: createUiStore(),
    evaluations: createEvaluations(bridge, replica),
    files: createProjectFiles({ bridge, replica }),
    pending: createPending(bridge, replica),
    referenceMeshes: createReferenceMeshes(bridge),
    libraryChanges: createLibraryChanges(bridge),
  }
}

const ShellContext = createContext<Shell | null>(null)

/** Provides the shell and follows main (replica, settings) while mounted. */
export function ShellProvider({
  shell,
  children,
}: {
  shell: Shell
  children: ReactNode
}): React.JSX.Element {
  useEffect(() => {
    const stopReplica = shell.replica.start()
    const stopSettings = shell.settings.start()
    const stopEvaluations = shell.evaluations.start()
    const stopPending = shell.pending.start()
    // a library edit is pending in projects whose draft plans copy it, without a project event
    const stopLibrary = shell.libraryChanges.start(() => shell.pending.refresh())
    // a newly bound (or reopened) project shows every reference (decision D17)
    const stopBound = shell.bridge.project.onBound(() => shell.ui.getState().resetReferenceView())
    return () => {
      stopLibrary()
      stopPending()
      stopReplica()
      stopSettings()
      stopEvaluations()
      stopBound()
    }
  }, [shell])
  // a step chosen in a field's adjust panel is remembered in the ui store for the session
  // (docs/conventions/inspector-layout.md#field-step-model-df104 rule 4)
  const [stepMemory] = useState<StepMemory>(() => ({
    get: (key) => shell.ui.getState().steps[key],
    set: (key, step) => shell.ui.getState().rememberStep(key, step),
  }))
  // accordions, More rows and tabs remember their state in the app settings, across launches
  // (docs/conventions/inspector-layout.md#accordions)
  const [inspector] = useState<InspectorMemory>(() =>
    inspectorMemory({
      groups: () => shell.settings.getState().settings.inspectorGroups,
      tabs: () => shell.settings.getState().settings.inspectorTabs,
      setGroup: (key, open) =>
        shell.settings.getState().update({ inspectorGroups: { [key]: open } }),
      setTab: (key, value) => shell.settings.getState().update({ inspectorTabs: { [key]: value } }),
      subscribe: (onChange) => shell.settings.subscribe(onChange),
    }),
  )
  return (
    <ShellContext.Provider value={shell}>
      <StepMemoryProvider memory={stepMemory}>
        <InspectorMemoryProvider memory={inspector}>{children}</InspectorMemoryProvider>
      </StepMemoryProvider>
    </ShellContext.Provider>
  )
}

export function useShell(): Shell {
  const shell = useContext(ShellContext)
  if (shell === null) throw new Error('useShell outside ShellProvider')
  return shell
}

export function useReplica(): ReplicaState {
  const { replica } = useShell()
  return useSyncExternalStore(replica.subscribe, replica.getState)
}

export function useSettings<T>(selector: (s: SettingsState) => T): T {
  return useStore(useShell().settings, selector)
}

export function useUi<T>(selector: (s: UiState) => T): T {
  return useStore(useShell().ui, selector)
}

/** Grows with every library write (task L1): a dependency of views that show library data. */
export function useLibraryVersion(): number {
  const { libraryChanges } = useShell()
  return useSyncExternalStore(libraryChanges.subscribe, libraryChanges.getState)
}

/** The window's pending changes and Apply state (task P3). */
export function usePending(): PendingState {
  const { pending } = useShell()
  return useSyncExternalStore(pending.subscribe, pending.getState)
}

/**
 * The renderer's 2D port once it has loaded; undefined while loading, after a failed load (logged
 * by the loader) and in hosts without one: the Shape Editor then draws the outlines
 * `design.shape.get` resolved.
 */
export function useRegion2d(): Region2dPort | undefined {
  const { region2d } = useShell()
  const [port, setPort] = useState<Region2dPort | undefined>(undefined)
  useEffect(() => {
    let live = true
    void region2d?.then((r) => {
      if (live && r.isOk()) setPort(r.unwrap())
    })
    return () => {
      live = false
    }
  }, [region2d])
  return port
}

/** A part's evaluation (status and last good mesh), or undefined before the window knows it. */
export function usePartEvaluation(partId: string | undefined): PartEvaluationEntry | undefined {
  const { evaluations } = useShell()
  const all = useSyncExternalStore(evaluations.subscribe, evaluations.getState)
  return partId === undefined ? undefined : all.get(partId)
}

/** The evaluation of a plan's part (snapshot scene, task E3b), or undefined before it is known. */
export function usePlanEvaluation(planId: string | undefined): PartEvaluationEntry | undefined {
  const { evaluations } = useShell()
  const all = useSyncExternalStore(evaluations.subscribe, evaluations.getState)
  return planId === undefined ? undefined : all.get(planSubject(planId))
}
