import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { saveDefaultPath, startFolder, type DialogFolders } from './file-dialogs'
import { useTempDir } from './persistence/fs.testing'

const tmp = useTempDir()

function folders(map: Record<string, string>): DialogFolders {
  return { dialogFolder: (k) => map[k], rememberDialogFolder: (k, f) => void (map[k] = f) }
}

describe('dialog start folders', () => {
  it('offers the remembered folder of the dialog kind while it exists', async () => {
    const f = folders({ project: tmp.dir, 'gcode-export': join(tmp.dir, 'gone') })
    expect(await startFolder(f, 'project')).toBe(tmp.dir)
    expect(await startFolder(f, 'gcode-export')).toBeUndefined()
    expect(await startFolder(f, 'reference-import')).toBeUndefined()
  })

  it('puts the save name in the folder', () => {
    expect(saveDefaultPath(undefined, 'Bracket.dfyom')).toBe('Bracket.dfyom')
    expect(saveDefaultPath(tmp.dir, 'Bracket.dfyom')).toBe(join(tmp.dir, 'Bracket.dfyom'))
  })
})
