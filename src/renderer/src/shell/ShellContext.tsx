// The shell's per-window state behind one context: the bridge (`window.dfyom`, a fake in tests),
// the document replica, the settings mirror and the UI store. Doc: docs/conventions/ui.md#app-shell
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { PreloadApi } from '../../../shared/preload-api'
import { createReplica, type Replica, type ReplicaState } from '../state/replica'
import { createSettingsStore, type SettingsState, type SettingsStore } from '../state/settings'
import { createUiStore, type UiState, type UiStore } from '../state/ui-store'

export interface Shell {
  readonly bridge: PreloadApi
  readonly replica: Replica
  readonly settings: SettingsStore
  readonly ui: UiStore
}

export function createShell(bridge: PreloadApi): Shell {
  return {
    bridge,
    replica: createReplica(bridge),
    settings: createSettingsStore(bridge),
    ui: createUiStore(),
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
    return () => {
      stopReplica()
      stopSettings()
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
