// Toolpaths of general shapes through the plan (v0.3 T1/T2 wiring): a named-shape pocket and an
// `on` profile with tab positions generate, export as G-code with arcs ≤ 180°, list their plan
// findings (`plan.restMaterial`, `plan.stepoverClamped`), go stale on a shape-only edit and abort;
// the X0 enclosure drawing (importSvg) end to end through plan export.
// Doc: docs/modes/plan-v0.3.md#wiring-t1-t2
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { ENCLOSURE_SECTIONS_SVG } from '../design/enclosure-sections.testing'
import type { Loop } from '../geometry/2d/model'
import { CORNER_MIN_TURN } from '../geometry/shape-measure'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { importSvg } from '../import/svg'
import { exportPlan } from '../post/plan-export'
import { streamProgram } from '../run/grbl/sender.fixture'
import { createToolpathCache } from '../toolpath/cache'
import { toGeneratorInputs } from '../toolpath/inputs'
import type { Toolpath } from '../toolpath/model'
import { generateRequest } from '../toolpath/request'
import { signalSteps } from '../workers/steps'
import type { PlanWarning } from './checks'
import { planOperationInputs } from './inputs'
import { loadPlan } from './plan'
import { planSetup, stale, type PlanSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()
const services = () => ({
  region2d,
  toolpaths: createToolpathCache(),
  workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
})

/** Two 16 mm squares joined by a 4 mm neck (narrower than the 6 mm tool), sharp corners. */
const dumbbell = [
  { kind: 'rectangle', center: ['-15', '0'], length: '16', width: '16', cornerRadius: '0' },
  { kind: 'rectangle', center: ['15', '0'], length: '16', width: '16', cornerRadius: '0' },
  { kind: 'rectangle', center: ['0', '0'], length: '20', width: '4', cornerRadius: '0' },
]

/** A named-shape pocket (pocket1) inside an `on` profile with tab positions (profile1). */
async function shapePlan() {
  const svc = services()
  const s = await planSetup({ part: false, services: svc })
  const partId = s.partId
  await s.run('design.shape.add', { partId, items: dumbbell })
  await s.run('design.shape.add', {
    partId,
    items: [
      { kind: 'rectangle', center: ['0', '0'], length: '60', width: '30', cornerRadius: '5' },
    ],
  })
  await s.run('design.pocket.add', {
    partId,
    shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] },
    depth: '3',
  })
  await s.run('design.profile.add', {
    partId,
    shape: { kind: 'named', shapeId: 'shape2', center: ['50', '30'] },
    side: 'on',
    slotWidth: '6',
    tabs: { width: '6', thickness: '3', positions: ['20', '100'] },
  })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const ops = s.plan(planId).setups[0]!.operations
  const planOp = (designId: string) => ops.find((o) => o.designOperationIds[0] === designId)!.id
  return { s, svc, planId, pocket: planOp('pocket1'), profile: planOp('profile1') }
}

const generate = async (s: PlanSetup, planId: string) => {
  const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
    .value as { jobId: string }
  return expectOk(await s.d.job(jobId).unwrap().result) as {
    operations: { planOperationId: string; status: string; error?: unknown }[]
  }
}

const toolpathOf = (s: PlanSetup, planId: string, planOperationId: string) =>
  s.query('plan.toolpath.get', { planId, planOperationId }) as {
    toolpath: Toolpath | null
    stale: boolean
  }

