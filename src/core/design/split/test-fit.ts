/**
 * Split parts 4b-3: the Test fit coupon. `design.split.testFit` adds, per clearance, a small new
 * source part: a block of the keyed band's thickness with one outline (the source outline's slot,
 * tabs and tool) and its own split, one line with the source's key kind and that clearance, so
 * its two pieces are the joint on scrap. The coupon is an ordinary split source: the split
 * machinery makes its pieces, the user edits it like any part. Pure sizing in `couponSize`.
 * Doc: docs/modes/split-parts.md#implementation-4b
 */
import { z } from 'zod'
import type { Issue } from '../../../shared/errors/app-error'
import { Err, Ok } from '../../../shared/result'
import { defineCommand, type AnyCommand } from '../../commands/define'
import { STOCK_FACE } from '../../geometry/face'
import { NAME_MAX } from '../../library/item'
import type { SnapshotDTO } from '../../library/snapshot'
import { Fields, invalid, load, PartArg, Src } from '../commands'
import { baseOf } from '../frozen-memo'
import type { OperationDTO, PartDTO, SplitDTO } from '../part.dto'
import { PartIdSchema } from '../part.dto'
import { requirePort } from '../shape'
import { SurfaceTable } from '../surfaces'
import { ownBlock, regeneratePieces, SPLIT_ID } from './commands'
import { derivedPartError } from './derived'
import {
  KEY_CLEARANCE_MAX,
  isKeyKind,
  keyClearance,
  keySize,
  sized,
  type KeyKind,
  type KeySize,
} from './keys'
import { lengthDTO, literal, splitKeys } from './pieces'

/** At most this many coupons per call (side by side clearances, e.g. 0.1, 0.15, 0.2 mm). */
export const TEST_FIT_MAX = 3
/** The coupon's block reaches this far (mm) past its outline on every side. */
const COUPON_STOCK_MARGIN = 5
/** The shortest coupon along its line (mm), and on each side of it. */
const COUPON_ALONG_MIN = 40
const COUPON_SIDE_MIN = 15
/** A key needs this many half widths of run (keys.ts: a third of its share, both sides). */
const RUN_PER_HALF = 6

/** A coupon's outline (mm): its length along the line, its width on each side of it. */
export interface CouponSize {
  readonly along: number
  readonly side: number
  /** The key the coupon's line gets (at the coupon's clearance). */
  readonly key: KeySize
}

const up = (v: number, step: number) => Math.ceil(v / step - 1e-9) * step

/**
 * The coupon outline for a key: long enough along the line that the key keeps its size (a key
 * shrunk on the source to fit its share keeps that neck: the coupon's run is cut to it, to
 * 0.5 mm), and on each side room for the key's depth, the clearance, a wall of one tool Ø and
 * 2 mm. `ref`: the source's key (undefined: none fits there yet, the nominal key).
 */
export function couponSize(
  kind: KeyKind,
  tool: number,
  c: number,
  height: number,
  ref: KeySize | undefined,
): CouponSize {
  const nominal = keySize(kind, tool, c, height, Infinity)!
  const shrunk = ref !== undefined && ref.neck < nominal.neck - 1e-6
  const key = shrunk ? sized(kind, ref.neck, tool, c) : nominal
  const need = RUN_PER_HALF * key.half
  const along = shrunk ? up(need, 0.5) : Math.max(COUPON_ALONG_MIN, up(need, 5))
  const side = Math.max(COUPON_SIDE_MIN, up(key.depth + c + tool + 2, 5))
  return { along, side, key }
}

/** The coupon's name: "<source> · test fit 0.15 mm", the source name cut to fit. */
export function couponName(source: string, clearance: string): string {
  const suffix = ` · test fit ${clearance}`
  return `${source.slice(0, NAME_MAX - suffix.length)}${suffix}`
}

const PieceOut = z.object({
  partId: PartIdSchema,
  name: z.string(),
  index: z.number(),
  blank: z.array(z.number()).describe('Length, width, thickness (mm)'),
})

