/**
 * Keeping a part's disabled list valid after every design command (hardening DF106): ids of
 * removed items are dropped (a later item may reuse the id; the already-cut list too, DF135), and nothing new may build on a
 * disabled item (a chamfer on its edge, an operation on its floor, Clones of it): enable it first.
 * Doc: docs/modes/design.md#disabling-operations-and-features-df106
 */
import { isDraft, original } from 'immer'
import { fail, Ok, type AppResult } from '../../shared/result'
import type { DocumentHook } from '../commands/define'
import { disabledState, topLevelUnits } from './disabled'
import { baseOf, isFrozenRecord } from './frozen-memo'
import type { PartDTO } from './part.dto'

const WHERE = 'design.disabledFollow'

/** The hook's work on one changed part: its pruned list; `before` is the record before the command. */
function follow(
  part: PartDTO,
  before: PartDTO | undefined,
  commandName: string,
): AppResult<string[]> {
  const listed = part.disabled ?? []
  const ids = new Set([
    ...part.operations.map((o) => o.id),
    ...(part.features ?? []).map((f) => f.id),
  ])
  const kept = listed.filter((id) => ids.has(id))
  // the toggle itself was checked by design.part.update
  if (commandName === 'design.part.update' || kept.length === 0) return Ok(kept)
  const units = new Set(topLevelUnits(part))
  const nested = kept.filter((id) => !units.has(id))
  const now = disabledState({ ...part, disabled: kept }).dependants
  const was = before?.disabled === undefined ? new Set<string>() : disabledState(before).dependants
  const added = [...now].filter((u) => !was.has(u))
  if (nested.length === 0 && added.length === 0) return Ok(kept)
  const offending = [...nested, ...added]
  const off = kept.join(', ')
  return fail('model.invariant', `${offending.join(', ')} would build on disabled ${off}`, {
    where: WHERE,
    issues: offending.map((id) => ({
      path: ['disabled'],
      rule: 'disabledTarget',
      message: `${id} would build on disabled ${off}: enable it first`,
      params: { id, disabled: kept },
    })),
  })
}

/** After every design command (commands.md#document-hooks). */
export const disabledFollowHook: DocumentHook = {
  name: WHERE,
  after: (draft, command) => {
    if (!command.name.startsWith('design.')) return Ok(undefined)
    for (const id of Object.keys(draft.parts)) {
      const draftPart = draft.parts[id]!
      const part: PartDTO = baseOf(draftPart)
      // an unchanged part is a committed document's frozen record
      const unchanged: boolean = isFrozenRecord(part)
      if (unchanged) continue
      // DF135: the already-cut list drops removed items too (cut-state.md#what-is-stored)
      const cut = part.alreadyCut
      if (cut !== undefined) {
        const ids = new Set([
          ...part.operations.map((o) => o.id),
          ...(part.features ?? []).map((f) => f.id),
        ])
        const kept = cut.filter((x) => ids.has(x))
        if (kept.length === 0) delete draftPart.alreadyCut
        else if (kept.length !== cut.length) draftPart.alreadyCut = kept
      }
      // C2: a mark goes with its id
      const marks = part.alreadyCutMarks
      if (marks !== undefined) {
        const listed = new Set(draftPart.alreadyCut ?? [])
        const gone = Object.keys(marks).filter((x) => !listed.has(x))
        if (gone.length === Object.keys(marks).length) delete draftPart.alreadyCutMarks
        else for (const x of gone) delete draftPart.alreadyCutMarks![x]
      }
      if (part.disabled === undefined) continue
      const before = isDraft(draftPart) ? (original(draftPart) as PartDTO | undefined) : undefined
      const r = follow(part, before, command.name)
      if (r.isErr()) return r.map(() => undefined)
      const kept = r.unwrap()
      if (kept.length === part.disabled.length) continue
      if (kept.length === 0) delete draftPart.disabled
      else draftPart.disabled = kept
    }
    return Ok(undefined)
  },
}
