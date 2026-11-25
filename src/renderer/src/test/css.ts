// Test-only: reads a stylesheet's rules for layout checks jsdom cannot compute (no layout engine).
// A rule is matched by its exact selector list (rules inside @media blocks count too).
// Doc: docs/conventions/testing.md
const fs = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: 'node:fs'): { readFileSync(p: string, enc: 'utf8'): string }
    }
  }
).process.getBuiltinModule('node:fs')

/** The declarations of the top-level rule `selector` in the file at `path` (from the repo root). */
export function cssRule(path: string, selector: string): Record<string, string> {
  const src = fs.readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const decls: Record<string, string> = {}
  let found = false
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.replace(/\s+/g, ' ').trim()
    if (sel !== selector) continue
    found = true
    for (const d of m[2]!.split(';')) {
      const i = d.indexOf(':')
      if (i > 0)
        decls[d.slice(0, i).trim()] = d
          .slice(i + 1)
          .replace(/\s+/g, ' ')
          .trim()
    }
  }
  if (!found) throw new Error(`${path}: no rule ${selector}`)
  return decls
}
