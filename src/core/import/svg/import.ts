/**
 * SVG import core: SVG text → shapes of closed loops and open paths of lines and arcs (mm, shape
 * frame) plus the import report. Pure and headless; `design.shape.import` (task K2/I1) reads the
 * file in the dispatcher's prepared input and calls `importSvg`.
 * Doc: docs/architecture/shapes.md#svg-import, docs/modes/design-v0.3.md#svg-import
 *
 * Pipeline: XML tokenizer → element walk (groups, `transform`, styles, basic shapes, path data) →
 * segments in mm (root viewport and transforms applied exactly, before fitting) → per subpath a
 * fitted and cleaned chain → per shape the fill rule classification and repair → shapes, report.
 */
import { Ok, type AppResult } from '../../../shared/result'
import type { Vec2 } from '../../geometry/model'
import {
  chainBounds,
  elementLength,
  type Bounds2,
  type Loop,
  type Path,
} from '../../geometry/2d/model'
import { buildChain, emptyStats, type Chain, type ChainStats } from './chain'
import { fillLoops, type FillRule, type FillSource } from './fill'
import { elementPointAt, windingNumber } from '../../geometry/2d/measure'
import { parsePathData, transformSeg, type Seg, type Subpath } from './path-data'
import { compose, parseTransform, type Affine, type Pt } from './transform'
import { rootViewport, userLength, type SvgUnit } from './units'
import { parseXml, svgError, type XmlElement } from './xml'

/** Import limits (docs/architecture/shapes.md#svg-import); beyond them `input.malformed`, rule `svgLimit`. */
export const SVG_LIMITS = {
  /** File size in bytes (UTF-8). */
  maxBytes: 10 * 2 ** 20,
  /** Lines and arcs after fitting, over all shapes. */
  maxElements: 20_000,
  /** Element nesting depth. */
  maxDepth: 256,
} as const

export interface SvgLimits {
  readonly maxBytes: number
  readonly maxElements: number
  readonly maxDepth: number
}

/** How the drawing becomes shapes. */
export type SvgSplit = 'file' | 'element' | 'loop'

export interface SvgImportOptions {
  /** What one user unit is when the file has no absolute size; default `px96` (CSS). */
  readonly unit?: SvgUnit
  /**
   * `element` (default): one shape per top-level element (a top-level group with everything in
   * it); `file`: one shape for the drawing; `loop`: one shape per outer loop with its holes.
   * Open paths are always shapes of their own (a shape with an open path has one item).
   */
  readonly split?: SvgSplit
  /** Lower limits (tests). */
  readonly limits?: Partial<SvgLimits>
}

/** A closed loop (`add` counter-clockwise, `subtract` clockwise) or an open path. */
export type SvgShapeItem =
  | { readonly kind: 'loop'; readonly op: 'add' | 'subtract'; readonly loop: Loop }
  | { readonly kind: 'path'; readonly path: Path }

export interface SvgShape {
  /** The element's label (`inkscape:label`) or id, else "Path 2", "Group 3", … */
  readonly name: string
  /** The SVG element it came from: `#id`, else `tag[n]` (n-th top-level element, 1-based). */
  readonly source: { readonly element: string }
  /**
   * Loops by decreasing |area| (a containing loop before the loops inside it), so folding them in
   * order with their `op` gives the filled area; or exactly one open path.
   */
  readonly items: readonly SvgShapeItem[]
}

export interface SvgImportWarning {
  readonly rule: string
  readonly message: string
  /** The element (`#id` or `tag` with its line). */
  readonly element?: string
}

