// Safe links on the virtual machine (hardening DF64, L1): exported programs with minimum
// retraction replayed through GrblSender and the virtual machine, every executed rapid checked
// against an independent stock simulation (links.fixture.ts): the geometry test part and an
// enclosure-like setup; the seeded random setups are links-seeded-*.test.ts.
// Doc: docs/modes/safe-links.md#verification-on-the-virtual-machine
import { describe, expect, it } from 'vitest'
import { generateDrilling } from '../toolpath/drilling'
import { generateFacing } from '../toolpath/facing'
import { generatePocket } from '../toolpath/pocket'
import { drillingInput, facingInput, pocketInput } from '../toolpath/testing/fixtures'
import { testPartToolpaths } from '../toolpath/testing/test-part'
import { TEST_STOCK } from '../geometry/testing/test-part'
import { checkCase, TOOLS, type SetupCase } from './links.fixture'

describe('safe links on the virtual machine', () => {
  it(
    'the geometry test part: only the 6 mm drill links low (its two runs)',
    { timeout: 60_000 },
    async () => {
      const parts = testPartToolpaths()
      const c: SetupCase = {
        ops: parts.map((p) => ({ tp: p.tp, tool: p.tool })),
        settings: {
          retraction: 'minimum',
          clearance: 10,
          margin: 2,
          stock: [TEST_STOCK.length, TEST_STOCK.width, TEST_STOCK.thickness],
          rates: [5000, 5000, 1000],
        },
        what: 'test part',
      }
      const r = await checkCase(c)
      expect(r.links.summary.low).toBeGreaterThan(0)
    },
  )

  it(
    'an enclosure-like setup: facing, relief pocket, pockets, holes; clamp height none, 0 and 12',
    { timeout: 60_000 },
    async () => {
      const stock = { length: 160, width: 100, thickness: 20 }
      const d6 = TOOLS.d6
      const heights = { clearanceHeight: 20, retractHeight: 2 }
      const pocketAt = (id: string, x: number, y: number, r: number, onZ: number, depth: number) =>
        generatePocket(
          pocketInput(
            stock,
            {
              kind: 'pocket',
              id,
              onZ,
              shape: { center: [x, y], contour: { kind: 'circle', radius: r } },
              depth,
              floorRadius: 0,
            },
            d6,
            { heights },
          ),
        ).unwrap()
      const relief = generatePocket(
        pocketInput(
          stock,
          {
            kind: 'pocket',
            id: 'relief',
            onZ: 0,
            shape: {
              center: [80, 50],
              contour: { kind: 'rectangle', length: 120, width: 70, cornerRadius: 6 },
            },
            depth: 3,
            floorRadius: 0,
          },
          d6,
          { heights },
        ),
      ).unwrap()
      const facing = generateFacing(
        facingInput(stock, d6, { heights, operation: { kind: 'facing', id: 'f', depth: 0.5 } }),
      ).unwrap()
      const hole = (id: string, x: number, y: number) =>
        generateDrilling({
          ...drillingInput(
            stock,
            {
              kind: 'drilling',
              id,
              onZ: -3,
              center: [x, y],
              diameter: 5,
              bottom: { kind: 'through' },
            },
            TOOLS.dr,
            { cycle: 'peck', peckDepth: 3, breakthrough: 0.5 },
          ),
          heights,
        }).unwrap()
      const ops = [
        { tp: facing, tool: d6 },
        { tp: relief, tool: d6 },
        { tp: pocketAt('p1', 40, 40, 8, -3, 6), tool: d6 },
        { tp: pocketAt('p2', 120, 60, 8, -3, 6), tool: d6 },
        { tp: pocketAt('p3', 80, 92, 4, 0, 2), tool: d6 },
        { tp: hole('h1', 30, 25), tool: TOOLS.dr },
        { tp: hole('h2', 130, 25), tool: TOOLS.dr },
        { tp: hole('h3', 130, 75), tool: TOOLS.dr },
      ]
      const results: Record<string, number> = {}
      for (const clampHeight of [undefined, 0, 12]) {
        const c: SetupCase = {
          ops,
          settings: {
            retraction: 'minimum',
            clearance: 20,
            margin: 2,
            ...(clampHeight === undefined ? {} : { clampHeight }),
            stock: [stock.length, stock.width, stock.thickness],
            rates: [3000, 3000, 1000],
          },
          what: `enclosure, clamp ${clampHeight}`,
        }
        const r = await checkCase(c)
        results[String(clampHeight)] = r.links.summary.low
        if (process.env['LINK_DEBUG'] !== undefined)
          process.stderr.write(`LINKS ${clampHeight} ${JSON.stringify(r.links.links)}\n`)
      }
      // inside the relief the links run low without a clamp height (p1 → p2 at its floor's
      // retract plane, Z −1); facing → relief leaves the stock: only with a clamp height
      expect(results['undefined']).toBe(5)
      expect(results['0']).toBe(6)
      expect(results['12']).toBe(6)
    },
  )
})
