// Safe links (hardening DF64): seeded random setups 21–40 (of 40, in two files so they run in
// parallel), properties 1–7 and the mutation test on the virtual machine (links.fixture.ts).
// One `it` per seed: each takes ≈ 2–3 s alone (two or three replays), 60 s under load
// (docs/conventions/testing.md#load-stable-tests). LINK_SEED=n runs one seed.
// Doc: docs/modes/safe-links.md#verification-on-the-virtual-machine
import { describe, expect, it } from 'vitest'
import { seededCase } from './links.fixture'

const only = process.env['LINK_SEED']
const seeds = Array.from({ length: 20 }, (_, i) => i + 21).filter(
  (s) => only === undefined || s === Number(only),
)

describe('safe links: seeded random setups 21–40', () => {
  let low = 0
  let mutations = 0
  for (const seed of seeds)
    it(`seed ${seed}`, { timeout: 60_000 }, async () => {
      const r = await seededCase(seed)
      low += r.low
      if (r.mutated) mutations++
    })

  it.skipIf(only !== undefined)(
    'the corpus exercises the links: many lowered, some mutated',
    () => {
      expect(low).toBeGreaterThan(10)
      expect(mutations).toBeGreaterThan(2)
    },
  )
})