export interface SvgImportReport {
  /** The viewport in mm when the file defines one. */
  readonly size?: { readonly width: number; readonly height: number }
  /** Exact bounds of everything imported, in the shape frame (mm). */
  readonly bounds?: Bounds2
  /** The unit the size was read in, or the option used for a unitless file. */
  readonly unit: string
  readonly unitAssumed: boolean
  /** Elements imported, by tag. */
  readonly imported: Readonly<Record<string, number>>
  /** Elements not imported, by tag (`text`, `image`, `use`, …; `hidden` for display none). */
  readonly skipped: Readonly<Record<string, number>>
  /** Cubic and quadratic Béziers fitted with arcs. */
  readonly beziersFitted: number
  /** Elliptical arcs (and non-circular ellipses, rounded-rect corners) fitted with arcs. */
  readonly ellipticalArcsFitted: number
  /** Largest deviation of a fitted piece by the in-fit estimate (mm, ≤ 0.01). */
  readonly maxDeviation: number
  readonly cornersAtCusps: number
  readonly microCornersMerged: number
  /** Source segments shorter than 1·10⁻⁴ mm merged. */
  readonly tinySegmentsMerged: number
  /** Loops rebuilt because they crossed or overlapped (self-intersections included). */
  readonly loopsRepaired: number
  /** Loops dropped: degenerate (no area) or the same fill on both sides. */
  readonly loopsDropped: number
  /** Open subpaths closed because their ends met within 0.01 mm. */
  readonly gapsClosed: number
  readonly loops: number
  readonly openPaths: number
  readonly lines: number
  readonly arcs: number
  readonly warnings: readonly SvgImportWarning[]
}

export interface SvgImport {
  readonly shapes: readonly SvgShape[]
  readonly report: SvgImportReport
}

/** Tags read for geometry. */
const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'])
const GROUP_TAGS = new Set(['g', 'a', 'switch'])
/** Non-rendering or definition elements: ignored silently. */
const SILENT_TAGS = new Set([
  'defs',
  'symbol',
  'title',
  'desc',
  'metadata',
  'clipPath',
  'mask',
  'pattern',
  'marker',
  'linearGradient',
  'radialGradient',
  'filter',
  'script',
  'style',
  'font',
  'font-face',
  'cursor',
  'view',
  'animate',
  'animateMotion',
  'animateTransform',
  'set',
])
const SVG_NS = 'http://www.w3.org/2000/svg'

/** One geometry element after transforms: its subpaths in mm. */
interface Drawn {
  readonly rule: FillRule
  readonly subpaths: readonly Subpath[]
  readonly ref: string
}

interface Group {
  readonly name: string
  readonly element: string
  readonly drawn: Drawn[]
}

interface Walk {
  readonly warnings: SvgImportWarning[]
  readonly imported: Record<string, number>
  readonly skipped: Record<string, number>
  /** Namespace prefixes bound to SVG (besides the default namespace). */
  readonly svgPrefixes: Set<string>
  segments: number
}

interface Inherited {
  readonly ctm: Affine
  readonly rule: FillRule
  readonly hidden: boolean
}

const bump = (m: Record<string, number>, k: string): void => {
  m[k] = (m[k] ?? 0) + 1
}

function styleOf(el: XmlElement): Map<string, string> {
  const out = new Map<string, string>()
  for (const decl of (el.attrs.get('style') ?? '').split(';')) {
    const c = decl.indexOf(':')
    if (c > 0) out.set(decl.slice(0, c).trim(), decl.slice(c + 1).trim())
  }
  return out
}

/** A presentation property: the `style` declaration wins over the attribute. */
const prop = (el: XmlElement, style: Map<string, string>, name: string): string | undefined =>
  style.get(name) ?? el.attrs.get(name)?.trim()

/** The SVG local name, or undefined for an element of another namespace (editor metadata). */
function localName(el: XmlElement, w: Walk): string | undefined {
  const c = el.name.indexOf(':')
  if (c < 0) return el.name
  return w.svgPrefixes.has(el.name.slice(0, c)) ? el.name.slice(c + 1) : undefined
}

