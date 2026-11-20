// App settings store of the main process: loaded once at start, updated through IPC, written to
// `<appData>/settings.json` (atomic, serialized) and pushed to every window.
// Doc: docs/conventions/ui.md#settings · contract: src/shared/settings.ts
import { join } from 'node:path'
import type { Logger } from '../../shared/logging'
import { parseWith } from '../../shared/parse'
import { Ok, tryCatch, type AppResult } from '../../shared/result'
import {
  AppSettingsPatchSchema,
  AppSettingsSchema,
  DEFAULT_SETTINGS,
  mergeSettings,
  type AppSettings,
} from '../../shared/settings'
import { errnoCode, nodeFs, writeFileAtomic, type PersistFs } from '../persistence/fs'

export const SETTINGS_FILE = 'settings.json'

export interface SettingsStore {
  get(): AppSettings
  /** Validates and applies a patch, notifies listeners and schedules the write. */
  update(patch: unknown): AppResult<AppSettings>
  /** Returns the unsubscribe. */
  onChange(listener: (settings: AppSettings, previous: AppSettings) => void): () => void
  /** Resolves when every scheduled write has finished (tests, quit). */
  flush(): Promise<void>
}

/**
 * Reads the settings file. Missing → defaults; unreadable or invalid → defaults with a warning
 * (the file is replaced on the next change). Settings are preferences, not user data, so the
 * pre-alpha reset needs no confirmation (docs/conventions/error-handling/migrations.md).
 */
export async function loadSettings(
  appData: string,
  log: Logger,
  fs: PersistFs = nodeFs,
): Promise<AppSettings> {
  const file = join(appData, SETTINGS_FILE)
  let text: string
  try {
    text = new TextDecoder().decode(await fs.readFile(file))
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT') log.warn({ file, err: String(e) }, 'settings unreadable')
    return DEFAULT_SETTINGS
  }
  const parsed = tryCatch(() => JSON.parse(text) as unknown, 'input.malformed', 'not JSON').andThen(
    (raw) => parseWith(AppSettingsSchema, raw, 'loadSettings'),
  )
  if (parsed.isErr()) {
    log.warn({ file, err: parsed.unwrapErr().toJSON() }, 'settings invalid; using defaults')
    return DEFAULT_SETTINGS
  }
  return parsed.unwrap()
}

export function createSettingsStore(o: {
  readonly appData: string
  readonly initial: AppSettings
  readonly log: Logger
  readonly fs?: PersistFs
}): SettingsStore {
  const fs = o.fs ?? nodeFs
  const file = join(o.appData, SETTINGS_FILE)
  const listeners = new Set<(s: AppSettings, prev: AppSettings) => void>()
  let current = o.initial
  // Writes run one after another, each writing the settings current when it starts.
  let tail: Promise<void> = Promise.resolve()
  let pending = false
  const scheduleWrite = () => {
    if (pending) return
    pending = true
    tail = tail.then(async () => {
      pending = false
      const r = await writeFileAtomic(fs, file, `${JSON.stringify(current, null, 2)}\n`)
      if (r.isErr()) o.log.warn({ file, err: r.unwrapErr().toJSON() }, 'settings not saved')
    })
  }
  return {
    get: () => current,
    update(patch) {
      const parsed = parseWith(AppSettingsPatchSchema, patch, 'settings.update')
      if (parsed.isErr()) return parsed
      const previous = current
      current = mergeSettings(current, parsed.unwrap())
      scheduleWrite()
      for (const l of [...listeners]) l(current, previous)
      return Ok(current)
    },
    onChange(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    flush: () => tail,
  }
}
