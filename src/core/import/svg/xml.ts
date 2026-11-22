/**
 * A small XML tokenizer for the SVG subset the importer reads: elements, attributes (quoted values,
 * the five predefined entities, character references and DOCTYPE internal-subset entities),
 * comments, CDATA, processing instructions. No DOM, no Node: `src/core` stays headless.
 * Doc: docs/architecture/shapes.md#svg-import
 *
 * Text content is dropped except for a flag (the importer only needs to know that `<style>` has
 * some). Malformed XML is `input.malformed` with rule `svgSyntax` and the line and column.
 */
import type { Issue } from '../../../shared/errors/app-error'
import { fail, Ok, type AppResult } from '../../../shared/result'

export interface XmlElement {
  /** The qualified name as written (`path`, `svg:path`, `sodipodi:namedview`). */
  readonly name: string
  readonly attrs: ReadonlyMap<string, string>
  readonly children: readonly XmlElement[]
  /** 1-based line of the start tag, for warnings. */
  readonly line: number
  /** Whether non-whitespace text or CDATA appeared directly inside. */
  readonly hasText: boolean
}

export const SVG_WHERE = 'svg.import'

/** An `input.malformed` error for an SVG file with one issue (`path` names the file argument). */
export function svgError(
  rule: string,
  message: string,
  params: Readonly<Record<string, unknown>> = {},
): AppResult<never> {
  const issue: Issue = { path: ['path'], rule, message, params }
  return fail('input.malformed', `not a readable SVG file: ${message}`, {
    where: SVG_WHERE,
    issues: [issue],
  })
}

const PREDEFINED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

interface MutableElement {
  name: string
  attrs: Map<string, string>
  children: MutableElement[]
  line: number
  hasText: boolean
}

const isNameStart = (c: number): boolean =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c > 127
const isNameChar = (c: number): boolean =>
  isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46
const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13

/**
 * Parses an XML document into its root element. `maxDepth` bounds element nesting (rule
 * `svgLimit` beyond it), so a hostile file cannot exhaust the stack of later recursive walks.
 */
