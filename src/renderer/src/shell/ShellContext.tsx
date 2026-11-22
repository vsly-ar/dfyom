// The shell's per-window state behind one context: the bridge (`window.dfyom`, a fake in tests),
// the document replica, the settings mirror and the UI store. Doc: docs/conventions/ui.md#app-shell
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { PreloadApi } from '../../../shared/preload-api'
import {
  createEvaluations,
  planSubject,
  type Evaluations,
  type PartEvaluationEntry,
} from '../state/evaluations'
import { createReferenceMeshes, type ReferenceMeshes } from '../state/reference-meshes'
import { createReplica, type Replica, type ReplicaState } from '../state/replica'
import { createSettingsStore, type SettingsState, type SettingsStore } from '../state/settings'
import { createUiStore, type UiState, type UiStore } from '../state/ui-store'
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
  /** The reference ghosts' triangles, per asset (task R3). */
  readonly referenceMeshes: ReferenceMeshes
}

export function createShell(bridge: PreloadApi): Shell {
  const replica = createReplica(bridge)
  return {
    bridge,
    replica,
    settings: createSettingsStore(bridge),
    ui: createUiStore(),
    evaluations: createEvaluations(bridge, replica),
    files: createProjectFiles({ bridge, replica }),
    referenceMeshes: createReferenceMeshes(bridge),
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
    // a newly bound (or reopened) project shows every reference (decision D17)
    const stopBound = shell.bridge.project.onBound(() => shell.ui.getState().resetReferenceView())
    return () => {
      stopReplica()
      stopSettings()
      stopEvaluations()
      stopBound()
    }
  }, [shell])
  return <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>
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
