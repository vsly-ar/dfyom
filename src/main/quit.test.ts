import { describe, expect, it } from 'vitest'
import {
  quitSteps,
  runIsActive,
  saveAllLetsQuit,
  saveFailedDialog,
  STOP_RUN_DIALOG,
  stopRunConfirmed,
  unsavedChangesDialog,
  unsavedChoice,
} from './quit'

describe('quitSteps', () => {
  it('quits without asking when nothing is running or unsaved', () => {
    expect(quitSteps({ runActive: false, unsaved: [] })).toEqual([])
  })

  it('asks about the run first, then about unsaved changes', () => {
    expect(quitSteps({ runActive: true, unsaved: [] })).toEqual(['stopRun'])
    expect(quitSteps({ runActive: false, unsaved: ['p1'] })).toEqual(['unsavedChanges'])
    expect(quitSteps({ runActive: true, unsaved: ['p1', 'p2'] })).toEqual([
      'stopRun',
      'unsavedChanges',
    ])
  })
})

describe('runIsActive', () => {
  it('is true for a job that has not ended', () => {
    expect(runIsActive('running')).toBe(true)
    expect(runIsActive('held')).toBe(true)
  })

  it('is false without a job or after it ended', () => {
    expect(runIsActive(undefined)).toBe(false)
    for (const phase of ['done', 'failed', 'stopped']) expect(runIsActive(phase)).toBe(false)
  })
})

describe('stop-run dialog', () => {
  it('focuses Cancel; only "Stop run and quit" confirms', () => {
    expect(STOP_RUN_DIALOG.buttons[STOP_RUN_DIALOG.defaultId]).toBe('Cancel')
    expect(STOP_RUN_DIALOG.buttons[STOP_RUN_DIALOG.cancelId]).toBe('Cancel')
    expect(stopRunConfirmed(STOP_RUN_DIALOG.buttons.indexOf('Stop run and quit'))).toBe(true)
    expect(stopRunConfirmed(STOP_RUN_DIALOG.cancelId)).toBe(false)
  })
})

describe('unsavedChangesDialog', () => {
  it('names a single project in the question', () => {
    const d = unsavedChangesDialog(['Bracket'])
    expect(d.message).toBe('Quit with unsaved changes in “Bracket”?')
    expect(d.detail).toContain('recoverable')
  })

  it('counts several projects and lists them', () => {
    const d = unsavedChangesDialog(['Bracket', 'Lid'])
    expect(d.message).toBe('Quit with unsaved changes in 2 projects?')
    expect(d.detail.startsWith('“Bracket”, “Lid”.')).toBe(true)
  })

  it('offers Save all / Quit without saving / Cancel, Cancel focused and on Escape', () => {
    const d = unsavedChangesDialog(['Bracket'])
    expect(d.buttons).toEqual(['Save all', 'Quit without saving', 'Cancel'])
    expect(d.buttons[d.defaultId]).toBe('Cancel')
    expect(d.buttons[d.cancelId]).toBe('Cancel')
  })

  it('maps the answer by button', () => {
    const { buttons } = unsavedChangesDialog(['Bracket'])
    expect(unsavedChoice(buttons.indexOf('Save all'))).toBe('saveAll')
    expect(unsavedChoice(buttons.indexOf('Quit without saving'))).toBe('discard')
    expect(unsavedChoice(buttons.indexOf('Cancel'))).toBe('cancel')
    // a closed box without an answer is a cancel
    expect(unsavedChoice(-1)).toBe('cancel')
  })
})

describe('Save all', () => {
  it('lets the quit go on only when every project was saved', () => {
    expect(saveAllLetsQuit({ kind: 'saved' })).toBe(true)
    expect(saveAllLetsQuit({ kind: 'cancelled' })).toBe(false)
    expect(saveAllLetsQuit({ kind: 'failed', name: 'Bracket', message: 'disk full' })).toBe(false)
  })

  it('names the project that failed and says the app keeps running', () => {
    const d = saveFailedDialog('Bracket', 'disk full')
    expect(d.message).toBe('“Bracket” could not be saved')
    expect(d.detail).toContain('disk full')
    expect(d.detail).toContain('keeps running')
  })
})
