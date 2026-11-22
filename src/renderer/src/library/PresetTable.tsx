// A tool's cutting presets (library.md#tool `presets`), one stacked block per preset so every value
// fits the editor without sideways scrolling: name, material class and the chip load derived from
// feed / (speed × flutes), read-only, above spindle speed, feed rate, plunge rate and the optional
// stepdown and stepover (compact labels, full names in the tooltip and accessible name). Cells parse as the
// fields do (a bare number in the window's unit, L5); an invalid entry stays in the cell, marked,
// and is not committed. Doc: docs/conventions/ui-library-window.md#layout
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { MATERIAL_CLASSES, type MaterialClass } from '../../../core/library/item'
import type { CuttingPresetDTO, ToolValuesDTO } from '../../../core/library/tool.dto'
import type { UnitSystem } from '../../../core/project/document'
import { Quantity } from '../../../core/quantity/quantity'
import type { QuantityDTO } from '../../../core/quantity/quantity.dto'
import type { QuantityKind } from '../../../core/quantity/units'
import { libraryMessages } from '../messages/library'
import { Button, FieldInput, IconButton, Select, type FieldMessage } from '../ui'
import { displayQuantity, libraryUnit, qdto, quantityOf } from './form'
import styles from './LibraryWindow.module.css'

const m = libraryMessages.tool.presets
const ANY = 'any'

type QuantityColumn = 'spindleSpeed' | 'feedRate' | 'plungeRate' | 'stepdown' | 'stepover'
const COLUMNS: readonly { key: QuantityColumn; kind: QuantityKind; optional: boolean }[] = [
  { key: 'spindleSpeed', kind: 'spindleSpeed', optional: false },
  { key: 'feedRate', kind: 'feedRate', optional: false },
  { key: 'plungeRate', kind: 'feedRate', optional: false },
  { key: 'stepdown', kind: 'length', optional: true },
  { key: 'stepover', kind: 'length', optional: true },
]

/** Feed per tooth in the window's length unit, or undefined when it cannot be derived. */
export function chipLoad(
  preset: Pick<CuttingPresetDTO, 'spindleSpeed' | 'feedRate'>,
  fluteCount: QuantityDTO,
  units: UnitSystem,
): string | undefined {
  const feed = quantityOf(preset.feedRate)
  const speed = quantityOf(preset.spindleSpeed)
  const flutes = quantityOf(fluteCount)
  if (feed === undefined || speed === undefined || flutes === undefined) return undefined
  const perTooth = feed.canonical / (speed.canonical * flutes.canonical) // mm per tooth
  if (!Number.isFinite(perTooth) || perTooth <= 0) return undefined
  return units === 'mm' ? `${perTooth.toFixed(3)} mm` : `${(perTooth / 25.4).toFixed(4)}"`
}

/** One quantity cell: parses on commit (blur, Enter); an invalid entry stays, marked. */
function QuantityCell({
  label,
  kind,
  value,
  units,
  optional,
  invalid,
  onCommit,
}: {
  label: string
  kind: QuantityKind
  value: QuantityDTO | undefined
  units: UnitSystem
  optional: boolean
  invalid: boolean
  onCommit: (v: QuantityDTO | undefined) => void
}): React.JSX.Element {
  const shown = displayQuantity(value, units)?.source ?? ''
  const [draft, setDraft] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  const commit = () => {
    if (draft === null) return
    const text = draft.trim()
    if (text === '' && optional) {
      setDraft(null)
      setBad(false)
      onCommit(undefined)
      return
    }
    const parsed = Quantity.parse(text, { kind, defaultUnit: libraryUnit(kind, units) })
    if (parsed.isErr()) {
      setBad(true)
      return
    }
    setDraft(null)
    setBad(false)
    onCommit(parsed.unwrap().toDTO())
  }
  return (
    <FieldInput
      aria-label={label}
      aria-invalid={bad || invalid}
      value={draft ?? shown}
      {...(libraryUnit(kind, units) === '1' ? {} : { unit: libraryUnit(kind, units) })}
      className={styles['qcell']}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape' && draft !== null) {
          e.preventDefault()
          e.stopPropagation()
          setDraft(null)
          setBad(false)
        }
      }}
    />
  )
}

