// `<appData>` resolution: `--data-dir`, and Electron's default `userData` without Electron (CLI).
// Spec: docs/architecture/persistence.md#files-and-folders, docs/architecture/llm-api.md#implementation-task-310
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultAppData, resolveAppData } from './paths'

describe('app data paths', () => {
  it('--data-dir wins over the given userData', () => {
    expect(resolveAppData(['x', '--data-dir', '/d'], '/u')).toBe('/d')
    expect(resolveAppData(['--data-dir=/e'], '/u')).toBe('/e')
    expect(resolveAppData([], '/u')).toBe('/u')
  })

  it("matches Electron's default userData per platform", () => {
    expect(defaultAppData('darwin', {}, '/h')).toBe(
      join('/h', 'Library', 'Application Support', 'DFYOM'),
    )
    expect(defaultAppData('win32', { APPDATA: 'C:\\A' }, '/h')).toBe(join('C:\\A', 'DFYOM'))
    expect(defaultAppData('linux', {}, '/h')).toBe(join('/h', '.config', 'DFYOM'))
    expect(defaultAppData('linux', { XDG_CONFIG_HOME: '/x' }, '/h')).toBe(join('/x', 'DFYOM'))
  })
})