const warnings = (s: PlanSetup, planId: string) =>
  (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings

/** Every G2/G3 of a GRBL program with its sweep (degrees), from the modal state before it. */
function arcSweeps(lines: readonly string[]): { cw: boolean; sweep: number }[] {
  const at = { X: 0, Y: 0, Z: 0 }
  let motion = 0
  const out: { cw: boolean; sweep: number }[] = []
  for (const raw of lines) {
    const line = raw.replace(/\(.*?\)/g, '').trim()
    if (line.length === 0) continue
    const words = new Map<string, number>()
    for (const m of line.matchAll(/([A-Z])(-?[\d.]+)/g)) {
      if (m[1] === 'G') {
        const g = Number(m[2])
        if (g >= 0 && g <= 3) motion = g
      } else words.set(m[1]!, Number(m[2]))
    }
    const to = {
      X: words.get('X') ?? at.X,
      Y: words.get('Y') ?? at.Y,
      Z: words.get('Z') ?? at.Z,
    }
    const moved = words.has('X') || words.has('Y') || words.has('Z')
    if (moved && (motion === 2 || motion === 3)) {
      const cx = at.X + (words.get('I') ?? 0)
      const cy = at.Y + (words.get('J') ?? 0)
      const a0 = Math.atan2(at.Y - cy, at.X - cx)
      const a1 = Math.atan2(to.Y - cy, to.X - cx)
      let d = motion === 3 ? a1 - a0 : a0 - a1
      while (d <= 1e-9) d += 2 * Math.PI
      out.push({ cw: motion === 2, sweep: (d * 180) / Math.PI })
    }
    if (moved) Object.assign(at, to)
  }
  return out
}

describe('toolpaths of general shapes (T1/T2 wiring)', () => {
  it('generates a named-shape pocket and an on profile with tabs; exports G2/G3 ≤ 180°', async () => {
    const { s, svc, planId, pocket, profile } = await shapePlan()
    const r = await generate(s, planId)
    expect(r.operations).toEqual([
      { planOperationId: pocket, status: 'generated' },
      { planOperationId: profile, status: 'generated' },
    ])
    const inputs = expectOk(planOperationInputs(s.d.doc, planId, undefined, region2d))
    expect(inputs.map((i) => expectOk(toGeneratorInputs(i, region2d)).kind)).toEqual([
      'regionPocket',
      'regionProfile',
    ])
    const prof = expectOk(toGeneratorInputs(inputs[1]!, region2d))
    if (prof.kind !== 'regionProfile') throw new Error('regionProfile expected')
    expect(prof.inputs[0]!.operation).toMatchObject({
      closed: true,
      side: 'on',
      through: true,
      onZ: 0,
      depth: 20,
      tabs: { positions: [20, 100], width: 6, thickness: 3 },
    })
    expect(prof.inputs[0]!.strategy.leadRadius).toBe(3)
    for (const id of [pocket, profile]) {
      const got = toolpathOf(s, planId, id)
      expect(got.stale).toBe(false)
      const tp = got.toolpath!
      expect(tp.passes.length).toBeGreaterThan(0)
      // the profile is cut through, the pocket 3 mm deep (0.2 mm finishing allowance on walls)
      const zs = tp.passes.flatMap((p) =>
        p.moves.flatMap((m) => (m.kind === 'drill' ? [] : [m.to[2]])),
      )
      expect(Math.min(...zs)).toBeCloseTo(id === pocket ? -3 : -20.5, 6)
    }
    const e = expectOk(await exportPlan(s.d.doc, planId, svc))
    expect(e.regenerated).toEqual([])
    const sweeps = arcSweeps(e.lines)
    expect(sweeps.some((a) => a.cw)).toBe(true)
    expect(sweeps.some((a) => !a.cw)).toBe(true)
    for (const a of sweeps) expect(a.sweep).toBeLessThanOrEqual(180 + 1e-6)
  })

  it('lists plan.restMaterial and the clamped-stepover notes; they never block', async () => {
    const { s, planId, pocket, profile } = await shapePlan()
    const at = (w: PlanWarning[], code: string) => w.filter((x) => x.code === code)
    const before = warnings(s, planId)
    // the default stepover (preset) is below R: no note; the 4 mm neck is narrower than the tool
    expect(at(before, 'plan.stepoverClamped')).toEqual([])
    const rest = at(before, 'plan.restMaterial')
    expect(rest.length).toBeGreaterThan(0)
    for (const w of rest) {
      expect(w).toMatchObject({ severity: 'warning', planOperationId: pocket, field: 'tool' })
      expect(w.params['operation']).toBe('pocket1')
      expect(Number(w.params['area'])).toBeGreaterThan(0)
      // in the neck (the face frame: x 40–60, y 28–32)
      expect(Math.abs(Number(w.params['u']) - 50)).toBeLessThan(10)
      expect(Math.abs(Number(w.params['v']) - 30)).toBeLessThan(2.5)
    }
    for (const planOperationId of [pocket, profile])
      await s.run('plan.operation.update', {
        planId,
        planOperationId,
        overrides: { stepover: '4.5' },
      })
    const notes = at(warnings(s, planId), 'plan.stepoverClamped')
    expect(notes.map((n) => [n.planOperationId, n.severity, n.field, n.params])).toEqual([
      [pocket, 'info', 'stepover', { operation: 'pocket1', stepover: 4.5, effective: 3 }],
      [profile, 'info', 'stepover', { operation: 'profile1', stepover: 4.5, effective: 3 }],
    ])
    expect(notes[0]!.message).toContain('3 mm (half the tool)')
    // notes and warnings do not block generation
    const r = await generate(s, planId)
    expect(r.operations.map((o) => o.status)).toEqual(['generated', 'generated'])
  })

  it('a shape-only edit makes the toolpath stale and marks the operation changed', async () => {
    const { s, planId, profile } = await shapePlan()
    await generate(s, planId)
    expect(toolpathOf(s, planId, profile).stale).toBe(false)
    // a draft follows the design on Apply: the toolpath input changes
    await s.run('design.shape.item.update', {
      partId: s.partId,
      shapeId: 'shape2',
      index: 0,
      length: '64',
    })
    await s.run('project.apply', {})
    expect(toolpathOf(s, planId, profile).stale).toBe(true)
    // a settled plan keeps its snapshot and shows the operation as changed in the design
    await generate(s, planId)
    await s.toStatus(planId, 'settledDesign')
    await s.run('design.shape.item.update', {
      partId: s.partId,
      shapeId: 'shape2',
      index: 0,
      length: '62',
    })
    await s.run('project.apply', {})
    const st = stale(s, planId)
    expect(st.partChanged).toEqual(['shapes'])
    expect(st.operations).toEqual([
      {
        operationId: 'profile1',
        changedInDesign: true,
        removedFromDesign: false,
        editedInPlan: false,
        designToolChanged: false,
      },
    ])
  })

  it('region generators abort at a step', async () => {
    const { s, planId } = await shapePlan()
    const inputs = expectOk(planOperationInputs(s.d.doc, planId, undefined, region2d))
    for (const input of inputs) {
      const request = expectOk(toGeneratorInputs(input, region2d))
      const ctl = new AbortController()
      let n = 0
      const steps = signalSteps(ctl.signal, () => {
        if (++n === 2) ctl.abort()
      })
      expectErrCode(
        generateRequest(request, steps, () => Ok(region2d)),
        'op.aborted',
      )
      // without a 2D port in the worker the region generators cannot run
      expectErrCode(generateRequest(request), 'internal.unexpected')
    }
  })
})

/** A loop of K1 elements as a closed `path` item of `design.shape.add` (mm strings). */
function pathItem(loop: Loop) {
  const p = (v: readonly [number, number]) => [String(v[0]), String(v[1])]
  const els = loop.elements
  return {
    kind: 'path',
    start: p(els[0]!.a),
    closed: true,
    segments: els.map((e) => {
      if (e.kind === 'line') return { kind: 'line', to: p(e.b) }
      const r = Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1])
      const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
      const a1 = Math.atan2(e.b[1] - e.centre[1], e.b[0] - e.centre[0])
      let sweep = e.ccw ? a1 - a0 : a0 - a1
      while (sweep < 0) sweep += 2 * Math.PI
      return {
        kind: 'arc',
        to: p(e.b),
        radius: String(r),
        cw: !e.ccw,
        ...(sweep > Math.PI ? { large: true } : {}),
      }
    }),
  }
}

