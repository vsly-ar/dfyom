// Spike S4 (docs/research/s4-offset-clearing.md): offset clearing of S1's corpus, measured with the
// toolpath heightmap oracle. Writes spikes/clearing/results.md. Needs S1's WASM build:
// `cd spikes/2d && npm ci && npm run build:wasm`, then
// `npx vitest run -c spikes/clearing/vitest.config.mts --silent=false`.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { format } from 'prettier'
import { cavalierWasm, type Candidate } from '../2d/candidates.ts'
import { netArea } from '../2d/geom.ts'
import type { ToolpathTool } from '../../src/core/toolpath/model.ts'
import { pockets, type Pocket } from './corpus.ts'
import { coverage, segCountOf, type Coverage } from './coverage.ts'
import { clearing, type Counts, type CutParams, type Order } from './traverse.ts'
import { buildTree, treeStats, type StepCap } from './tree.ts'

const D = 6
const R = D / 2
const tool: ToolpathTool = {
  id: 'D6',
  type: 'flatEndMill',
  diameter: D,
  cornerRadius: 0,
  fluteLength: 20,
}
const params: CutParams = {
  toolRadius: R,
  z: -2,
  top: 0,
  retractZ: 2,
  feed: 1000,
  plungeFeed: 300,
  helixDiameter: 0.8 * D,
  rampAngle: 3,
}

interface Variant {
  readonly id: string
  readonly stepover: number
  readonly cap: StepCap
  readonly gapFill: boolean
  readonly order: Order
}

/** 0.4 D is the default stepover, 0.9 D the largest the strategy allows (plan-v0.1.md). */
const variants: Variant[] = [
  { id: '0.4D rings', stepover: 0.4 * D, cap: 'none', gapFill: false, order: 'rings' },
  { id: '0.4D linked', stepover: 0.4 * D, cap: 'none', gapFill: false, order: 'linked' },
  { id: '0.9D no cap', stepover: 0.9 * D, cap: 'none', gapFill: false, order: 'linked' },
  { id: '0.9D √2·R cap', stepover: 0.9 * D, cap: 'sqrt2', gapFill: false, order: 'linked' },
  { id: '0.9D corner cap', stepover: 0.9 * D, cap: 'corner', gapFill: false, order: 'linked' },
  { id: '0.9D R cap', stepover: 0.9 * D, cap: 'R', gapFill: false, order: 'linked' },
  { id: '0.9D + gap rings', stepover: 0.9 * D, cap: 'none', gapFill: true, order: 'linked' },
  { id: '0.9D √2·R + gap rings', stepover: 0.9 * D, cap: 'sqrt2', gapFill: true, order: 'linked' },
]
const complete = (v: Variant) => v.stepover <= R || v.cap === 'R' || v.gapFill

interface Row {
  pocket: string
  variant: Variant
  tree: ReturnType<typeof treeStats>
  counts: Counts
  cov: Coverage
  computeMs: number
  cutLength: number
  machineS: number
  restExpected: number
}

const rows: Row[] = []
let cc: Candidate
let corpus: Pocket[]

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

function run(p: Pocket, v: Variant) {
  const opts = { toolRadius: R, stepover: v.stepover, cap: v.cap, gapFill: v.gapFill }
  const roots = buildTree(cc, p.region, opts)
  return { roots, ...clearing(cc, roots, params, v.order) }
}

beforeAll(async () => {
  const wasm = join(import.meta.dirname, '..', '2d', 'cc-wasm', 'cc_wasm.wasm')
  if (!existsSync(wasm))
    throw new Error(
      'spikes/2d/cc-wasm/cc_wasm.wasm missing: cd spikes/2d && npm ci && npm run build:wasm',
    )
  cc = await cavalierWasm(readFileSync(wasm))
  corpus = pockets(cc)
})

