/**
 * Roughing passes in the design (hardening DF122, slice R1): a plain pocket's `roughingPass`
 * owns the roughing pocket `<id>_roughing` (DF108's model generalised), kept right before its
 * owner with the owner's geometry; its tool field is its own. `syncRoughing` is the one writer:
 * the design commands run it on every operation list they write.
 * Doc: docs/modes/roughing.md#model, docs/modes/roughing.md#implementation-r1
 */
import { z } from 'zod'
import { fail, None, type AppResult } from '../../shared/result'
import { deepEqual } from '../library/snapshot'
import {
  operationToDTO,
  roughingOperationId,
  type Operation,
  type Pocket,
  type RoughingMargins,
} from './operation'

/**
 * The `roughing` arg of `design.pocket.add` (and, sketched, `.update`) and the pattern tools:
 * true = on (margins kept, else the defaults), `{ wall, floor }` = on with these margins (an
 * absent one is its default), false or null = off.
 */
const Src = z.string().min(1).max(256) // as commands.ts `Src` (no import cycle)

export const RoughingArg = z.union([
  z.boolean().nullable(),
  z.object({ wall: Src.optional(), floor: Src.optional() }).strict(),
])

export type RoughingArgs = z.output<typeof RoughingArg>

/** The arg's description on the add tools (tools/list budget: one line). */
export const ROUGHING_DESCRIPTION =
  'Bigger tool first (op <id>_roughing); {wall, floor}: stock to leave, default finishAllowance, 0'

/**
 * The margins after `arg` (undefined = off): `prev` when the arg is absent or true and roughing
 * was on; `parse` reads a length source at a path (`roughing.wall`).
 */
export function roughingFromArg(
  arg: RoughingArgs | undefined,
  prev: RoughingMargins | undefined,
  parse: (path: string, source: string) => Quantity,
): RoughingMargins | undefined {
  if (arg === undefined) return prev
  if (arg === null || arg === false) return undefined
  if (arg === true) return prev ?? {}
  return {
    ...(arg.wall === undefined ? {} : { wall: parse('roughing.wall', arg.wall) }),
    ...(arg.floor === undefined ? {} : { floor: parse('roughing.floor', arg.floor) }),
  }
}

type Quantity = NonNullable<RoughingMargins['wall']>

/** A plain pocket's roughing pocket (owned by `roughingOf`, not by a feature). */
export const isOwnedRoughing = (op: Operation): boolean =>
  op.kind === 'pocket' && op.roughing === true && op.roughingOf !== undefined && op.owner.isNone()

/** A plain pocket with a roughing setting. */
const isRoughingOwner = (op: Operation): boolean =>
  op.kind === 'pocket' && op.roughing !== true && op.owner.isNone() && op.roughingPass !== undefined

/** Default name of a roughing pocket: "Pocket 1 · roughing" (as a feature's owned operation). */
export const roughingName = (ownerName: string): string => `${ownerName} · roughing`

/**
 * The operations with every roughing owner's `<id>_roughing` right before it, its geometry the
 * owner's (on, shape, depth, floor radius, Through) and its margins the owner's (`leave`); its
 * tool field, a custom name and its general tolerance are kept. Roughing pockets of an owner
 * that is gone or has roughing off are dropped. An unchanged roughing pocket keeps its object
 * (so its record is kept), and a list without roughing comes back as a copy of itself.
 */
export function syncRoughing(ops: readonly Operation[]): Operation[] {
  if (!ops.some((o) => isOwnedRoughing(o) || isRoughingOwner(o))) return [...ops]
  const prev = new Map<string, Pocket>()
  for (const o of ops) if (isOwnedRoughing(o)) prev.set((o as Pocket).roughingOf!, o as Pocket)
  const out: Operation[] = []
  for (const o of ops) {
    if (isOwnedRoughing(o)) continue
    if (isRoughingOwner(o)) out.push(roughingFor(o as Pocket, prev.get(o.id)))
    out.push(o)
  }
  return out
}

function roughingFor(owner: Pocket, old: Pocket | undefined): Pocket {
  const leave = owner.roughingPass!
  const custom = old !== undefined && !old.name.endsWith(' · roughing')
  const built: Pocket = {
    kind: 'pocket',
    id: roughingOperationId(owner.id),
    name: custom ? old.name : roughingName(owner.name),
    generalTolerance: old?.generalTolerance ?? { length: None, angle: None },
    on: owner.on,
    tool: old?.tool ?? None,
    toolLocked: old?.toolLocked ?? false,
    owner: owner.owner,
    shape: owner.shape,
    depth: owner.depth,
    floorRadius: owner.floorRadius,
    ...(owner.through === true ? { through: true } : {}),
    roughing: true,
    roughingOf: owner.id,
    ...(leave.wall === undefined && leave.floor === undefined ? {} : { leave }),
  }
  return old !== undefined && deepEqual(operationToDTO(old), operationToDTO(built)) ? old : built
}

/**
 * `design.featureOwned` (rule `roughingOwned`) for a roughing pocket: its geometry, order and
 * life go through its owner's `roughing` (its name and tool stay its own).
 */
export function roughingOwnedError(op: Pocket, ownerName: string, where: string): AppResult<never> {
  return fail(
    'design.featureOwned',
    `${op.id} is the roughing pass of ${ownerName} (${op.roughingOf}); change that pocket's roughing instead`,
    {
      issues: [
        {
          path: ['operationId'],
          rule: 'roughingOwned',
          message: `edited through ${ownerName}'s roughing`,
          params: { operationId: op.roughingOf! },
        },
      ],
      data: { operationId: op.id, ownerId: op.roughingOf },
      where,
    },
  )
}
