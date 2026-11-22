/**
 * Result shaping for agents at the MCP and `dfyom batch` boundary: summaries of the large reads
 * (`plan.get`, `plan.toolpath.get`), DFM warnings as changes, compact quantities and numbers.
 * The command layer, the GUI's IPC and one-shot CLI calls keep the full results.
 * Doc: docs/architecture/llm-api.md#result-size
 */
import type { z } from 'zod'
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import { Warnings } from '../design/commands'
import { QUANTITY_KINDS, UNITS, type QuantityKind } from '../quantity/units'
import type { CommandOutcome } from '../commands/dispatcher'
import type { SessionCallResult } from './session'

/** Reserved arg of the summarized reads: `"summary"` (default) or `"full"`. */
export const DETAIL_KEY = 'detail'
/** Reserved args of `plan.toolpath.get` with `detail: "full"`: a range of its moves. */
export const FROM_KEY = 'from'
export const COUNT_KEY = 'count'
export const DEFAULT_MOVE_COUNT = 500
export const MAX_MOVE_COUNT = 5000

/** Tools whose result is summarized unless `detail: "full"`. */
export const SUMMARIZED = new Set(['plan.get', 'plan.toolpath.get'])

export interface View {
  readonly detail: 'summary' | 'full'
  readonly from: number
  readonly count: number
}

const FULL_HINT = 'summary; pass detail: "full" for the whole record'
const TOOLPATH_HINT =
  'summary; detail: "full" returns the moves (from, count: a range, default 500), plan_export the gCode'

/** What the shaper reads from the session (the bound project's queries, result schemas). */
export interface ShaperSession {
  readonly boundKey: string | undefined
  /** A query of the bound project, without an action digest. */
  peek(name: string, args: object): AppResult<unknown>
  /** The registry result schema of a tool, if it is a command or query. */
  resultSchema(name: string): z.ZodType | undefined
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Removes the reserved `detail`/`from`/`count` of a summarized read before dispatch. */
export function splitDetail(
  name: string,
  rawArgs: unknown,
): AppResult<{ args: unknown; view: View }> {
  const view: View = { detail: 'summary', from: 0, count: DEFAULT_MOVE_COUNT }
  if (!SUMMARIZED.has(name) || !isObj(rawArgs)) return Ok({ args: rawArgs, view })
  const keys = name === 'plan.toolpath.get' ? [DETAIL_KEY, FROM_KEY, COUNT_KEY] : [DETAIL_KEY]
  const args: Obj = {}
  const reserved: Obj = {}
  for (const [k, v] of Object.entries(rawArgs)) (keys.includes(k) ? reserved : args)[k] = v
  const issue = (path: string, rule: string, message: string) =>
    fail('input.malformed', `${name}: ${message}`, {
      where: 'AgentSession',
      issues: [{ path: [path], rule, message }],
    })
  const detail = reserved[DETAIL_KEY] ?? 'summary'
  if (detail !== 'summary' && detail !== 'full')
    return issue(DETAIL_KEY, 'enum', 'detail must be "summary" or "full"')
  const int = (k: string, dflt: number, max: number): AppResult<number> => {
    const v = reserved[k] ?? dflt
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max)
      return issue(k, 'integer', `${k} must be an integer from 0 to ${max}`)
    return Ok(v)
  }
  const from = int(FROM_KEY, 0, Number.MAX_SAFE_INTEGER)
  if (from.isErr()) return Err(from.unwrapErr())
  const count = int(COUNT_KEY, DEFAULT_MOVE_COUNT, MAX_MOVE_COUNT)
  if (count.isErr()) return Err(count.unwrapErr())
  return Ok({ args, view: { detail, from: from.unwrap(), count: count.unwrap() } })
}

/**
 * One shaper per agent session (MCP session, batch run): it remembers the DFM warnings it last
 * sent per part, so an edit's result lists only what changed.
 */
export class ResultShaper {
  private key: string | undefined
  private seen = new Map<string, Map<string, string>>()

  constructor(private readonly session: ShaperSession) {}