describe('S4 offset clearing', () => {
  it('clears every pocket of the corpus', async () => {
    for (const p of corpus) {
      const c0 = cc.offset(p.region, R)
      const opening = cc.offset(c0, -R)
      const restExpected = netArea(p.region) - netArea(opening)
      for (const v of variants) {
        const times: number[] = []
        let res = run(p, v)
        for (let k = 0; k < 5; k++) {
          const t0 = performance.now()
          res = run(p, v)
          times.push(performance.now() - t0)
        }
        const cov = coverage(p.region, c0, res.toolpath, tool, p.size, params.z)
        rows.push({
          pocket: p.name,
          variant: v,
          tree: treeStats(res.roots),
          counts: res.counts,
          cov,
          computeMs: median(times),
          cutLength: res.toolpath.stats.cutLength,
          machineS: res.toolpath.stats.estimatedSeconds,
          restExpected,
        })
        expect(cov.gouge, `${p.name} / ${v.id}: gouge`).toBe(0)
      }
    }
    await writeResults()
  })

  it('leaves no material above tolerance with step ≤ R or with gap rings', () => {
    for (const r of rows)
      if (complete(r.variant)) expect(r.cov.leftover, `${r.pocket} / ${r.variant.id}`).toBe(0)
  })

  it('cuts exactly the expected rest material (region − opening) where nothing is left over', () => {
    for (const r of rows)
      if (complete(r.variant))
        expect(Math.abs(r.cov.rest - r.restExpected), `${r.pocket} / ${r.variant.id}`).toBeLessThan(
          0.01 * r.restExpected + 1,
        )
  })

  it('retracts at least once per extra leaf when linked, far less than ring by ring', () => {
    for (const r of rows) {
      if (r.variant.order !== 'linked') continue
      expect(r.counts.retracts, `${r.pocket} / ${r.variant.id}`).toBeGreaterThanOrEqual(
        r.tree.leaves - 1,
      )
    }
    for (const p of corpus) {
      const ringwise = rows.find((r) => r.pocket === p.name && r.variant.id === '0.4D rings')!
      const linked = rows.find((r) => r.pocket === p.name && r.variant.id === '0.4D linked')!
      expect(ringwise.counts.retracts).toBe(ringwise.tree.rings - 1)
      expect(linked.counts.retracts).toBeLessThanOrEqual(ringwise.counts.retracts)
    }
  })
})

const f1 = (n: number) => n.toFixed(1)
const f2 = (n: number) => n.toFixed(2)

async function writeResults(): Promise<void> {
  const out: string[] = [
    '# Spike S4 results: offset clearing of regions',
    '',
    `Generated by \`npx vitest run -c spikes/clearing/vitest.config.mts\` (${new Date().toISOString().slice(0, 10)}, Node ${process.version}). ` +
      `Report: [docs/research/s4-offset-clearing.md](../../docs/research/s4-offset-clearing.md).`,
    '',
    `Tool: flat end mill D ${D}; one level at Z ${params.z}; feed ${params.feed}, plunge ${params.plungeFeed}, rapids ${'5000/5000/2000'} mm/min; ` +
      'helix Ø 0.8 D, ramp/helix angle 3°; no finishing allowance. Heightmap cell 0.1 mm, tolerance 0.01 mm. ' +
      'Compute = ring tree + traversal, median of 5 (WASM CavalierContours); heightmap time is the oracle, not the generator.',
    '',
    '## Corpus',
    '',
    '| Pocket | Segments | Area (mm²) | Rest expected (mm², region − opening) |',
    '| --- | --- | --- | --- |',
  ]
  for (const p of corpus) {
    const r = rows.find((x) => x.pocket === p.name)!
    out.push(
      `| ${p.name} | ${segCountOf(p.region)} | ${f1(netArea(p.region))} | ${f1(r.restExpected)} |`,
    )
  }
  out.push(
    '',
    '## Runs',
    '',
    '| Pocket | Variant | Nodes / leaves / rings / gap rings | Retracts | Feed links | Entries h/r/p | Leftover mm² (largest cells) | Rest mm² | Gouge | Cut mm | Est. s | Compute ms | Oracle ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  )
  for (const r of rows) {
    const t = r.tree
    const c = r.counts
    const left = r.cov.leftover > 0 ? `**${f2(r.cov.leftover)}** (${r.cov.leftoverCells})` : '0'
    out.push(
      `| ${r.pocket} | ${r.variant.id} | ${t.nodes} / ${t.leaves} / ${t.rings} / ${t.gaps} | ${c.retracts} | ${c.feedLinks} | ${c.helix}/${c.ramp}/${c.plunge} | ${left} | ${f1(r.cov.rest)} | ${f2(r.cov.gouge)} | ${r.cutLength.toFixed(0)} | ${r.machineS.toFixed(0)} | ${f2(r.computeMs)} | ${r.cov.ms.toFixed(0)} |`,
    )
  }
  const md = await format(out.join('\n') + '\n', { parser: 'markdown' })
  writeFileSync(join(import.meta.dirname, 'results.md'), md)
  console.log(md)
}