const testFit = defineCommand({
  kind: 'document',
  name: 'design.split.testFit',
  summary:
    "Add a Test fit coupon per clearance: a small two-piece part with the split's key, cut on scrap first.",
  title: () => 'Test fit',
  machine: false,
  args: z.object({
    ...PartArg,
    clearances: z
      .array(Src)
      .min(1)
      .max(TEST_FIT_MAX)
      .optional()
      .describe("One coupon each; default the split's"),
  }),
  result: z.object({
    parts: z.array(
      z.object({
        partId: PartIdSchema,
        name: z.string(),
        clearance: z.number().describe('mm'),
        size: z.array(z.number()).describe('Block length, width, thickness (mm)'),
        neck: z.number().describe('The key neck (mm)'),
        pieces: z.array(PieceOut),
      }),
    ),
  }),
  run(draft, args, ctx) {
    const where = 'design.split.testFit'
    const loaded = load(draft, args.partId, where)
    if (loaded.isErr()) return loaded
    const l = loaded.unwrap()
    if (l.dto.derivedFrom !== undefined) return derivedPartError(draft, l.dto, where)
    const split = l.dto.split
    if (split === undefined || !isKeyKind(split.joint.kind))
      return invalid(
        [
          {
            path: ['partId'],
            rule: 'keysOnly',
            message: 'Test fit needs a split whose lines are joined by puzzle or dovetail keys',
          },
        ],
        where,
      )
    const kind = split.joint.kind
    const port = requirePort(ctx.services.region2d, where)
    if (port.isErr()) return port
    const planned = splitKeys(l, split, port.unwrap())
    if (planned.isErr()) return Err(planned.unwrapErr().withContext(where))
    const { keys, outlineTool: tool, outline } = planned.unwrap()
    const ref = keys.keys[0]
    const at = ref ?? keys.issues[0]
    if (at === undefined)
      return invalid(
        [
          {
            path: ['partId'],
            rule: 'noKey',
            message: 'no split line has a piece on both sides',
          },
        ],
        where,
      )
    // the clearances: given, else the split's
    const units = draft.unitSystem
    const f = new Fields(l.units, SurfaceTable.build(l.part.operations, l.stock).resolver(0))
    const given = (args.clearances ?? []).map((s, i) => f.q(`clearances.${i}`, 'length', s))
    const done = f.done()
    if (done.isErr()) return Err(done.unwrapErr().withContext(where))
    const issues: Issue[] = []
    given.forEach((q, i) => {
      if (!(q.canonical >= 0 && q.canonical <= KEY_CLEARANCE_MAX))
        issues.push({
          path: ['clearances', i],
          rule: 'range',
          message: `must be between 0 and ${KEY_CLEARANCE_MAX} mm`,
          params: { min: 0, max: KEY_CLEARANCE_MAX },
        })
    })
    if (issues.length > 0) return invalid(issues, where)
    type Len = SplitDTO['margin']
    const clearances: { mm: number; dto: Len }[] =
      given.length > 0
        ? given.map((q) => ({ mm: q.canonical, dto: literal(q.toDTO() as Len, units) }))
        : [
            {
              mm: keyClearance(split),
              dto: literal(split.joint.clearance ?? lengthDTO(keyClearance(split), units), units),
            },
          ]
    const L = (mm: number) => lengthDTO(mm, units)
    const source = baseOf(draft.parts[args.partId]!)
    const outlineDto =
      outline === undefined
        ? undefined
        : (l.dto.operations[outline] as Extract<OperationDTO, { kind: 'profile' }>)
    const sourceStock = baseOf(draft.snapshots[source.stock]) as SnapshotDTO
    const takenAt = new Date(ctx.clock.now()).toISOString()
    const m = COUPON_STOCK_MARGIN
    const out = []
    for (const c of clearances) {
      const size = couponSize(kind, tool, c.mm, at.height, ref?.size)
      const across = 2 * size.side
      const [lx, ly] = at.axis === 'x' ? [across, size.along] : [size.along, across]
      const block = { length: lx + 2 * m, width: ly + 2 * m, thickness: at.height }
      const partId = ctx.ids.next('part')
      const snapshotId = ctx.ids.next('snapshot')
      draft.snapshots[snapshotId] = ownBlock(
        sourceStock,
        block,
        'Coupon',
        snapshotId,
        takenAt,
        units,
      )
      const profile: OperationDTO = {
        kind: 'profile',
        id: 'profile1',
        name: 'Coupon outline',
        on: STOCK_FACE['+z'],
        shape: {
          kind: 'rectangle',
          center: [L(m + lx / 2), L(m + ly / 2)],
          length: L(lx),
          width: L(ly),
          cornerRadius: L(0),
        },
        side: 'outside',
        slotWidth: outlineDto === undefined ? L(tool) : literal(outlineDto.slotWidth, units),
        tabs: {
          count: { kind: 'scalar', source: '4', defaultUnit: '1', exact: { num: '4', den: '1' } },
          width: outlineDto?.tabs
            ? literal(outlineDto.tabs.width, units)
            : L(units === 'inch' ? 6.35 : 6),
          thickness: outlineDto?.tabs
            ? literal(outlineDto.tabs.thickness, units)
            : L(units === 'inch' ? 1.5875 : 2),
        },
        ...(outlineDto?.tool === undefined ? {} : { tool: outlineDto.tool }),
        ...(outlineDto?.toolLocked === undefined ? {} : { toolLocked: outlineDto.toolLocked }),
      } as OperationDTO
      const name = couponName(source.name, L(c.mm).source)
      const part: PartDTO = {
        id: partId,
        name,
        stock: snapshotId,
        ...(source.generalTolerance === undefined
          ? {}
          : { generalTolerance: source.generalTolerance }),
        operations: [profile],
        split: {
          id: SPLIT_ID,
          lines: [{ axis: at.axis, at: L(m + size.side) }],
          levels: [],
          margin: literal(split.margin, units),
          joint: { kind, clearance: c.dto },
        },
      }
      draft.parts[partId] = part
      const r = regeneratePieces(draft, partId, ctx, false, where)
      if (r.isErr()) return r
      out.push({
        partId,
        name,
        clearance: c.mm,
        size: [block.length, block.width, block.thickness],
        neck: size.key.neck,
        pieces: r.unwrap().pieces.map((p) => ({ ...p, blank: [...p.blank] })),
      })
    }
    return Ok({ parts: out })
  },
})

export const TEST_FIT_COMMANDS: readonly AnyCommand[] = [testFit]
