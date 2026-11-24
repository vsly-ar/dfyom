// Test-only setup for the reference compare (DF60 P4/P5; not app code): a design whose project
// session reads in-memory STL sources, in-process workers and evaluations, the enclosure
// approximated from its reference, and the compare job's result. Shared by
// `reference-compare.test.ts` and `reference-compare.perf.ts`.
// Doc: docs/modes/reference-tools.md#test-plans
import { fail, Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers, memoryFiles, type WorkerPort } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import { nodeManifoldSource } from '../geometry/testing/node-wasm'
import type { SolidKernel } from '../geometry/solid-port'
import { hashJson } from '../plan/snapshot'
import { assetPathOf, type AssetRef } from '../project/assets'
import type { ProjectSession } from '../project/storage'
import { designSetup, testStock, type DesignSetup } from './design.fixture'
import type { EvaluationService } from './evaluation'
import { partGeometryInput } from './load'
import { binaryStl, enclosureFullStl, soupOf } from './stl.testing'

export const region2d = nodeRegion2d()

let kernelLoad: Promise<SolidKernel> | undefined
/** The test's own kernel (evaluations, STL writers), loaded once. */
export const testKernel = (): Promise<SolidKernel> =>
  (kernelLoad ??= loadManifold(nodeManifoldSource()).then((k) => expectOk(k)))

/** STL bytes by the path a test imports them from. */
export const SOURCES: Record<string, Uint8Array> = {}
/** The imported assets of every setup (one map, so setups may share workers). */
const FILES = new Map<string, Uint8Array>()

const hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

/** The part's evaluation, computed in-process on demand (no debounce, no scheduler). */
function evaluationsOf(kernel: SolidKernel, get: () => DesignSetup): EvaluationService {
  // the last one kept per input, as the scheduler keeps it (a compare after no edit reuses it)
  let last: { hash: string; state: ReturnType<EvaluationService['state']> } | undefined
  const state = (doc: DesignSetup['d']['doc'], partId: string) => {
    const input = expectOk(partGeometryInput(doc, partId, region2d))
    const inputHash = hashJson(input)
    if (last?.hash === inputHash) return last.state
    const ev = kernel.withSolids((solids) => evaluatePart(input, solids, undefined, region2d))
    const r = ev.isErr()
      ? { status: 'failed' as const, inputHash, error: ev.unwrapErr() }
      : { status: 'done' as const, inputHash, evaluation: ev.unwrap() }
    last = { hash: inputHash, state: r }
    return r
  }
  return {
    state,
    evaluate: (partId) => Promise.resolve(Ok(state(get().d.doc, partId))),
  }
}

/** A setup with its workers and evaluations (the evaluations keep the last one per input). */
export type CompareSetup = DesignSetup & {
  readonly workers: WorkerPort
  readonly evaluations: EvaluationService
}

/** A design setup whose session imports from `SOURCES`; `workers` shared when given. */
export async function compareSetup(stock?: object, workers?: WorkerPort): Promise<CompareSetup> {
  const kernel = await testKernel()
  const session = {
    async importAsset(source: string) {
      const bytes = SOURCES[source]
      if (bytes === undefined) return fail('input.malformed', 'no such file')
      const sha256 = await hex(bytes)
      const path = assetPathOf(sha256, 'stl')
      FILES.set(`/work/${path}`, bytes)
      return Ok({ path, sha256, size: bytes.length } satisfies AssetRef)
    },
    assetFile: (path: string) => Ok(`/work/${path}`),
  } as unknown as ProjectSession
  const w =
    workers ??
    createInProcessWorkers({
      files: memoryFiles(FILES),
      solids: () => loadManifold(nodeManifoldSource()),
      region2d: () => Ok(region2d),
    })
  // the evaluations read `s` only once the setup has returned
  const evaluations = evaluationsOf(kernel, () => s)
  const s: DesignSetup = await designSetup({
    ...(stock === undefined ? {} : { stock }),
    services: {
      project: session,
      workers: w,
      region2d,
      evaluations,
    },
  })
  return Object.assign(s, { workers: w, evaluations })
}

