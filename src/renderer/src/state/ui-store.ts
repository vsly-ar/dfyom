// Per-window UI state (Zustand, ui.md decision 6): mode, shell overlays, the selection of each
// mode and pick mode (task 3.6), and reference visibility (task R3, decision D17). Never in the
// document or the undo history.
// Doc: docs/conventions/ui.md#where-things-live, #mode-switching, #selection-and-picking,
// docs/modes/reference-model.md#display
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Placement, ReferenceWarning } from '../../../core/design/reference'
import type { ShapeItem } from '../../../core/design/shape.dto'
import type { SvgImportReport } from '../../../core/import/svg'
import type { Issue } from '../../../shared/errors/app-error'
import type { AppMode } from '../../../core/modes'
import type { CloneRowKind } from '../../../core/design/clones/clones'
import type { ClonePathData } from '../viewport/clone-path'
import type { ReferenceOverlayState } from '../modes/design/reference-overlay'
import {
  IDLE_COMPARE,
  type CompareSettings,
  type CompareState,
} from '../modes/design/reference-compare-state'
import type { Box } from '../viewport/mesh'

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
  /** Help → Connect an agent… (ui.md#connect-an-agent-hardening-a4). */
  readonly connectAgentOpen: boolean
  setConnectAgentOpen(open: boolean): void
  /** The open part-setup dialog of design mode (ui.md § Design sidebar and setup dialogs), or null. */
  readonly designDialog: DesignDialog | null
  setDesignDialog(dialog: DesignDialog | null): void
  /**
   * The part Design shows (split parts S0: window state, not document state); null or a removed
   * part: the first part. Switching clears the design selection and closes the Reference panel
   * and the Shape Editor. Doc: docs/modes/split-parts.md#prerequisite-several-parts-per-project
   */
  readonly designPart: string | null
  setDesignPart(partId: string | null): void
  /** The project key the Stock dialog opened by itself for (once per project and window). */
  readonly stockOfferedFor: string | null
  markStockOffered(key: string): void
  /**
   * Each mode keeps its own selection (an operation or, in design, a reference id; or null). A
   * design selection of another id closes the Reference panel (ui.md § Reference panel).
   */
  readonly selection: Readonly<Record<AppMode, string | null>>
  select(mode: AppMode, id: string | null): void
  /**
   * The Reference panel in the right sidebar (dogfood DF3, ui.md § Reference panel): open while
   * true; its reference is the design selection.
   */
  readonly referencePanel: boolean
  /** Opens the panel with this reference selected (null: none yet) and shows the inspector. */
  openReferencePanel(referenceId: string | null): void
  /** Closes the panel; a selected reference is deselected (the inspector shows the part). */
  closeReferencePanel(): void
  /** "See through stock" (DF2): per window, on at start. */
  readonly seeThroughStock: boolean
  setSeeThroughStock(on: boolean): void
  /** Fit mode's live preview (DF5): the ghost's placement while fitting, view state only. */
  readonly referencePreview: ReferencePreview | null
  setReferencePreview(preview: ReferencePreview | null): void
  /** Bumped to ask the shell to show a collapsed inspector (the Reference panel opened). */
  readonly inspectorRequest: number
  /** Asks the shell to show a collapsed inspector (the part menu's Split part…). */
  showInspector(): void
  /**
   * The split line or level the Split section's field has focus on, or the viewport holds or
   * hovers (split parts 4a polish): drawn in the accent in the exploded preview. View state only.
   */
  readonly splitFocus: SplitFocus | null
  setSplitFocus(focus: SplitFocus | null): void
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
  /** The window's project changed: every reference shows again, notes are dropped, Design shows the first part. */
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
  /** The viewport's measure tool is on (the main toolbar's Measure and `D`, DF19; per window). */
  readonly measuring: boolean
  setMeasuring(on: boolean): void
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
   * The Reference panel's fitted section and hovered level, drawn on the ghost (DF60; per window,
   * set while the panel's Levels and Section rows show, null otherwise).
   */
  readonly referenceOverlay: ReferenceOverlayState | null
  setReferenceOverlay(overlay: ReferenceOverlayState | null): void
  /**
   * The compare overlay (DF60 P5; per window): on for this reference and threshold while set,
   * off when null. It outlives the Reference panel (choosing a region selects its operation, and
   * its edits re-colour the part); the Compare switch and the viewport legend's Hide turn it off.
   */
  readonly referenceCompare: CompareSettings | null
  setReferenceCompare(settings: CompareSettings | null): void
  /** The compare overlay's last result and its per-vertex view (`useReferenceCompare`). */
  readonly compareResult: CompareState
  setCompareResult(state: CompareState): void
  /** The region chosen in the compare list (its index in the result; a new result clears it). */
  readonly compareRegion: number | null
  setCompareRegion(index: number | null): void
  /** A box to frame the camera on (part frame); `seq` changes for each request (DF60 P5). */
  readonly viewportFocus: { readonly box: Box; readonly seq: number } | null
  focusViewport(box: Box): void
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
  /**
   * The open "Make Clones…" draft (v0.4 task U3): shown in the inspector, its ghosts in the
   * viewport; no command and no undo step until "Make clones". Null when none is open.
   */
  readonly clonesDraft: ClonesDraftState | null
  setClonesDraft(draft: ClonesDraftState | null): void
  /** The selected (expanded) row of the Clones editor shown: its path segment is amber (U3). */
  readonly clonesRow: ClonesRowFocus | null
  setClonesRow(focus: ClonesRowFocus | null): void
  /** A polite announcement of the design viewport ("Clone 4 skipped."; U3), or null. */
  readonly announcement: string | null
  announce(message: string | null): void
}