const refOf = (el: XmlElement, tag: string): string => {
  const id = el.attrs.get('id')
  return id ? `#${id}` : `<${tag}> on line ${el.line}`
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Subpaths of a geometry element in user units; undefined (with a warning) when not drawable. */
function geometry(el: XmlElement, tag: string, w: Walk, ref: string): Subpath[] | undefined {
  const num = (name: string, def?: number): number | undefined => {
    const raw = el.attrs.get(name)
    if (raw === undefined || raw.trim() === '' || raw.trim() === 'auto') return def
    return userLength(raw)
  }
  const invalid = (what: string): undefined => {
    w.warnings.push({
      rule: 'attributeInvalid',
      message: `<${tag}> skipped: ${what}`,
      element: ref,
    })
    return undefined
  }
  const ellipse = (cx: number, cy: number, rx: number, ry: number): Subpath => {
    const u = { x: rx, y: 0 }
    const v = { x: 0, y: ry }
    const p0 = { x: cx + rx, y: cy }
    const p1 = { x: cx - rx, y: cy }
    return {
      closed: true,
      segs: [
        { kind: 'ellipse', c: { x: cx, y: cy }, u, v, t0: 0, dt: Math.PI, a: p0, b: p1 },
        { kind: 'ellipse', c: { x: cx, y: cy }, u, v, t0: Math.PI, dt: Math.PI, a: p1, b: p0 },
      ],
    }
  }
  const points = (closed: boolean): Subpath[] | undefined => {
    const raw = (el.attrs.get('points') ?? '').trim()
    const nums = raw === '' ? [] : raw.split(/[\s,]+|(?=-)(?<=[\d.])/).map(Number)
    if (nums.some((x) => !Number.isFinite(x))) return invalid('malformed points')
    if (nums.length % 2 === 1)
      w.warnings.push({
        rule: 'pointsOdd',
        message: `<${tag}> has an odd number of coordinates; the last one is ignored`,
        element: ref,
      })
    const pts: Pt[] = []
    for (let k = 0; k + 1 < nums.length; k += 2) pts.push({ x: nums[k]!, y: nums[k + 1]! })
    const segs: Seg[] = []
    for (let k = 0; k + 1 < pts.length; k++)
      if (pts[k]!.x !== pts[k + 1]!.x || pts[k]!.y !== pts[k + 1]!.y)
        segs.push({ kind: 'line', a: pts[k]!, b: pts[k + 1]! })
    const first = pts[0]
    const last = pts[pts.length - 1]
    if (closed && first && last && (first.x !== last.x || first.y !== last.y) && segs.length > 0)
      segs.push({ kind: 'line', a: last, b: first })
    return segs.length > 0 ? [{ closed, segs }] : []
  }

  switch (tag) {
    case 'path': {
      const d = el.attrs.get('d') ?? ''
      const r = parsePathData(d)
      if (r.error)
        w.warnings.push({
          rule: 'pathData',
          message: `path data error (${r.error.message}); the path is imported up to it`,
          element: ref,
        })
      return r.subpaths
    }
    case 'rect': {
      const x = num('x', 0)
      const y = num('y', 0)
      const wd = num('width')
      const ht = num('height')
      let rx = num('rx')
      let ry = num('ry')
      if (x === undefined || y === undefined || wd === undefined || ht === undefined)
        return invalid('x, y, width or height missing or not a length')
      if (!(wd > 0 && ht > 0)) return invalid('width and height must be > 0')
      if ((rx !== undefined && rx < 0) || (ry !== undefined && ry < 0))
        return invalid('negative corner radius')
      if (rx === undefined) rx = ry ?? 0
      if (ry === undefined) ry = rx
      rx = Math.min(rx, wd / 2)
      ry = Math.min(ry, ht / 2)
      if (rx === 0 || ry === 0) {
        const p = [
          { x, y },
          { x: x + wd, y },
          { x: x + wd, y: y + ht },
          { x, y: y + ht },
        ]
        return [
          {
            closed: true,
            segs: p.map((a, k): Seg => ({ kind: 'line', a, b: p[(k + 1) % 4]! })),
          },
        ]
      }
      const segs: Seg[] = []
      const ln = (a: Pt, b: Pt): void => {
        if (a.x !== b.x || a.y !== b.y) segs.push({ kind: 'line', a, b })
      }
      /** Quarter arc from quadrant point k to k + 1 (0: +x, 1: +y, 2: −x, 3: −y), ends exact. */
      const corner = (cx: number, cy: number, k: number): void => {
        const q = (j: number): Pt => {
          const m = j % 4
          return m === 0
            ? { x: cx + rx!, y: cy }
            : m === 1
              ? { x: cx, y: cy + ry! }
              : m === 2
                ? { x: cx - rx!, y: cy }
                : { x: cx, y: cy - ry! }
        }
        segs.push({
          kind: 'ellipse',
          c: { x: cx, y: cy },
          u: { x: rx!, y: 0 },
          v: { x: 0, y: ry! },
          t0: (k * Math.PI) / 2,
          dt: Math.PI / 2,
          a: q(k),
          b: q(k + 1),
        })
      }
      ln({ x: x + rx, y }, { x: x + wd - rx, y })
      corner(x + wd - rx, y + ry, 3)
      ln({ x: x + wd, y: y + ry }, { x: x + wd, y: y + ht - ry })
      corner(x + wd - rx, y + ht - ry, 0)
      ln({ x: x + wd - rx, y: y + ht }, { x: x + rx, y: y + ht })
      corner(x + rx, y + ht - ry, 1)
      ln({ x, y: y + ht - ry }, { x, y: y + ry })
      corner(x + rx, y + ry, 2)
      return [{ closed: true, segs }]
    }
    case 'circle': {
      const cx = num('cx', 0)
      const cy = num('cy', 0)
      const r = num('r')
      if (cx === undefined || cy === undefined || r === undefined)
        return invalid('cx, cy or r missing or not a length')
      if (!(r > 0)) return invalid('r must be > 0')
      return [ellipse(cx, cy, r, r)]
    }
    case 'ellipse': {
      const cx = num('cx', 0)
      const cy = num('cy', 0)
      let rx = num('rx')
      let ry = num('ry')
      if (rx === undefined) rx = ry
      if (ry === undefined) ry = rx
      if (cx === undefined || cy === undefined || rx === undefined || ry === undefined)
        return invalid('cx, cy, rx or ry missing or not a length')
      if (!(rx > 0 && ry > 0)) return invalid('rx and ry must be > 0')
      return [ellipse(cx, cy, rx, ry)]
    }
    case 'line': {
      const x1 = num('x1', 0)
      const y1 = num('y1', 0)
      const x2 = num('x2', 0)
      const y2 = num('y2', 0)
      if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined)
        return invalid('x1, y1, x2 or y2 not a length')
      if (x1 === x2 && y1 === y2) return []
      return [
        {
          closed: false,
          segs: [{ kind: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } }],
        },
      ]
    }
    case 'polyline':
      return points(false)
    case 'polygon':
      return points(true)
    default:
      return undefined
  }
}

