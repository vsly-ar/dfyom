/**
 * Result shaping for agents at the MCP and `dfyom batch` boundary: summaries of the large reads
 * (`plan.get`, `plan.toolpath.get`, `plan.warning.list`, `design.operation.list`,
 * `design.clones.preview`), DFM warnings as changes, tools by name, compact quantities and
 * numbers. The command layer, the GUI's IPC and one-shot CLI calls keep the full results.
 * Doc: docs/architecture/llm-api.md#result-size,
 * #amendment-hardening-df38-df39-df41-x2-agent-friction
 */
import type { z } from 'zod'
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import { Warnings } from '../design/commands'
import { setupToolChanges, toolRuns } from '../plan/tool-runs'
import { QUANTITY_KINDS, UNITS, type QuantityKind } from '../quantity/units'
import type { CommandOutcome } from '../commands/dispatcher'
import type { UnitSystem } from '../project/document'
import type { SessionCallResult } from './session'

/** Reserved arg of the summarized reads: `"summary"` (default) or `"full"`. */
export const DETAIL_KEY = 'detail'
/** Reserved args of `plan.toolpath.get` with `detail: "full"`: a range of its moves. */
export const FROM_KEY = 'from'
export const COUNT_KEY = 'count'
export const DEFAULT_MOVE_COUNT = 500
export const MAX_MOVE_COUNT = 5000

