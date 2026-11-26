/**
 * The tool field in commands: the `tool` arg (a union on `kind`), turning it into a design tool
 * (a library tool becomes a tool snapshot of the project, taken in the command), and keeping
 * tool snapshots tidy. Shared by `design.<kind>.add`, `design.operation.tool.set` and the auto
 * choice. Doc: docs/modes/design-v0.2.md#commands-and-queries-v02
 */
import type { Draft } from 'immer'
import { z } from 'zod'
import { collect, Err, fail, None, Ok, Some, type AppResult } from '../../shared/result'
import type { CommandContext } from '../commands/context'
import { ItemIdSchema } from '../library/item'
import type { LibraryItem } from '../library/library-item'
import { deepEqual, takeSnapshot } from '../library/snapshot'
import { TOOL_TYPES } from '../library/tool.dto'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { Quantity } from '../quantity/quantity'
import { fieldContext } from './operation'
import { checkGeneralizedTool, type DesignTool } from './tool'

const Len = z.string().min(1).max(64)

export const ToolArg = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('generalized'),
    type: z.enum(TOOL_TYPES),
    diameter: Len,
    cornerRadius: Len.optional(),
    angle: z.string().min(1).max(64).optional(),
  }),
  z.object({ kind: z.literal('specific'), toolLibraryItemId: ItemIdSchema }),
])
// No description: the primer's operation-args line explains the tool arg once (tools/list budget).
export type ToolArgs = z.output<typeof ToolArg>

/**
 * The tool snapshot of a library item for the tool field: an existing one of the document with the
 * item's current values is reused, else a new one is taken into the draft.
 */
export function toolSnapshotFor(
  draft: Draft<ProjectDoc>,
  item: LibraryItem,
  ctx: CommandContext,
): AppResult<string> {
  const values = item.values.toDTO()
  const found = Object.values(draft.snapshots).find(
    (s) => s.kind === 'tool' && s.libraryItemId === item.id && deepEqual(s.values, values),
  )
  if (found !== undefined) return Ok(found.id)
  const id = ctx.ids.next('snapshot')
  return takeSnapshot(item, id, new Date(ctx.clock.now()).toISOString()).map((s) => {
    draft.snapshots[id] = s.toDTO()
    return id
  })
}

/** Removes a tool snapshot no operation of any part uses any more (stock snapshots stay). */
export function dropUnusedToolSnapshot(draft: Draft<ProjectDoc>, snapshotId: string): void {
  if (draft.snapshots[snapshotId]?.kind !== 'tool') return
  const used = Object.values(draft.parts).some((p) =>
    p.operations.some((o) => o.tool?.kind === 'specific' && o.tool.snapshotId === snapshotId),
  )
  if (!used) delete draft.snapshots[snapshotId]
}

/**
 * The design tool of a `tool` arg (paths under `tool`): a generalized tool's values are literals
 * (`model.invariant` per field); a library tool must exist and be a tool (`input.malformed`), its
 * snapshot is taken into the draft.
 */
export function toolFromArg(
  arg: ToolArgs,
  draft: Draft<ProjectDoc>,
  units: UnitSystem,
  ctx: CommandContext,
  where: string,
): AppResult<DesignTool> {
  if (arg.kind === 'specific') {
    const library = ctx.services.library
    if (library === undefined)
      return fail('internal.unexpected', 'no library service configured', { where })
    const found = library.lookup('tool', arg.toolLibraryItemId)
    if (found.state !== 'found')
      return fail('input.malformed', `tool ${arg.toolLibraryItemId} is not in the library`, {
        issues: [
          {
            path: ['tool', 'toolLibraryItemId'],
            rule: found.state === 'missing' ? 'unknownItem' : 'unreadableItem',
            message:
              found.state === 'missing' ? 'no such library tool' : 'the tool file does not load',
          },
        ],
        where,
      })
    return toolSnapshotFor(draft, found.item, ctx)
      .map((snapshotId): DesignTool => ({ kind: 'specific', snapshotId }))
      .mapErr((e) => e.withContext(where))
  }
  const parse = (field: string, src: string, kind: 'length' | 'angle' = 'length') =>
    Quantity.parse(src, fieldContext(kind, units)).mapErr((e) => e.prefixIssues('tool', field))
  const diameter = parse('diameter', arg.diameter)
  const re: AppResult<Quantity | undefined> =
    arg.cornerRadius === undefined ? Ok(undefined) : parse('cornerRadius', arg.cornerRadius)
  const angle: AppResult<Quantity | undefined> =
    arg.angle === undefined ? Ok(undefined) : parse('angle', arg.angle, 'angle')
  const parsed = collect<unknown>([diameter, re, angle])
  if (parsed.isErr()) return Err(parsed.unwrapErr().withContext(where))
  const r = re.unwrap()
  const a = angle.unwrap()
  return checkGeneralizedTool({
    kind: 'generalized',
    type: arg.type,
    diameter: diameter.unwrap(),
    cornerRadius: r === undefined ? None : Some(r),
    angle: a === undefined ? None : Some(a),
  }).mapErr((e) => e.prefixIssues('tool').withContext(where))
}