export function PresetTable({
  presets,
  tool,
  units,
  messages,
  onChange,
}: {
  presets: readonly CuttingPresetDTO[]
  tool: Pick<ToolValuesDTO, 'fluteCount' | 'diameter'>
  units: UnitSystem
  messages: (field: string) => FieldMessage[]
  onChange: (presets: CuttingPresetDTO[]) => void
}): React.JSX.Element {
  const set = (i: number, patch: Partial<CuttingPresetDTO>) =>
    onChange(presets.map((p, n) => (n === i ? ({ ...p, ...patch } as CuttingPresetDTO) : p)))
  const add = () => {
    const mm = units === 'mm'
    let n = presets.length + 1
    while (presets.some((p) => p.name === m.defaultName(n))) n += 1
    onChange([
      ...presets,
      {
        name: m.defaultName(n),
        spindleSpeed: qdto('spindleSpeed', '18000', units),
        feedRate: qdto('feedRate', mm ? '1000' : '40', units),
        plungeRate: qdto('feedRate', mm ? '300' : '12', units),
      },
    ])
  }
  const errors = messages('presets')
  return (
    <div className={styles['presets']}>
      <p className={styles['hint']}>{m.hint}</p>
      {presets.length === 0 ? (
        <p className={styles['emptyNote']}>{m.empty}</p>
      ) : (
        <ul className={styles['presetList']} aria-label={m.caption}>
          {presets.map((p, i) => {
            const rowIssues = (key: string) => messages(`presets.${i}.${key}`).length > 0
            const load = chipLoad(p, tool.fluteCount, units)
            return (
              <li key={i} className={styles['preset']} aria-label={p.name}>
                <div className={styles['pcell']} data-wide="">
                  <span className={styles['pcellLabel']} aria-hidden="true">
                    {m.columns.name}
                  </span>
                  <FieldInput
                    aria-label={m.field(p.name, m.columns.name)}
                    aria-invalid={rowIssues('name')}
                    value={p.name}
                    maxLength={60}
                    className={styles['cellName']}
                    onChange={(e) => set(i, { name: e.target.value })}
                  />
                </div>
                <div className={styles['pcell']} data-wide="">
                  <span className={styles['pcellLabel']} aria-hidden="true">
                    {m.columns.materialClass}
                  </span>
                  <Select<string>
                    aria-label={m.field(p.name, m.columns.materialClass)}
                    options={[
                      { value: ANY, label: m.anyMaterial },
                      ...MATERIAL_CLASSES.map((c) => ({
                        value: c,
                        label: libraryMessages.classes[c],
                      })),
                    ]}
                    value={p.materialClass ?? ANY}
                    className={styles['cellSelect']}
                    onValueChange={(v) =>
                      set(i, { materialClass: v === ANY ? undefined : (v as MaterialClass) })
                    }
                  />
                </div>
                <div className={styles['pcell']}>
                  <span className={styles['pcellLabel']} aria-hidden="true">
                    {m.columns.chipLoad}
                  </span>
                  <output
                    aria-label={m.field(p.name, m.columns.chipLoad)}
                    className={styles['derived']}
                  >
                    {load ?? m.chipLoadNone}
                  </output>
                </div>
                <div className={styles['presetRemove']}>
                  <IconButton
                    label={m.remove(p.name)}
                    icon={<Trash2 aria-hidden="true" />}
                    onClick={() => onChange(presets.filter((_, n) => n !== i))}
                  />
                </div>
                {COLUMNS.map((c) => (
                  <div key={c.key} className={styles['pcell']}>
                    <span
                      className={styles['pcellLabel']}
                      title={m.columns[c.key]}
                      aria-hidden="true"
                    >
                      {m.short[c.key]}
                    </span>
                    <QuantityCell
                      label={m.field(p.name, m.columns[c.key])}
                      kind={c.kind}
                      value={p[c.key]}
                      units={units}
                      optional={c.optional}
                      invalid={rowIssues(c.key)}
                      onCommit={(v) => set(i, { [c.key]: v } as Partial<CuttingPresetDTO>)}
                    />
                  </div>
                ))}
              </li>
            )
          })}
        </ul>
      )}
      {errors.length > 0 ? (
        <ul className={styles['presetErrors']}>
          {errors.map((e) => (
            <li key={e.id}>{e.text}</li>
          ))}
        </ul>
      ) : null}
      <div>
        <Button size="sm" icon={<Plus aria-hidden="true" />} onClick={add}>
          {m.add}
        </Button>
      </div>
    </div>
  )
}
