// Test-only: the safe-links property cases (hardening DF64): a setup exported with `full` and
// `minimum`, both replayed on the virtual machine, properties 1–7 of
// docs/modes/safe-links.md#verification-on-the-virtual-machine checked; random setups by seed and
// the mutation test. Used by links.test.ts and links-seeded-*.test.ts. Not app code.
import { expect } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import type { Machine } from '../library/machine'
import { generateDrilling } from '../toolpath/drilling'
import { generateFacing } from '../toolpath/facing'
import {
  planLinks,
  type LinkOperation,
  type LinkSettings,
  type SetupLinks,
} from '../toolpath/links'
import type { Move, Toolpath, ToolpathTool, Vec3 } from '../toolpath/model'
import { generatePocket } from '../toolpath/pocket'
import { generateProfile } from '../toolpath/profile'
import {
  bullNose,
  drill,
  drillingInput,
  endMill,
  facingInput,
  pocketInput,
  profileInput,
} from '../toolpath/testing/fixtures'
import { random } from '../toolpath/testing/region-fixtures'
import { exportGrbl, type GrblExport } from './export'
import { moveKey, replayRapids, type HolderReplay, type Replay } from './links-replay.fixture'
import { exportInput, operation, OPTS, testMachine } from './post.fixture'

export interface SetupCase {
  readonly ops: readonly {
    readonly tp: Toolpath
    readonly tool: ToolpathTool
    /** DF132 H4: the stickout the holder floor uses. */
    readonly stickout?: number
  }[]
  readonly settings: LinkSettings
  readonly what: string
  /** DF132 H4: the replay's independent holder check. */
  readonly holder?: HolderReplay
}

const MACHINE = testMachine()

function linkOps(c: SetupCase): LinkOperation[] {
  return c.ops.map((o, i) => ({
    toolpath: o.tp,
    tool: o.tool,
    ...(o.stickout === undefined ? {} : { stickout: o.stickout }),
    pauseBefore: i === 0 || c.ops[i - 1]!.tool.id !== o.tool.id,
  }))
}

/** The tools by program number (first use). */
function toolNumbers(c: SetupCase): ToolpathTool[] {
  const out: ToolpathTool[] = []
  for (const o of c.ops) if (!out.some((t) => t.id === o.tool.id)) out.push(o.tool)
  return out
}

function exported(c: SetupCase, toolpaths: readonly Toolpath[], machine: Machine): GrblExport {
  return expectOk(
    exportGrbl(
      exportInput(
        toolpaths.map((tp, i) => operation(tp, c.ops[i]!.tool)),
        machine,
        { setup: { name: 'Setup 1', clearanceHeight: c.settings.clearance } },
      ),
      OPTS,
    ),
  )
}

async function replay(c: SetupCase, e: GrblExport, fullRapids?: ReadonlySet<string>) {
  return replayRapids(e, MACHINE, {
    tools: toolNumbers(c),
    stock: c.settings.stock,
    clearance: c.settings.clearance,
    margin: c.settings.margin,
    ...(c.settings.clampHeight === undefined ? {} : { clampHeight: c.settings.clampHeight }),
    ...(fullRapids === undefined ? {} : { fullRapids }),
    ...(c.holder === undefined ? {} : { holder: c.holder }),
  })
}

export interface Checked {
  readonly links: SetupLinks
  readonly min: Replay
  readonly full: Replay
  readonly eMin: GrblExport
  readonly eFull: GrblExport
}

