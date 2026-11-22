// design.reference.* through the dispatcher: import (prepare: asset copy + worker parse),
// update / turn / fit, remove, list, undo/redo and errors.
// Spec: docs/modes/reference-model.md#commands-and-queries
import { describe, expect, it } from 'vitest'
import { fail, Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers, memoryFiles } from '../commands/jobs'
import { assetPathOf, type AssetRef } from '../project/assets'
import type { ProjectSession } from '../project/storage'
import { designSetup, testStock, type DesignSetup } from './design.fixture'
import type { ReferenceDTO } from './reference.dto'
import { asciiStl, binaryStl, boxSoup, ENCLOSURE_TRIANGLES, enclosureStl } from './stl.testing'

const hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

/** Source files the "user" has, and a session that copies them into an in-memory work/. */
function fakeProject(sources: Record<string, Uint8Array>) {
  const files = new Map<string, Uint8Array>()
  const imports: string[] = []
  const session = {
    async importAsset(source: string, opts: { maxBytes?: number } = {}) {
      const bytes = sources[source]
      if (bytes === undefined)
        return fail('input.malformed', 'no such file', {
          issues: [{ path: ['path'], rule: 'unreadableFile', message: 'no such file' }],
        })
      if (bytes.length > (opts.maxBytes ?? Infinity))
        return fail('input.malformed', 'too large', {
          issues: [{ path: ['path'], rule: 'tooLarge', message: 'too large' }],
        })
      const sha256 = await hex(bytes)
      const path = assetPathOf(sha256, 'stl')
      files.set(`/work/${path}`, bytes)
      imports.push(source)
      return Ok({ path, sha256, size: bytes.length } satisfies AssetRef)
    },
    assetFile: (path: string) => Ok(`/work/${path}`),
  } as unknown as ProjectSession
  return { session, workers: createInProcessWorkers({ files: memoryFiles(files) }), imports }
}

const BOX = '/models/box.stl'
const SMALL = '/models/small.stl'
const OPEN = '/models/open.stl'
const BAD = '/models/bad.stl'
const ENCLOSURE = '/models/enclosure-wood-base.stl'

const SOURCES = {
  [BOX]: binaryStl(boxSoup(20, 10, 5)),
  [SMALL]: asciiStl(boxSoup(2, 1.5, 0.5)),
  [OPEN]: binaryStl(boxSoup(20, 10, 5).slice(9)),
  [BAD]: new TextEncoder().encode('solid x\n  facet nromal 0 0 1\n'),
}

async function setup(opts: { units?: 'mm' | 'inch'; stock?: object } = {}) {
  const p = fakeProject({ ...SOURCES, [ENCLOSURE]: enclosureStl() })
  const s = await designSetup({
    ...opts,
    services: { project: p.session, workers: p.workers },
  })
  return { ...p, s }
}

interface Imported {
  referenceId: string
  sourceUnit: string
  guess: { unit: string; reason: string }
  warnings: { code: string; params: Record<string, unknown> }[]
}
const importRef = async (s: DesignSetup, args: object) =>
  (await s.run('design.reference.import', { partId: s.partId, ...args })) as Imported
const ref = (s: DesignSetup, id: string) => s.d.doc.references[id] as ReferenceDTO
const src = (q: { source: string }) => q.source
const sources = (r: ReferenceDTO) => ({
  scale: src(r.scale),
  rotation: [src(r.rotation.x), src(r.rotation.y), src(r.rotation.z)],
  position: [src(r.position.x), src(r.position.y), src(r.position.z)],
})
const list = async (s: DesignSetup) => {
  const r = expectOk(
    s.d.query('design.reference.list', { partId: s.partId }, { kind: 'ui', id: 'w' }),
  )
  return (r.value as { references: (ReferenceDTO & { placed: unknown; warnings: unknown[] })[] })
    .references
}

