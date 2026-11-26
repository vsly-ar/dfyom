/**
 * Roughing passes in the design (hardening DF122, slices R1, R4): a plain pocket's or an
 * `inside`/`outside` profile's `roughingPass` owns the roughing operation `<id>_roughing` (DF108's
 * model generalised), kept right before its owner with the owner's geometry; its tool field is its
 * own. `syncRoughing` is the one writer: the design commands run it on every operation list they
 * write.
 * Doc: docs/modes/roughing.md#model, docs/modes/roughing.md#implementation-r1,
 * docs/modes/roughing.md#implementation-r4
 */
import { z } from 'zod'
import { fail, None, type AppResult } from '../../shared/result'
import { deepEqual } from '../library/snapshot'
import type { UnitSystem } from '../project/document'
import {
  operationToDTO,
  roughingOperationId,
  type Operation,
  type Pocket,
  type Profile,
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

/** DF122 R4 (Q142): a through profile's default skin under its roughing: 0.5 mm / 0.02″. */
export const DEFAULT_SKIN: Readonly<Record<UnitSystem, number>> = { mm: 0.5, inch: 0.508 }

/**
 * How far above its floor a roughing profile stops (mm): its `leave.floor`, by default 0 for a
 * step and the skin (`DEFAULT_SKIN`) for a through profile. A through profile with tabs stops at
 * least at the tabs' top, so the owner's tabs keep their thickness and stay the only tabs (nothing
 * comes loose before they exist). Doc: docs/modes/roughing.md#implementation-r4
 */
export function roughingSkin(op: Profile, units: UnitSystem): number {
  const set = op.leave?.floor?.canonical
  if (op.depth.isSome()) return set ?? 0
  const tabs = op.tabs.positions.isSome()
    ? op.tabs.positions.unwrap().length > 0
    : op.tabs.count.canonical > 0
  const skin = set ?? DEFAULT_SKIN[units]
  return tabs ? Math.max(skin, op.tabs.thickness.canonical) : skin
}

/** A roughing pocket or profile owned by `roughingOf` (not by a feature). */
export const isOwnedRoughing = (op: Operation): boolean =>
  (op.kind === 'pocket' || op.kind === 'profile') &&
  op.roughing === true &&
  op.roughingOf !== undefined &&
  op.owner.isNone()

/** A plain pocket or an `inside`/`outside` profile (R4) with a roughing setting. */
const isRoughingOwner = (op: Operation): boolean =>
  (op.kind === 'pocket' || (op.kind === 'profile' && op.side !== 'on')) &&
  op.roughing !== true &&
  op.owner.isNone() &&
  op.roughingPass !== undefined

/** The kinds that take a roughing pass. */
export type Roughable = Pocket | Profile

/** Default name of a roughing operation: "Pocket 1 · roughing" (as a feature's owned operation). */
export const roughingName = (ownerName: string): string => `${ownerName} · roughing`

/**
 * The operations with every roughing owner's `<id>_roughing` right before it, its geometry the
 * owner's (pocket: on, shape, depth, floor radius, Through; profile: on, shape, side, slot width,
 * depth, tabs) and its margins the owner's (`leave`); its tool field, a custom name and its general
 * tolerance are kept. Roughing operations of an owner that is gone or has roughing off are
 * dropped. An unchanged roughing operation keeps its object (so its record is kept), and a list
 * without roughing comes back as a copy of itself.
 */
export function syncRoughing(ops: readonly Operation[]): Operation[] {
  if (!ops.some((o) => isOwnedRoughing(o) || isRoughingOwner(o))) return [...ops]
  const prev = new Map<string, Roughable>()
  for (const o of ops)
    if (isOwnedRoughing(o)) prev.set((o as Roughable).roughingOf!, o as Roughable)
  const out: Operation[] = []
  for (const o of ops) {
    if (isOwnedRoughing(o)) continue
    if (isRoughingOwner(o)) {
      const old = prev.get(o.id)
      out.push(roughingFor(o as Roughable, old?.kind === o.kind ? old : undefined))
    }
    out.push(o)
  }
  return out
}

function roughingFor(owner: Roughable, old: Roughable | undefined): Roughable {
  const leave = owner.roughingPass!
  const custom = old !== undefined && !old.name.endsWith(' · roughing')
  const common = {
    id: roughingOperationId(owner.id),
    name: custom ? old.name : roughingName(owner.name),
    generalTolerance: old?.generalTolerance ?? { length: None, angle: None },
    on: owner.on,
    tool: old?.tool ?? None,
    toolLocked: old?.toolLocked ?? false,
    owner: owner.owner,
    shape: owner.shape,
  }
  const tail = {
    roughing: true as const,
    roughingOf: owner.id,
    ...(leave.wall === undefined && leave.floor === undefined ? {} : { leave }),
  }
  const built: Roughable =
    owner.kind === 'pocket'
      ? {
          kind: 'pocket',
          ...common,
          depth: owner.depth,
          floorRadius: owner.floorRadius,
          ...(owner.through === true ? { through: true } : {}),
          ...tail,
        }
      : {
          kind: 'profile',
          ...common,
          depth: owner.depth,
          side: owner.side,
          slotWidth: owner.slotWidth,
          // R4: the owner's tabs, kept for the record; the roughing cuts none (inputs.ts)
          tabs: owner.tabs,
          ...tail,
        }
  return old !== undefined && deepEqual(operationToDTO(old), operationToDTO(built)) ? old : built
}

/**
 * `design.featureOwned` (rule `roughingOwned`) for a roughing operation: its geometry, order and
 * life go through its owner's `roughing` (its name and tool stay its own).
 */
export function roughingOwnedError(
  op: Roughable,
  ownerName: string,
  where: string,
): AppResult<never> {
  return fail(
    'design.featureOwned',
    `${op.id} is the roughing pass of ${ownerName} (${op.roughingOf}); change its roughing instead`,
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