  /** The call with its value shaped for an agent; errors pass unchanged. */
  shape(call: SessionCallResult, args: unknown, view: View): SessionCallResult {
    if (call.result.isErr()) return call
    if (this.session.boundKey !== this.key) {
      this.key = this.session.boundKey
      this.seen.clear()
    }
    const outcome = call.result.unwrap()
    let value = outcome.value
    if (view.detail === 'summary' && call.name === 'plan.get') value = this.planSummary(value)
    if (call.name === 'plan.toolpath.get')
      value = view.detail === 'summary' ? toolpathSummary(value) : toolpathRange(value, view)
    const partId = isObj(args) && typeof args['partId'] === 'string' ? args['partId'] : undefined
    if (call.name === 'design.warning.list' && partId !== undefined && isObj(value))
      this.remember(partId, value['warnings'])
    else if (partId !== undefined && isObj(value) && this.carriesDfmWarnings(call.name))
      value = { ...value, warnings: this.delta(partId, value['warnings']) }
    const applied = outcome.applied as Obj | undefined
    const shapedApplied =
      applied !== undefined && Array.isArray(applied['warnings'])
        ? {
            ...applied,
            warnings: (applied['warnings'] as unknown[]).map((w) =>
              isObj(w) && typeof w['partId'] === 'string'
                ? { partId: w['partId'], ...this.delta(w['partId'], w['warnings']) }
                : w,
            ),
          }
        : applied
    const shaped: CommandOutcome = { value: compact(value), revision: outcome.revision }
    if (shapedApplied !== undefined)
      (shaped as { applied?: unknown }).applied = compact(shapedApplied)
    return { ...call, result: Ok(shaped) }
  }

  private carriesDfmWarnings(name: string): boolean {
    const schema = this.session.resultSchema(name) as { shape?: Obj } | undefined
    return schema?.shape?.['warnings'] === Warnings
  }

  private remember(partId: string, warnings: unknown): void {
    if (Array.isArray(warnings)) this.seen.set(partId, keyed(warnings))
  }

  /**
   * The part's warnings as changes against the ones this session last received for it (all
   * `added` the first time): `count` after the change, `added`/`changed` in full, `removed` by
   * code, operation and parameter. Empty lists are left out.
   */
  private delta(partId: string, warnings: unknown): Obj {
    if (!Array.isArray(warnings)) return { count: 0 }
    const before = this.seen.get(partId) ?? new Map<string, string>()
    const after = keyed(warnings)
    this.seen.set(partId, after)
    const added: unknown[] = []
    const changed: unknown[] = []
    for (const [k, json] of after) {
      const old = before.get(k)
      if (old === undefined) added.push(JSON.parse(json))
      else if (old !== json) changed.push(JSON.parse(json))
    }
    const removed = [...before.entries()]
      .filter(([k]) => !after.has(k))
      .map(([, json]) => {
        const w = JSON.parse(json) as Obj
        return {
          code: w['code'],
          operation: w['operation'],
          ...(w['parameter'] === undefined ? {} : { parameter: w['parameter'] }),
        }
      })
    return {
      count: warnings.length,
      ...(added.length > 0 ? { added } : {}),
      ...(changed.length > 0 ? { changed } : {}),
      ...(removed.length > 0 ? { removed } : {}),
    }
  }