describe('design.reference.import', () => {
  it('copies and parses the file, guesses mm and fits centre + top; undo/redo', async () => {
    const { s } = await setup()
    const before = s.d.doc
    const r = await importRef(s, { path: BOX })
    expect(r).toMatchObject({ referenceId: 'reference-4', sourceUnit: 'mm', guess: { unit: 'mm' } })
    expect(r.warnings.map((w) => w.code)).toEqual(['reference.unitGuessed'])
    const rec = ref(s, r.referenceId)
    expect(rec).toMatchObject({
      partId: s.partId,
      name: 'box',
      sourceUnit: 'mm',
      asset: {
        format: 'stl',
        triangles: 12,
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 10, z: 5 } },
      },
    })
    expect(rec.asset.path).toBe(`assets/${rec.asset.sha256}.stl`)
    // stock 100 × 60 × 20: centred in XY, top at the stock top
    expect(sources(rec)).toEqual({
      scale: '1',
      rotation: ['0°', '0°', '0°'],
      position: ['40 mm', '25 mm', '-5 mm'],
    })
    expect(s.d.doc.parts).toEqual(before.parts) // never changes the part
    const after = s.d.doc
    await s.undo()
    expect(s.d.doc).toEqual(before)
    await s.redo()
    expect(s.d.doc).toEqual(after)
  })

  it('guesses inch for a model 1/10 of the stock that fits as inch (ASCII file)', async () => {
    const { s } = await setup()
    const r = await importRef(s, { path: SMALL, name: 'Small' })
    expect(r.sourceUnit).toBe('inch')
    expect(r.guess.reason).toBe(
      'Read as inch: 2 × 1.5 × 0.5 in mm would be 50× smaller than the stock',
    )
    // 2 × 1.5 × 0.5 in = 50.8 × 38.1 × 12.7 mm, centred
    expect(sources(ref(s, r.referenceId)).position).toEqual(['24.6 mm', '10.95 mm', '-12.7 mm'])
    expect(ref(s, r.referenceId).name).toBe('Small')
  })

  it('an explicit source unit and fit win; no unitGuessed warning then', async () => {
    const { s } = await setup()
    const r = await importRef(s, {
      path: SMALL,
      sourceUnit: 'mm',
      fit: { anchor: { u: 'min', v: 'max' }, z: 'bottom' },
    })
    expect(r).toMatchObject({ sourceUnit: 'mm', guess: { unit: 'inch' }, warnings: [] })
    expect(sources(ref(s, r.referenceId)).position).toEqual(['0 mm', '58.5 mm', '-20 mm'])
  })

  it('writes positions in the project units (inch project)', async () => {
    const { s } = await setup({ units: 'inch' })
    const r = await importRef(s, { path: BOX, sourceUnit: 'mm' })
    expect(sources(ref(s, r.referenceId)).position).toEqual(['1.5748"', '0.98425"', '-0.19685"'])
  })

  it('warns about open meshes and models sticking out of the stock', async () => {
    const { s } = await setup({ stock: { ...testStock(), length: '15' } })
    const r = await importRef(s, { path: OPEN, sourceUnit: 'mm' })
    expect(r.warnings.map((w) => w.code)).toEqual(['reference.openMesh', 'reference.exceedsStock'])
    expect(r.warnings[1]!.params).toEqual({ x: 5, y: 0, z: 0 })
  })

  it('imports the real enclosure STL end to end: parse, unit guess, fit', async () => {
    const stock = { ...testStock(), length: '300', width: '200', thickness: '50' }
    const { s } = await setup({ stock })
    const r = await importRef(s, { path: ENCLOSURE })
    expect(r.sourceUnit).toBe('mm')
    const rec = ref(s, r.referenceId)
    expect(rec.name).toBe('enclosure-wood-base')
    expect(rec.asset.triangles).toBe(ENCLOSURE_TRIANGLES)
    expect(r.warnings.map((w) => w.code)).toEqual(['reference.unitGuessed'])
    const [placed] = await list(s)
    const box = placed!.placed as { min: Record<string, number>; max: Record<string, number> }
    // centred on the 300 × 200 stock, its top at the stock top
    expect((box.min['x']! + box.max['x']!) / 2).toBeCloseTo(150, 3)
    expect((box.min['y']! + box.max['y']!) / 2).toBeCloseTo(100, 3)
    expect(box.max['z']).toBeCloseTo(0, 3)
    expect(box.max['x']! - box.min['x']!).toBeCloseTo(249.496, 2)
  })

  it('refuses bad input without a record or an undo step', async () => {
    const { s, imports } = await setup()
    const rev = s.d.revision
    const relative = await s.fail(
      'design.reference.import',
      { partId: s.partId, path: 'box.stl' },
      'input.malformed',
    )
    expect(relative.issues[0]?.rule).toBe('absolutePath')
    const missing = await s.fail(
      'design.reference.import',
      { partId: s.partId, path: '/nope.stl' },
      'input.malformed',
    )
    expect(missing.issues[0]?.rule).toBe('unreadableFile')
    const bad = await s.fail(
      'design.reference.import',
      { partId: s.partId, path: BAD },
      'input.malformed',
    )
    expect(bad.issues[0]).toMatchObject({ path: ['path'], rule: 'stlSyntax', params: { line: 2 } })
    await s.fail('design.reference.import', { partId: 'nope', path: BOX }, 'input.malformed')
    expect(imports).toEqual([BAD]) // the part and the path are checked before copying
    expect(s.d.revision).toBe(rev)
    expect(s.d.doc.references).toEqual({})
  })

  it('without a project session the import fails cleanly', async () => {
    const s = await designSetup()
    await s.fail('design.reference.import', { partId: s.partId, path: BOX }, 'internal.unexpected')
  })
})

