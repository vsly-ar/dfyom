/**
 * Design commands against the command budget (hardening P5, docs/architecture/shapes.md#design-commands-p5):
 * a whole design update on realistic parts – the v0.4 exit lid (enclosure-lid.testing.ts, built as
 * the X1 flow builds it) and a part with a 100-instance Clones grid – and its phases (the part
 * load, `recalculateFeatures`, the Clones follow hook, resolve + checks). Outside `npm run check`
 * (timings are flaky in CI): `npm run perf`.
 */
import { createDraft, finishDraft } from 'immer'
import { describe, expect, it } from 'vitest'
import { createInProcessWorkers, memoryFiles } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { followClones } from './clones/commands'
import { designSetup, type DesignSetup } from './design.fixture'
import { ENCLOSURE_SECTIONS_SVG } from './enclosure-sections.testing'
import {
  BOLT_CIRCLE,
  CUTOUT,
  LID_PROFILE,
  LID_STOCK,
  LID_TOOLS,
  onBoard,
  SCREWS,
  VENTS,
} from './enclosure-lid.testing'
import { recalculateFeatures } from './feature-sync'
import { loadPart } from './load'
import { shapesOf } from './operation'
import { libraryTools, partWarnings } from './warnings'
import type { Vec2 } from '../geometry/model'
import type { Region2dPort } from '../geometry/2d/port'

const region2d = nodeRegion2d()
const SVG = '/drawings/enclosure-sections.svg'

/**
 * The lowest of three medians of `n` runs each, after 5 warm-ups: a burst of load from parallel
 * runs inflates one round's median, not all three, while a slower command raises every round.
 */
async function median(n: number, fn: () => unknown): Promise<number> {
  for (let i = 0; i < 5; i++) await fn()
  const rounds: number[] = []
  for (let k = 0; k < 3; k++) {
    const times: number[] = []
    for (let i = 0; i < n; i++) {
      const t = performance.now()
      await fn()
      times.push(performance.now() - t)
    }
    times.sort((a, b) => a - b)
    rounds.push(times[Math.floor(n / 2)]!)
  }
  return Math.min(...rounds)
}

const at = (p: Vec2): [string, string] => onBoard(p).map((c) => `${c}`) as [string, string]

/** The lid as the X1 flow designs it (exit-criteria.v04.fixture.ts), before the M3 → M4 edit. */
async function lid(): Promise<{ s: DesignSetup; cutout: string; bolt: string }> {
  const s = await designSetup({
    stock: {
      name: 'Birch plywood 6',
      shape: 'block',
      length: `${LID_STOCK.length}`,
      width: `${LID_STOCK.width}`,
      thickness: `${LID_STOCK.thickness}`,
      material: { name: 'Birch plywood', class: LID_STOCK.materialClass },
    },
    services: {
      region2d,
      workers: createInProcessWorkers({ files: memoryFiles(new Map([[SVG, svgBytes()]])) }),
    },
  })
  await addTools(s)
  const partId = s.partId
  const run = <T>(name: string, args: object) => s.run(name, { partId, ...args }) as Promise<T>
  await run('design.shape.import', { path: SVG })
  await run('design.shape.remove', { shapeId: 'shape2' })
  await run('design.profile.add', {
    shape: { kind: 'named', shapeId: 'shape1', center: ['127.5', '100'] },
    side: LID_PROFILE.side,
    slotWidth: `${LID_PROFILE.slotWidth}`,
    tabs: {
      count: `${LID_PROFILE.tabs.count}`,
      width: `${LID_PROFILE.tabs.width}`,
      thickness: `${LID_PROFILE.tabs.thickness}`,
    },
  })
  const screw = await run<{ featureId: string }>('design.hole.add', {
    center: at(SCREWS.source),
    type: SCREWS.type,
    fastener: SCREWS.fastener,
    fit: SCREWS.fit,
  })
  const grid = SCREWS.grid
  await run('design.clones.add', {
    source: { featureId: screw.featureId },
    rows: [
      {
        kind: 'grid',
        cols: grid.columns,
        rows: grid.rows,
        du: `${grid.spacing[0]}`,
        dv: `${grid.spacing[1]}`,
      },
    ],
  })
  const cutout = await run<{ operationId: string }>('design.profile.add', {
    shape: { kind: 'circle', center: at(CUTOUT.centre), diameter: `${CUTOUT.diameter}` },
    side: 'inside',
    slotWidth: `${CUTOUT.diameter / 2}`,
    tabs: { count: '0' },
  })
  await run('design.chamfer.add', {
    edgeOf: cutout.operationId,
    width: `${CUTOUT.chamferWidth}`,
  })
  const bolt = await run<{ featureId: string }>('design.hole.add', {
    center: at(BOLT_CIRCLE.source),
    type: BOLT_CIRCLE.type,
    fastener: BOLT_CIRCLE.fastener,
    fit: BOLT_CIRCLE.fit,
  })
  const a = BOLT_CIRCLE.arc
  await run('design.clones.add', {
    source: { featureId: bolt.featureId },
    rows: [
      {
        kind: 'arc',
        radius: `${a.radius}`,
        angle: `${a.angle}`,
        arc: `${a.sweep}`,
        step: `${a.step}`,
      },
    ],
  })
  const slot = await run<{ shapeId: string }>('design.shape.add', {
    name: 'Vent slot',
    items: [
      {
        kind: 'obround',
        center: ['0', '0'],
        length: `${VENTS.length}`,
        width: `${VENTS.width}`,
      },
    ],
  })
  const vent = await run<{ operationId: string }>('design.profile.add', {
    shape: { kind: 'named', shapeId: slot.shapeId, center: at(VENTS.source) },
    side: 'inside',
    slotWidth: `${LID_TOOLS.mill.diameter}`,
    tabs: { count: '0' },
  })
  await run('design.clones.add', {
    source: { operationIds: [vent.operationId] },
    rows: [
      {
        kind: 'offset',
        count: VENTS.offset.count,
        du: `${VENTS.offset.step[0]}`,
        dv: `${VENTS.offset.step[1]}`,
        skip: [3],
      },
    ],
  })
  // the tool choice on Apply, as the flow's auto-apply makes it
  await s.run('project.apply', {})
  return { s, cutout: cutout.operationId, bolt: bolt.featureId }
}

