import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { createTestLogger } from '../../shared/testing/logger'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { faultFs, useTempDir } from '../persistence/fs.testing'
import { createSettingsStore, loadSettings, SETTINGS_FILE } from './store'

const tmp = useTempDir()

describe('settings store', () => {
  it('starts from the defaults without a file', async () => {
    const log = createTestLogger()
    expect(await loadSettings(tmp.dir, log)).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS).toMatchObject({
      theme: 'system',
      reduceMotion: false,
      allowLocalAgents: true,
      defaultAnchor: { u: 'centre', v: 'centre' },
    })
    expect(log.at('warn')).toEqual([])
  })

  it('persists an update and loads it again; missing fields take their defaults', async () => {
    const log = createTestLogger()
    const store = createSettingsStore({ appData: tmp.dir, initial: DEFAULT_SETTINGS, log })
    expectOk(store.update({ theme: 'dark', layouts: { shell: { navigator: 20, viewport: 80 } } }))
    expectOk(store.update({ allowLocalAgents: false, layouts: { other: { a: 100 } } }))
    expectOk(store.update({ lastMachine: 'machine-1' }))
    await store.flush()
    const loaded = await loadSettings(tmp.dir, log)
    expect(loaded).toEqual({
      theme: 'dark',
      reduceMotion: false,
      allowLocalAgents: false,
      layouts: { shell: { navigator: 20, viewport: 80 }, other: { a: 100 } },
      defaultAnchor: { u: 'centre', v: 'centre' },
      libraryUnits: 'mm',
      snapGrid: { mm: 1, inch: 1 / 16 },
      autoApplyDelay: 10,
      sidePanels: {},
      lastMachine: 'machine-1',
      jogKeys: 'game',
      skipHomeConfirm: [],
      autoReconnect: true,
      advancedUser: false,
      limitBackOff: 3,
      jogFeed: {},
      cuttingJogFeed: {},
      jogStep: {},
      inspectorGroups: {},
      inspectorTabs: {},
    })

    await writeFile(join(tmp.dir, SETTINGS_FILE), JSON.stringify({ reduceMotion: true }))
    expect(await loadSettings(tmp.dir, log)).toEqual({ ...DEFAULT_SETTINGS, reduceMotion: true })
  })

  it('notifies listeners with the previous settings', async () => {
    const store = createSettingsStore({
      appData: tmp.dir,
      initial: DEFAULT_SETTINGS,
      log: createTestLogger(),
    })
    const listener = vi.fn()
    store.onChange(listener)
    const next = expectOk(store.update({ reduceMotion: true }))
    expect(listener).toHaveBeenCalledWith(next, DEFAULT_SETTINGS)
    await store.flush()
  })

  it('rejects unknown fields and wrong values without changing anything', async () => {
    const store = createSettingsStore({
      appData: tmp.dir,
      initial: DEFAULT_SETTINGS,
      log: createTestLogger(),
    })
    expectErrCode(store.update({ theme: 'blue' }), 'input.malformed')
    expectErrCode(store.update({ token: 'x' }), 'input.malformed')
    expectErrCode(store.update({ defaultAnchor: { u: 'left', v: 'min' } }), 'input.malformed')
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    const next = expectOk(store.update({ defaultAnchor: { u: 'min', v: 'max' } }))
    expect(next.defaultAnchor).toEqual({ u: 'min', v: 'max' })
    await store.flush()
  })

  it('falls back to the defaults for an invalid file, with a warning', async () => {
    const log = createTestLogger()
    await writeFile(join(tmp.dir, SETTINGS_FILE), '{ not json')
    expect(await loadSettings(tmp.dir, log)).toEqual(DEFAULT_SETTINGS)
    await writeFile(join(tmp.dir, SETTINGS_FILE), JSON.stringify({ theme: 7 }))
    expect(await loadSettings(tmp.dir, log)).toEqual(DEFAULT_SETTINGS)
    expect(log.at('warn')).toHaveLength(2)
  })

  it('keeps the settings in memory when the write fails, and logs it', async () => {
    const log = createTestLogger()
    const fs = faultFs((op) => (op === 'rename' ? 'fail' : undefined))
    const store = createSettingsStore({ appData: tmp.dir, initial: DEFAULT_SETTINGS, log, fs })
    expectOk(store.update({ theme: 'light' }))
    await store.flush()
    expect(store.get().theme).toBe('light')
    expect(log.at('warn').map((e) => e.msg)).toEqual(['settings not saved'])
    await expect(readFile(join(tmp.dir, SETTINGS_FILE))).rejects.toThrow()
  })
})
