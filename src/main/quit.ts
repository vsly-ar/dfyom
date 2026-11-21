// Quitting the app (docs/conventions/ui.md#confirmations): which questions to ask before the app
// quits and what the answers mean, kept free of Electron so it is unit-tested; src/main/index.ts
// asks them with native message boxes, src/main/ipc.ts saves.

/** The run states that make quitting ask first (docs/modes/run-v0.1.md#machine-host-and-protocol). */
export function runIsActive(phase: string | undefined): boolean {
  return phase !== undefined && !['done', 'failed', 'stopped'].includes(phase)
}

/** One question before quitting; asked in this order, each only if still needed when its turn comes. */
export type QuitStep = 'stopRun' | 'unsavedChanges'

export function quitSteps(state: {
  readonly runActive: boolean
  readonly unsaved: readonly unknown[]
}): QuitStep[] {
  const steps: QuitStep[] = []
  if (state.runActive) steps.push('stopRun')
  if (state.unsaved.length > 0) steps.push('unsavedChanges')
  return steps
}

/** A native message box: buttons in order, the safe choice (Cancel) focused and on Escape. */
export interface QuitDialog {
  readonly type: 'warning'
  readonly message: string
  readonly detail: string
  readonly buttons: string[]
  readonly defaultId: number
  readonly cancelId: number
}

export const STOP_RUN_DIALOG: QuitDialog = {
  type: 'warning',
  message: 'A run is in progress',
  detail: 'Quitting stops the run: DFYOM holds the feed, then resets the machine.',
  buttons: ['Cancel', 'Stop run and quit'],
  defaultId: 0,
  cancelId: 0,
}

/** "Stop run and quit" was chosen. */
export const stopRunConfirmed = (response: number): boolean => response === 1

const UNSAVED_BUTTONS = ['Save all', 'Quit without saving', 'Cancel'] as const
export type UnsavedChoice = 'saveAll' | 'discard' | 'cancel'

/** The one confirmation for every open project with unsaved changes, naming them. */
export function unsavedChangesDialog(names: readonly string[]): QuitDialog {
  const quoted = names.map((n) => `“${n}”`)
  const one = quoted.length === 1
  return {
    type: 'warning',
    message: one
      ? `Quit with unsaved changes in ${quoted[0]}?`
      : `Quit with unsaved changes in ${quoted.length} projects?`,
    detail:
      (one ? '' : `${quoted.join(', ')}.\n\n`) +
      'Save all saves each project to its file; an untitled project asks where to save it. ' +
      'Quitting without saving keeps the changes recoverable: DFYOM offers to restore them when you open the project again.',
    buttons: [...UNSAVED_BUTTONS],
    defaultId: UNSAVED_BUTTONS.indexOf('Cancel'),
    cancelId: UNSAVED_BUTTONS.indexOf('Cancel'),
  }
}

export function unsavedChoice(response: number): UnsavedChoice {
  if (response === 0) return 'saveAll'
  if (response === 1) return 'discard'
  return 'cancel'
}

/** Outcome of "Save all": every project saved, or the quit is cancelled (dialog cancelled or a save failed). */
export type SaveAllOutcome =
  | { readonly kind: 'saved' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly name: string; readonly message: string }

/** The quit goes on only when every project was saved. */
export const saveAllLetsQuit = (o: SaveAllOutcome): boolean => o.kind === 'saved'

export function saveFailedDialog(name: string, message: string): QuitDialog {
  return {
    type: 'warning',
    message: `“${name}” could not be saved`,
    detail: `${message}\n\nDFYOM keeps running so you can save it another way.`,
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
  }
}
