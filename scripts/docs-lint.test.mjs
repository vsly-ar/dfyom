// Docs lint: rules from docs/conventions/documentation.md, enforced in `npm test`.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ADR_STATUS_VALUES,
  STATUS_VALUES,
  anchors,
  brokenLinks,
  extractLinks,
  listMarkdown,
  slug,
  statusOf,
} from './docs-lint.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DOCS = join(ROOT, 'docs')
const INDEX = join(DOCS, 'README.md')
const DECISIONS = join(DOCS, 'decisions')
const docs = listMarkdown(DOCS)
const read = (f) => readFileSync(f, 'utf8')
const rel = (f) => relative(ROOT, f)

/** Absolute paths (files and folders) that a markdown file links to. */
const linkTargets = (file) =>
  new Set(
    extractLinks(read(file))
      .filter((t) => !/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith('#'))
      .map((t) => resolve(dirname(file), decodeURIComponent(t.split('#')[0]))),
  )

/**
 * A doc is indexed when docs/README.md links it, links a folder containing it (e.g.
 * `decisions/`), or links its folder's README.md which in turn links it.
 */
function isIndexed(file, indexLinks) {
  if (indexLinks.has(file)) return true
  for (let d = dirname(file); d.startsWith(DOCS) && d !== DOCS; d = dirname(d))
    if (indexLinks.has(d)) return true
  const folderReadme = join(dirname(file), 'README.md')
  return (
    folderReadme !== file &&
    existsSync(folderReadme) &&
    isIndexed(folderReadme, indexLinks) &&
    linkTargets(folderReadme).has(file)
  )
}

describe('docs lint', () => {
  it('lists every doc in docs/README.md (directly, via a folder link, or via a folder README)', () => {
    const indexLinks = linkTargets(INDEX)
    const unindexed = docs.filter((f) => f !== INDEX && !isIndexed(f, indexLinks)).map(rel)
    expect(unindexed).toEqual([])
  })

  it('has a valid Status line near the top of every doc', () => {
    const bad = docs
      .filter((f) => f !== INDEX)
      .filter((f) => {
        const allowed = f.startsWith(DECISIONS) ? ADR_STATUS_VALUES : STATUS_VALUES
        return !allowed.includes(statusOf(read(f)))
      })
      .map((f) => `${rel(f)}: ${statusOf(read(f)) ?? 'missing'}`)
    expect(bad).toEqual([])
  })

  it('shows the same status in the docs/README.md map as in the doc itself', () => {
    const mismatches = []
    for (const m of read(INDEX).matchAll(
      /^\|[^|]*\|\s*\[[^\]]*\]\(([^)#]+)\)[^|]*\|\s*(\S+)\s*\|$/gm,
    )) {
      const [, target, listed] = m
      const file = resolve(DOCS, target)
      if (!STATUS_VALUES.includes(listed) || !file.endsWith('.md')) continue
      const actual = statusOf(read(file))
      if (actual !== listed) mismatches.push(`${target}: index says ${listed}, doc says ${actual}`)
    }
    expect(mismatches).toEqual([])
  })

  it('has only resolvable relative links and #anchors', () => {
    const files = [...docs, join(ROOT, 'README.md'), join(ROOT, 'CLAUDE.md')].filter(existsSync)
    const broken = files.flatMap((f) => brokenLinks(f).map((p) => `${rel(f)}: ${p}`))
    expect(broken).toEqual([])
  })
})

describe('docs lint helpers', () => {
  it('slugs headings like GitHub', () => {
    expect(slug('v0.1 – 2.5D basics to the virtual machine')).toBe(
      'v01--25d-basics-to-the-virtual-machine',
    )
    expect(slug('4. Explicit errors (Result, Option, AppError, invariant models)')).toBe(
      '4-explicit-errors-result-option-apperror-invariant-models',
    )
    expect(slug('Pre-alpha exception: no data preservation yet')).toBe(
      'pre-alpha-exception-no-data-preservation-yet',
    )
    expect(slug('Using `fail` and [links](x.md) with **bold**')).toBe(
      'using-fail-and-links-with-bold',
    )
    expect(slug('snake_case stays')).toBe('snake_case-stays')
  })

  it('numbers duplicate headings and ignores code fences', () => {
    const a = anchors('# A\n## A\n```md\n# Not a heading\n```\n## A\n')
    expect([...a]).toEqual(['a', 'a-1', 'a-2'])
  })

  it('extracts inline and reference links but not code', () => {
    const md = '[a](x.md#h) [b](<y z.md> "t") `[c](no.md)`\n```\n[d](no.md)\n```\n[e]: ref.md\n'
    expect(extractLinks(md)).toEqual(['x.md#h', 'y z.md', 'ref.md'])
  })
})