/** Exports `c` with `full` and `minimum`, replays both and checks properties 1–6. */
export async function checkCase(c: SetupCase): Promise<Checked> {
  const what = c.what
  const ops = linkOps(c)
  const links = planLinks(ops, c.settings)
  expect(links.collisions, what).toEqual([])
  const eFull = exported(
    c,
    ops.map((o) => o.toolpath),
    MACHINE,
  )
  const eMin = exported(c, links.toolpaths, MACHINE)
  const full = await replay(c, eFull)
  expect(full.failures, what).toEqual([])
  const fullRapids = new Set(full.moves.filter((m) => m.rapid).map(moveKey))
  const min = await replay(c, eMin, fullRapids)
  if (min.failures.length > 0 && process.env['LINK_DEBUG'] !== undefined)
    console.log(JSON.stringify(c.settings), JSON.stringify(links.links), min.failures)
  expect(min.failures, what).toEqual([])
  // 1. levels within [entry Z, clearance]; every rapid vertical or horizontal
  for (const l of links.links) {
    expect(l.level, what).toBeGreaterThanOrEqual(l.entry[2] - 1e-9)
    expect(l.level, what).toBeLessThanOrEqual(c.settings.clearance + 1e-9)
  }
  for (const m of min.links) {
    const vertical = Math.abs(m.from[0] - m.to[0]) < 1e-6 && Math.abs(m.from[1] - m.to[1]) < 1e-6
    const horizontal = Math.abs(m.from[2] - m.to[2]) < 1e-6
    expect(vertical || horizontal, `${what}: ${m.line}`).toBe(true)
  }
  // a lowered link shows up as a rapid below the clearance height the full program lacks
  expect(min.links.length > 0, what).toBe(links.summary.low > 0)
  // 2. tool changes, start and end as with full: the moves before each tool change, the header
  // and the footer are the same lines
  const before = (lines: readonly string[]) =>
    lines.flatMap((l, k) => (l.startsWith('(Tool change to') ? [lines[k - 1]] : []))
  expect(before(eMin.lines), what).toEqual(before(eFull.lines))
  const head = (lines: readonly string[]) =>
    lines.slice(
      0,
      lines.findIndex((l) => l.startsWith('X')),
    )
  expect(head(eMin.lines), what).toEqual(head(eFull.lines))
  expect(eMin.lines.slice(-3), what).toEqual(eFull.lines.slice(-3))
  // 4. the cut is unchanged: the same feed moves, the same stock cell by cell
  const feeds = (r: Replay) => r.moves.filter((m) => !m.rapid).map((m) => `${m.from} ${m.to}`)
  expect(feeds(min), what).toEqual(feeds(full))
  expect(min.heightmap.z, what).toEqual(full.heightmap.z)
  // 5. never slower: link by link and on the virtual machine
  for (const l of links.links) expect(l.seconds, what).toBeLessThanOrEqual(l.fullSeconds + 1e-9)
  expect(min.seconds, what).toBeLessThanOrEqual(full.seconds + 1e-6)
  expect(eMin.stats.estimatedSeconds, what).toBeLessThanOrEqual(eFull.stats.estimatedSeconds + 1e-9)
  // 6. deterministic
  expect(exported(c, planLinks(ops, c.settings).toolpaths, MACHINE).text, what).toBe(eMin.text)
  return { links, min, full, eMin, eFull }
}

// ── Random setups ─────────────────────────────────────────────────────────────────────────

export const TOOLS = {
  d6: endMill(6),
  d4: endMill(4),
  bn: bullNose(6, 1),
  dr: drill(5),
  d10: endMill(10),
}

/**
 * A random setup: an optional facing, then pockets (circles and rectangles), drillings and
 * through or blind profiles at random places with random tools, sizes and safe heights, in a
 * random order (often grouped by tool, so tool runs have several operations), with no clamp
 * height, 0, or a random one.
 */
export function randomSetup(seed: number): SetupCase {
  const rnd = random(seed)
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!
  const stock = {
    length: 100 + Math.round(rnd() * 60),
    width: 70 + Math.round(rnd() * 30),
    thickness: 8 + Math.round(rnd() * 8),
  }
  const retract = 1 + Math.round(rnd() * 4) / 2
  const clearance = retract + 4 + Math.round(rnd() * 10)
  const heights = { clearanceHeight: clearance, retractHeight: retract }
  const ops: { tp: Toolpath; tool: ToolpathTool }[] = []
  const at = (margin: number): [number, number] => [
    margin + rnd() * (stock.length - 2 * margin),
    margin + rnd() * (stock.width - 2 * margin),
  ]
  const facingTool = pick([TOOLS.d6, TOOLS.d10])
  const faced = rnd() < 0.5
  if (faced)
    ops.push({
      tool: facingTool,
      tp: generateFacing(
        facingInput(stock, facingTool, {
          heights,
          operation: { kind: 'facing', id: 'facing', depth: 0.5 + Math.round(rnd() * 2) / 2 },
        }),
      ).unwrap(),
    })
  const n = 3 + Math.floor(rnd() * 5)
  for (let k = 0; k < n; k++) {
    const kind = pick(['circle', 'rect', 'drill', 'profile'] as const)
    const id = `${kind}${k}`
    if (kind === 'drill') {
      const tool = TOOLS.dr
      const r = generateDrilling({
        ...drillingInput(
          stock,
          {
            kind: 'drilling',
            id,
            onZ: 0,
            center: at(5),
            diameter: 5,
            bottom:
              rnd() < 0.5
                ? { kind: 'through' }
                : { kind: 'drillPoint', depth: 2 + rnd() * 5, pointAngle: 118 },
          },
          tool,
          rnd() < 0.5
            ? { cycle: 'simple', breakthrough: 0.5 }
            : { cycle: 'peck', peckDepth: 2, breakthrough: 0.5 },
        ),
        heights,
      })
      if (r.isOk()) ops.push({ tool, tp: r.unwrap() })
      continue
    }
    const tool = pick([TOOLS.d6, TOOLS.d4, TOOLS.bn])
    if (kind === 'profile') {
      const length = 15 + rnd() * 30
      const width = 10 + rnd() * 20
      const r = generateProfile(
        profileInput(
          stock,
          {
            kind: 'profile',
            id,
            shape: {
              center: at(Math.max(length, width) / 2 + 8),
              contour: { kind: 'rectangle', length, width, cornerRadius: 0 },
            },
            side: rnd() < 0.5 ? 'inside' : 'outside',
            slotWidth: tool.diameter,
            tabs: { count: rnd() < 0.5 ? 0 : 2, width: 4, thickness: 2 },
          },
          tool.type === 'flatEndMill' ? tool : TOOLS.d6,
          { heights },
        ),
      )
      if (r.isOk())
        ops.push({ tool: tool.type === 'flatEndMill' ? tool : TOOLS.d6, tp: r.unwrap() })
      continue
    }
    const size = 6 + rnd() * 10
    const r = generatePocket(
      pocketInput(
        stock,
        {
          kind: 'pocket',
          id,
          onZ: 0,
          shape: {
            center: at(size + 3),
            contour:
              kind === 'circle'
                ? { kind: 'circle', radius: size }
                : { kind: 'rectangle', length: 2 * size, width: size + 4, cornerRadius: 4 },
          },
          depth: 1 + rnd() * 4,
          floorRadius: 0,
        },
        tool,
        { heights },
      ),
    )
    if (r.isOk()) ops.push({ tool, tp: r.unwrap() })
  }
  // often grouped by tool: tool runs of several operations (the facing stays first)
  const rest = ops.slice(faced ? 1 : 0)
  if (rnd() < 0.7) rest.sort((a, b) => a.tool.id.localeCompare(b.tool.id))
  const clamp = rnd()
  const clampHeight = clamp < 1 / 3 ? undefined : clamp < 2 / 3 ? 0 : Math.round(rnd() * 150) / 10
  return {
    ops: [...ops.slice(0, faced ? 1 : 0), ...rest],
    settings: {
      retraction: 'minimum',
      clearance,
      margin: retract,
      ...(clampHeight === undefined ? {} : { clampHeight }),
      stock: [stock.length, stock.width, stock.thickness],
      rates: [5000, 5000, 1000],
    },
    what: `seed ${seed}`,
  }
}

