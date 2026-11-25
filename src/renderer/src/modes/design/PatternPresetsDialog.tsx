// The pattern's Presets dialog (hardening DF107): a modal grid of preview cards, one per preset,
// each a window onto its lattice (`presetThumb` at PREVIEW size), its name, a one-line
// description and its key numbers. The cards are one radio group with a roving focus: arrows
// move (up/down a row), Home/End jump, Enter, Space or a click applies and closes, Escape closes
// without a change. The preset the pattern already is is marked Current and focused on open.
// Applying is the caller's one `design.pattern.update` (one undo step).
// Doc: docs/modes/patterns.md#presets-dialog-and-more-presets-df107, docs/conventions/ui.md#pattern-inspector-p1
import { useRef, useState } from 'react'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import { PATTERN_PRESETS, type PatternPreset } from '../../../../core/design/pattern/presets'
import { designMessages } from '../../messages/design'
import { Button, Dialog } from '../../ui'
import styles from './Design.module.css'
import { matchesPreset, presetNumbers } from './pattern-presets'
import { PREVIEW, presetThumb } from './pattern-thumbs'

const p = designMessages.features.pattern

/** Cards per row (the grid's columns; Up/Down move by a row). */
export const PRESET_COLUMNS = 4

/** The previews, computed once. */
const PREVIEWS = new Map(PATTERN_PRESETS.map((preset) => [preset.id, presetThumb(preset, PREVIEW)]))

export function PatternPresetsDialog({
  feature,
  onApply,
}: {
  feature: FeatureDTO
  /** Applies the preset's args (one `design.pattern.update`). */
  onApply: (preset: PatternPreset) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const current = PATTERN_PRESETS.findIndex((preset) => matchesPreset(feature, preset))
  const [active, setActive] = useState(Math.max(current, 0))
  const cards = useRef<(HTMLButtonElement | null)[]>([])

  // on open the current preset (else the first) is the tabbable card, so it takes the focus
  const openChange = (o: boolean) => {
    if (o) setActive(Math.max(current, 0))
    setOpen(o)
  }

  const move = (to: number) => {
    const i = Math.min(Math.max(to, 0), PATTERN_PRESETS.length - 1)
    setActive(i)
    cards.current[i]?.focus()
  }
  const apply = (preset: PatternPreset) => {
    setOpen(false)
    onApply(preset)
  }
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: PRESET_COLUMNS,
      ArrowUp: -PRESET_COLUMNS,
    }
    if (e.key in step) move(i + step[e.key]!)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(PATTERN_PRESETS.length - 1)
    else return
    e.preventDefault()
  }

  return (
    <Dialog
      title={p.presetsTitle}
      description={p.presetsDescription}
      size="xl"
      open={open}
      onOpenChange={openChange}
      trigger={
        <Button size="sm" data-pattern-presets>
          {p.presetsButton}
        </Button>
      }
    >
      <div
        role="radiogroup"
        aria-label={p.presetsTitle}
        className={styles['presetGrid']}
        style={{ gridTemplateColumns: `repeat(${PRESET_COLUMNS}, minmax(0, 1fr))` }}
      >
        {PATTERN_PRESETS.map((preset, i) => {
          const name = p.presetNames[preset.id] ?? preset.id
          return (
            <button
              key={preset.id}
              ref={(el) => {
                cards.current[i] = el
              }}
              type="button"
              role="radio"
              aria-label={name}
              aria-description={`${p.presetDescriptions[preset.id] ?? ''} ${presetNumbers(preset, p.presetWords)}`}
              aria-checked={i === current}
              tabIndex={i === active ? 0 : -1}
              data-preset={preset.id}
              className={styles['presetCard']}
              onClick={() => apply(preset)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  apply(preset)
                } else onKeyDown(e, i)
              }}
              onFocus={() => setActive(i)}
            >
              <PresetPreview cells={PREVIEWS.get(preset.id) ?? []} />
              <span className={styles['presetName']}>
                {name}
                {i === current ? (
                  <span className={styles['presetCurrent']}>{p.presetCurrent}</span>
                ) : null}
              </span>
              <span className={styles['presetDescription']}>
                {p.presetDescriptions[preset.id] ?? ''}
              </span>
              <span className={styles['presetNumbers']}>
                {presetNumbers(preset, p.presetWords)}
              </span>
            </button>
          )
        })}
      </div>
    </Dialog>
  )
}

/** A preset's preview: a window onto its lattice, drawn as the mini outlines at PREVIEW size. */
function PresetPreview({
  cells,
}: {
  cells: readonly (readonly (readonly [number, number])[])[]
}): React.JSX.Element {
  const r = (v: number) => Math.round(v * 10) / 10
  const d = cells.map((c) => `M${c.map(([x, y]) => `${r(x)} ${r(y)}`).join('L')}Z`).join('')
  return (
    <svg
      className={styles['presetPreview']}
      viewBox={`0 0 ${PREVIEW.w} ${PREVIEW.h}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <path className={styles['miniFill']} d={d} />
      <path className={styles['miniEdge']} d={d} />
    </svg>
  )
}