  /** `plan.get` summary: setups and operations with tool, feeds, times and finding counts. */
  private planSummary(value: unknown): unknown {
    const plan = isObj(value) ? value['plan'] : undefined
    if (!isObj(plan)) return value
    const planId = plan['id'] as string
    const peek = (name: string, args: object): Obj | undefined => {
      const r = this.session.peek(name, args)
      return r.isOk() && isObj(r.unwrap()) ? (r.unwrap() as Obj) : undefined
    }
    const ops = new Map<string, Obj>()
    for (const o of (peek('plan.operation.list', { planId })?.['operations'] as Obj[]) ?? [])
      ops.set(o['id'] as string, o)
    const findings = (peek('plan.warning.list', { planId })?.['warnings'] as Obj[]) ?? []
    const countBy = (list: Obj[]) => {
      const c: Record<string, number> = {}
      for (const f of list) c[f['severity'] as string] = (c[f['severity'] as string] ?? 0) + 1
      return c
    }
    const snapshots = (plan['snapshots'] as Obj[]) ?? []
    const nameOf = (id: unknown) => {
      const s = snapshots.find((x) => x['id'] === id)
      const values = s === undefined ? undefined : s['values']
      return isObj(values) && typeof values['name'] === 'string' ? values['name'] : null
    }
    const design = plan['design'] as Obj
    const taken = isObj(design['taken']) ? design['taken'] : {}
    let planSeconds: number | null = 0
    const setups = ((plan['setups'] as Obj[]) ?? []).map((s) => {
      let setupSeconds: number | null = 0
      const operations = ((s['operations'] as Obj[]) ?? []).map((o) => {
        const id = o['id'] as string
        const listed = ops.get(id)
        const tp = peek('plan.toolpath.get', { planId, planOperationId: id })
        const path = tp?.['toolpath'] as { stats?: { estimatedSeconds?: number } } | null
        const seconds = path?.stats?.estimatedSeconds ?? null
        if (seconds === null || tp?.['stale'] === true) setupSeconds = null
        else if (setupSeconds !== null) setupSeconds += seconds
        const feeds = isObj(listed?.['feeds'])
          ? Object.fromEntries(
              Object.entries(listed['feeds'] as Obj).map(([k, f]) => [
                k,
                isObj(f) ? f['value'] : null,
              ]),
            )
          : null
        const own = findings.filter((f) => f['planOperationId'] === id)
        return {
          id,
          kind: listed?.['kind'] ?? null,
          designOperationIds: o['designOperationIds'],
          tool: nameOf(o['tool']),
          feeds,
          seconds,
          toolpath:
            path === null || path === undefined
              ? 'none'
              : tp?.['stale'] === true
                ? 'stale'
                : 'current',
          ...(own.length > 0 ? { findings: countBy(own) } : {}),
        }
      })
      if (setupSeconds === null) planSeconds = null
      else if (planSeconds !== null) planSeconds += setupSeconds
      return {
        id: s['id'],
        name: s['name'],
        ...(s['direction'] === undefined ? {} : { direction: s['direction'] }),
        ...(s['rotation'] === undefined ? {} : { rotation: s['rotation'] }),
        clearanceHeight: s['clearanceHeight'],
        retractHeight: s['retractHeight'],
        operations,
        seconds: setupSeconds,
      }
    })
    return {
      plan: {
        id: planId,
        name: plan['name'],
        status: plan['status'],
        design: {
          partId: design['partId'],
          takenAt: design['takenAt'],
          hash: design['hash'],
          operations: Array.isArray(taken['operations']) ? taken['operations'].length : 0,
          planEdits: JSON.stringify(design['taken']) !== JSON.stringify(design['part']),
        },
        machine: nameOf(plan['machine']),
        stock: nameOf(taken['stock']),
        setups,
        seconds: planSeconds,
        findings: countBy(findings),
      },
      detail: FULL_HINT,
    }
  }
}

/** Identity of a DFM warning: code, operation, parameter, and its index among equal ones. */
function keyed(warnings: readonly unknown[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const w of warnings) {
    if (!isObj(w)) continue
    const base = `${String(w['code'])}|${String(w['operation'])}|${String(w['parameter'] ?? '')}`
    let k = base
    for (let i = 1; out.has(k); i++) k = `${base}|${i}`
    const { pendingApply: _p, ...rest } = w
    out.set(k, JSON.stringify(rest))
  }
  return out
}

interface MoveLike {
  kind: string
  to?: readonly number[]
  at?: readonly number[]
  top?: number
  bottom?: number
}

/** Bounds of the move end points (drills: top and bottom), `null` without moves. */
function bounds(passes: readonly { moves: readonly MoveLike[] }[]) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  const add = (x: number, y: number, z: number) => {
    const p = [x, y, z]
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, p[i]!)
      max[i] = Math.max(max[i]!, p[i]!)
    }
  }
  for (const pass of passes)
    for (const m of pass.moves) {
      if (m.to !== undefined) add(m.to[0]!, m.to[1]!, m.to[2]!)
      else if (m.at !== undefined) {
        add(m.at[0]!, m.at[1]!, m.top ?? 0)
        add(m.at[0]!, m.at[1]!, m.bottom ?? 0)
      }
    }
  return min[0] === Infinity ? null : { min, max }
}