/**
 * The mutation test of one link: `c`'s link `index` lowered to `z`, exported and replayed against
 * the full program's rapids; the replay's failures.
 */
export async function loweredReplay(
  c: SetupCase,
  r: Checked,
  index: number,
  z: number,
): Promise<readonly string[]> {
  const e = exported(c, lowered(r.links, index, z), MACHINE)
  const fullRapids = new Set(r.full.moves.filter((m) => m.rapid).map(moveKey))
  return (await replay(c, e, fullRapids)).failures
}

/** `links` with link `index` lowered to `z` (its up, across and down moves). */
function lowered(links: SetupLinks, index: number, z: number): Toolpath[] {
  const link = links.links.find((l) => l.index === index)!
  const move = (m: Move): Move =>
    m.kind === 'rapid' && Math.abs(m.to[2] - link.level) < 1e-9
      ? { kind: 'rapid', to: [m.to[0], m.to[1], z] as Vec3 }
      : m
  return links.toolpaths.map((tp, i) => {
    if (i !== index - 1) return tp
    const passes = tp.passes.map((p, k) =>
      k === tp.passes.length - 1
        ? { ...p, moves: p.moves.map((m, j) => (j >= p.moves.length - 2 ? move(m) : m)) }
        : p,
    )
    return { ...tp, passes }
  })
}

/**
 * One seeded random setup: properties 1–6 (`checkCase`), 7 (a 2 mm field never lowers a link) and
 * the mutation test: a link whose level the field's need sets, lowered by the margin + 0.5 mm, must
 * fail the replay. Returns the low links and whether a mutation ran (the corpus counts them).
 */
export async function seededCase(seed: number): Promise<{ low: number; mutated: boolean }> {
  const c = randomSetup(seed)
  if (c.ops.length < 2) return { low: 0, mutated: false }
  const r = await checkCase(c)
  const coarse = planLinks(linkOps(c), { ...c.settings, cell: 2 })
  r.links.links.forEach((l, i) =>
    expect(coarse.links[i]!.level, c.what).toBeGreaterThanOrEqual(l.level - 1e-9),
  )
  // the need is within the margin + 0.4 mm of the level: lowered by the margin + 0.5 mm, the link
  // passes less than the margin over the material that set it
  const bound = r.links.links.find(
    (l) => l.low && Number.isFinite(l.floor) && l.level - l.floor < c.settings.margin + 0.4,
  )
  if (bound === undefined) return { low: r.links.summary.low, mutated: false }
  const z = bound.level - c.settings.margin - 0.5
  const e = exported(c, lowered(r.links, bound.index, z), MACHINE)
  const fullRapids = new Set(r.full.moves.filter((m) => m.rapid).map(moveKey))
  const bad = await replay(c, e, fullRapids)
  expect(bad.failures.length, `${c.what}: link ${bound.index} at ${z}`).toBeGreaterThan(0)
  return { low: r.links.summary.low, mutated: true }
}
