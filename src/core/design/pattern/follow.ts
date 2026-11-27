/**
 * Patterns follow what their owned records were resolved from (patterns P4 follow-up): a
 * pattern's owned pocket (a through pocket's depth) and owned shape record (the face rectangle,
 * the stacked `floor`) are expanded from the stock and the operations before the pattern, so a
 * changed stock (thickness or size), boundary shape or lower pattern re-expands it in the same
 * command (one undo step), as the split follow regenerates pieces. Records are written only when
 * they change; a part and stock the command left alone (frozen records) are skipped.
 * Doc: docs/modes/patterns.md#implementation-p4
 */
import type { Draft } from 'immer'
import { Err, Ok, type AppResult } from '../../../shared/result'
import type { DocumentHook } from '../../commands/define'
import type { CommandContext } from '../../commands/context'
import { deepEqual } from '../../library/snapshot'
import type { ProjectDoc } from '../../project/document'
import { load, shapeEnv } from '../commands'
import {
  featureBlock,
  materialize,
  ownedOperationId,
  type ExpansionContext,
  type LoadedFeature,
} from '../feature'
import { placeFeature, writePlaced } from '../feature-commands'
import { baseOf, isFrozenRecord } from '../frozen-memo'
import type { LoadedPart } from '../load'
import { operationToDTO } from '../operation'

const WHERE = 'design.patternFollow'

/**
 * Kinds whose owned records are expanded from the stock and earlier operations: patterns, and
 * engraved patterns (engraved-patterns.md E3: the face rectangle in their owned shape record).
 */
const FOLLOWING = new Set(['pattern', 'engraving'])

/** Does expanding the pattern now give exactly its stored owned operations and shape? */
function isCurrent(l: LoadedPart, { spec, feature }: LoadedFeature): boolean {
  const ops = l.part.operations
  const { start, end } = featureBlock(ops, feature.id)
  const ctx: ExpansionContext = {
    units: l.units,
    stock: l.stock,
    before: ops.slice(0, start),
    ownedId: (role) => ownedOperationId(feature.id, role),
    shapes: l.dto.shapes ?? [],
    after: ops.slice(end),
  }
  // an expansion that fails now is not current: the placement reports why
  const owned = spec
    .expand(feature, ctx)
    .andThen((x) => materialize(feature, x, ops.slice(start, end)))
  if (owned.isErr()) return false
  const stored = l.dto.operations.slice(start, end)
  const fresh = owned.unwrap()
  if (fresh.length !== stored.length) return false
  if (fresh.some((o, i) => !deepEqual(operationToDTO(o), stored[i]))) return false
  const shapes = spec.ownedShapes?.(feature, ctx)
  if (shapes === undefined) return true
  if (shapes.isErr()) return false
  const have = (l.dto.shapes ?? []).filter((x) => x.owner === feature.id)
  return (
    have.length === shapes.unwrap().length &&
    shapes.unwrap().every((sh) =>
      deepEqual(
        have.find((x) => x.id === sh.id),
        sh,
      ),
    )
  )
}

/**
 * Re-expands every pattern of a part this command changed (its record or its stock snapshot)
 * whose owned records are no longer what it expands to, in design order (a stacked pattern after
 * the one below it). A pattern that no longer places is the command's error, at its fields.
 */
export function followPatterns(draft: Draft<ProjectDoc>, ctx: CommandContext): AppResult<void> {
  for (const id of Object.keys(draft.parts)) {
    const part = draft.parts[id]!
    // pieces carry their source's records (the split follow regenerates them after this)
    if (part.derivedFrom !== undefined) continue
    if (!(part.features ?? []).some((f) => FOLLOWING.has(f.kind))) continue
    const stock = Object.hasOwn(draft.snapshots, part.stock)
      ? baseOf(draft.snapshots[part.stock])
      : undefined
    if (isFrozenRecord(baseOf(part)) && isFrozenRecord(stock)) continue
    const done = new Set<string>()
    for (;;) {
      const loaded = load(draft, id, WHERE)
      if (loaded.isErr()) return loaded
      const l = loaded.unwrap()
      const ops = l.part.operations
      const stale = l.features
        .filter((f) => FOLLOWING.has(f.spec.kind) && !done.has(f.feature.id))
        .sort(
          (a, b) => featureBlock(ops, a.feature.id).start - featureBlock(ops, b.feature.id).start,
        )
        .find((f) => {
          if (isCurrent(l, f)) {
            done.add(f.feature.id)
            return false
          }
          return true
        })
      if (stale === undefined) break
      done.add(stale.feature.id)
      const placed = placeFeature(
        l,
        stale.spec,
        stale.feature,
        stale.feature,
        WHERE,
        shapeEnv(l, ctx.services.region2d),
      )
      if (placed.isErr()) return Err(placed.unwrapErr().prefixIssues('features', stale.feature.id))
      writePlaced(draft, id, placed.unwrap(), stale.spec.toDTO(stale.feature))
    }
  }
  return Ok(undefined)
}

/**
 * After every document command (commands.md#document-hooks), `design.pattern.*` too: a stacked
 * pattern follows the pattern below it.
 */
export const patternFollowHook: DocumentHook = {
  name: WHERE,
  after: (draft, _command, ctx) => followPatterns(draft, ctx),
}
