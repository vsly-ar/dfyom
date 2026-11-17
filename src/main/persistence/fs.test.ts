import { realpathSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalPath, foldPath, nodeFs } from './fs'
import { useTempDir } from './fs.testing'

const tmp = useTempDir()

describe('foldPath', () => {
  it('folds case on macOS and Windows only', () => {
    expect(foldPath('/A/B.dfyom', 'darwin')).toBe('/a/b.dfyom')
    expect(foldPath('C:\\A.dfyom', 'win32')).toBe('c:\\a.dfyom')
    expect(foldPath('/A/B.dfyom', 'linux')).toBe('/A/B.dfyom')
  })
})

describe('canonicalPath', () => {
  it('resolves symlinks, also for a file that does not exist yet', async () => {
    const real = join(realpathSync(tmp.dir), 'docs')
    await mkdir(real)
    await symlink(real, join(tmp.dir, 'link'))
    await writeFile(join(real, 'a.dfyom'), 'x')
    expect(await canonicalPath(nodeFs, join(tmp.dir, 'link', 'a.dfyom'))).toBe(
      join(real, 'a.dfyom'),
    )
    expect(await canonicalPath(nodeFs, join(tmp.dir, 'link', 'new.dfyom'))).toBe(
      join(real, 'new.dfyom'),
    )
  })
})

describe('nodeFs.fsync', () => {
  it('flushes a file through a writable handle (Windows refuses read-only ones)', async () => {
    const f = join(tmp.dir, 'f')
    await writeFile(f, 'x')
    await expect(nodeFs.fsync(f)).resolves.toBeUndefined()
  })
})