/** Tools that take the reserved `detail` arg, with their default. */
export const DETAIL_DEFAULT: ReadonlyMap<string, 'summary' | 'full'> = new Map([
  ['plan.get', 'summary'],
  ['plan.toolpath.get', 'summary'],
  ['design.shape.get', 'full'],
  ['plan.warning.list', 'summary'],
  ['design.operation.list', 'summary'],
  ['design.clones.preview', 'summary'],
])
/** Tools whose result is summarized unless `detail: "full"`. */
export const SUMMARIZED = new Set(
  [...DETAIL_DEFAULT].filter(([, d]) => d === 'summary').map(([name]) => name),
)

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
  /** A library snapshot of the bound project (`ProjectDoc.snapshots`), to name tools. */
  snapshot?(id: string): unknown
  /** The bound project's unit system (default mm). */
  unitSystem?(): UnitSystem | undefined
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Removes the reserved `detail`/`from`/`count` of a summarized read before dispatch. */
export function splitDetail(
  name: string,
  rawArgs: unknown,
): AppResult<{ args: unknown; view: View }> {
  const dflt = DETAIL_DEFAULT.get(name)
  const view: View = { detail: dflt ?? 'full', from: 0, count: DEFAULT_MOVE_COUNT }
  if (dflt === undefined || !isObj(rawArgs)) return Ok({ args: rawArgs, view })
  const keys = name === 'plan.toolpath.get' ? [DETAIL_KEY, FROM_KEY, COUNT_KEY] : [DETAIL_KEY]
  const args: Obj = {}
  const reserved: Obj = {}
  for (const [k, v] of Object.entries(rawArgs)) (keys.includes(k) ? reserved : args)[k] = v
  const issue = (path: string, rule: string, message: string) =>
    fail('input.malformed', `${name}: ${message}`, {
      where: 'AgentSession',
      issues: [{ path: [path], rule, message }],
    })
  const detail = reserved[DETAIL_KEY] ?? dflt
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
  /** Running `design.part.evaluate` jobs → their part, to shape the outcome's warnings. */
  private evaluations = new Map<string, string>()

  constructor(private readonly session: ShaperSession) {}

  /** The call with its value shaped for an agent; errors pass unchanged. */
  shape(call: SessionCallResult, args: unknown, view: View): SessionCallResult {
    if (call.result.isErr()) return call
    if (this.session.boundKey !== this.key) {
      this.key = this.session.boundKey
      this.seen.clear()
      this.evaluations.clear()
    }
    const outcome = call.result.unwrap()
    let value = outcome.value
    const summary = view.detail === 'summary'
    if (summary && call.name === 'plan.get') value = this.planSummary(value)
    if (call.name === 'plan.toolpath.get')
      value = summary ? toolpathSummary(value) : toolpathRange(value, view)
    if (summary && call.name === 'design.shape.get') value = shapeSummary(value)
    if (call.name === 'plan.warning.list')
      value = summary ? findingGroups(value) : withFindingNext(value)
    if (summary && call.name === 'design.operation.list') value = operationSummary(value)
    if (summary && call.name === 'design.clones.preview') value = previewSummary(value)
    const partId = isObj(args) && typeof args['partId'] === 'string' ? args['partId'] : undefined
    if (call.name === 'design.warning.list' && partId !== undefined && isObj(value))
      this.remember(partId, value['warnings'])
    else if (partId !== undefined && isObj(value) && this.carriesDfmWarnings(call.name))
      value = { ...value, warnings: this.delta(partId, value['warnings']) }
    if (call.name === 'design.part.evaluate' && partId !== undefined && isObj(value))
      if (typeof value['jobId'] === 'string') this.evaluations.set(value['jobId'], partId)
    if (call.name === 'job.wait' || call.name === 'job.get') value = this.evaluationOutcome(value)
    value = this.namedTools(value)
    const applied = this.namedTools(outcome.applied) as Obj | undefined
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

  /**
   * A finished `design.part.evaluate` job (`job.wait`, `job.get`): its outcome's warnings as
   * changes, like an edit's (llm-api.md, DF41 F8).
   */
  private evaluationOutcome(value: unknown): unknown {
    if (!isObj(value) || typeof value['jobId'] !== 'string') return value
    const partId = this.evaluations.get(value['jobId'])
    const outcome = value['outcome']
    if (partId === undefined || !isObj(outcome)) return value
    this.evaluations.delete(value['jobId'])
    const result = outcome['value']
    if (outcome['ok'] !== true || !isObj(result) || !Array.isArray(result['warnings'])) return value
    return {
      ...value,
      outcome: {
        ...outcome,
        value: { ...result, warnings: this.delta(partId, result['warnings']) },
      },
    }
  }

  /**
   * Specific tool references `{ kind: "specific", snapshotId }` with the snapshot's `name` and
   * `diameter`, at any depth (llm-api.md, DF41 F5).
   */
  private namedTools(v: unknown): unknown {
    const session = this.session
    if (session.snapshot === undefined) return v
    const walk = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(walk)
      if (!isObj(x)) return x
      if (x['kind'] === 'specific' && typeof x['snapshotId'] === 'string') {
        const snap = session.snapshot?.(x['snapshotId'])
        const values = isObj(snap) ? snap['values'] : undefined
        if (!isObj(values)) return x
        return {
          ...x,
          ...(typeof values['name'] === 'string' ? { name: values['name'] } : {}),
          ...(values['diameter'] === undefined ? {} : { diameter: values['diameter'] }),
        }
      }
      const out: Obj = {}
      for (const [k, y] of Object.entries(x)) out[k] = walk(y)
      return out
    }
    return walk(v)
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

  /**
   * `plan.get` summary: setups and operations with tool, feeds, times and finding counts; per
   * setup its tool runs and tool changes (DF66).
   */
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
    const warningList = peek('plan.warning.list', { planId })
    const findings = (warningList?.['warnings'] as Obj[]) ?? []
    // DF69: the Z reference per tool run, by its first operation
    const zRefOf = new Map<string, Obj | null>()
    for (const r of (warningList?.['zRefs'] as Obj[] | undefined) ?? [])
      zRefOf.set(r['planOperationId'] as string, (r['zRef'] as Obj | null) ?? null)
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
    const inch = this.session.unitSystem?.() === 'inch'
    // DF69: a length (mm) in the project's units
    const length = (v: number) =>
      inch ? Math.round((v / 25.4) * 1e4) / 1e4 : Math.round(v * 1e3) / 1e3
    const rawSetups = ((plan['setups'] as Obj[]) ?? []).map((s) => ({
      operations: ((s['operations'] as Obj[]) ?? []).map((o) => ({
        id: o['id'] as string,
        tool: typeof o['tool'] === 'string' ? o['tool'] : undefined,
      })),
    }))
    const setups = ((plan['setups'] as Obj[]) ?? []).map((s, si) => {
      let setupSeconds: number | null = 0
      // DF59: the per-side maximum of the current toolpaths' reach past the stock (mm)
      let reach: Record<Side, number> | null = { xMin: 0, xMax: 0, yMin: 0, yMax: 0 }
      const operations = ((s['operations'] as Obj[]) ?? []).map((o) => {
        const id = o['id'] as string
        const listed = ops.get(id)
        const tp = peek('plan.toolpath.get', { planId, planOperationId: id })
        const path = tp?.['toolpath'] as { stats?: { estimatedSeconds?: number } } | null
        const seconds = path?.stats?.estimatedSeconds ?? null
        if (seconds === null || tp?.['stale'] === true) setupSeconds = null
        else if (setupSeconds !== null) setupSeconds += seconds
        const reachOf = isObj(tp?.['overreach']) ? (tp['overreach'] as Record<Side, number>) : null
        if (reachOf === null || tp?.['stale'] === true) reach = null
        else if (reach !== null)
          for (const k of SIDES) reach[k] = Math.max(reach[k], reachOf[k] ?? 0)
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
      // DF66: the tool runs and the tool changes the operator makes (setup start included)
      const secondsOf = new Map(operations.map((o) => [o.id, o.seconds]))
      const toolRunList = toolRuns(rawSetups[si]?.operations ?? []).map((r) => {
        let seconds: number | null = 0
        for (const o of r.operations) {
          const t = secondsOf.get(o.id) ?? null
          seconds = t === null || seconds === null ? null : seconds + t
        }
        const z = zRefOf.get(r.operations[0]!.id)
        const at = z?.['at'] as [number, number] | undefined
        return {
          tool: nameOf(r.tool),
          operations: r.operations.map((o) => o.id),
          seconds,
          ...(z === undefined
            ? {}
            : {
                zRef:
                  z === null
                    ? null
                    : {
                        surface: z['surface'],
                        label: z['label'],
                        level: length(z['level'] as number),
                        at: at === undefined ? null : [length(at[0]), length(at[1])],
                        chosen: z['chosen'],
                      },
              }),
        }
      })
      return {
        id: s['id'],
        name: s['name'],
        direction: s['direction'] ?? '+z',
        rotation: s['rotation'] ?? 0,
        clearanceHeight: s['clearanceHeight'],
        retractHeight: s['retractHeight'],
        overreach: reach === null ? null : overreachIn(reach, inch),
        operations,
        seconds: setupSeconds,
        toolChanges: setupToolChanges(rawSetups, si),
        toolRuns: toolRunList,
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

type Side = 'xMin' | 'xMax' | 'yMin' | 'yMax'
const SIDES: readonly Side[] = ['xMin', 'xMax', 'yMin', 'yMax']

/**
 * A setup's reach past the stock (mm) in the project's units, rounded up to 0.1 mm or 0.01 in
 * (DF59, llm-api.md#result-size).
 */
function overreachIn(mm: Record<Side, number>, inch: boolean): Record<Side, number> {
  const [per, step] = inch ? [1 / 25.4, 100] : [1, 10]
  const up = (v: number) => Math.ceil(v * per * step - 1e-9) / step || 0
  return { xMin: up(mm.xMin), xMax: up(mm.xMax), yMin: up(mm.yMin), yMax: up(mm.yMax) }
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

/**
 * `design.shape.get` with `detail: "summary"`: the items' kinds and scalar fields (lists as
 * their lengths), the resolved shape's numbers without its loops.
 */
function shapeSummary(value: unknown): unknown {
  if (!isObj(value) || !isObj(value['shape'])) return value
  const shape = value['shape']
  const items = Array.isArray(shape['items'])
    ? shape['items'].map((item) =>
        isObj(item)
          ? Object.fromEntries(
              Object.entries(item).map(([k, x]) => [k, Array.isArray(x) ? x.length : x]),
            )
          : item,
      )
    : shape['items']
  const r = value['resolved']
  const resolved = isObj(r)
    ? (() => {
        const { pieces, path: _path, ...rest } = r
        return {
          ...rest,
          ...(Array.isArray(pieces)
            ? {
                pieces: pieces.length,
                holes: pieces.reduce(
                  (n: number, p) =>
                    n + (isObj(p) && Array.isArray(p['holes']) ? p['holes'].length : 0),
                  0,
                ),
              }
            : {}),
        }
      })()
    : r
  return {
    ...value,
    shape: { ...shape, items },
    ...(resolved === undefined ? {} : { resolved }),
    detail: 'summary; detail: "full" (the default) returns the items and resolved loops',
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

// ── plan findings, design operations, Clones previews (DF38, DF39, F11) ──────────────────

/** At most this many groups, and this many plan operation ids per group, in a findings summary. */
export const MAX_FINDING_GROUPS = 40
export const MAX_GROUP_OPERATIONS = 20

/** The next step of an unresolved feed (DF39): the library preset first, it fixes every operation. */
export const FEEDS_NEXT =
  "add a feeds preset for the stock's material class to the library tool (library_tool_update; draft plans follow the library) or enter the values per plan operation (plan_operation_update)"

function findingNext(f: Obj): string | undefined {
  return (f['code'] === 'plan.check' && f['rule'] === 'unresolved') || f['code'] === 'feeds.noData'
    ? FEEDS_NEXT
    : undefined
}

/**
 * `plan.warning.list` with `detail: "full"`: every finding, with `next` where there is one; the
 * Z references without their viewport outline (DF69, docs/modes/z-reference.md#implementation-notes-df69).
 */
function withFindingNext(value: unknown): unknown {
  if (!isObj(value) || !Array.isArray(value['warnings'])) return value
  return {
    ...value,
    ...(Array.isArray(value['zRefs'])
      ? {
          zRefs: value['zRefs'].map((r: unknown) => {
            if (!isObj(r)) return r
            const { outline: _, ...rest } = r
            return rest
          }),
        }
      : {}),
    warnings: value['warnings'].map((f: unknown) => {
      if (!isObj(f)) return f
      const next = findingNext(f)
      return next === undefined ? f : { ...f, next }
    }),
  }
}

/** JSON with sorted keys: equal values give equal strings whatever their key order. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    isObj(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  )
}

/**
 * `plan.warning.list` summary: findings grouped by everything but their plan operation, with a
 * count, the first ids and `next`; counts by severity of all findings (llm-api.md, DF38).
 */
function findingGroups(value: unknown): unknown {
  if (!isObj(value) || !Array.isArray(value['warnings'])) return value
  const groups = new Map<string, { finding: Obj; count: number; ids: string[] }>()
  const counts: Record<string, number> = {}
  for (const f of value['warnings'] as unknown[]) {
    if (!isObj(f)) continue
    const { planOperationId, ...finding } = f
    const severity = String(finding['severity'])
    counts[severity] = (counts[severity] ?? 0) + 1
    const key = stableJson(finding)
    const g = groups.get(key) ?? { finding, count: 0, ids: [] }
    groups.set(key, g)
    g.count++
    if (typeof planOperationId === 'string') g.ids.push(planOperationId)
  }
  const all = [...groups.values()]
  const shown = all.slice(0, MAX_FINDING_GROUPS).map(({ finding, count, ids }) => {
    const { code, severity, rule, field, message, params, ...rest } = finding
    const next = findingNext(finding)
    return {
      code,
      severity,
      rule,
      ...(field === undefined ? {} : { field }),
      message,
      ...(isObj(params) && Object.keys(params).length > 0 ? { params } : {}),
      ...rest,
      ...(next === undefined ? {} : { next }),
      count,
      ...(ids.length > 0 ? { planOperationIds: ids.slice(0, MAX_GROUP_OPERATIONS) } : {}),
      ...(ids.length > MAX_GROUP_OPERATIONS ? { more: ids.length - MAX_GROUP_OPERATIONS } : {}),
    }
  })
  const cut = all.slice(MAX_FINDING_GROUPS)
  return {
    counts,
    groups: shown,
    ...(cut.length > 0
      ? { moreGroups: { groups: cut.length, findings: cut.reduce((n, g) => n + g.count, 0) } }
      : {}),
    ...(value['pendingApply'] === undefined ? {} : { pendingApply: value['pendingApply'] }),
    detail: 'summary: findings grouped across plan operations; detail: "full" lists each finding',
  }
}

/** A quantity DTO or number as mm; undefined otherwise. */
const mm = (q: unknown): number | undefined =>
  typeof q === 'number' ? q : isObj(q) ? rational(q['exact']) : undefined

/** An operation's position: `center`, or its shape's `center`. */
function positionOf(op: Obj): [number, number] | undefined {
  const shape = op['shape']
  const c: unknown = Array.isArray(op['center'])
    ? op['center']
    : isObj(shape) && Array.isArray(shape['center'])
      ? shape['center']
      : undefined
  if (!Array.isArray(c)) return undefined
  const u = mm(c[0])
  const v = mm(c[1])
  return u === undefined || v === undefined ? undefined : [u, v]
}

/** An operation without what a Clones instance changes: ids, name, references and position. */
function unmoved(op: Obj): string {
  const {
    id: _id,
    name: _n,
    featureId: _f,
    featureRole: _r,
    on: _on,
    edgeOf: _e,
    center: _c,
    ...rest
  } = op
  const shape = rest['shape']
  if (isObj(shape)) {
    const { center: _sc, ...unplaced } = shape
    rest['shape'] = unplaced
  }
  return stableJson(rest)
}

const mmRound = (x: number): number => Math.round(x * 1000) / 1000

/**
 * `design.operation.list` summary: Clones instance operations that only move are listed per
 * Clones feature as `{ n, offset }` (id `<featureId>_<n>_<sourceOperationId>`); the others in
 * full (llm-api.md, DF38).
 */
function operationSummary(value: unknown): unknown {
  if (!isObj(value) || !Array.isArray(value['operations'])) return value
  const ops = (value['operations'] as unknown[]).filter(isObj)
  const byId = new Map(ops.map((o) => [o['id'], o]))
  const clones = new Map<
    string,
    { sources: string[]; instances: Map<number, [number, number] | null> }
  >()
  const operations: Obj[] = []
  for (const op of ops) {
    const featureId = op['featureId']
    const role =
      typeof op['featureRole'] === 'string' ? /^(\d+)_(.+)$/.exec(op['featureRole']) : null
    const sourceId = role?.[2]
    const source = sourceId === undefined ? undefined : byId.get(sourceId)
    if (
      typeof featureId !== 'string' ||
      role === null ||
      sourceId === undefined ||
      source === undefined ||
      op['id'] !== `${featureId}_${role[1]}_${sourceId}` ||
      unmoved(op) !== unmoved(source)
    ) {
      operations.push(op)
      continue
    }
    const entry = clones.get(featureId) ?? { sources: [] as string[], instances: new Map() }
    clones.set(featureId, entry)
    if (!entry.sources.includes(sourceId)) entry.sources.push(sourceId)
    const n = Number(role[1])
    const at = positionOf(op)
    const from = positionOf(source)
    const offset: [number, number] | null =
      at === undefined || from === undefined
        ? null
        : [mmRound(at[0] - from[0]), mmRound(at[1] - from[1])]
    if ((entry.instances.get(n) ?? null) === null) entry.instances.set(n, offset)
  }
  if (clones.size === 0) return value
  return {
    ...value,
    operations,
    clones: [...clones].map(([featureId, e]) => ({
      featureId,
      sourceOperationIds: e.sources,
      instances: [...e.instances]
        .sort(([a], [b]) => a - b)
        .map(([n, offset]) => ({ n, ...(offset === null ? {} : { offset }) })),
    })),
    detail:
      'summary: Clones instances that only move are under clones as { n, offset } (id <featureId>_<n>_<sourceOperationId>); detail: "full" lists every operation',
  }
}

/** `design.clones.preview` summary: rows without their drawn `path` (llm-api.md, F11). */
function previewSummary(value: unknown): unknown {
  if (!isObj(value) || !Array.isArray(value['rows'])) return value
  return {
    ...value,
    rows: (value['rows'] as unknown[]).map((r) => {
      if (!isObj(r)) return r
      const { path: _path, ...rest } = r
      return rest
    }),
    detail: 'summary: rows without path; detail: "full" keeps it',
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

/**
 * Quantities compacted, floats rounded and string `stack` keys dropped (an error kept as data
 * inside a result; llm-api.md#a1-compact-results), recursively (a copy; the input is not changed).
 */
export function compact(v: unknown): unknown {
  if (typeof v === 'number') return round(v)
  if (Array.isArray(v)) return v.map(compact)
  if (!isObj(v)) return v
  if (isQuantity(v)) return compactQuantity(v)
  const out: Obj = {}
  for (const [k, x] of Object.entries(v))
    if (k !== 'stack' || typeof x !== 'string') out[k] = compact(x)
  return out
}