export function parseXml(text: string, maxDepth: number): AppResult<XmlElement> {
  const n = text.length
  let i = 0
  const entities = new Map<string, string>()
  const stack: MutableElement[] = []
  let root: MutableElement | undefined

  const position = (at: number): { line: number; column: number } => {
    let line = 1
    let last = -1
    for (let k = 0; k < at && k < n; k++)
      if (text.charCodeAt(k) === 10) {
        line++
        last = k
      }
    return { line, column: at - last }
  }
  const syntax = (message: string, at = i): AppResult<never> =>
    svgError('svgSyntax', `${message} (line ${position(at).line})`, position(at))
  let lineAt = 0
  let lineNo = 1
  /** Line of `at`, counted incrementally (tags are visited in order). */
  const lineOf = (at: number): number => {
    for (; lineAt < at; lineAt++) if (text.charCodeAt(lineAt) === 10) lineNo++
    return lineNo
  }

  const decode = (raw: string, at: number): AppResult<string> => {
    if (raw.indexOf('&') < 0) return Ok(raw)
    let out = ''
    let k = 0
    while (k < raw.length) {
      const amp = raw.indexOf('&', k)
      if (amp < 0) {
        out += raw.slice(k)
        break
      }
      out += raw.slice(k, amp)
      const semi = raw.indexOf(';', amp)
      if (semi < 0) return syntax('unterminated entity reference', at)
      const ref = raw.slice(amp + 1, semi)
      let value: string | undefined
      if (ref.startsWith('#x') || ref.startsWith('#X')) {
        const code = Number.parseInt(ref.slice(2), 16)
        value = Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : undefined
      } else if (ref.startsWith('#')) {
        const code = Number.parseInt(ref.slice(1), 10)
        value = Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : undefined
      } else value = PREDEFINED[ref] ?? entities.get(ref)
      if (value === undefined) return syntax(`unknown entity &${ref};`, at)
      out += value
      k = semi + 1
    }
    return Ok(out)
  }

  /** Reads `<!DOCTYPE …>`, keeping simple internal general entities (Illustrator's `&ns_svg;`). */
  const doctype = (): AppResult<void> => {
    let k = i + 9
    let depth = 0
    for (; k < n; k++) {
      const c = text[k]
      if (c === '[') depth++
      else if (c === ']') depth--
      else if (c === '"' || c === "'") {
        const end = text.indexOf(c, k + 1)
        if (end < 0) return syntax('unterminated DOCTYPE')
        k = end
      } else if (c === '>' && depth === 0) break
    }
    if (k >= n) return syntax('unterminated DOCTYPE')
    const body = text.slice(i, k)
    for (const m of body.matchAll(/<!ENTITY\s+([A-Za-z_][\w.-]*)\s+(?:"([^"]*)"|'([^']*)')\s*>/g))
      entities.set(m[1]!, m[2] ?? m[3] ?? '')
    i = k + 1
    return Ok(undefined)
  }

  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      if (text.slice(i).trim() !== '' && stack.length === 0) return syntax('text outside the root')
      if (stack.length > 0) stack[stack.length - 1]!.hasText ||= text.slice(i).trim() !== ''
      i = n
      break
    }
    if (lt > i) {
      const t = text.slice(i, lt)
      if (stack.length > 0) {
        if (t.trim() !== '') stack[stack.length - 1]!.hasText = true
      } else if (t.trim() !== '' && !(i === 0 && t.trim() === '﻿'))
        return syntax('text outside the root', i)
    }
    i = lt
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4)
      if (end < 0) return syntax('unterminated comment')
      i = end + 3
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9)
      if (end < 0) return syntax('unterminated CDATA section')
      if (stack.length === 0) return syntax('CDATA outside the root')
      stack[stack.length - 1]!.hasText ||= text.slice(i + 9, end).trim() !== ''
      i = end + 3
    } else if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2)
      if (end < 0) return syntax('unterminated processing instruction')
      i = end + 2
    } else if (text.startsWith('<!DOCTYPE', i)) {
      if (root !== undefined || stack.length > 0) return syntax('DOCTYPE after the root')
      const r = doctype()
      if (r.isErr()) return r
    } else if (text.startsWith('<!', i)) {
      return syntax('unsupported markup declaration')
    } else if (text.charCodeAt(i + 1) === 47) {
      // end tag
      let k = i + 2
      while (k < n && isNameChar(text.charCodeAt(k))) k++
      const name = text.slice(i + 2, k)
      while (k < n && isSpace(text.charCodeAt(k))) k++
      if (text.charCodeAt(k) !== 62) return syntax('malformed end tag', i)
      const open = stack.pop()
      if (open === undefined) return syntax(`unexpected end tag </${name}>`, i)
      if (open.name !== name) return syntax(`</${name}> closes <${open.name}>`, i)
      i = k + 1
    } else {
      // start tag
      const tagAt = i
      let k = i + 1
      if (!isNameStart(text.charCodeAt(k))) return syntax('malformed tag', i)
      while (k < n && isNameChar(text.charCodeAt(k))) k++
      const el: MutableElement = {
        name: text.slice(i + 1, k),
        attrs: new Map(),
        children: [],
        line: lineOf(tagAt),
        hasText: false,
      }
      let selfClosing = false
      for (;;) {
        const s0 = k
        while (k < n && isSpace(text.charCodeAt(k))) k++
        const c = text.charCodeAt(k)
        if (k >= n) return syntax(`unterminated tag <${el.name}>`, tagAt)
        if (c === 62) {
          k++
          break
        }
        if (c === 47) {
          if (text.charCodeAt(k + 1) !== 62) return syntax('malformed tag end', k)
          selfClosing = true
          k += 2
          break
        }
        if (k === s0 || !isNameStart(c)) return syntax(`malformed attribute in <${el.name}>`, k)
        const a0 = k
        while (k < n && isNameChar(text.charCodeAt(k))) k++
        const attr = text.slice(a0, k)
        while (k < n && isSpace(text.charCodeAt(k))) k++
        if (text.charCodeAt(k) !== 61) return syntax(`attribute ${attr} has no value`, k)
        k++
        while (k < n && isSpace(text.charCodeAt(k))) k++
        const q = text[k]
        if (q !== '"' && q !== "'") return syntax(`attribute ${attr} is not quoted`, k)
        const end = text.indexOf(q, k + 1)
        if (end < 0) return syntax(`unterminated value of ${attr}`, k)
        const raw = text.slice(k + 1, end)
        if (raw.indexOf('<') >= 0) return syntax(`'<' in the value of ${attr}`, k)
        const value = decode(raw, k)
        if (value.isErr()) return value
        if (el.attrs.has(attr)) return syntax(`duplicate attribute ${attr}`, a0)
        el.attrs.set(attr, value.unwrap())
        k = end + 1
      }
      i = k
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(el)
      else if (root === undefined) root = el
      else return syntax('more than one root element', tagAt)
      if (!selfClosing) {
        if (stack.length >= maxDepth)
          return svgError('svgLimit', `elements nest deeper than ${maxDepth}`, {
            limit: maxDepth,
            line: el.line,
          })
        stack.push(el)
      }
    }
  }
  if (stack.length > 0) return syntax(`<${stack[stack.length - 1]!.name}> is not closed`, n)
  if (root === undefined) return svgError('svgSyntax', 'no root element', {})
  return Ok(root)
}
