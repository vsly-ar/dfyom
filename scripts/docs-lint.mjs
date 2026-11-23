// Docs lint helpers: enforce docs/conventions/documentation.md (index, status line, links).
// The checks themselves run as a Vitest test: scripts/docs-lint.test.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export const STATUS_VALUES = ['stub', 'draft', 'accepted', 'implemented']
/** ADRs may also be superseded/deprecated instead of edited (documentation.md rule 6). */
export const ADR_STATUS_VALUES = [...STATUS_VALUES, 'proposed', 'superseded', 'deprecated']

/** All `*.md` files below `dir`, as absolute paths, sorted. */
export function listMarkdown(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => join(e.parentPath, e.name))
    .sort()
}

function stripFences(md) {
  return md.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
}

/** Remove fenced code blocks and inline code spans so their contents are not parsed as links. */
export function stripCode(md) {
  return stripFences(md).replace(/`[^`\n]*`/g, '')
}

/** Link targets of inline links `[t](target "title")` and reference definitions `[t]: target`. */
export function extractLinks(md) {
  const text = stripCode(md)
  const links = []
  for (const m of text.matchAll(/\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g))
    links.push(m[1] ?? m[2])
  for (const m of text.matchAll(/^\s{0,3}\[[^\]]+\]:\s+<?(\S+?)>?(?:\s|$)/gm)) links.push(m[1])
  return links
}

/** GitHub heading anchor slug (github-slugger rules, applied to the rendered heading text). */
export function slug(heading) {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links/images -> text
    .replace(/`([^`]*)`/g, '$1') // code spans -> text
    .replace(/(^|\W)[*_]{1,3}(\S(?:.*?\S)?)[*_]{1,3}(?=\W|$)/g, '$1$2') // emphasis markers
    .replace(/<[^>]+>/g, '') // inline HTML tags
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-')
}

/** Anchors GitHub generates for all ATX headings of a document (duplicates get -1, -2, …). */
export function anchors(md) {
  const seen = new Map()
  const result = new Set()
  for (const m of stripFences(md).matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1])
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    result.add(n === 0 ? base : `${base}-${n}`)
  }
  return result
}

/** The `Status:` value near the top of a doc (first 5 lines), or undefined. */
export function statusOf(md) {
  const head = md.split('\n').slice(0, 5).join('\n')
  return /^Status:\s*\**([a-z]+)\**/m.exec(head)?.[1]
}

const isExternal = (target) => /^[a-z][a-z0-9+.-]*:/i.test(target)

/**
 * Broken relative links of one markdown file: missing files, and `#anchors` that match
 * no heading in the target markdown file (anchors into non-markdown files are not checked).
 * `read` and `anchorsOf` can be memoized by a caller checking many files.
 */
export function brokenLinks(
  file,
  read = (f) => readFileSync(f, 'utf8'),
  anchorsOf = (f) => anchors(read(f)),
) {
  const problems = []
  for (const target of extractLinks(read(file))) {
    if (isExternal(target)) continue
    const [rawPath, fragment] = target.split('#', 2)
    const path = decodeURIComponent(rawPath ?? '')
    const resolved = path === '' ? file : resolve(dirname(file), path)
    let stat
    try {
      stat = statSync(resolved)
    } catch {
      problems.push(`${target}: file not found`)
      continue
    }
    if (fragment === undefined || fragment === '' || !stat.isFile() || !resolved.endsWith('.md'))
      continue
    if (!anchorsOf(resolved).has(decodeURIComponent(fragment).toLowerCase()))
      problems.push(
        `${target}: no heading for #${fragment} in ${relative(dirname(file), resolved) || 'this file'}`,
      )
  }
  return problems
}
