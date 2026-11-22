// Per-window UI state (Zustand, ui.md decision 6): mode, shell overlays, the selection of each
// mode and pick mode (task 3.6), and reference visibility (task R3, decision D17). Never in the
// document or the undo history.
// Doc: docs/conventions/ui.md#where-things-live, #mode-switching, #selection-and-picking,
// docs/modes/reference-model.md#display
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { ReferenceWarning } from '../../../core/design/reference'
import type { AppMode } from '../../../core/modes'

/** Pick mode: a field asks the viewport for a surface (ui.md#selection-and-picking). */
export interface PickRequestState {
  /** Which field asked (unique per field; labels repeat across operations). */
  readonly owner: string
  /** The field's label, for the banner ("Pick a surface for On"). */
  readonly field: string
  /** Surface ids that may be picked. */
  readonly eligible: ReadonlySet<string>
  /** Called with the picked surface id; pick mode then ends. */
  readonly onPick: (surface: string) => void
}

export interface UiState {
  readonly mode: AppMode
  setMode(mode: AppMode): void
  /** The settings dialog (opened from the toolbar or the agent indicator). */
  readonly settingsOpen: boolean
  setSettingsOpen(open: boolean): void
  /** The keyboard shortcut list (`?`, Help menu). */
  readonly shortcutsOpen: boolean
  setShortcutsOpen(open: boolean): void
  /** Each mode keeps its own selection (an operation or, in design, a reference id; or null). */
  readonly selection: Readonly<Record<AppMode, string | null>>
  select(mode: AppMode, id: string | null): void
  /** Active pick mode, or null. */
  readonly pick: PickRequestState | null
  setPick(pick: PickRequestState | null): void
  /**
   * References hidden in this window (decision D17: per-window view state, no command, no undo
   * step, never saved); a new window or a newly bound project shows every reference.
   */
  readonly hiddenReferences: ReadonlySet<string>
  setReferenceVisible(id: string, visible: boolean): void
  /** The import's own warnings (unit guess, open mesh, many triangles) per reference, this window. */
  readonly referenceNotes: Readonly<Record<string, readonly ReferenceWarning[]>>
  setReferenceNotes(id: string, notes: readonly ReferenceWarning[]): void
  /** The window's project changed: every reference shows again, notes are dropped. */
  resetReferenceView(): void
}

export type UiStore = StoreApi<UiState>

export function createUiStore(initial: Partial<Pick<UiState, 'mode'>> = {}): UiStore {
  return createStore<UiState>()((set) => ({
    mode: initial.mode ?? 'design',
    setMode: (mode) => set({ mode }),
    settingsOpen: false,
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    shortcutsOpen: false,
    setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
    selection: { design: null, plan: null, run: null },
    select: (mode, id) => set((s) => ({ selection: { ...s.selection, [mode]: id } })),
    pick: null,
    setPick: (pick) => set({ pick }),
    hiddenReferences: new Set(),
    setReferenceVisible: (id, visible) =>
      set((s) => {
        if (s.hiddenReferences.has(id) === !visible) return {}
        const next = new Set(s.hiddenReferences)
        if (visible) next.delete(id)
        else next.add(id)
        return { hiddenReferences: next }
      }),
    referenceNotes: {},
    setReferenceNotes: (id, notes) =>
      set((s) => ({ referenceNotes: { ...s.referenceNotes, [id]: notes } })),
    resetReferenceView: () => set({ hiddenReferences: new Set(), referenceNotes: {} }),
  }))
}
