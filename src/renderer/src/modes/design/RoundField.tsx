// The Round switch of a rectangle's corner radius (DF120 R2): a switch field on its own row under
// Corner radius in the pocket and profile inspectors, the Shape Editor's rectangle item and a
// rectangle pattern cell. While on, the radius field is read-only and shows the derived radius.
// A command that applied a too-large radius as Round (`adjusted`) shows its message as the undo
// toast, as the open-path "Side set to On line" toast does.
// Doc: docs/modes/hole-slots-and-round-corners.md#implementation-r2, docs/conventions/ui.md#info-notes
import type { Adjusted } from '../../../../core/design/round'
import { designMessages } from '../../messages/design'
import { Field, Switch } from '../../ui'

const t = designMessages.inspector

export function RoundField({
  checked,
  readOnly = false,
  onChange,
}: {
  checked: boolean
  readOnly?: boolean
  onChange(round: boolean): void
}): React.JSX.Element {
  return (
    <Field label={t.round} kind="toggle" info={t.roundInfo} readOnly={readOnly}>
      <Switch
        label={t.round}
        hideLabel
        checked={checked}
        disabled={readOnly}
        onCheckedChange={onChange}
      />
    </Field>
  )
}

/** The message of the first value a command result changed on apply (DF120), if any. */
export function adjustedNote(reply: { ok: boolean; value?: unknown }): string | undefined {
  if (!reply.ok) return undefined
  const adjusted = (reply.value as { adjusted?: readonly Adjusted[] } | undefined)?.adjusted
  return adjusted?.[0]?.message
}
