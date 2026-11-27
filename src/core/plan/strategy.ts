/**
 * Pass strategy parameters per operation kind: which keys a kind takes, parsing them as
 * entered, their defaults (resolved on evaluation, never stored) and their constraints.
 * Doc: docs/modes/plan-v0.1.md#pass-strategies-v01
 *
 * Resolved values are float64 in canonical units (mm, °), as the toolpath generators use them.
 */
import { z } from 'zod'
import type { Issue } from '../../shared/errors/app-error'
import { collect, fail, None, type AppResult, type Option } from '../../shared/result'
import {
  chamferDiameter,
  fieldContext,
  isGeneralShape,
  isLoopChamferOp,
  lineDeepest,
  type Operation,
} from '../design/operation'
import type { OperationKind } from '../design/part.dto'
import { chamferEdge } from '../design/geometry-input'
import { SurfaceTable } from '../design/surfaces'
import { chamferDepth, chamferTerraces, loopChamferDepth } from '../geometry/model'
import type { MaterialClass } from '../library/item'
import type { Stock } from '../library/stock'
import type { CuttingPreset, Tool } from '../library/tool'
import type { UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import {
  DIRECTIONS,
  DRILL_CYCLES,
  FACING_AXES,
  FACING_PATTERNS,
  ENTRIES,
  type StrategyDTO,
} from './plan.dto'

export type StrategyKey = keyof StrategyDTO

/** Strategy parameters each operation kind accepts. */
export const STRATEGY_KEYS: Readonly<Record<OperationKind, readonly StrategyKey[]>> = {
  facing: ['direction', 'pattern', 'axis', 'overshoot'],
  pocket: [
    'direction',
    'entry',
    'helixDiameter',
    'rampAngle',
    'finishAllowance',
    'finishStepdown',
    'breakthrough',
  ],
  drilling: ['cycle', 'peckDepth', 'chipBreakBack', 'helixPitch', 'rampAngle', 'breakthrough'],
  profile: ['direction', 'entry', 'rampAngle', 'breakthrough', 'finishAllowance', 'finishStepdown'],
  // plan-v0.4.md § Chamfer toolpath; `dwell` is later (needs a dwell move, T1)
  chamfer: ['entry', 'rampAngle'],
  // Line (engraved-patterns.md § Toolpath): ramp-back (default) or plunge (V-bits, tapered balls)
  line: ['entry', 'rampAngle'],
}

const LENGTH_KEYS = [
  'overshoot',
  'helixDiameter',
  'finishAllowance',
  'finishStepdown',
  'peckDepth',
  'chipBreakBack',
  'helixPitch',
  'breakthrough',
] as const
type LengthKey = (typeof LENGTH_KEYS)[number]

const Src = z.string().min(1).max(256)
const clear = <S extends z.ZodType>(s: S) => s.nullable().optional()

/** `strategy` arg of `plan.operation.update`: values as entered; `null` clears (default). */
export const StrategyArgSchema = z
  .object({
    direction: clear(z.enum(DIRECTIONS)).describe('climb (default) or conventional'),
    pattern: clear(z.enum(FACING_PATTERNS)).describe('Facing: zigzag (default) or oneWay'),
    axis: clear(z.enum(FACING_AXES)).describe('Facing: x (default, along length) or y'),
    overshoot: clear(Src).describe('Facing: tool edge past the stock edge; default 1 mm / 0.04"'),
    entry: clear(z.enum(ENTRIES)).describe(
      'Pocket: helix (default), ramp or plunge; profile/line: ramp (default) or plunge; chamfer: plunge or contour (default: plunge when DC ≥ the chamfer Ø)',
    ),
    helixDiameter: clear(Src).describe('Pocket: default 0.8 D'),
    rampAngle: clear(Src).describe(
      'Pocket/profile/drilling (helix)/chamfer (contour)/line: 0.5°–30°, default 3°, line 10°',
    ),
    finishAllowance: clear(Src).describe(
      'Pocket/profile: default 0.2 mm / 0.008" (wood 0.5 mm / 0.02"); 0 = none',
    ),
    finishStepdown: clear(Src).describe(
      'Pocket/profile: default the depth, ≤ flute length (wood also ≤ 2 D)',
    ),
    cycle: clear(z.enum(DRILL_CYCLES)).describe(
      'Drilling: simple, peck or chipBreak (drill), helix (end mill)',
    ),
    peckDepth: clear(Src).describe('Drilling: default DC'),
    chipBreakBack: clear(Src).describe('Drilling: default 0.5 mm / 0.02"'),
    helixPitch: clear(Src).describe('Drilling (helix): default preset stepdown, else 0.25 DC'),
    breakthrough: clear(Src).describe('Through drilling/profile/pocket: default 0.5 mm / 0.02"'),
  })
  .describe('Pass strategy parameters; omitted keys stay, null resets to the default')
export type StrategyArgs = z.output<typeof StrategyArgSchema>

/**
 * The stored strategy after applying `args` (as entered) for an operation of `kind`. Keys of
 * another kind are `input.malformed` (rule `notForKind`); values are parsed in the project's unit
 * system. Constraints are checked separately (`strategyIssues`).
 */
export function applyStrategyArgs(
  kind: OperationKind,
  current: StrategyDTO,
  args: StrategyArgs,
  units: UnitSystem,
): AppResult<StrategyDTO> {
  const allowed = STRATEGY_KEYS[kind]
  const issues: Issue[] = []
  const next: Record<string, unknown> = { ...current }
  const parsed: AppResult<unknown>[] = []
  for (const [key, value] of Object.entries(args) as [StrategyKey, unknown][]) {
    if (value === undefined) continue
    if (!allowed.includes(key)) {
      issues.push({
        path: ['strategy', key],
        rule: 'notForKind',
        message: `not a strategy parameter of a ${kind} operation`,
      })
      continue
    }
    if (value === null) delete next[key]
    else if (key === 'rampAngle' || (LENGTH_KEYS as readonly string[]).includes(key)) {
      const q = Quantity.parse(
        value as string,
        fieldContext(key === 'rampAngle' ? 'angle' : 'length', units),
      ).mapErr((e) => e.prefixIssues('strategy', key))
      parsed.push(q)
      if (q.isOk()) next[key] = q.unwrap().toDTO()
    } else next[key] = value
  }
  if (issues.length > 0)
    return fail('input.malformed', `${issues.length} strategy parameter(s) not for a ${kind}`, {
      issues,
      where: 'plan.operation.update',
    })
  return collect(parsed).map(() => next as StrategyDTO)
}

// ── resolution ───────────────────────────────────────────────────────────────────────────

/** Metric / inch defaults in mm (0.04″ = 1.016 mm). */
const DEF = {
  overshoot: { mm: 1, inch: 1.016 },
  finishAllowance: { mm: 0.2, inch: 0.2032 },
  /** Softwood and hardwood stock (DF76): 0.5 mm / 0.02″. */
  woodFinishAllowance: { mm: 0.5, inch: 0.508 },
  chipBreakBack: { mm: 0.5, inch: 0.508 },
  breakthrough: { mm: 0.5, inch: 0.508 },
} as const
const RAMP_ANGLE = 3
/** A Line's default ramp angle (engraved-patterns.md § Line operation, the chamfer's range). */
export const LINE_RAMP_ANGLE = 10

type Direction = (typeof DIRECTIONS)[number]

export type ResolvedStrategy =
  | {
      readonly kind: 'line'
      /** Ramp-back entry (default) or a straight plunge (V-bits and tapered balls only). */
      readonly entry: 'ramp' | 'plunge'
      readonly rampAngle: number
      /** The deepest point of the groove (mm): F10's `depth` for a V-bit's feeds. */
      readonly cutDepth: number
    }
  | {
      readonly kind: 'chamfer'
      /**
       * `auto` (absent) resolved: plunge when DC covers the chamfer and the tip stays in the edge;
       * `stepped` for a chamfer with a stepdown (F7, never stored).
       */
      readonly entry: 'plunge' | 'contour' | 'stepped'
      readonly rampAngle: number
      /** The cut's depth below the tool tip (mm): F10's `depth` for the feeds (P-D). */
      readonly cutDepth: number
    }
  | {
      readonly kind: 'facing'
      readonly direction: Direction
      readonly pattern: 'zigzag' | 'oneWay'
      readonly axis: 'x' | 'y'
      readonly overshoot: number
    }
  | {
      readonly kind: 'pocket'
      readonly direction: Direction
      readonly entry: 'helix' | 'ramp' | 'plunge'
      readonly helixDiameter: number
      readonly rampAngle: number
      readonly finishAllowance: number
      readonly finishStepdown: number
      /** A through pocket's (patterns P4) only; absent on a blind pocket. */
      readonly breakthrough?: number
    }
  | {
      readonly kind: 'drilling'
      readonly cycle: 'simple' | 'peck' | 'chipBreak' | 'helix'
      readonly peckDepth: number
      readonly chipBreakBack: number
      readonly helixPitch: number
      /** Steepest helix slope (`helix` only), as the pocket's. */
      readonly rampAngle: number
      /** Helix direction (`helix` only); not settable in v0.1, always `climb`. */
      readonly direction: Direction
      readonly breakthrough: number
    }
  | {
      readonly kind: 'profile'
      readonly direction: Direction
      readonly entry: 'ramp' | 'plunge'
      readonly rampAngle: number
      readonly breakthrough: number
      readonly finishAllowance: number
      readonly finishStepdown: number
    }

/**
 * Stock classes with the wood finishing defaults (DF76): grain that tears at the top edge.
 * Doc: docs/modes/plan-v0.1.md#finishing-defaults-hardening-df75-df76
 */
export const WOOD_CLASSES: ReadonlySet<MaterialClass> = new Set(['softwood', 'hardwood'])

/**
 * The default finishing allowance in mm (0.2 mm / 0.008″, wood 0.5 mm / 0.02″, DF76): what an
 * unset `finishAllowance` resolves to, and the default wall margin of a roughing pass (DF122,
 * shown as "Auto · 0.5 mm" in the design inspector). Doc: docs/modes/plan-v0.1.md#pass-strategies-v01
 */
export const defaultFinishAllowance = (material: MaterialClass, units: UnitSystem): number =>
  (WOOD_CLASSES.has(material) ? DEF.woodFinishAllowance : DEF.finishAllowance)[units]

/**
 * Default finish stepdown (DF75, DF76): the cut depth, at most the flute length and, in wood,
 * at most 2 × D; without a tool the depth. The levels split the depth equally (`levels`).
 */
function finishStepdownDefault(depth: number, tool: Option<Tool>, wood: boolean): number {
  return tool.mapOr(depth, (t) =>
    Math.min(depth, t.fluteLength.canonical, wood ? 2 * t.diameter.canonical : Infinity),
  )
}

export interface StrategyContext {
  readonly ops: readonly Operation[]
  readonly allOps: readonly Operation[]
  readonly stock: Stock
  readonly units: UnitSystem
  readonly tool: Option<Tool>
  readonly preset: Option<CuttingPreset>
}

const mm = (dto: StrategyDTO[LengthKey] | StrategyDTO['rampAngle']): Option<number> =>
  dto === undefined
    ? None
    : Quantity.fromDTO(dto)
        .ok()
        .map((q) => q.canonical)

/** Depth below the operation's `on` surface to the hole/floor bottom (mm), for drilling cycles. */
export function holeDepth(
  op: Extract<Operation, { kind: 'drilling' }>,
  allOps: readonly Operation[],
  stock: Stock,
): number {
  if (op.bottom !== 'through' && op.depth.isSome()) return op.depth.unwrap().canonical
  return materialBelow(op.on, allOps, stock)
}

/** The material below the surface `on` along its normal (mm; the stock thickness on the top). */
function materialBelow(on: string, allOps: readonly Operation[], stock: Stock): number {
  const table = SurfaceTable.of(allOps, stock)
  return table
    .get(on)
    .mapOr(stock.thickness.canonical, (e) => e.faceZ.add(table.extent(e.direction)).toNumber())
}

/** Every parameter with its default (docs/modes/plan-v0.1.md#pass-strategies-v01). */
export function resolveStrategy(
  kind: OperationKind,
  s: StrategyDTO,
  c: StrategyContext,
): ResolvedStrategy {
  const D = c.tool.mapOr(0, (t) => t.diameter.canonical)
  const u = c.units
  const direction = s.direction ?? 'climb'
  const rampAngle = mm(s.rampAngle).unwrapOr(RAMP_ANGLE)
  const wood = WOOD_CLASSES.has(c.stock.material.class)
  const finishAllowance = mm(s.finishAllowance).unwrapOr(
    defaultFinishAllowance(c.stock.material.class, u),
  )
  const breakthrough = mm(s.breakthrough).unwrapOr(DEF.breakthrough[u])
  switch (kind) {
    case 'facing':
      return {
        kind,
        direction,
        pattern: s.pattern ?? 'zigzag',
        axis: s.axis ?? 'x',
        overshoot: mm(s.overshoot).unwrapOr(DEF.overshoot[u]),
      }
    case 'pocket': {
      const op = c.ops[0]
      // a through pocket (patterns P4): the material below `on` + breakthrough
      const through = op?.kind === 'pocket' && op.through === true
      const depth =
        op?.kind !== 'pocket'
          ? 0
          : through
            ? materialBelow(op.on, c.allOps, c.stock) + breakthrough
            : op.depth.canonical
      return {
        kind,
        direction,
        entry: s.entry === 'ramp' || s.entry === 'plunge' ? s.entry : 'helix',
        helixDiameter: mm(s.helixDiameter).unwrapOr(0.8 * D),
        rampAngle,
        finishAllowance,
        finishStepdown: mm(s.finishStepdown).unwrapOr(finishStepdownDefault(depth, c.tool, wood)),
        ...(through ? { breakthrough } : {}),
      }
    }
    case 'drilling': {
      const op = c.ops[0]
      const depth = op?.kind === 'drilling' ? holeDepth(op, c.allOps, c.stock) : 0
      const isDrill = c.tool.mapOr(true, (t) => t.type === 'drill')
      const presetStepdown = c.preset.andThen((p) => p.stepdown).map((q) => q.canonical)
      return {
        kind,
        cycle: s.cycle ?? (!isDrill ? 'helix' : depth > 3 * D ? 'peck' : 'simple'),
        peckDepth: mm(s.peckDepth).unwrapOr(D),
        chipBreakBack: mm(s.chipBreakBack).unwrapOr(DEF.chipBreakBack[u]),
        helixPitch: mm(s.helixPitch).unwrapOr(presetStepdown.unwrapOr(0.25 * D)),
        rampAngle,
        direction: 'climb',
        breakthrough,
      }
    }
    case 'profile': {
      const op = c.ops[0]
      // the groove depth, else the material below `on` + breakthrough (the levels split the cut)
      const depth =
        op?.kind === 'profile'
          ? op.depth.mapOr(
              materialBelow(op.on, c.allOps, c.stock) + breakthrough,
              (d) => d.canonical,
            )
          : 0
      return {
        kind,
        direction,
        entry: s.entry === 'plunge' ? 'plunge' : 'ramp',
        rampAngle,
        breakthrough,
        finishAllowance,
        finishStepdown: mm(s.finishStepdown).unwrapOr(finishStepdownDefault(depth, c.tool, wood)),
      }
    }
    case 'line':
      return {
        kind,
        entry: s.entry === 'plunge' ? 'plunge' : 'ramp',
        rampAngle: mm(s.rampAngle).unwrapOr(LINE_RAMP_ANGLE),
        cutDepth: c.ops.reduce((m, op) => {
          if (op.kind !== 'line') return m
          return Math.max(m, lineDeepest(op.depth))
        }, 0),
      }
    case 'chamfer': {
      const tool = c.tool.isSome() ? c.tool.unwrap() : undefined
      const plunge = c.ops.every((op) => {
        if (op.kind !== 'chamfer' || tool === undefined) return false
        const cut = chamferCuts(op, c.allOps, c.stock, tool)
        return cut !== undefined && cut.plungeFits && cut.plungeDepth <= cut.edgeDepth + EPS
      })
      const op = c.ops[0]
      // F7: terraces by a flat end mill; the feeds see one terrace's height
      const terraces =
        op?.kind === 'chamfer' && op.stepdown.isSome() ? steppedTerraces(op, c.allOps) : null
      // a general edge (edge-chamfers.md E1) enters in the air beside the edge: `contour` only
      const loop = op?.kind === 'chamfer' && isLoopChamferOp(op, c.allOps)
      const entry =
        terraces !== null
          ? 'stepped'
          : loop
            ? 'contour'
            : s.entry === 'plunge' || s.entry === 'contour'
              ? s.entry
              : plunge
                ? 'plunge'
                : 'contour'
      const cut =
        op?.kind === 'chamfer' && tool !== undefined
          ? chamferCuts(op, c.allOps, c.stock, tool)
          : undefined
      return {
        kind,
        entry,
        rampAngle,
        cutDepth:
          terraces !== null
            ? (terraces?.height ?? 0)
            : loop
              ? loopChamferDepth({ width: op.width.canonical, angle: op.angle.canonical })
              : cut === undefined
                ? 0
                : entry === 'plunge'
                  ? cut.plungeDepth
                  : cut.contourDepth,
      }
    }
  }
}

/** Float slack for comparisons of derived float64 values. */
const EPS = 1e-9
/** Tool sizes compare within this (mm), as the fit rule (tool-fit.ts). */
const FIT_TOL = 0.01

/** A stepped chamfer's terraces (F7); undefined when its edge is not round or gives no cone. */
function steppedTerraces(
  op: Extract<Operation, { kind: 'chamfer' }>,
  allOps: readonly Operation[],
): { readonly count: number; readonly height: number } | undefined {
  const edge = chamferEdge(allOps, op.edgeOf)
  if (edge === undefined || op.stepdown.isNone()) return undefined
  return chamferTerraces(
    {
      edgeDiameter: edge.diameter,
      diameter: chamferDiameter(
        op,
        allOps.find((o) => o.id === op.edgeOf),
      )!.toNumber(),
      angle: op.angle.canonical,
    },
    op.stepdown.unwrap().canonical,
  )
}

/**
 * The tip depth below its face of a chamfer along a general edge (edge-chamfers.md E1): width /
 * tan(α / 2), whatever the tool (one ring in the air beside the edge); undefined for a circular
 * chamfer (`chamferCuts`).
 */
export function loopCut(
  op: Extract<Operation, { kind: 'chamfer' }>,
  allOps: readonly Operation[],
): number | undefined {
  return isLoopChamferOp(op, allOps)
    ? loopChamferDepth({ width: op.width.canonical, angle: op.angle.canonical })
    : undefined
}

/** A chamfer's cuts with `tool` (mm below its face); undefined when the edge is not round. */
export interface ChamferCuts {
  readonly edgeDiameter: number
  /** The chamfer's diameter at the face: edge Ø + 2 × width (D45). */
  readonly diameter: number
  /** DC covers the chamfer Ø (within 0.01 mm): it can be plunged. */
  readonly plungeFits: boolean
  /** Plunged tip: where the tool cone has the chamfer's Ø at the face. */
  readonly plungeDepth: number
  /** Contoured tip: the chamfer's own depth. */
  readonly contourDepth: number
  /** The edge's bottom (a pocket's or blind hole's depth; Infinity through). */
  readonly edgeDepth: number
}

export function chamferCuts(
  op: Extract<Operation, { kind: 'chamfer' }>,
  allOps: readonly Operation[],
  stock: Stock,
  tool: Tool,
): ChamferCuts | undefined {
  const edgeOp = allOps.find((o) => o.id === op.edgeOf)
  const edge = chamferEdge(allOps, op.edgeOf)
  if (edge === undefined || edgeOp === undefined) return undefined
  const D = chamferDiameter(op, edgeOp)!.toNumber()
  const angle = op.angle.canonical
  const edgeDepth =
    edgeOp.kind === 'drilling'
      ? edgeOp.bottom === 'through'
        ? Infinity
        : holeDepth(edgeOp, allOps, stock)
      : edgeOp.kind === 'pocket'
        ? edgeOp.depth.canonical
        : Infinity // an inside circle profile cuts through
  return {
    edgeDiameter: edge.diameter,
    diameter: D,
    plungeFits: tool.diameter.canonical + FIT_TOL >= D,
    plungeDepth: chamferDepth({ edgeDiameter: tool.tipDiameterMm, diameter: D, angle }),
    contourDepth: chamferDepth({ edgeDiameter: edge.diameter, diameter: D, angle }),
    edgeDepth,
  }
}

/**
 * Constraint violations of the resolved strategy (paths `strategy.<key>`). Tool-dependent rules
 * apply only with a tool.
 */
export function strategyIssues(
  kind: OperationKind,
  s: StrategyDTO,
  r: ResolvedStrategy,
  c: StrategyContext,
): Issue[] {
  const issues: Issue[] = []
  const bad = (key: string, rule: string, message: string, params?: Record<string, unknown>) =>
    issues.push({ path: ['strategy', key], rule, message, ...(params && { params }) })
  const set = (k: StrategyKey) => s[k] !== undefined
  const tool = c.tool
  if (kind === 'profile' && (s.entry === 'helix' || s.entry === 'contour'))
    bad('entry', 'notForKind', 'a profile enters by ramp or plunge')
  if (kind === 'pocket' && s.entry === 'contour')
    bad('entry', 'notForKind', 'a pocket enters by helix, ramp or plunge')
  if (kind === 'line' && (s.entry === 'helix' || s.entry === 'contour'))
    bad('entry', 'notForKind', 'a line enters by a ramp or a plunge')
  if (
    kind === 'line' &&
    s.entry === 'plunge' &&
    tool.isSome() &&
    // a tapered ball's small tip is backed by its cone (tapered-ball-nose.md#line-operation)
    tool.unwrap().type !== 'chamferMill' &&
    tool.unwrap().type !== 'taperedBallEndMill'
  )
    bad(
      'entry',
      'linePlunge',
      'only a V-bit or a tapered ball plunges into a line; ramp with a ball or flat end mill',
    )
  if (kind === 'chamfer' && (s.entry === 'helix' || s.entry === 'ramp'))
    bad('entry', 'notForKind', 'a chamfer is plunged or contoured')
  if (r.kind === 'chamfer' && r.entry === 'stepped' && s.entry !== undefined)
    bad('entry', 'stepped', 'a stepped chamfer is cut in terraces (no plunge or contour)')
  if (
    kind === 'chamfer' &&
    s.entry === 'plunge' &&
    c.ops.some((op) => op.kind === 'chamfer' && isLoopChamferOp(op, c.allOps))
  )
    bad(
      'entry',
      'loopEntry',
      'a chamfer along a general edge enters in the air beside the edge (contour), not by a plunge',
    )
  if ('rampAngle' in r && (r.rampAngle < 0.5 || r.rampAngle > 30))
    bad('rampAngle', 'range', 'must be 0.5° to 30°', { min: 0.5, max: 30 })
  if ('finishAllowance' in r && r.finishAllowance < 0)
    bad('finishAllowance', 'nonNegative', 'must be ≥ 0')
  if ('breakthrough' in r && (r.breakthrough ?? 0) < 0)
    bad('breakthrough', 'nonNegative', 'must be ≥ 0')
  if (r.kind === 'facing' && r.overshoot < 0) bad('overshoot', 'nonNegative', 'must be ≥ 0')
  if (r.kind === 'pocket' || r.kind === 'profile') {
    if (set('finishStepdown') && r.finishStepdown <= 0)
      bad('finishStepdown', 'positive', 'must be > 0')
    tool.map((t) => {
      if (set('finishStepdown') && r.finishStepdown > t.fluteLength.canonical)
        bad('finishStepdown', 'fluteLength', 'must be at most the flute length', {
          max: t.fluteLength.canonical,
        })
    })
  }
  if (r.kind === 'pocket') {
    if (set('helixDiameter') && r.helixDiameter <= 0)
      bad('helixDiameter', 'positive', 'must be > 0')
    tool.map((t) => {
      const op = c.ops[0]
      // general shapes: the narrowest size needs the 2D layer (T3)
      if (
        op?.kind === 'pocket' &&
        op.shape.kind !== 'named' &&
        !isGeneralShape(op.shape) &&
        r.entry === 'helix' &&
        set('helixDiameter')
      ) {
        const narrowest =
          op.shape.kind === 'circle'
            ? op.shape.diameter.canonical
            : Math.min(op.shape.length.canonical, op.shape.width.canonical)
        if (r.helixDiameter + t.diameter.canonical > narrowest)
          bad('helixDiameter', 'fits', 'helix diameter + D must fit the narrowest pocket size', {
            max: narrowest - t.diameter.canonical,
          })
      }
    })
  }
  if (r.kind === 'drilling') {
    for (const k of ['peckDepth', 'chipBreakBack', 'helixPitch'] as const)
      if (set(k) && r[k] <= 0) bad(k, 'positive', 'must be > 0')
    tool.map((t) => {
      const drillCycle = r.cycle !== 'helix'
      if (drillCycle !== (t.type === 'drill'))
        bad(
          'cycle',
          'toolType',
          t.type === 'drill'
            ? 'a drill uses simple, peck or chipBreak'
            : 'an end mill bores with helix',
        )
    })
  }
  if (r.kind === 'chamfer' && r.entry !== 'stepped' && s.entry === 'plunge')
    tool.map((t) => {
      for (const op of c.ops) {
        if (op.kind !== 'chamfer') continue
        const cut = chamferCuts(op, c.allOps, c.stock, t)
        if (cut === undefined) continue
        if (!cut.plungeFits)
          bad('entry', 'plungeSize', 'a plunge needs a tool diameter ≥ the chamfer diameter', {
            diameter: t.diameter.canonical,
            chamfer: cut.diameter,
          })
        else if (cut.plungeDepth > cut.edgeDepth + EPS)
          bad('entry', 'plungeDepth', "the plunged tip would go below the edge's bottom", {
            depth: cut.plungeDepth,
            edgeDepth: cut.edgeDepth,
          })
      }
    })
  return issues
}