describe('design.reference.update / remove / list', () => {
  async function imported() {
    const t = await setup()
    const r = await importRef(t.s, { path: BOX, sourceUnit: 'mm' })
    const upd = (args: object) =>
      t.s.run('design.reference.update', {
        partId: t.s.partId,
        referenceId: r.referenceId,
        ...args,
      }) as Promise<{ warnings: { code: string; params: object }[] }>
    return { ...t, id: r.referenceId, upd }
  }

  it('changes fields as entered (formulas on stock faces), one undo step each', async () => {
    const { s, id, upd } = await imported()
    const before = s.d.doc
    await upd({
      name: 'Box',
      scale: '2',
      rotation: { z: '90' },
      position: { x: '1 in', z: 'stock.top.z - 10' },
    })
    expect(ref(s, id).name).toBe('Box')
    expect(sources(ref(s, id))).toEqual({
      scale: '2',
      rotation: ['0°', '0°', '90'],
      position: ['1 in', '25 mm', 'stock.top.z - 10'],
    })
    // rotated 90° about Z and doubled: 20 × 40 × 10 from the min corner
    const [l] = await list(s)
    expect(l!.placed).toEqual({
      min: { x: 25.4, y: 25, z: -10 },
      max: { x: 45.4, y: 65, z: 0 },
    })
    expect(l!.warnings).toHaveLength(1) // y 65 > 60
    await s.undo()
    expect(s.d.doc).toEqual(before)
  })

  it('turn adds exact 90° steps; fit moves onto the stock after the other changes', async () => {
    const { s, id, upd } = await imported()
    await upd({ turn: { axis: 'x', turns: 1 } })
    await upd({ turn: { axis: 'x', turns: 2 } })
    expect(sources(ref(s, id)).rotation).toEqual(['270°', '0°', '0°'])
    await upd({ turn: { axis: 'x', turns: 1 } })
    expect(sources(ref(s, id)).rotation).toEqual(['0°', '0°', '0°'])
    const w = await upd({ scale: '3', fit: { anchor: { u: 'max', v: 'min' }, z: 'centre' } })
    // 60 × 30 × 15 at the max-X, min-Y corner, centred in Z (stock 100 × 60 × 20)
    expect(sources(ref(s, id)).position).toEqual(['40 mm', '0 mm', '-17.5 mm'])
    expect(w.warnings).toEqual([])
    expect(s.d.history.undoable.at(-1)?.title).toBe('Fit reference to stock')
  })

  it('warns when the placed reference exceeds the stock', async () => {
    const { upd } = await imported()
    const w = await upd({ scale: '10' })
    expect(w.warnings[0]).toMatchObject({ code: 'reference.exceedsStock' })
  })

  it('refuses invalid edits', async () => {
    const { s, id } = await imported()
    const args = (a: object) => ({ partId: s.partId, referenceId: id, ...a })
    const zero = await s.fail('design.reference.update', args({ scale: '0' }), 'model.invariant')
    expect(zero.issues[0]).toMatchObject({ path: ['scale'], rule: 'positive' })
    await s.fail(
      'design.reference.update',
      args({ turn: { axis: 'z', turns: 0 } }),
      'input.malformed',
    )
    await s.fail(
      'design.reference.update',
      args({ position: { x: '0' }, fit: {} }),
      'input.malformed',
    )
    await s.fail('design.reference.update', args({ rotation: { x: '5 mm' } }), 'quantity.unit')
    const unknown = await s.fail(
      'design.reference.update',
      { partId: s.partId, referenceId: 'nope' },
      'input.malformed',
    )
    expect(unknown.issues[0]?.rule).toBe('unknownReference')
  })

  it('remove deletes the record; undo brings it back', async () => {
    const { s, id } = await imported()
    const before = s.d.doc
    await s.run('design.reference.remove', { partId: s.partId, referenceId: id })
    expect(s.d.doc.references).toEqual({})
    expect(await list(s)).toEqual([])
    await s.undo()
    expect(s.d.doc).toEqual(before)
  })
})
