// Per-window UI state (Zustand, ui.md decision 6): mode, shell overlays, the selection of each
// mode and pick mode (task 3.6), and reference visibility (task R3, decision D17). Never in the
// document or the undo history.
// Doc: docs/conventions/ui.md#where-things-live, #mode-switching, #selection-and-picking,
// docs/modes/reference-model.md#display
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { ReferenceWarning } from '../../../core/design/reference'
import type { ShapeItem } from '../../../core/design/shape.dto'
import type { SvgImportReport } from '../../../core/import/svg'
import type { Issue } from '../../../shared/errors/app-error'
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

/** The Shape Editor's per-window state (task U1): the selected item of the selected shape. */
export interface ShapeEditorState {
  readonly shapeId: string
  /** The selected item's index (its fields, handles and dashed outline). */
  readonly item: number
  /** The selected segment row of a path item (its handles highlight), or null. */
  readonly segment: number | null
}

/**
 * A handle drag in progress (ui.md § Shapes: the outline follows the pointer every frame from the
 * renderer's 2D port; commands go out at most every 100 ms).
 */
export interface ShapePreview {
  readonly shapeId: string
  readonly index: number
  /** The dragged item's numbers (mm, degrees). */
  readonly item: ShapeItem<number>
}

/** Why the shown shape is invalid: a refused commit or an invalid drag state (red segment). */
export interface ShapeIssues {
  readonly shapeId: string
  readonly issues: readonly Issue[]
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
  /** Shape Editor (task U1): selected item and segment, null outside the editor. */
  readonly shapeEditor: ShapeEditorState | null
  selectShapeItem(shapeId: string, item: number, segment?: number | null): void
  /** "Show items": every item's outline drawn thinly (per window, no command). */
  readonly showShapeItems: boolean
  setShowShapeItems(show: boolean): void
  readonly shapePreview: ShapePreview | null
  setShapePreview(preview: ShapePreview | null): void
  readonly shapeIssues: ShapeIssues | null
  setShapeIssues(issues: ShapeIssues | null): void
  /**
   * The design navigator's undo toast ("Removed Pocket 2", "Removed segment 2"): one toast region
   * for the mode, which the inspector's removals (segment table, task U1) also use.
   */
  readonly removedToast: string | null
  setRemovedToast(message: string | null): void
  /**
   * The operation whose rotation field has focus (task U2): the viewport draws its placed,
   * rotated bounding box thin and dashed; null otherwise.
   */
  readonly rotationGuide: string | null
  setRotationGuide(operationId: string | null): void
  /** The last SVG import's report (task U2), reopened from the shape inspector; not persisted. */
  readonly lastImport: LastImport | null
  setLastImport(last: LastImport | null): void
  /** The "Snap" toggle of the Shape Editor and the viewport (task U3; per window, on at start). */
  readonly snapOn: boolean
  setSnapOn(on: boolean): void
  /**
   * Depth (mm) of the reference section below the edited shape's face (task U3; per window); null:
   * the middle of the reference's height there.
   */
  readonly sectionDepth: number | null
  setSectionDepth(mm: number | null): void
  /**
   * Feature rows expanded in the navigator (v0.4 task U1): per window and per feature while the
   * window is open, collapsed by default; no command, never saved.
   */
  readonly expandedFeatures: ReadonlySet<string>
  setFeatureExpanded(featureId: string, expanded: boolean): void
  /**
   * A feature field to focus once its inspector shows (task U1: "Edited through Hole 1" and
   * "Fix in Hole 1" select the feature, then its inspector focuses `field` and clears this).
   */
  readonly featureFocus: FeatureFocus | null
  setFeatureFocus(focus: FeatureFocus | null): void
}

/** Which feature field the feature inspector should focus (a dotted field path, `cbDiameter`). */
export interface FeatureFocus {
  readonly featureId: string
  readonly field: string
}

/** The last import's report and the shapes it created (ui.md#import-report: "Later access"). */
export interface LastImport {
  readonly shapeIds: readonly string[]
  readonly report: SvgImportReport
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
    shapeEditor: null,
    selectShapeItem: (shapeId, item, segment = null) =>
      set({ shapeEditor: { shapeId, item, segment } }),
    showShapeItems: false,
    setShowShapeItems: (showShapeItems) => set({ showShapeItems }),
    shapePreview: null,
    setShapePreview: (shapePreview) => set({ shapePreview }),
    shapeIssues: null,
    setShapeIssues: (shapeIssues) => set({ shapeIssues }),
    removedToast: null,
    setRemovedToast: (removedToast) => set({ removedToast }),
    rotationGuide: null,
    setRotationGuide: (rotationGuide) => set({ rotationGuide }),
    lastImport: null,
    setLastImport: (lastImport) => set({ lastImport }),
    snapOn: true,
    setSnapOn: (snapOn) => set({ snapOn }),
    sectionDepth: null,
    setSectionDepth: (sectionDepth) => set({ sectionDepth }),
    expandedFeatures: new Set(),
    setFeatureExpanded: (id, expanded) =>
      set((s) => {
        if (s.expandedFeatures.has(id) === expanded) return {}
        const next = new Set(s.expandedFeatures)
        if (expanded) next.add(id)
        else next.delete(id)
        return { expandedFeatures: next }
      }),
    featureFocus: null,
    setFeatureFocus: (featureFocus) => set({ featureFocus }),
  }))
}
