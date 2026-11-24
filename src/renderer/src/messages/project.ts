// User-facing strings of the project file UI (New / Open / Save, recovery, locks) and the
// keyboard shortcut list (task 3.6). Doc: docs/conventions/ui.md#project-files, #keyboard-shortcuts
import type { UnitSystem } from '../../../core/project/document'

export const projectMessages = {
  start: {
    title: 'No project open',
    description: 'Create a project, or open a project file.',
    new: 'New project',
    open: 'Open project',
    recoverTitle: 'Unsaved changes from an earlier session',
    untitled: 'Untitled project',
    restore: 'Restore',
    discard: 'Discard',
    /** DF80: Run mode needs no project. */
    machineTitle: 'Machine',
    machineDescription: 'Connect, home and jog the machine without a project.',
    machineAction: 'Go to Run',
  },
  newDialog: {
    title: 'New project',
    description: 'A new, untitled project. Save it to choose where its file goes.',
    name: 'Project name',
    defaultName: 'Untitled',
    units: 'Unit system',
    unitNames: { mm: 'Millimetres', inch: 'Inches' } satisfies Record<UnitSystem, string>,
    create: 'Create project',
    cancel: 'Cancel',
  },
  save: 'Save',
  saveAs: 'Save as',
  saved: (file: string) => `Saved to ${file}`,
  recovery: {
    title: 'Restore unsaved changes?',
    description: (file: string | null) =>
      file === null
        ? 'An untitled project has changes from an earlier session that were never saved.'
        : `“${file}” has changes from an earlier session that were not saved to the file.`,
    restore: 'Restore changes',
    discard: 'Discard changes',
    discardTitle: 'Discard the unsaved changes?',
    discardDescription:
      'The changes from the earlier session are deleted for good; the project file stays as it was saved.',
  },
  locked: {
    title: 'The project is open elsewhere',
    description:
      'Another DFYOM window or instance has this project open. Close it there, or try again. A lock left by a DFYOM on another computer that stopped can be taken over 2 minutes after its last sign of life.',
    retry: 'Try again',
    retryLater: 'Retry in 2 min',
    waiting: (s: number) => `Retrying in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
    cancel: 'Cancel',
  },
  incompatible: {
    title: 'This project can’t be opened',
    description: (file: string) =>
      `“${file}” was saved by an earlier pre-alpha version of DFYOM, and its data no longer loads. Pre-alpha versions don’t upgrade projects: discard its content and start fresh with an empty project of the same name, or keep the file as it is.`,
    reset: 'Discard and start fresh',
    cancel: 'Cancel',
    confirmTitle: (file: string) => `Discard the content of “${file}”?`,
    confirmDescription:
      'The file is replaced by an empty project with the same name and units. Its parts and plans are deleted for good.',
  },
  failed: {
    open: 'The project could not be opened',
    save: 'The project could not be saved',
    create: 'The project could not be created',
    close: 'Back to the project',
  },
  shortcuts: {
    title: 'Keyboard shortcuts',
    description: 'Shortcuts act while focus is not in a text field, except where noted.',
    close: 'Close',
    groups: {
      file: 'Project',
      edit: 'Edit',
      modes: 'Modes and panels',
      viewport: 'Viewport (while it has focus)',
      fields: 'Fields',
      design: 'Design navigator',
      library: 'Library window',
      runJog: 'Run: jog (connected, no run going)',
    },
    what: {
      /** DF88 (docs/conventions/ui.md#jog-hotkeys). */
      jog: (dir: string) => `Jog ${dir} (tap: one step, hold: until released)`,
      stopJog: 'Stop jogging',
      jogOff: 'Jog keys are off (Settings → Jog keys)',
      newProject: 'New project',
      openProject: 'Open project',
      save: 'Save',
      saveAs: 'Save as',
      apply: 'Apply changes (also in a text field)',
      settings: 'Settings',
      undo: 'Undo (in a text field: the text)',
      redo: 'Redo',
      escape: 'Clear the selection, cancel pick mode',
      modes: 'Design, Plan, Run',
      regions: 'Next region (Shift+F6: previous)',
      list: 'This list',
      views: 'Top, Front, Right, Isometric view',
      oppositeViews: 'Bottom, Back, Left view',
      fit: 'Fit',
      orbit: 'Orbit (Shift: pan)',
      zoom: 'Zoom',
      move: 'Move the operation up or down',
      rowMenu: 'Open the focused row’s menu (Chamfer, Make Clones…, Remove)',
      measure: 'Measure (dimension): point to point; Shift locks to an axis, Esc clears, then ends',
      noSnap: 'Drag a handle or tab without snapping',
      angleStep: 'Drag a handle in 15° steps (no snapping)',
      commit: 'Commit the value (one undo step) and apply',
      commitOnly: 'Commit the value only (also a click away)',
      revert: 'Revert to the stored value',
      step: 'Step the value (Shift ×10, Alt ×0.1)',
      pick: 'Pick a surface in the viewport (again: cancel)',
      adjust: "Move into the field's adjust panel (Esc: back to the field)",
      references: 'References',
      openLibrary: 'Open the Library window (Window → Library)',
      librarySave: 'Save the item being edited',
      libraryList: 'Select an item in the list (Enter: edit it)',
    },
  },
} as const