/** The lid's library tools (LID_TOOLS; exit-criteria.v04.fixture.ts adds them with presets). */
async function addTools(s: DesignSetup): Promise<void> {
  const common = {
    fluteLength: '12',
    overallLength: '50',
    fluteCount: '2',
    toolMaterial: 'carbide',
  }
  const { profile, mill, chamfer } = LID_TOOLS
  for (const t of [profile, mill])
    await s.run('library.tool.add', {
      values: { ...common, name: t.name, type: t.type, diameter: `${t.diameter}` },
    })
  await s.run('library.tool.add', {
    values: {
      ...common,
      name: chamfer.name,
      type: chamfer.type,
      diameter: `${chamfer.diameter}`,
      angle: `${chamfer.angle}`,
    },
  })
}

function svgBytes(): Uint8Array {
  interface NodeProcess {
    getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL): Uint8Array }
  }
  const fs = (globalThis as unknown as { process: NodeProcess }).process.getBuiltinModule('node:fs')
  return new Uint8Array(fs.readFileSync(ENCLOSURE_SECTIONS_SVG))
}

/**
 * A counterbored M4 hole, a Clones grid of 10 × 10 (the v0.4 limit, 100 instances, 200
 * operations) and a pocket after it, on a 400 × 400 × 20 block.
 */
async function clonesHeavy(): Promise<{ s: DesignSetup; pocket: string; hole: string }> {
  const s = await designSetup({
    stock: {
      name: 'Block',
      shape: 'block',
      length: '400',
      width: '400',
      thickness: '20',
      material: { name: '6061-T6', class: 'aluminum' },
    },
    services: { region2d },
  })
  await addTools(s)
  const partId = s.partId
  const run = <T>(name: string, args: object) => s.run(name, { partId, ...args }) as Promise<T>
  await run('design.facing.add', { depth: '0.5' })
  const hole = await run<{ featureId: string }>('design.hole.add', {
    center: ['20', '20'],
    type: 'counterbore',
    fastener: 'M4',
  })
  await run('design.clones.add', {
    source: { featureId: hole.featureId },
    rows: [{ kind: 'grid', cols: 10, rows: 10, du: '20', dv: '20' }],
  })
  const pocket = await run<{ operationId: string }>('design.pocket.add', {
    shape: { kind: 'rectangle', center: ['320', '320'], length: '40', width: '30' },
    depth: '3',
  })
  await s.run('project.apply', {})
  return { s, pocket: pocket.operationId, hole: hole.featureId }
}

/** Phases of a design update on the committed document (median ms). */
interface Phases {
  /** `loadPart` (every command loads the part it edits, the Clones follow hook once more). */
  readonly load: number
  /** `recalculateFeatures` over all features (after every operation update). */
  readonly recalc: number
  /** The Clones follow hook (after every document command) when nothing changed. */
  readonly follow: number
  /** Resolve + parameter checks: the part's warnings, as every command result carries them. */
  readonly checks: number
  /** The same checks on a fresh 2D port: shape and measure caches miss (a shape just edited). */
  readonly coldChecks: number
}