/** A path row as the Clones editors hold it: `design.clones.*` args (quantities as entered). */
export type ClonesRowArg = {
  readonly kind: CloneRowKind
  readonly skip?: readonly number[]
} & Readonly<Record<string, unknown>>

/** The "Make Clones…" draft (ui.md § Clones). */
export interface ClonesDraftState {
  readonly partId: string
  /** What was selected when it opened (a selection change closes the draft). */
  readonly openedFor: string
  /** The Source list: the selected item first (fixed), then what sits on its surfaces. */
  readonly options: readonly {
    readonly id: string
    readonly label: string
    readonly fixed: boolean
    readonly host?: string
  }[]
  /** A feature source (one feature, no options). */
  readonly feature: boolean
  /** Source options the user unchecked. */
  readonly unchecked: ReadonlySet<string>
  readonly rows: readonly ClonesRowArg[]
  /** The last preview's path (the viewport's ghosts), or null before the first or after a refusal. */
  readonly preview: ClonePathData | null
}

/** Which Clones editor's row is selected: a feature id, or `draft`. */
export interface ClonesRowFocus {
  readonly owner: string
  readonly row: number
}

/** A split line (index into `split.lines`) or level (into `split.levels`). */
export interface SplitFocus {
  readonly kind: 'line' | 'level'
  readonly index: number
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

/** Design mode's part-setup dialogs (D45): set once per project, opened from the toolbar. */
/** `newPart`: the Stock dialog creating another part (split parts S0). */
export type DesignDialog = 'stock' | 'shapes' | 'newPart'

/** A reference's placement while Fit mode previews it (mm, degrees; DF5). */
export interface ReferencePreview {
  readonly referenceId: string
  readonly placement: Placement
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
    connectAgentOpen: false,
    setConnectAgentOpen: (connectAgentOpen) => set({ connectAgentOpen }),
    designDialog: null,
    setDesignDialog: (designDialog) => set({ designDialog }),
    designPart: null,
    setDesignPart: (designPart) =>
      set((s) =>
        s.designPart === designPart
          ? {}
          : {
              designPart,
              selection: { ...s.selection, design: null },
              referencePanel: false,
              referencePreview: null,
              shapeEditor: null,
            },
      ),
    stockOfferedFor: null,
    markStockOffered: (stockOfferedFor) => set({ stockOfferedFor }),
    selection: { design: null, plan: null, run: null },
    select: (mode, id) =>
      set((s) => ({
        selection: { ...s.selection, [mode]: id },
        ...(mode === 'design' && s.referencePanel && id !== s.selection.design
          ? { referencePanel: false, referencePreview: null }
          : {}),
      })),
    referencePanel: false,
    openReferencePanel: (id) =>
      set((s) => ({
        referencePanel: true,
        selection: { ...s.selection, design: id },
        inspectorRequest: s.referencePanel ? s.inspectorRequest : s.inspectorRequest + 1,
      })),
    closeReferencePanel: () =>
      set((s) => ({
        referencePanel: false,
        referencePreview: null,
        selection: {
          ...s.selection,
          design: s.referencePanel ? null : s.selection.design,
        },
      })),
    seeThroughStock: true,
    setSeeThroughStock: (seeThroughStock) => set({ seeThroughStock }),
    referencePreview: null,
    setReferencePreview: (referencePreview) => set({ referencePreview }),
    inspectorRequest: 0,
    showInspector: () => set((s) => ({ inspectorRequest: s.inspectorRequest + 1 })),
    splitFocus: null,
    setSplitFocus: (splitFocus) =>
      set((s) =>
        s.splitFocus?.kind === splitFocus?.kind && s.splitFocus?.index === splitFocus?.index
          ? {}
          : { splitFocus },
      ),
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
    resetReferenceView: () =>
      set({ hiddenReferences: new Set(), referenceNotes: {}, designPart: null }),
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
    measuring: false,
    setMeasuring: (measuring) => set({ measuring }),
    snapOn: true,
    setSnapOn: (snapOn) => set({ snapOn }),
    sectionDepth: null,
    setSectionDepth: (sectionDepth) => set({ sectionDepth }),
    referenceOverlay: null,
    setReferenceOverlay: (referenceOverlay) => set({ referenceOverlay }),
    referenceCompare: null,
    setReferenceCompare: (referenceCompare) =>
      set((s) => ({
        referenceCompare,
        ...(referenceCompare === null ? { compareResult: IDLE_COMPARE, compareRegion: null } : {}),
        ...(referenceCompare?.referenceId !== s.referenceCompare?.referenceId
          ? { compareRegion: null }
          : {}),
      })),
    compareResult: IDLE_COMPARE,
    setCompareResult: (compareResult) =>
      set((s) =>
        compareResult.result === s.compareResult.result
          ? { compareResult }
          : { compareResult, compareRegion: null },
      ),
    compareRegion: null,
    setCompareRegion: (compareRegion) => set({ compareRegion }),
    viewportFocus: null,
    focusViewport: (box) =>
      set((s) => ({ viewportFocus: { box, seq: (s.viewportFocus?.seq ?? 0) + 1 } })),
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
    clonesDraft: null,
    setClonesDraft: (clonesDraft) => set({ clonesDraft }),
    clonesRow: null,
    setClonesRow: (clonesRow) => set({ clonesRow }),
    announcement: null,
    announce: (announcement) => set({ announcement }),
  }))
}
