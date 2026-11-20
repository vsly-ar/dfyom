// Per-window UI state (Zustand, ui.md decision 6): mode and shell overlays. Selection, camera and
// pick mode join it with the mode UIs (3.5–3.7). Never in the document or the undo history.
// Doc: docs/conventions/ui.md#where-things-live, #mode-switching
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { AppMode } from '../../../core/modes'

export interface UiState {
  readonly mode: AppMode
  setMode(mode: AppMode): void
  /** The settings dialog (opened from the toolbar or the agent indicator). */
  readonly settingsOpen: boolean
  setSettingsOpen(open: boolean): void
}

export type UiStore = StoreApi<UiState>

export function createUiStore(initial: Partial<Pick<UiState, 'mode'>> = {}): UiStore {
  return createStore<UiState>()((set) => ({
    mode: initial.mode ?? 'design',
    setMode: (mode) => set({ mode }),
    settingsOpen: false,
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  }))
}