async function phases(s: DesignSetup): Promise<Phases> {
  const doc = s.d.doc
  const load = await median(30, () => loadPart(doc, s.partId, 'perf').unwrap())
  const l = loadPart(doc, s.partId, 'perf').unwrap()
  const recalc = await median(30, () =>
    recalculateFeatures(l.part.operations, l.features, l.stock, l.units, l.dto.shapes ?? []),
  )
  const follow = await median(30, () => {
    const draft = createDraft(doc)
    followClones(draft, { services: { region2d } } as never).unwrap()
    finishDraft(draft)
  })
  const tools = libraryTools(s.library)
  const warnings = (port: Region2dPort) =>
    shapesOf(l.part.operations, l.dto)
      .andThen((shapes) =>
        partWarnings(
          { ...l.part, ...(shapes.size === 0 ? {} : { shapes }) },
          l.stock,
          l.units,
          tools,
          l.snapshots,
          port,
          l.features,
          l.dto.shapes,
        ),
      )
      .unwrap()
  const checks = await median(30, () => warnings(region2d))
  const cold: number[] = []
  for (let i = 0; i < 11; i++) {
    const port = nodeRegion2d()
    const t = performance.now()
    warnings(port)
    cold.push(performance.now() - t)
  }
  cold.sort((a, b) => a - b)
  return { load, recalc, follow, checks, coldChecks: cold[5]! }
}

const ms = (v: number) => `${v.toFixed(2)} ms`
const report = (p: Phases) =>
  `load ${ms(p.load)}, recalculateFeatures ${ms(p.recalc)}, Clones follow ${ms(p.follow)}, ` +
  `resolve + checks ${ms(p.checks)} (caches missed: ${ms(p.coldChecks)})`

/**
 * Guards (docs/architecture/shapes.md#design-commands-p5) for a machine loaded by parallel runs
 * (medians swing ≈ 2× there): about twice the medians measured under load, so a return of the
 * per-command work P5 removed (2–10× these) still fails.
 */
const GUARD = {
  /** A whole design update through the dispatcher (shape.perf.ts guards its edit the same). */
  command: 10,
  /** Resolve + checks of an update: the command budget (shapes.md#performance). */
  checks: 3,
  /** The part load, the Clones follow hook and feature recalculation on unchanged records. */
  load: 1,
  follow: 1,
  recalc: 0.5,
} as const

function expectPhases(p: Phases): void {
  expect(p.checks).toBeLessThanOrEqual(GUARD.checks)
  expect(p.load).toBeLessThanOrEqual(GUARD.load)
  expect(p.follow).toBeLessThanOrEqual(GUARD.follow)
  expect(p.recalc).toBeLessThanOrEqual(GUARD.recalc)
}

describe('design commands within the command budget (P5)', () => {
  it('the v0.4 lid: an operation update and a hole feature update', async () => {
    const { s, cutout, bolt } = await lid()
    const ops = s.part().operations.length
    let d = 22
    const profileMs = await median(30, () =>
      s.run('design.profile.update', {
        partId: s.partId,
        operationId: cutout,
        shape: {
          kind: 'circle',
          center: at(CUTOUT.centre),
          diameter: `${(d = d === 22 ? 22.5 : 22)}`,
        },
      }),
    )
    let f = 'M3'
    const holeMs = await median(30, () =>
      s.run('design.hole.update', {
        partId: s.partId,
        featureId: bolt,
        fastener: (f = f === 'M3' ? 'M4' : 'M3'),
      }),
    )
    const p = await phases(s)
    console.log(
      `lid (${ops} operations, 5 features): design.profile.update ${ms(profileMs)}, ` +
        `design.hole.update of a Clones source ${ms(holeMs)}; ${report(p)}`,
    )
    expect(profileMs).toBeLessThanOrEqual(GUARD.command)
    expect(holeMs).toBeLessThanOrEqual(GUARD.command)
    expectPhases(p)
  })

  it('100 clone instances: an operation update and the source hole update', async () => {
    const { s, pocket, hole } = await clonesHeavy()
    const ops = s.part().operations.length
    let w = 30
    const pocketMs = await median(30, () =>
      s.run('design.pocket.update', {
        partId: s.partId,
        operationId: pocket,
        shape: {
          kind: 'rectangle',
          center: ['320', '320'],
          length: '40',
          width: `${(w = w === 30 ? 31 : 30)}`,
        },
      }),
    )
    let f = 'M4'
    const holeMs = await median(15, () =>
      s.run('design.hole.update', {
        partId: s.partId,
        featureId: hole,
        fastener: (f = f === 'M4' ? 'M3' : 'M4'),
      }),
    )
    const p = await phases(s)
    console.log(
      `100 clones (${ops} operations): design.pocket.update ${ms(pocketMs)}, ` +
        `design.hole.update of the source (100 instances follow) ${ms(holeMs)}; ${report(p)}`,
    )
    expect(pocketMs).toBeLessThanOrEqual(GUARD.command)
    // the source edit expands and rewrites the 200 owned operations again: no budget of its own
    expect(holeMs).toBeLessThanOrEqual(60)
    expectPhases(p)
  })
})