/**
 * Sharp inside corners of a pocket outline (as `insideCorners` of shape-measure counts them):
 * vertices (0 = start, i = end of element i − 1) where the loop turns by more than
 * `CORNER_MIN_TURN` towards its interior, so the tool leaves its radius there.
 */
function sharpInsideCorners(loop: Loop): number[] {
  const els = loop.elements
  const dir = (e: Loop['elements'][number], end: boolean): [number, number] => {
    if (e.kind === 'line') return [e.b[0] - e.a[0], e.b[1] - e.a[1]]
    const p = end ? e.b : e.a
    const rx = p[0] - e.centre[0]
    const ry = p[1] - e.centre[1]
    return e.ccw ? [-ry, rx] : [ry, -rx]
  }
  // counter-clockwise loops (by the vertex polygon) turn left at the corners the tool cannot reach
  let area = 0
  for (const e of els) area += e.a[0] * e.b[1] - e.b[0] * e.a[1]
  const out: number[] = []
  els.forEach((e, i) => {
    const a = dir(els[(i - 1 + els.length) % els.length]!, true)
    const b = dir(e, false)
    const cos = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b))
    const turn = Math.sign(a[0] * b[1] - a[1] * b[0])
    if (cos < Math.cos(CORNER_MIN_TURN) && turn === Math.sign(area)) out.push(i)
  })
  return out
}

