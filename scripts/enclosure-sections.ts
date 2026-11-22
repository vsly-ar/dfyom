// Writes the test-only fixture src/core/design/__fixtures__/enclosure-sections.svg from the
// enclosure STL next to it (v0.3 exit criteria, Q27). Not part of the app.
// Run: `npm run fixtures:enclosure-sections` (docs/conventions/testing.md#fixtures).
// The generator is src/core/design/enclosure-sections.testing.ts; its test fails when the
// committed file differs from what this writes.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ENCLOSURE_SECTIONS_SVG,
  enclosureSections,
  fitLoop,
  generateEnclosureSections,
} from '../src/core/design/enclosure-sections.testing.ts'

const stl = new Uint8Array(
  readFileSync(new URL('../src/core/design/__fixtures__/enclosure-wood-base.stl', import.meta.url)),
)
writeFileSync(ENCLOSURE_SECTIONS_SVG, generateEnclosureSections(stl))
for (const s of enclosureSections(stl))
  console.log(`${s.id}: ${s.loop.length} section vertices, ${fitLoop(s.loop).length} segments`)
console.log(`wrote ${fileURLToPath(ENCLOSURE_SECTIONS_SVG)}`)
