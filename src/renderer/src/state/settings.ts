// The window's mirror of the app settings (owned by main): applies them to the document root
// (`data-theme`, `data-motion`) and sends changes to main, which pushes them to every window.
// Doc: docs/conventions/ui.md#settings · contract: src/shared/settings.ts
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { PreloadApi } from '../../../shared/preload-api'
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type AppSettings,
  type AppSettingsPatch,
} from '../../../shared/settings'

export interface SettingsState {
  readonly settings: AppSettings
  /** Applies the patch at once (optimistic) and sends it to main. */
  update(patch: AppSettingsPatch): void
}

export type SettingsStore = StoreApi<SettingsState> & {
  /** Follows main's pushes; returns the stop function. */
  start(): () => void
}

export function createSettingsStore(bridge: Pick<PreloadApi, 'settings'>): SettingsStore {
  const store = createStore<SettingsState>()((set, get) => ({
    settings: bridge.settings.initial ?? DEFAULT_SETTINGS,
    update(patch) {
      const s = get().settings
      set({ settings: mergeSettings(s, patch) })
      void bridge.settings.update(patch).then((reply) => {
        // main refused it (invalid): go back to main's settings
        if (!reply.ok) set({ settings: s })
      })
    },
  }))
  return Object.assign(store, {
    start: () => bridge.settings.onChange((settings) => store.setState({ settings })),
  })
}

/**
 * Theme and motion on the document root: `data-theme` only when not following the OS (tokens.css
 * then uses `prefers-color-scheme`), `data-motion='reduce'` when the app setting asks for it.
 */
export function applySettings(s: AppSettings, root: HTMLElement = document.documentElement): void {
  if (s.theme === 'system') delete root.dataset['theme']
  else root.dataset['theme'] = s.theme
  if (s.reduceMotion) root.dataset['motion'] = 'reduce'
  else delete root.dataset['motion']
}