/**
 * The X0 drawing as a part: outline (shape1) and cavity (shape2) imported, the cavity pocketed
 * 4 mm and the outline profiled through with tabs; `fillet` rounds the cavity's sharp corners
 * first through the Shape Editor's item command (D32), each by the largest of `FILLET_RADII` its
 * neighbouring segments take (rule `filletTooLarge` otherwise).
 */
const FILLET_RADII = ['2', '1', '0.5', '0.25', '0.1']

async function enclosurePlan(fillet = false) {
  const svc = services()
  const s = await planSetup({
    part: false,
    services: svc,
    stock: {
      name: 'Enclosure block',
      shape: 'block',
      length: '280',
      width: '210',
      thickness: '10',
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  const proc = (
    globalThis as unknown as {
      process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, e: 'utf8'): string } }
    }
  ).process
  const svg = proc.getBuiltinModule('node:fs').readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8')
  const shapes = expectOk(importSvg(svg)).shapes
  const loops: Record<string, Loop> = {}
  for (const name of ['outline', 'cavity']) {
    const item = shapes.find((x) => x.name === name)!.items[0]!
    if (item.kind !== 'loop') throw new Error('loop expected')
    loops[name] = item.loop
    await s.run('design.shape.add', { partId: s.partId, name, items: [pathItem(item.loop)] })
  }
  const sharp = sharpInsideCorners(loops['cavity']!)
  const radii: string[] = []
  if (fillet)
    for (const vertex of sharp) {
      const fillets = radii.map((radius, k) => ({ vertex: sharp[k]!, radius }))
      for (const radius of FILLET_RADII) {
        const r = await s.d.dispatch(
          'design.shape.item.update',
          {
            partId: s.partId,
            shapeId: 'shape2',
            index: 0,
            fillets: [...fillets, { vertex, radius }],
          },
          ui,
        )
        if (r.isOk()) {
          radii.push(radius)
          break
        }
        expect(r.unwrapErr().issues?.map((i) => i.rule)).toEqual(['filletTooLarge'])
      }
    }
  const center = ['140', '105']
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: { kind: 'named', shapeId: 'shape2', center },
    depth: '4',
  })
  await s.run('design.profile.add', {
    partId: s.partId,
    shape: { kind: 'named', shapeId: 'shape1', center },
    slotWidth: '8',
    tabs: { count: '3', width: '8', thickness: '2' },
  })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  return { s, svc, planId, sharp, radii }
}

describe('the X0 enclosure drawing through plan export', () => {
  it(
    'imports outline and cavity, pockets the cavity, profiles the outline with tabs, exports',
    { timeout: 120_000 },
    async () => {
      const { s, svc, planId } = await enclosurePlan()
      const e = expectOk(await exportPlan(s.d.doc, planId, svc))
      expect(e.regenerated).toHaveLength(2)
      const sweeps = arcSweeps(e.lines)
      expect(sweeps.length).toBeGreaterThan(10)
      for (const a of sweeps) expect(a.sweep).toBeLessThanOrEqual(180 + 1e-6)
      // the pocket reaches 4 mm, the profile through the 10 mm block (0.5 mm breakthrough)
      const zs = e.lines.flatMap((l) => {
        const m = /Z(-?[\d.]+)/.exec(l)
        return m === null ? [] : [Number(m[1])]
      })
      expect(Math.min(...zs)).toBeCloseTo(-10.5, 6)
      expect(zs).toContain(-4)
    },
  )

  it(
    'with the cavity corners filleted (D32): no sharp corner left; the program streams through the virtual machine',
    { timeout: 120_000 },
    async () => {
      // the two sharp corners where the back wall meets its 2 mm step; one sits next to a
      // 0.33 mm arc of the fitted wall, so it takes only a small fillet
      const { s, svc, planId, sharp, radii } = await enclosurePlan(true)
      expect(sharp).toHaveLength(2)
      expect(radii).toHaveLength(2)
      // the 6 mm tool still leaves its radius in the corners (a warning), but none is sharp
      const smallest = Math.min(...radii.map(Number))
      for (const w of warnings(s, planId).filter((x) => x.rule === 'cornerRadius'))
        expect(w.params['cornerRadius']).toBeCloseTo(smallest, 6)
      const e = expectOk(await exportPlan(s.d.doc, planId, svc))
      expect(e.regenerated).toHaveLength(2)
      const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
      const run = await streamProgram(e.lines, machine)
      expect(run.lines).toBe(e.lines.length)
      // cutting time at the program's feeds (aluminium, 6 mm tool): minutes, not seconds
      expect(run.seconds).toBeGreaterThan(600)
    },
  )
})
