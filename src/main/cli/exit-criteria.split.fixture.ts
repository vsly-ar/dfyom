// Test-only: the split parts 4a exit criterion (hardening DF91), run headless through the bundled
// CLI (exit-criteria.mcp.test.ts): the enclosure (split.fixture.ts, built from scratch) split by
// one level, then by the level and two lines, then by the level joined by dowels (4b-1), and the
// proposal's 600 × 400 panel split by one line with a puzzle key (4b-2) and its Test fit coupon
// (4b-3), and the enclosure split to fit a library board by the suggestion (4c), and a shelf longer
// than the machine's travel split by one line with a finger joint (4d, its pieces' fitted outlines
// reassembling the shelf), and a round table top Ø 1200 split by a curved line (a named shape) and a
// straight one with puzzle keys (4e, its four pieces reassembling it); every piece is planned,
// exported and run on the virtual machine, setup by setup. Not app code.
// Docs: docs/modes/split-parts.md#implementation-4a, docs/modes/split-parts.md#implementation-4b,
// docs/modes/split-parts.md#implementation-4c, docs/modes/split-parts.md#implementation-4d,
// docs/modes/split-parts.md#implementation-4e, docs/modes/split-parts.md#slices
import { readFileSync } from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'
import { expectOk } from '../../shared/testing/result'
import { join } from 'node:path'
import { expect } from 'vitest'
import { len, libraryInput, machineValues } from '../../core/library/library.fixture'
import { flat4, flat6 } from '../../core/plan/plan.fixture'
import {
  ENCLOSURE_LEVEL,
  ENCLOSURE_STOCK,
  enclosureCommands,
  LONG_PANEL_LINE,
  LONG_PANEL_STOCK,
  longPanelCommands,
  PANEL_LINE,
  PANEL_STOCK,
  panelCommands,
  TABLE_LINE,
  TABLE_STOCK,
  tableCommands,
} from '../../core/design/split/split.fixture'
import { regionArea, type Region } from '../../core/geometry/2d/model'
import { nodeRegion2d } from '../../core/geometry/2d/testing/node-wasm'
import { toGeometryInput } from '../../core/design/geometry-input'
import { loadPart } from '../../core/design/load'
import type { PartDTO } from '../../core/design/part.dto'
import { shapeRegion } from '../../core/design/split/layout'
import type { SnapshotDTO } from '../../core/library/snapshot'
import type { ProjectDoc } from '../../core/project/document'
import { withoutAppVersion } from '../../core/post/plan-export'
import { agentSession, type Call, type RunJobStatus } from './exit-criteria.fixture'

interface SplitResult {
  pieces: { partId: string; name: string; index: number; blank: number[] }[]
  findings: { severity: string; params: { rule: string; reason?: string } }[]
}
interface PlanGet {
  plan: { name: string; setups: { id: string; name: string; direction: string }[] }
}

/** The program's header comments (up to the Generator line, its app version dropped). */
const programHeader = (gcode: string): string => {
  const lines = withoutAppVersion(gcode).split('\n')
  return lines.slice(0, lines.findIndex((l) => l.startsWith('(Generator:')) + 1).join('\n') + '\n'
}
interface RunStatus {
  state: string
  mpos: [number, number, number]
  workZero: [number, number, number]
}

/** A 6 mm flat that reaches through a 40 mm piece (the cavity is 30 mm deep in a piece). */
const flat6Long = () => ({
  ...flat6(),
  name: 'Flat 6 long',
  fluteLength: len('45'),
  overallLength: len('90'),
})

/** A part's through outside profile as a region of its frame (mm), from the saved project. */
function outlineOf(
  files: Record<string, Uint8Array>,
  partId: string,
): { region: Region; offset: number[] } {
  const read = <T>(name: string): T => JSON.parse(strFromU8(files[name]!)) as T
  const part = read<PartDTO>(`parts/${partId}.json`)
  const snapshots = Object.fromEntries(
    Object.keys(files)
      .filter((f) => f.startsWith('snapshots/'))
      .map((f) => {
        const x = read<SnapshotDTO>(f)
        return [x.id, x]
      }),
  )
  const doc = {
    parts: { [partId]: part },
    snapshots,
    unitSystem: 'mm',
  } as unknown as ProjectDoc
  const loaded = expectOk(loadPart(doc, partId, 'exit'))
  const g = expectOk(toGeometryInput(loaded.part, loaded.stock, nodeRegion2d())).operations
  const at = part.operations.findIndex((o) => o.kind === 'profile' && o.side === 'outside')
  const og = g[at]
  const region = og?.kind === 'profile' ? shapeRegion(og.shape) : undefined
  expect(region, partId).toBeDefined()
  const mm = (q: { exact: { num: string; den: string } }) =>
    Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))
  return { region: region!, offset: (part.offset ?? []).map(mm) }
}

