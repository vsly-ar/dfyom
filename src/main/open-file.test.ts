// Opening `.dfyom` files from Finder (hardening U5): paths from launch arguments, the window that
// takes a file, the instance lock rule and the queue before `ready`.
// Doc: docs/conventions/ui.md#project-files
import { describe, expect, it } from 'vitest'
import {
  createFileQueue,
  fileRoute,
  isProjectFile,
  projectFilesFromArgv,
  takesInstanceLock,
} from './open-file'

describe('projectFilesFromArgv', () => {
  it('takes .dfyom arguments, resolves relative ones against the launch folder', () => {
    expect(
      projectFilesFromArgv(
        ['/Applications/DFYOM.app/Contents/MacOS/DFYOM', 'a.dfyom', '/p/b.DFYOM', 'notes.txt'],
        '/work',
      ),
    ).toEqual(['/work/a.dfyom', '/p/b.DFYOM'])
  })

  it('skips the executable, the script of an unpackaged run, flags and the value of --data-dir', () => {
    expect(
      projectFilesFromArgv(
        [
          '/x/electron.dfyom',
          'out/main/index.js',
          '--data-dir',
          '/tmp/data.dfyom',
          '--data-dir=/tmp/other.dfyom',
          '--mcp-http=off',
          '-psn_0_12345',
          'part.dfyom',
        ],
        '/w',
      ),
    ).toEqual(['/w/part.dfyom'])
  })

  it('finds nothing in a plain launch', () => {
    expect(projectFilesFromArgv(['/x/DFYOM'], '/')).toEqual([])
    expect(projectFilesFromArgv([], '/')).toEqual([])
  })

  it('recognises the extension in any case only at the end', () => {
    expect(isProjectFile('/p/a.dfyom')).toBe(true)
    expect(isProjectFile('/p/a.Dfyom')).toBe(true)
    expect(isProjectFile('/p/a.dfyom.bak')).toBe(false)
  })
})

describe('fileRoute', () => {
  it('the last focused window when it has no project', () => {
    expect(
      fileRoute(
        [
          { id: 1, hasProject: false },
          { id: 2, hasProject: false },
        ],
        2,
      ),
    ).toEqual({ kind: 'window', id: 2 })
  })

  it('else a window without a project, reused before one with a project', () => {
    expect(
      fileRoute(
        [
          { id: 1, hasProject: true },
          { id: 2, hasProject: false },
        ],
        1,
      ),
    ).toEqual({ kind: 'window', id: 2 })
  })

  it('else the last focused window, whose Open makes a new window', () => {
    expect(
      fileRoute(
        [
          { id: 1, hasProject: true },
          { id: 3, hasProject: true },
        ],
        3,
      ),
    ).toEqual({ kind: 'window', id: 3 })
  })

  it('else the first window; a closed last-focused window counts as none', () => {
    expect(
      fileRoute(
        [
          { id: 4, hasProject: true },
          { id: 5, hasProject: true },
        ],
        9,
      ),
    ).toEqual({ kind: 'window', id: 4 })
    expect(fileRoute([{ id: 4, hasProject: true }], undefined)).toEqual({ kind: 'window', id: 4 })
  })

  it('a new window when no project window is open', () => {
    expect(fileRoute([], undefined)).toEqual({ kind: 'newWindow' })
    expect(fileRoute([], 3)).toEqual({ kind: 'newWindow' })
  })
})

describe('takesInstanceLock', () => {
  it('packaged always; unpackaged only with --data-dir (npm run dev takes none)', () => {
    expect(takesInstanceLock(true, undefined)).toBe(true)
    expect(takesInstanceLock(true, '/d')).toBe(true)
    expect(takesInstanceLock(false, '/d')).toBe(true)
    expect(takesInstanceLock(false, undefined)).toBe(false)
  })
})

describe('createFileQueue', () => {
  it('holds files until started, then hands on the queued and every later one in order', () => {
    const q = createFileQueue()
    const seen: string[] = []
    q.push('/a.dfyom')
    q.push('/b.dfyom')
    expect(seen).toEqual([])
    q.start((f) => seen.push(f))
    expect(seen).toEqual(['/a.dfyom', '/b.dfyom'])
    q.push('/c.dfyom')
    expect(seen).toEqual(['/a.dfyom', '/b.dfyom', '/c.dfyom'])
  })
})