/** Walks an element and its descendants, collecting geometry in mm. */
function walk(el: XmlElement, inh: Inherited, w: Walk, out: Drawn[]): void {
  const tag = localName(el, w)
  if (tag === undefined) return
  const style = styleOf(el)
  if (prop(el, style, 'display') === 'none') {
    if (!SILENT_TAGS.has(tag)) bump(w.skipped, 'hidden')
    return
  }
  if (SILENT_TAGS.has(tag)) {
    if (tag === 'style' && el.hasText)
      w.warnings.push({
        rule: 'styleSheetIgnored',
        message: 'a <style> sheet is ignored; only style attributes and properties are read',
      })
    return
  }
  const ref = refOf(el, tag)
  if (!SHAPE_TAGS.has(tag) && !GROUP_TAGS.has(tag)) {
    bump(w.skipped, tag)
    if (tag === 'svg')
      w.warnings.push({
        rule: 'nestedSvg',
        message: 'a nested <svg> is not imported',
        element: ref,
      })
    return
  }
  let ctm = inh.ctm
  const tr = el.attrs.get('transform')
  if (tr !== undefined) {
    const t = parseTransform(tr)
    if (t.isSome()) ctm = compose(ctm, t.unwrap())
    else
      w.warnings.push({
        rule: 'transformInvalid',
        message: 'a malformed transform is ignored',
        element: ref,
      })
  }
  const fr = prop(el, style, 'fill-rule')
  const rule: FillRule = fr === 'evenodd' ? 'evenodd' : fr === 'nonzero' ? 'nonzero' : inh.rule
  const vis = prop(el, style, 'visibility')
  const hidden =
    vis === 'hidden' || vis === 'collapse' ? true : vis === 'visible' ? false : inh.hidden
  for (const a of ['clip-path', 'mask'] as const) {
    const v = prop(el, style, a)
    if (v !== undefined && v !== 'none')
      w.warnings.push({
        rule: a === 'mask' ? 'maskIgnored' : 'clipIgnored',
        message: `${a} is ignored; the geometry is imported unclipped`,
        element: ref,
      })
  }
  if (GROUP_TAGS.has(tag)) {
    const kids = tag === 'switch' ? el.children.slice(0, 1) : el.children
    for (const c of kids) walk(c, { ctm, rule, hidden }, w, out)
    return
  }
  if (hidden) {
    bump(w.skipped, 'hidden')
    return
  }
  const subs = geometry(el, tag, w, ref)
  if (subs === undefined) {
    bump(w.skipped, tag)
    return
  }
  bump(w.imported, tag)
  const subpaths = subs.map((s) => ({
    closed: s.closed,
    segs: s.segs.map((g) => transformSeg(ctm, g)),
  }))
  for (const s of subpaths) w.segments += s.segs.length
  out.push({ rule, subpaths, ref })
}

