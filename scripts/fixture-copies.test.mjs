// The exit-part drawing is also published under docs/ for black-box acceptance runs (X2 F9):
// the copy must stay identical to the design fixture. Doc: docs/guides/dogfood-v0.4-lid.md
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('published fixture copies', () => {
  it('docs/guides/assets/enclosure-sections.svg equals the design fixture', () => {
    const fixture = readFileSync(
      join(root, 'src/core/design/__fixtures__/enclosure-sections.svg'),
      'utf8',
    )
    const copy = readFileSync(join(root, 'docs/guides/assets/enclosure-sections.svg'), 'utf8')
    expect(copy).toBe(fixture)
  })
})
