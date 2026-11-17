import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { newProjectDoc } from './document'
import {
  docToFiles,
  fileContent,
  isLayoutPath,
  loadProjectFiles,
  parseManifest,
  stableJson,
  touchedPaths,
  type ProjectLayout,
} from './layout'

const doc = newProjectDoc({ name: 'Bracket', unitSystem: 'mm' })
/** A layout with a record collection, as parts/plans will add (the generic mechanism). */
const withParts: ProjectLayout = { collections: ['parts'] }
const partsDoc = {
  name: 'P',
  unitSystem: 'mm',
  parts: { 'part-1': { id: 'part-1', w: 2 }, 'part-2': { id: 'part-2', w: 3 } },
}

const manifest = (over: Record<string, unknown> = {}) => ({
  format: 'dfyom-project',
  schemaVersion: 1,
  projectId: 'project-1',
  appVersion: '0.0.8',
  savedAt: '2026-11-17T10:00:00.000Z',
  revision: 3,
  files: [{ path: 'project.json', size: 10, sha256: 'a'.repeat(64) }],
  ...over,
})

describe('stableJson', () => {
  it('pretty-prints with sorted keys and a trailing newline, so files diff cleanly', () => {
    expect(stableJson({ b: 1, a: { d: [2, { z: 1, y: 0 }], c: null } })).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      2,\n      {\n        "y": 0,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    )
  })
})

describe('docToFiles', () => {
  it('writes project-level fields to project.json', () => {
    const files = expectOk(docToFiles(doc))
    expect([...files.keys()]).toEqual(['project.json'])
    expect(JSON.parse(files.get('project.json') ?? '')).toEqual({
      name: 'Bracket',
      unitSystem: 'mm',
    })
  })

  it('writes one file per record of a collection', () => {
    const files = expectOk(docToFiles(partsDoc, withParts))
    expect([...files.keys()].sort()).toEqual([
      'parts/part-1.json',
      'parts/part-2.json',
      'project.json',
    ])
    expect(JSON.parse(files.get('project.json') ?? '')).toEqual({ name: 'P', unitSystem: 'mm' })
    expect(JSON.parse(files.get('parts/part-2.json') ?? '')).toEqual({ id: 'part-2', w: 3 })
  })

  it('rejects record ids that are not safe file names', () => {
    const bad = { ...partsDoc, parts: { '../evil': { id: 'x' } } }
    expectErrCode(docToFiles(bad, withParts), 'input.malformed')
  })
})

describe('touchedPaths / fileContent', () => {
  it('maps patches to the files of the changed records', () => {
    const paths = touchedPaths(
      [
        { op: 'replace', path: ['name'], value: 'Q' },
        { op: 'replace', path: ['parts', 'part-1', 'w'], value: 5 },
        { op: 'remove', path: ['parts', 'part-2'] },
      ],
      withParts,
    )
    expect(paths !== 'all' && [...paths].sort()).toEqual([
      'parts/part-1.json',
      'parts/part-2.json',
      'project.json',
    ])
  })

  it('a replaced collection or document touches all files', () => {
    expect(touchedPaths([{ op: 'replace', path: ['parts'], value: {} }], withParts)).toBe('all')
    expect(touchedPaths([{ op: 'replace', path: [], value: {} }], withParts)).toBe('all')
  })

  it('returns the current content of a file, or None once its record is gone', () => {
    expect(fileContent(partsDoc, 'parts/part-1.json', withParts).unwrap()).toBe(
      stableJson({ id: 'part-1', w: 2 }),
    )
    expect(fileContent(partsDoc, 'parts/gone.json', withParts).isNone()).toBe(true)
    expect(fileContent(partsDoc, 'project.json', withParts).unwrap()).toBe(
      stableJson({ name: 'P', unitSystem: 'mm' }),
    )
  })
})

describe('isLayoutPath', () => {
  it('accepts only project.json and <collection>/<safe id>.json', () => {
    expect(isLayoutPath('project.json', withParts)).toBe(true)
    expect(isLayoutPath('parts/part-1.json', withParts)).toBe(true)
    for (const p of [
      'parts/../x.json',
      'plans/a.json',
      '/project.json',
      'parts/a/b.json',
      'x.json',
    ])
      expect(isLayoutPath(p, withParts), p).toBe(false)
  })
})

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    expect(expectOk(parseManifest(manifest())).revision).toBe(3)
  })

  it('refuses a newer schemaVersion (persist.migration)', () => {
    expectErrCode(parseManifest(manifest({ schemaVersion: 2 })), 'persist.migration')
  })

  it('rejects another format, a bad hash or a file path outside the layout', () => {
    expectErrCode(parseManifest(manifest({ format: 'zip' })), 'input.malformed')
    expectErrCode(
      parseManifest(manifest({ files: [{ path: 'project.json', size: 1, sha256: 'xyz' }] })),
      'input.malformed',
    )
    expectErrCode(
      parseManifest(manifest({ files: [{ path: '../x.json', size: 1, sha256: 'a'.repeat(64) }] })),
      'input.malformed',
    )
    expectErrCode(parseManifest('nope'), 'input.malformed')
  })
})

describe('loadProjectFiles (load pipeline)', () => {
  it('round-trips a document through its files', () => {
    const files = expectOk(docToFiles(doc))
    expect(expectOk(loadProjectFiles(files))).toEqual(doc)
  })

  it('rejects malformed JSON, a malformed document, unknown files and a missing project.json', () => {
    expectErrCode(loadProjectFiles(new Map([['project.json', '{']])), 'input.malformed')
    expectErrCode(
      loadProjectFiles(new Map([['project.json', '{"name":"A","unitSystem":"cm"}']])),
      'input.malformed',
    )
    expectErrCode(
      loadProjectFiles(
        new Map([
          ['project.json', '{"name":"A","unitSystem":"mm"}'],
          ['extra.json', '{}'],
        ]),
      ),
      'input.malformed',
    )
    expectErrCode(loadProjectFiles(new Map()), 'input.malformed')
  })

  it('returns a deeply frozen document', () => {
    expect(Object.isFrozen(expectOk(loadProjectFiles(expectOk(docToFiles(doc)))))).toBe(true)
  })
})