/** UTF-8 byte length (exact only when it might exceed `limit`). */
function byteLength(text: string, limit: number): number {
  if (text.length * 3 <= limit) return text.length
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n++
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

const limitError = (what: string, limit: number, actual?: number): AppResult<never> =>
  svgError('svgLimit', `the drawing has more ${what} than the limit (${limit})`, {
    limit,
    ...(actual === undefined ? {} : { actual }),
  })

/** The middle of a loop's longest element (containment of holes in outer loops). */
function probe(l: Loop): Vec2 {
  let best = l.elements[0]!
  for (const e of l.elements) if (elementLength(e) > elementLength(best)) best = e
  return elementPointAt(best, 0.5).point
}

/**
 * Imports an SVG drawing. Never throws: malformed XML, a non-SVG root, a bad viewport, an empty
 * drawing and the limits are `input.malformed` with rule `svgSyntax`, `svgNotSvg`, `svgViewport`,
 * `svgEmpty` or `svgLimit`; recoverable problems (bad path data, invalid attributes, ignored
 * clips) are report warnings.
 */
export function importSvg(text: string, options: SvgImportOptions = {}): AppResult<SvgImport> {
  const limits: SvgLimits = { ...SVG_LIMITS, ...options.limits }
  const bytes = byteLength(text, limits.maxBytes)
  if (bytes > limits.maxBytes) return limitError('bytes', limits.maxBytes, bytes)
  const parsed = parseXml(text, limits.maxDepth)
  if (parsed.isErr()) return parsed
  const root = parsed.unwrap()
  const c = root.name.indexOf(':')
  const rootLocal = c < 0 ? root.name : root.name.slice(c + 1)
  if (rootLocal !== 'svg') return svgError('svgNotSvg', `the root element is <${root.name}>`, {})
  const svgPrefixes = new Set<string>()
  for (const [k, v] of root.attrs)
    if (k.startsWith('xmlns:') && v === SVG_NS) svgPrefixes.add(k.slice(6))

  const vp = rootViewport(
    {
      ...(root.attrs.has('width') ? { width: root.attrs.get('width')! } : {}),
      ...(root.attrs.has('height') ? { height: root.attrs.get('height')! } : {}),
      ...(root.attrs.has('viewBox') ? { viewBox: root.attrs.get('viewBox')! } : {}),
      ...(root.attrs.has('preserveAspectRatio')
        ? { preserveAspectRatio: root.attrs.get('preserveAspectRatio')! }
        : {}),
    },
    options.unit ?? 'px96',
  )
  if ('err' in vp)
    return svgError(
      'svgViewport',
      vp.err === 'viewBox' ? 'the viewBox is malformed' : 'the width or height is not positive',
      {},
    )
  const view = vp.ok

  const w: Walk = { warnings: [], imported: {}, skipped: {}, svgPrefixes, segments: 0 }
  const split = options.split ?? 'element'
  const rootStyle = styleOf(root)
  const rootRule: FillRule =
    prop(root, rootStyle, 'fill-rule') === 'evenodd' ? 'evenodd' : 'nonzero'
  const base: Inherited = { ctm: view.matrix, rule: rootRule, hidden: false }
  const groups: Group[] = []
  const rootName = root.attrs.get('inkscape:label') ?? root.attrs.get('id') ?? 'Drawing'
  if (split === 'file') {
    const g: Group = { name: rootName, element: 'svg', drawn: [] }
    for (const ch of root.children) walk(ch, base, w, g.drawn)
    groups.push(g)
  } else {
    let n = 0
    for (const ch of root.children) {
      const tag = localName(ch, w)
      if (tag === undefined) continue
      n++
      const g: Group = {
        name:
          ch.attrs.get('inkscape:label') ??
          ch.attrs.get('id') ??
          `${tag === 'g' ? 'Group' : capital(tag)} ${n}`,
        element: ch.attrs.get('id') ? `#${ch.attrs.get('id')}` : `${tag}[${n}]`,
        drawn: [],
      }
      walk(ch, base, w, g.drawn)
      if (g.drawn.length > 0) groups.push(g)
    }
  }
  // every source segment gives at least one element: refuse early, before fitting
  if (w.segments > limits.maxElements) return limitError('elements', limits.maxElements, w.segments)

  const stats: ChainStats = emptyStats()
  const shapes: SvgShape[] = []
  let repaired = 0
  let dropped = 0
  let unclosed = 0
  for (const g of groups) {
    const sources: FillSource[] = []
    const opens: Chain[] = []
    for (const d of g.drawn) {
      const loops: Loop[] = []
      for (const s of d.subpaths) {
        const chain = buildChain(s.segs, s.closed, stats)
        if (stats.elements > limits.maxElements) return limitError('elements', limits.maxElements)
        if (chain === undefined) {
          dropped++
          w.warnings.push({
            rule: 'loopDegenerate',
            message: 'a subpath without length or area is dropped',
            element: d.ref,
          })
        } else if (chain.closed) loops.push({ elements: chain.elements })
        else opens.push(chain)
      }
      if (loops.length > 0) sources.push({ rule: d.rule, loops })
    }
    const fill = fillLoops(sources)
    repaired += fill.repaired
    dropped += fill.dropped
    unclosed += fill.unclosed
    const items: SvgShapeItem[] = fill.loops.map((l) => ({ kind: 'loop', op: l.op, loop: l.loop }))
    if (split === 'loop') {
      // each outer loop with the holes directly inside it (the smallest containing outer loop)
      const outers = items.filter((i) => i.kind === 'loop' && i.op === 'add')
      const per = outers.map((o): SvgShapeItem[] => [o])
      for (const h of items) {
        if (h.kind !== 'loop' || h.op !== 'subtract') continue
        let best = -1
        for (let k = outers.length - 1; k >= 0; k--) {
          const o = outers[k]!
          if (o.kind === 'loop' && windingNumber(o.loop, probe(h.loop)) !== 0) {
            best = k
            break
          }
        }
        if (best >= 0) per[best]!.push(h)
      }
      per.forEach((its, k) =>
        shapes.push({
          name: per.length > 1 ? `${g.name} ${k + 1}` : g.name,
          source: { element: g.element },
          items: its,
        }),
      )
    } else if (items.length > 0)
      shapes.push({ name: g.name, source: { element: g.element }, items })
    opens.forEach((o, k) =>
      shapes.push({
        name: items.length > 0 || opens.length > 1 ? `${g.name} path ${k + 1}` : g.name,
        source: { element: g.element },
        items: [{ kind: 'path', path: { elements: o.elements } }],
      }),
    )
  }
  if (repaired > 0)
    w.warnings.push({
      rule: 'loopsRepaired',
      message: `${repaired} crossing or overlapping loop(s) were rebuilt by the fill rule`,
    })
  if (unclosed > 0)
    w.warnings.push({
      rule: 'repairUnclosed',
      message: `${unclosed} edge chain(s) did not close after the repair and were dropped`,
    })
  if (stats.forced > 0)
    w.warnings.push({
      rule: 'fitForced',
      message: `${stats.forced} curve piece(s) could not be fitted within the tolerance`,
    })
  if (shapes.length === 0)
    return svgError('svgEmpty', 'the drawing has no paths or shapes to import', {})

  let lines = 0
  let arcs = 0
  let loops = 0
  let openPaths = 0
  const all: Loop[] = []
  for (const s of shapes)
    for (const i of s.items) {
      const ch = i.kind === 'loop' ? i.loop : i.path
      if (i.kind === 'loop') loops++
      else openPaths++
      all.push(ch)
      for (const e of ch.elements)
        if (e.kind === 'line') lines++
        else arcs++
    }
  const bounds = chainBounds(all.flatMap((l) => l.elements))
  const report: SvgImportReport = {
    ...(view.size ? { size: view.size } : {}),
    ...(bounds ? { bounds } : {}),
    unit: view.unit,
    unitAssumed: view.assumed,
    imported: w.imported,
    skipped: w.skipped,
    beziersFitted: stats.beziers,
    ellipticalArcsFitted: stats.ellipses,
    maxDeviation: stats.maxDeviation,
    cornersAtCusps: stats.cusps,
    microCornersMerged: stats.microCorners,
    tinySegmentsMerged: stats.tinySegments,
    loopsRepaired: repaired,
    loopsDropped: dropped,
    gapsClosed: stats.gapsClosed,
    loops,
    openPaths,
    lines,
    arcs,
    warnings: w.warnings,
  }
  return Ok({ shapes, report })
}