/** `plan.toolpath.get` summary: moves per pass, bounds, lengths and time. */
function toolpathSummary(value: unknown): unknown {
  if (!isObj(value) || !isObj(value['toolpath'])) return value
  const tp = value['toolpath']
  const passes = tp['passes'] as { kind: string; moves: MoveLike[] }[]
  return {
    ...value,
    toolpath: {
      planOperationId: tp['planOperationId'],
      tool: tp['tool'],
      spindleSpeed: tp['spindleSpeed'],
      stats: tp['stats'],
      moves: passes.reduce((n, p) => n + p.moves.length, 0),
      passes: passes.map((p) => ({ kind: p.kind, moves: p.moves.length })),
      bounds: bounds(passes),
    },
    detail: TOOLPATH_HINT,
  }
}

/** `plan.toolpath.get` with `detail: "full"`: the moves `from`…`from + count` across passes. */
function toolpathRange(value: unknown, view: View): unknown {
  if (!isObj(value) || !isObj(value['toolpath'])) return value
  const tp = value['toolpath']
  const passes = tp['passes'] as { kind: string; moves: MoveLike[] }[]
  const total = passes.reduce((n, p) => n + p.moves.length, 0)
  const end = Math.min(total, view.from + view.count)
  const out: { kind: string; first: number; moves: MoveLike[] }[] = []
  let first = 0
  for (const p of passes) {
    const lo = Math.max(view.from, first)
    const hi = Math.min(end, first + p.moves.length)
    if (lo < hi) out.push({ kind: p.kind, first: lo, moves: p.moves.slice(lo - first, hi - first) })
    first += p.moves.length
  }
  return {
    ...value,
    toolpath: { ...tp, passes: out },
    moves: {
      from: view.from,
      count: Math.max(0, end - view.from),
      total,
      next: end < total ? end : null,
    },
  }
}

// ── compact values ─────────────────────────────────────────────────────────────────────────

const KINDS = new Set<string>(QUANTITY_KINDS)
/** Spellings of each kind's canonical unit (factor 1): a literal in them is the plain number. */
const CANONICAL: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  QUANTITY_KINDS.map((k: QuantityKind) => [
    k,
    Object.values(UNITS)
      .filter((u) => u.kind === k && u.factor.toString() === '1')
      .flatMap((u) => u.spellings),
  ]),
)
const DECIMAL = /^[-+]?(\d+\.?\d*|\.\d+)$/

/** 10 significant digits: drops float noise (2.4000000000000004 → 2.4); integers unchanged. */
export function round(n: number): number {
  return Number.isInteger(n) || !Number.isFinite(n) ? n : Number(n.toPrecision(10))
}

const rational = (r: unknown): number | undefined =>
  isObj(r) && typeof r['num'] === 'string' && typeof r['den'] === 'string'
    ? Number(r['num']) / Number(r['den'])
    : undefined

/**
 * A quantity DTO as an agent needs it: the plain number (canonical unit: mm, deg, mm/min, rpm,
 * W) when its source is that literal, else `{ source, value }` (+ `tolerance: { upper, lower }`).
 */
function compactQuantity(q: Obj): unknown {
  const value = rational(q['exact'])!
  const source = String(q['source'])
  const tol = q['tolerance']
  if (!isObj(tol)) {
    let s = source.trim()
    for (const sp of CANONICAL[q['kind'] as string] ?? [])
      if (s.toLowerCase().endsWith(sp)) {
        s = s.slice(0, s.length - sp.length).trim()
        break
      }
    if (DECIMAL.test(s) && Number(s) === value) return round(value)
  }
  return {
    source,
    value: round(value),
    ...(isObj(tol)
      ? {
          tolerance: {
            upper: round(rational(tol['upper'])!),
            lower: round(rational(tol['lower'])!),
          },
        }
      : {}),
  }
}

function isQuantity(v: Obj): boolean {
  return (
    typeof v['kind'] === 'string' &&
    KINDS.has(v['kind']) &&
    typeof v['source'] === 'string' &&
    typeof v['defaultUnit'] === 'string' &&
    rational(v['exact']) !== undefined &&
    Object.keys(v).every((k) => ['kind', 'source', 'defaultUnit', 'exact', 'tolerance'].includes(k))
  )
}

/** Quantities compacted and floats rounded, recursively (a copy; the input is not changed). */
export function compact(v: unknown): unknown {
  if (typeof v === 'number') return round(v)
  if (Array.isArray(v)) return v.map(compact)
  if (!isObj(v)) return v
  if (isQuantity(v)) return compactQuantity(v)
  const out: Obj = {}
  for (const [k, x] of Object.entries(v)) out[k] = compact(x)
  return out
}
