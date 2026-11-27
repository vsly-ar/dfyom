// The machine editor's "Holder" group (Spindle tab, Library window only; hardening DF132 H1): the
// collet nut choice (None, a built-in preset, or Measured), then the four sizes beside the holder
// drawing. Choosing a preset fills all sizes; editing one keeps the preset ("ER11 nut, edited").
// Measured from None starts from the ER11 sizes, so the form opens valid and the user corrects it.
// The tool editor's Details reuse it for a tool's own holder (`variant="tool"`, DF132 H6): no group
// of its own, and "None" reads "Machine's holder".
// Doc: docs/modes/tool-holder.md#implementation-h1, #implementation-h6
import { useState } from 'react'
import {
  HOLDER_PRESETS,
  HOLDER_SIZES,
  holderEdited,
  presetHolderDTO,
  type HolderSize,
} from '../../../core/library/holder'
import {
  HOLDER_PRESET_IDS,
  type HolderDTO,
  type HolderPresetId,
} from '../../../core/library/holder.dto'
import type { UnitSystem } from '../../../core/project/document'
import { libraryMessages } from '../messages/library'
import { Field, InspectorGroup, Select, type FieldMessage, type SelectOption } from '../ui'
import { QuantityField, WithAside } from './fields'
import { HolderDrawing } from './HolderDrawing'

const H = libraryMessages.machine.holder
const T = libraryMessages.tool.holder
type Choice = 'none' | 'custom' | HolderPresetId

const ICON: Record<HolderSize, 'width' | 'depth'> = {
  nutDiameter: 'width',
  nutLength: 'depth',
  bodyDiameter: 'width',
  maxShank: 'width',
}

const bare = (source: string) => source.replace(/ mm$/, '')

function presetOption(id: HolderPresetId, edited: boolean): SelectOption<Choice> {
  const p = HOLDER_PRESETS[id]
  return {
    value: id,
    label: edited ? H.edited(H.presets[id]) : H.presets[id],
    description: H.presetSizes(bare(p.nutDiameter), bare(p.nutLength), p.bodyDiameter, p.maxShank),
  }
}

/** A holder's choice as the Details summary names it ("ER16 nut", "Measured"). */
export function holderChoiceLabel(value: HolderDTO): string {
  return value.preset === undefined ? H.custom : H.presets[value.preset]
}

export function HolderGroup({
  value,
  units,
  messages,
  onChange,
  variant = 'machine',
}: {
  value: HolderDTO | undefined
  units: UnitSystem
  messages: (field: string) => FieldMessage[]
  onChange: (holder: HolderDTO | undefined) => void
  /** `tool`: a tool's own holder inside the tool editor's Details (H6); none = the machine's. */
  variant?: 'machine' | 'tool'
}): React.JSX.Element {
  const tool = variant === 'tool'
  const [focused, setFocused] = useState<HolderSize | undefined>(undefined)
  const choice: Choice = value === undefined ? 'none' : (value.preset ?? 'custom')
  const edited = value !== undefined && holderEdited(value)
  const options: SelectOption<Choice>[] = [
    tool
      ? { value: 'none', label: T.none, description: T.noneDescription }
      : { value: 'none', label: H.none },
    ...HOLDER_PRESET_IDS.map((id) => presetOption(id, edited && id === choice)),
    { value: 'custom', label: H.custom, description: H.customDescription },
  ]
  const choose = (c: Choice) => {
    if (c === 'none') return onChange(undefined)
    if (c !== 'custom') return onChange(presetHolderDTO(c))
    const { preset: _preset, ...sizes } = value ?? presetHolderDTO('er11')
    onChange(sizes)
  }
  const onFocusField = (f: string | undefined) => {
    const size = f?.startsWith('holder.') ? (f.slice(7) as HolderSize) : undefined
    setFocused(size !== undefined && HOLDER_SIZES.includes(size) ? size : undefined)
  }
  const body = (
    <>
      <Field
        label={tool ? T.choice : H.choice}
        info={tool ? T.choiceNote : H.choiceNote}
        messages={messages('holder.preset')}
      >
        <Select<Choice> options={options} value={choice} onValueChange={choose} />
      </Field>
      {value !== undefined ? (
        <WithAside aside={<HolderDrawing focused={focused} />}>
          {HOLDER_SIZES.map((f) => (
            <QuantityField
              key={f}
              field={`holder.${f}`}
              stepKind="xy"
              label={H.labels[f]}
              kind="length"
              value={value[f]}
              units={units}
              icon={ICON[f]}
              messages={messages}
              info={H.notes[f]}
              optional={f === 'maxShank'}
              onChange={(v) => {
                const next: HolderDTO = { ...value }
                if (v === undefined) delete next[f]
                else next[f] = v
                onChange(next)
              }}
              onFocusField={onFocusField}
            />
          ))}
        </WithAside>
      ) : null}
    </>
  )
  return tool ? body : <InspectorGroup title={H.title}>{body}</InspectorGroup>
}
