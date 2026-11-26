// Recent projects (DF114): the start panel's views and File → Open Recent's labels.
// Doc: docs/conventions/ui.md#project-files
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: {} }))

const { projectName, recentMenuLabels, recentProjectViews, shortFolder } =
  await import('./recent-projects')

describe('recent projects', () => {
  it('names a project by its file without the extension', () => {
    expect(projectName('/w/Lid.dfyom')).toBe('Lid')
    expect(projectName('/w/Lid.DFYOM')).toBe('Lid')
  })

  it('shortens the home folder to ~', () => {
    expect(shortFolder('/Users/ana/parts/Lid.dfyom', '/Users/ana')).toBe('~/parts')
    expect(shortFolder('/Users/ana/Lid.dfyom', '/Users/ana')).toBe('~')
    expect(shortFolder('/Users/anabel/Lid.dfyom', '/Users/ana')).toBe('/Users/anabel')
    expect(shortFolder('/Volumes/cnc/Lid.dfyom', '/Users/ana')).toBe('/Volumes/cnc')
  })

  it('marks files that are gone as missing, in the stored order', () => {
    const views = recentProjectViews(
      [
        { path: '/Users/ana/a/Lid.dfyom', openedAt: 2 },
        { path: '/Users/ana/b/Box.dfyom', openedAt: 1 },
      ],
      '/Users/ana',
      (p) => p.includes('Lid'),
    )
    expect(views).toEqual([
      { path: '/Users/ana/a/Lid.dfyom', name: 'Lid', folder: '~/a', openedAt: 2, missing: false },
      { path: '/Users/ana/b/Box.dfyom', name: 'Box', folder: '~/b', openedAt: 1, missing: true },
    ])
  })

  it('menu labels add the folder only to names that occur twice', () => {
    expect(
      recentMenuLabels(
        ['/Users/ana/a/Lid.dfyom', '/Users/ana/b/Lid.dfyom', '/x/Box.dfyom'],
        '/Users/ana',
      ),
    ).toEqual(['Lid — ~/a', 'Lid — ~/b', 'Box'])
  })
})