/** The evaluated part of `s` as an STL (part frame, mm) and its bounding box minimum. */
export async function partStl(
  s: DesignSetup,
): Promise<{ bytes: Uint8Array; min: [number, number, number] }> {
  const kernel = await testKernel()
  const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
  const ev = expectOk(
    kernel.withSolids((solids) => evaluatePart(input, solids, undefined, region2d)),
  )
  const soup = soupOf(ev.positions, ev.indices)
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  for (let i = 0; i < soup.length; i++) min[i % 3] = Math.min(min[i % 3]!, soup[i]!)
  return { bytes: binaryStl(soup), min }
}

/** Imports `path` and places its min corner at `min` (part frame). */
export async function importAt(s: DesignSetup, path: string, min: readonly number[]) {
  const r = (await s.run('design.reference.import', {
    partId: s.partId,
    path,
    sourceUnit: 'mm',
  })) as { referenceId: string }
  await s.run('design.reference.update', {
    partId: s.partId,
    referenceId: r.referenceId,
    position: { x: String(min[0]), y: String(min[1]), z: String(min[2]) },
  })
  return r.referenceId
}

export interface Region {
  kind: 'missing' | 'extra'
  volume: number
  maxDev: number
  at: number[]
  bounds: number[][]
  surfaces: string[]
  operationIds: string[]
  cause?: string
}
export interface Compared {
  method: string
  threshold: number
  stats: {
    missingVolume: number
    extraVolume: number
    maxMissing: number
    maxExtra: number
    referenceVolume: number
    partVolume: number
  }
  regions: Region[]
  more?: number
  below: { count: number; volume: number }
  offcuts?: { count: number; volume: number }
  note?: string
  evaluation: string
}

/** `design.reference.compare { source: part }` and its job's result. */
export async function compare(s: DesignSetup, extra: object = {}): Promise<Compared> {
  const { jobId } = (await s.run('design.reference.compare', {
    partId: s.partId,
    source: { kind: 'part' },
    ...extra,
  })) as { jobId: string }
  return expectOk(await s.d.job(jobId).unwrap().result) as Compared
}

export const ENCLOSURE = '/models/enclosure.stl'
const HARDWOOD = {
  length: '260',
  width: '190',
  thickness: '60.523',
  material: { name: 'Oak', class: 'hardwood' },
}
interface Imported {
  shapeIds: string[]
  section: { shapes: { placeAt: { center: number[]; anchor: string } }[] }
}
const named = (r: Imported) => {
  const at = r.section.shapes[0]!.placeAt
  return {
    shape: { kind: 'named', shapeId: r.shapeIds[0], center: at.center.map(String) },
    anchor: at.anchor,
  }
}

/**
 * The enclosure approximated from its reference the way an agent would: shapes from its
 * sections, the cavity pocket, the two bottom steps and the outline profile (no tabs). The
 * notch, the rebate, the top edge round, the slot and the pilot holes are left out.
 */
export async function enclosureDesign(
  cavityDepth: string,
  workers?: WorkerPort,
): Promise<CompareSetup> {
  SOURCES[ENCLOSURE] ??= enclosureFullStl()
  const s = await compareSetup({ ...testStock(), ...HARDWOOD }, workers)
  const partId = s.partId
  await s.run('design.reference.import', { partId, path: ENCLOSURE, sourceUnit: 'mm' })
  const shape = (from: object) =>
    s.run('design.shape.import', { partId, from }) as Promise<Imported>
  const outline = await shape({ depth: '30', loops: 'outer' })
  const cavity = await shape({ depth: '30', loops: 'holes' })
  const step2 = await shape({ face: 'stock.bottom', depth: '3', loops: 'outer' })
  const step1 = await shape({ face: 'stock.bottom', depth: '1', loops: 'outer' })
  const tabs = { count: '0', width: '6', thickness: '2' }
  await s.run('design.pocket.add', { partId, ...named(cavity), depth: cavityDepth })
  for (const [step, depth] of [
    [step1, '1.77'],
    [step2, '4.19'],
  ] as const)
    await s.run('design.profile.add', {
      partId,
      on: 'stock.bottom',
      side: 'outside',
      ...named(step),
      depth,
      tabs,
    })
  await s.run('design.profile.add', { partId, side: 'outside', ...named(outline), tabs })
  return s
}