/**
 * The 4d and 4e exits' reassembly: the pieces' fitted outlines (their outline profiles moved back
 * by their offsets) cover the source outline once, with no overlap, up to the joint's clearance
 * band and T-bones (under 0.5 % of the area), sampled every `step` mm over the stock (`size`), off
 * the boundaries.
 */
function fittedOutlinesReassemble(
  archive: string,
  sourceId: string,
  pieceIds: readonly string[],
  size: readonly [number, number],
  step: number,
  gapSeen = false,
): void {
  const port = nodeRegion2d()
  const files = unzipSync(readFileSync(archive))
  const source = outlineOf(files, sourceId)
  const pieces = pieceIds.map((id) => outlineOf(files, id))
  let inSource = 0
  let missed = 0
  // off the line, the finger edges and the outline: no sample on a boundary
  for (let x = 0.7; x < size[0]; x += step)
    for (let y = 0.7; y < size[1]; y += step) {
      const hits = pieces.filter((p) =>
        port.contains(p.region, [x + p.offset[0]!, y + p.offset[1]!]),
      ).length
      const want = port.contains(source.region, [x, y])
      expect(hits, `${x} ${y}`).toBeLessThanOrEqual(want ? 1 : 0)
      if (want) inSource++
      if (want && hits === 0) missed++
    }
  const area = regionArea(source.region)
  expect(Math.abs(inSource * step * step - area) / area).toBeLessThan(0.005)
  expect(missed / inSource).toBeLessThan(0.005)
  if (gapSeen) expect(missed).toBeGreaterThan(0) // the clearance band and the T-bones are there
}

