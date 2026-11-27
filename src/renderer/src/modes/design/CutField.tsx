// The inspector's "Already cut" switch (hardening DF135 C3) of a top-level operation or feature:
// the same mark as the row menu's Mark as already cut / not cut, one `design.part.update
// { alreadyCut }` and one undo step. A run's mark says when it was cut (and Changed since) in a
// message under the switch. Not shown for owned or nested rows (their feature carries the mark),
// rows that are off (DF106; the row menu offers no mark there either) or split pieces (read-only).
// Doc: docs/modes/cut-state.md#implementation-c3, docs/conventions/ui.md (Switch fields)
import { cutChangedUnits, cutMarkOf, recutUnits } from '../../../../core/design/already-cut'
import { isDisabled, topLevelUnits } from '../../../../core/design/disabled'
import { designMessages } from '../../messages/design'
import { Field, Switch, type FieldMessage } from '../../ui'
import { disabledOf, type DesignPart } from './model'
import { markDay } from './OperationList'
import { useCommand } from './useDesign'

const m = designMessages.navigator

export function CutField({ part, id }: { part: DesignPart; id: string }): React.JSX.Element | null {
  const call = useCommand()
  const dto = part.dto
  if (dto.derivedFrom !== undefined) return null
  if (!topLevelUnits(dto).includes(id) || isDisabled(disabledOf(part), id)) return null
  const list = dto.alreadyCut ?? []
  const cut = list.includes(id)
  const mark = cut ? cutMarkOf(dto, id) : undefined
  const run = mark?.by === 'run' && mark.at !== ''
  const changed = run && cutChangedUnits(dto).has(id)
  const messages: FieldMessage[] = run
    ? [
        changed
          ? {
              id: 'cut',
              severity: 'hard',
              text: m.cutChangedTitle(markDay(mark.at), recutUnits(dto).has(id)),
            }
          : { id: 'cut', severity: 'note', text: m.cutByRunTitle(markDay(mark.at)) },
      ]
    : []
  return (
    <Field label={m.cutField} kind="toggle" info={m.cutFieldInfo} messages={messages}>
      <Switch
        label={m.cutField}
        hideLabel
        checked={cut}
        onCheckedChange={(on) =>
          void call('design.part.update', {
            partId: dto.id,
            alreadyCut: on ? [...list, id] : list.filter((x) => x !== id),
          })
        }
      />
    </Field>
  )
}
