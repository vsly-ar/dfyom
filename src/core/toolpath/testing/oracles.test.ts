// The heightmap oracle's tool surface: `surfaceOf` (constants taken once, docs/conventions/testing.md#load-stable-tests)
// gives exactly the production `toolSurface` numbers.
import { describe, expect, it } from 'vitest'
import { bullNose, chamferMill, drill, endMill } from './fixtures'
import { surfaceOf, toolSurface } from './oracles'

describe('surfaceOf', () => {
  it('equals toolSurface for every tool kind, inside, at and past the radius', () => {
    const tools = [
      chamferMill(6, 90, 0),
      chamferMill(3, 60, 0.4),
      drill(5),
      drill(5, 180),
      endMill(6),
      bullNose(6, 1),
    ]
    for (const tool of tools) {
      const surface = surfaceOf(tool)
      for (let k = 0; k <= 400; k++) {
        const rho = (k / 400) * (tool.diameter / 2 + 0.5)
        expect(surface(rho), `${tool.id} at ${rho}`).toBe(toolSurface(tool, rho))
      }
      const edge = tool.diameter / 2 + 1e-12
      expect(surface(edge)).toBe(toolSurface(tool, edge))
    }
  })
})