export async function exitCriteriaSplitFlow(
  call: Call,
  dir: string,
): Promise<{ pieces: number; setups: number }> {
  const { ok, waitJob } = agentSession(call)
  for (const t of [flat6Long(), flat4()]) await ok('library.tool.add', { values: libraryInput(t) })
  const machine = (
    await ok<{ id: string }>('library.machine.add', { values: libraryInput(machineValues()) })
  ).value.id
  const created = await ok<{ revision: number }>('project.create', {
    name: 'Enclosure split',
    unitSystem: 'mm',
  })
  const { partId } = (
    await ok<{ partId: string }>('design.part.add', {
      name: 'Enclosure',
      stock: ENCLOSURE_STOCK,
      expectedRevision: created.value.revision,
    })
  ).value
  for (const [name, args] of enclosureCommands(partId)) await ok(name, args)
  // split parts 4b-2: the proposal's exit part, a 600 × 400 panel, beside the enclosure
  const panelId = (
    await ok<{ partId: string }>('design.part.add', { name: 'Panel', stock: PANEL_STOCK })
  ).value.partId
  for (const [name, args] of panelCommands(panelId)) await ok(name, args)
  // split parts 4d: a shelf longer than the machine's 800 mm travel
  const shelfId = (
    await ok<{ partId: string }>('design.part.add', { name: 'Shelf', stock: LONG_PANEL_STOCK })
  ).value.partId
  for (const [name, args] of longPanelCommands(shelfId)) await ok(name, args)
  // split parts 4e: a round table top Ø 1200, its curved split line a named shape
  const tableId = (
    await ok<{ partId: string }>('design.part.add', { name: 'Table', stock: TABLE_STOCK })
  ).value.partId
  let curve = ''
  for (const [name, args] of tableCommands(tableId)) {
    const r = await ok<{ shapeId?: string }>(name, args)
    if (name === 'design.shape.add') curve = r.value.shapeId!
  }

  let pieces = 0
  let setups = 0
  let shelfPieces: string[] = []
  let tablePieces: string[] = []
  const splits: [string, object, string?][] = [
    ['level', { levels: [ENCLOSURE_LEVEL] }],
    [
      'level-lines',
      {
        levels: [ENCLOSURE_LEVEL],
        lines: [
          { axis: 'x', at: '125' },
          { axis: 'y', at: '100' },
        ],
      },
    ],
    // split parts 4b-1: the level joined by dowels placed by the helper
    ['level-dowels', { levels: [ENCLOSURE_LEVEL], dowels: {} }],
    // split parts 4b-2: the panel in two pieces joined by puzzle keys
    ['panel-puzzle', { lines: [PANEL_LINE], joint: 'puzzle' }, panelId],
    // split parts 4b-3: the panel's Test fit coupon, its own two-piece part
    ['panel-coupon', {}, panelId],
    // split parts 4c: the enclosure split to fit a 200 × 100.1 × 40 library board by the
    // suggestion, every piece on that board
    ['fit', {}],
    // split parts 4d: the shelf in two pieces joined by fingers, each within the travel
    ['shelf-finger', { lines: [LONG_PANEL_LINE], joint: 'finger' }, shelfId],
    // split parts 4e: the table by the curved line and y = 605, joined by puzzle keys
    ['table-curve', { lines: [{ shape: curve }, TABLE_LINE], joint: 'puzzle' }, tableId],
  ]
  for (const [label, split, splitPart = partId] of splits) {
    let source =
      splitPart === panelId
        ? 'Panel'
        : splitPart === shelfId
          ? 'Shelf'
          : splitPart === tableId
            ? 'Table'
            : 'Enclosure'
    let r: SplitResult
    if (label === 'panel-coupon') {
      const fit = (
        await ok<{ parts: { name: string; size: number[]; pieces: SplitResult['pieces'] }[] }>(
          'design.split.testFit',
          { partId: panelId },
        )
      ).value.parts
      expect(fit).toHaveLength(1)
      expect(fit[0]!.name).toBe('Panel · test fit 0.15 mm')
      expect(fit[0]!.size[2]).toBe(18)
      source = fit[0]!.name
      r = { pieces: fit[0]!.pieces, findings: [] }
    } else if (label === 'fit') {
      const board = (
        await ok<{ id: string }>('library.stock.add', {
          values: {
            ...ENCLOSURE_STOCK,
            name: 'Block 200 × 100.1 × 40',
            length: '200',
            width: '100.1',
            thickness: '40',
          },
        })
      ).value.id
      const fit = (
        await ok<{ lines: object[]; levels: string[]; pieces: number }>('design.split.suggest', {
          partId,
          stockLibraryItemId: board,
        })
      ).value
      expect(fit).toMatchObject({
        lines: [
          { axis: 'x', at: '125 mm' },
          { axis: 'y', at: '100 mm' },
        ],
        levels: ['-40 mm'],
        pieces: 8,
      })
      r = (
        await ok<SplitResult>('design.split.set', {
          partId,
          split: { lines: fit.lines, levels: fit.levels, useStocks: true },
          confirm: true,
        })
      ).value
      // every piece on the library board
      expect(r.pieces.map((p) => p.blank)).toEqual(Array(8).fill([200, 100.1, 40]))
    } else
      r = (await ok<SplitResult>('design.split.set', { partId: splitPart, split, confirm: true }))
        .value
    expect(r.pieces).toHaveLength(
      label === 'level-lines' || label === 'fit' ? 8 : label === 'table-curve' ? 4 : 2,
    )
    if (label === 'table-curve') {
      // keys on the straight runs (none on the arcs: no `curved` pair, each pair has a straight
      // run; the 65 mm run from the bump to y = 605 takes a small key, a `thinJoint` warning);
      // every piece within the 800 mm travel, the table not
      expect(r.findings.filter((f) => ['keyFit', 'outsideTravel'].includes(f.params.rule))).toEqual(
        [],
      )
      expect(r.pieces.every((p) => p.blank[0]! < 800 && p.blank[1]! < 800)).toBe(true)
      tablePieces = r.pieces.map((p) => p.partId)
    }
    if (label === 'panel-puzzle') {
      // every run holds its keys; the male piece's blank holds its knobs
      expect(r.findings.filter((f) => f.params.rule === 'keyFit')).toEqual([])
      expect(r.pieces[0]!.blank[0]).toBeGreaterThan(r.pieces[1]!.blank[0]!)
    }
    if (label === 'level-dowels')
      expect(r.findings.filter((f) => /^dowel/.test(f.params.rule))).toEqual([])
    if (label === 'shelf-finger') {
      // fingers along the whole line; every piece within the travel, the shelf not
      expect(
        r.findings.filter((f) => ['keyFit', 'thinJoint', 'outsideTravel'].includes(f.params.rule)),
      ).toEqual([])
      expect(r.pieces.every((p) => p.blank[0]! < 800 && p.blank[1]! < 800)).toBe(true)
      shelfPieces = r.pieces.map((p) => p.partId)
    }
    // a renamed piece keeps its number in the header and adds its name (split parts 4a polish)
    if (label === 'level')
      await ok('design.part.update', { partId: r.pieces[1]!.partId, name: 'Ring' })
    for (const piece of r.pieces) {
      const { planId } = (
        await ok<{ planId: string }>('plan.create', {
          partId: piece.partId,
          machineLibraryItemId: machine,
        })
      ).value
      const errors = (
        await ok<{ warnings: { severity: string; message: string }[] }>('plan.warning.list', {
          planId,
          detail: 'full',
        })
      ).value.warnings.filter((w) => w.severity === 'error')
      expect(errors, `${label} ${piece.name}`).toEqual([])
      const plan = (await ok<PlanGet>('plan.get', { planId })).value.plan
      // the upper piece's dowel holes are drilled from its bottom: a flip setup
      if (label === 'level-dowels') expect(plan.setups.map((x) => x.direction)).toContain('-z')
      let dowelHoles = 0
      await ok('run.connection.open', {
        target: 'virtual',
        planId,
        timeScale: 'max',
        prepare: true,
      })
      for (const [n, setup] of plan.setups.entries()) {
        const target = join(dir, `${label}-${piece.index}-${n + 1}.nc`)
        await ok('plan.export', { planId, setupId: setup.id, target })
        // the program is for the piece's own blank
        const [bl, bw, bt] = piece.blank.map((v) => +v.toFixed(3))
        const gcode = readFileSync(target, 'utf8')
        dowelHoles += gcode.match(/Dowel hole \d+/g)?.length ?? 0
        expect(gcode).toContain(`(Stock X ${bl} Y ${bw} Z ${bt} mm`)
        // the header names the piece after the plan (split parts 4a polish; golden for the first)
        // (a non-default name stays with the number through the second split; comments are ASCII)
        const renamed = piece.index === 2 && source === 'Enclosure' ? ': Ring' : ''
        expect(gcode).toContain(
          `(Program: ${plan.name})\n(Piece ${piece.index} of ${r.pieces.length} of ${source.replaceAll(' · ', ' - ')}${renamed})\n`,
        )
        if (label === 'level' && piece.index === 1 && n === 0)
          await expect(programHeader(gcode)).toMatchFileSnapshot(
            '__golden__/exit-criteria-split-piece-header.nc',
          )
        // tools zeroed on a floor (the rim holes on the top facing's floor): touch off there
        const floorZero = new Map(
          [...gcode.matchAll(/\(Z0 for tool (\d+): .*?, ([\d.]+) below the stock top\)/g)].map(
            (x) => [Number(x[1]), Number(x[2])],
          ),
        )
        if (n > 0) {
          // the next setup's stock zeroed at the same machine place (centred, as prepare)
          const s = (await ok<RunStatus>('run.status.get')).value
          const g54 = [-400 - piece.blank[0]! / 2, -400 - piece.blank[1]! / 2, s.workZero[2]]
          await ok('run.workZero.set', {
            axes: ['x', 'y', 'z'],
            values: s.mpos.map((m, i) => m - g54[i]!),
          })
        }
        const topZero = (await ok<RunStatus>('run.status.get')).value.workZero[2]
        const run = await ok<{ jobId: string }>('run.job.start', { planId, setupId: setup.id })
        const ended = await waitJob(run.value.jobId, async (job: RunJobStatus) => {
          if (job.phase === 'toolChange') {
            const s = (await ok<RunStatus>('run.status.get')).value
            const below = floorZero.get(job.toolChange!.n) ?? 0
            await ok('run.workZero.set', {
              axes: ['z'],
              values: [0, 0, s.mpos[2] - (topZero - below)],
            })
            await ok('run.job.continue', { jobId: run.value.jobId, toolChange: job.toolChange!.n })
          } else if (job.phase === 'programPause')
            await ok('run.job.continue', { jobId: run.value.jobId, pause: job.pause })
        })
        expect(ended.ok, `${label} ${piece.name} ${setup.name}: ${JSON.stringify(ended)}`).toBe(
          true,
        )
        setups++
      }
      await ok('run.connection.close')
      // every piece of the doweled split drills its dowel holes
      if (label === 'level-dowels') expect(dowelHoles, piece.name).toBeGreaterThan(0)
      pieces++
    }
  }
  await ok('project.save', { target: join(dir, 'enclosure-split.dfyom') })
  // 4d: the shelf's pieces, as saved, reassemble it
  expect(shelfPieces).toHaveLength(2)
  fittedOutlinesReassemble(
    join(dir, 'enclosure-split.dfyom'),
    shelfId,
    shelfPieces,
    [1010, 310],
    2,
    true,
  )
  // 4e: the table's four pieces, as saved, reassemble it
  expect(tablePieces).toHaveLength(4)
  fittedOutlinesReassemble(
    join(dir, 'enclosure-split.dfyom'),
    tableId,
    tablePieces,
    [1210, 1210],
    4,
  )
  return { pieces, setups }
}
