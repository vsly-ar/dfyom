/**
 * Command and query args: shape check that also rejects unknown keys at any depth.
 * Doc: docs/architecture/commands.md#dispatcher-pipeline
 *
 * Zod objects strip unknown keys; a mistyped optional key (`dept` for `depth`) would then be
 * silently ignored and its default used. Every key of the raw args must therefore survive in
 * the parsed value (defaults may add keys; only stripped ones are unknown). An unknown key's
 * issue names the closest valid key of its object (docs/architecture/llm-api.md#a5-unknown-arguments-and-projectclose).
 */
import type { z } from 'zod'
import type { Issue } from '../../shared/errors/app-error'
import { parseWith } from '../../shared/parse'
import { fail, type AppResult } from '../../shared/result'

export function parseArgs<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  where: string,
): AppResult<z.output<S>> {
  const parsed = parseWith(schema, raw, where)
  if (parsed.isErr()) return parsed
  const unknown: (string | number)[][] = []
  unknownKeys(raw, parsed.unwrap(), [], unknown)
  if (unknown.length === 0) return parsed
  const issues = unknown.map((path) => unknownKeyIssue(schema, raw, path))
  const first = issues[0]!
  const more = issues.length > 1 ? ` (+ ${issues.length - 1} more)` : ''
  return fail('input.malformed', `${where}: ${first.message}${more}`, { issues, where })
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function unknownKeys(
  raw: unknown,
  parsed: unknown,
  path: (string | number)[],
  out: (string | number)[][],
): void {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    raw.forEach((r, i) => unknownKeys(r, parsed[i], [...path, i], out))
    return
  }
  if (!isRecord(raw) || !isRecord(parsed)) return
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(parsed, key)) out.push([...path, key])
    else unknownKeys(raw[key], parsed[key], [...path, key], out)
  }
}

/** Valid keys listed in an issue at most. */
const MAX_VALID = 20

/** `unknown argument "timeout"; did you mean "timeoutSeconds"?` with the object's valid keys. */
export function unknownKeyIssue(
  schema: z.ZodType,
  raw: unknown,
  path: readonly (string | number)[],
): Issue {
  const key = String(path[path.length - 1])
  const valid = validKeys(schema, raw, path.slice(0, -1))
  const suggestion = closest(key, valid)
  return {
    path: [...path],
    rule: 'unrecognized_keys',
    message:
      `unknown argument "${key}"` +
      (suggestion === undefined ? '' : `; did you mean "${suggestion}"?`),
    params: {
      key,
      ...(suggestion === undefined ? {} : { suggestion }),
      ...(valid.length > 0 ? { valid: valid.slice(0, MAX_VALID) } : {}),
    },
  }
}

/**
 * The closest of `candidates` to `key`, if close enough to be a likely mistake: an edit
 * distance (transpositions count once) of at most a third of the longer name, one name inside
 * the other, or a long common prefix (`timeoutMs` → `timeoutSeconds`). Case is ignored.
 */
export function closest(key: string, candidates: readonly string[]): string | undefined {
  const k = key.toLowerCase()
  let best: { name: string; score: number } | undefined
  for (const name of candidates) {
    const n = name.toLowerCase()
    const d = distance(k, n)
    const close = d <= Math.floor(Math.max(k.length, n.length) / 3)
    const contains = k.length >= 3 && n.length >= 3 && (n.includes(k) || k.includes(n))
    const shorter = Math.min(k.length, n.length)
    const prefix = commonPrefix(k, n) >= Math.max(4, Math.ceil(0.6 * shorter))
    if (!close && !contains && !prefix) continue
    // a close spelling ranks before containment or a shared prefix
    const score = close ? d : 100 + d
    if (best === undefined || score < best.score) best = { name, score }
  }
  return best?.name
}

function commonPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

/** Edit distance with adjacent transpositions (optimal string alignment). */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, d[i - 2]![j - 2]! + 1)
      d[i]![j] = v
    }
  return d[a.length]![b.length]!
}

// ── schema walk ────────────────────────────────────────────────────────────────────────────

interface Def {
  readonly type: string
  readonly shape?: Record<string, z.ZodType>
  readonly innerType?: z.ZodType
  readonly in?: z.ZodType
  readonly getter?: () => z.ZodType
  readonly options?: readonly z.ZodType[]
  readonly discriminator?: string
  readonly element?: z.ZodType
  readonly items?: readonly z.ZodType[]
  readonly rest?: z.ZodType | null
  readonly left?: z.ZodType
  readonly right?: z.ZodType
}

const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def

/**
 * The base schemas `s` may be for the value `raw`: wrappers removed, unions expanded (a
 * discriminated union to the options matching `raw`'s discriminator, if any).
 */
function basesOf(s: z.ZodType, raw: unknown, depth = 0): Def[] {
  if (depth > 20) return []
  const d = defOf(s)
  const inner = (x: z.ZodType | undefined) => (x === undefined ? [] : basesOf(x, raw, depth + 1))
  switch (d.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
      return inner(d.innerType)
    case 'pipe':
      return inner(d.in)
    case 'lazy':
      return inner(d.getter?.())
    case 'intersection':
      return [...inner(d.left), ...inner(d.right)]
    case 'union': {
      const all = (d.options ?? []).flatMap(inner)
      const disc = d.discriminator
      if (disc === undefined || !isRecord(raw)) return all
      const matching = all.filter((o) => {
        const lit = o.shape?.[disc]
        const values = lit === undefined ? undefined : (defOf(lit) as { values?: unknown[] }).values
        return values?.includes(raw[disc]) ?? false
      })
      return matching.length > 0 ? matching : all
    }
    default:
      return [d]
  }
}

/** The schemas of a child (key or index) of the value `raw` of schema `s`. */
function childSchemas(s: z.ZodType, raw: unknown, seg: string | number): z.ZodType[] {
  return basesOf(s, raw).flatMap((d) => {
    const child =
      d.type === 'object' && typeof seg === 'string'
        ? d.shape?.[seg]
        : d.type === 'array'
          ? d.element
          : d.type === 'tuple' && typeof seg === 'number'
            ? (d.items?.[seg] ?? d.rest ?? undefined)
            : undefined
    return child === undefined ? [] : [child]
  })
}

/** The keys of the object at `path` of the args, per the schema (empty when unknown). */
function validKeys(schema: z.ZodType, raw: unknown, path: readonly (string | number)[]): string[] {
  let schemas = [schema]
  let value = raw
  for (const seg of path) {
    schemas = schemas.flatMap((s) => childSchemas(s, value, seg))
    value = isRecord(value) || Array.isArray(value) ? (value as never)[seg] : undefined
  }
  const keys = new Set<string>()
  for (const s of schemas)
    for (const d of basesOf(s, value))
      if (d.type === 'object') for (const k of Object.keys(d.shape ?? {})) keys.add(k)
  return [...keys]
}
