// The engraved pattern's Presets dialog (engraved-patterns.md E3, § Presets dialog): a modal grid
// of the 13 shipped presets in three groups (Tiles, Motifs, Round), each card the motif's lines
// (light lines drawn light), its name, a one-line description and its size. It behaves as the
// pattern's Presets dialog (PatternPresetsDialog.tsx, DF107): the cards are one radio group with
// a roving focus (arrows, Up/Down by a row, Home/End), Enter, Space or a click applies and
// closes, Escape closes without a change; the current preset is marked and focused on open.
// Applying is the caller's one `design.engraving.update` (one undo step).
// Doc: docs/modes/engraved-patterns.md#presets, docs/modes/engraved-patterns.md#implementation-e3
import { Fragment, useRef, useState } from 'react'
import { ENGRAVING_PRESETS, type EngravingPreset } from '../../../../core/design/engraving/presets'
import type { UnitSystem } from '../../../../core/project/document'
import { engravingMessages } from '../../messages/engraving'
import { lengthSource } from '../../messages/dfm'
import { Button, Dialog } from '../../ui'
import styles from './Design.module.css'
import { presetThumb, type MotifThumb } from './engraving-thumbs'

const e = engravingMessages

/** Cards per row (Up/Down move by a row). */
export const ENGRAVING_PRESET_COLUMNS = 4

const GROUPS = ['tile', 'single', 'round'] as const

export function EngravingPresetsDialog({
  current,
  units,
  onApply,
}: {
  /** The preset the feature is (none for a shapes motif). */
  current: string | undefined
  units: UnitSystem
  /** Applies the preset (one `design.engraving.update`). */
  onApply: (preset: EngravingPreset) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const at = ENGRAVING_PRESETS.findIndex((p) => p.id === current)
  const [active, setActive] = useState(Math.max(at, 0))
  const cards = useRef<(HTMLButtonElement | null)[]>([])

  const openChange = (o: boolean) => {
    if (o) setActive(Math.max(at, 0))
    setOpen(o)
  }
  const move = (to: number) => {
    const i = Math.min(Math.max(to, 0), ENGRAVING_PRESETS.length - 1)
    setActive(i)
    cards.current[i]?.focus()
  }
  const apply = (preset: EngravingPreset) => {
    setOpen(false)
    onApply(preset)
  }
  const onKeyDown = (ev: React.KeyboardEvent, i: number) => {
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: ENGRAVING_PRESET_COLUMNS,
      ArrowUp: -ENGRAVING_PRESET_COLUMNS,
    }
    if (ev.key in step) move(i + step[ev.key]!)
    else if (ev.key === 'Home') move(0)
    else if (ev.key === 'End') move(ENGRAVING_PRESETS.length - 1)
    else return
    ev.preventDefault()
  }
  const size = (p: EngravingPreset) =>
    e.presetSize(lengthSource(p.size[0], units), lengthSource(p.size[1], units))

  return (
    <Dialog
      title={e.presetsTitle}
      description={e.presetsDescription}
      size="xl"
      open={open}
      onOpenChange={openChange}
      trigger={
        <Button size="sm" data-engraving-presets>
          {e.presetsButton}
        </Button>
      }
    >
      <div
        role="radiogroup"
        aria-label={e.presetsTitle}
        className={styles['presetGrid']}
        style={{ gridTemplateColumns: `repeat(${ENGRAVING_PRESET_COLUMNS}, minmax(0, 1fr))` }}
      >
        {GROUPS.map((group) => (
          <Fragment key={group}>
            <h3 className={styles['engravingPresetGroup']}>{e.presetGroups[group]}</h3>
            {ENGRAVING_PRESETS.map((preset, i) => {
              if (preset.kind !== group) return null
              const name = e.presetNames[preset.id] ?? preset.id
              const description = e.presetDescriptions[preset.id] ?? ''
              return (
                <button
                  key={preset.id}
                  ref={(el) => {
                    cards.current[i] = el
                  }}
                  type="button"
                  role="radio"
                  aria-label={name}
                  aria-description={`${description} ${size(preset)}`}
                  aria-checked={i === at}
                  tabIndex={i === active ? 0 : -1}
                  data-preset={preset.id}
                  className={styles['presetCard']}
                  onClick={() => apply(preset)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault()
                      apply(preset)
                    } else onKeyDown(ev, i)
                  }}
                  onFocus={() => setActive(i)}
                >
                  <MotifPreview
                    thumb={presetThumb(preset.id)}
                    className={styles['presetPreview']}
                  />
                  <span className={styles['presetName']}>
                    {name}
                    {i === at ? (
                      <span className={styles['presetCurrent']}>{e.presetCurrent}</span>
                    ) : null}
                  </span>
                  <span className={styles['presetDescription']}>{description}</span>
                  <span className={styles['presetNumbers']}>{size(preset)}</span>
                </button>
              )
            })}
          </Fragment>
        ))}
      </div>
    </Dialog>
  )
}

/** A motif's lines, fitted into the box with a small border; light levels drawn light. */
export function MotifPreview({
  thumb,
  className,
}: {
  thumb: MotifThumb
  className?: string | undefined
}): React.JSX.Element {
  const pad = Math.max(thumb.w, thumb.h) * 0.06
  return (
    <svg
      className={className}
      viewBox={`${-pad} ${-pad} ${thumb.w + 2 * pad} ${thumb.h + 2 * pad}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {thumb.lines.map((l, i) => (
        <path
          key={i}
          className={styles['engravingLine']}
          d={l.d}
          strokeOpacity={l.opacity}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  )
}
