import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTestLogger } from '../../shared/testing/logger'
import { faultFs, useTempDir } from '../persistence/fs.testing'
import { APP_STATE_FILE, createAppStateStore, EMPTY_APP_STATE, loadAppState } from './app-state'

const tmp = useTempDir()
const WINDOW = {
  bounds: { x: 40, y: 60, width: 1300, height: 820 },
  maximized: true,
  fullScreen: false,
}

describe('app state store', () => {
  it('starts empty without a file', async () => {
    const log = createTestLogger()
    expect(await loadAppState(tmp.dir, log)).toEqual({ dialogFolders: {} })
    expect(log.at('warn')).toEqual([])
  })

  it('persists the last window and the dialog folders and loads them again', async () => {
    const log = createTestLogger()
    const store = createAppStateStore({ appData: tmp.dir, initial: EMPTY_APP_STATE, log })
    store.setWindow({ ...WINDOW, maximized: false })
    store.setWindow(WINDOW)
    store.setLibraryWindow({ ...WINDOW, maximized: false })
    store.rememberDialogFolder('project', '/work/parts')
    store.rememberDialogFolder('reference-import', '/work/models')
    expect(store.dialogFolder('project')).toBe('/work/parts')
    expect(store.dialogFolder('gcode-export')).toBeUndefined()
    await store.flush()
    expect(await loadAppState(tmp.dir, log)).toEqual({
      window: WINDOW,
      libraryWindow: { ...WINDOW, maximized: false },
      dialogFolders: { project: '/work/parts', 'reference-import': '/work/models' },
    })
  })

  it('writes once after changes settle', async () => {
    const log = createTestLogger()
    const store = createAppStateStore({
      appData: tmp.dir,
      initial: EMPTY_APP_STATE,
      log,
      delayMs: 20,
    })
    store.setWindow(WINDOW)
    await expect(readFile(join(tmp.dir, APP_STATE_FILE))).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 60))
    await store.flush()
    expect((await loadAppState(tmp.dir, log)).window).toEqual(WINDOW)
  })

  it('keeps the valid parts of a damaged file; garbage gives the empty state with a warning', async () => {
    const log = createTestLogger()
    const file = join(tmp.dir, APP_STATE_FILE)
    await writeFile(
      file,
      JSON.stringify({ window: { bounds: 'x' }, dialogFolders: { project: '/p' } }),
    )
    expect(await loadAppState(tmp.dir, log)).toEqual({ dialogFolders: { project: '/p' } })
    await writeFile(file, '{ not json')
    expect(await loadAppState(tmp.dir, log)).toEqual(EMPTY_APP_STATE)
    expect(log.at('warn')).toHaveLength(1)
  })

  it('keeps the state in memory when the write fails, and logs it', async () => {
    const log = createTestLogger()
    const fs = faultFs((op) => (op === 'rename' ? 'fail' : undefined))
    const store = createAppStateStore({ appData: tmp.dir, initial: EMPTY_APP_STATE, log, fs })
    store.rememberDialogFolder('project', '/p')
    await store.flush()
    expect(store.dialogFolder('project')).toBe('/p')
    expect(log.at('warn').map((e) => e.msg)).toEqual(['app state not saved'])
  })
})
