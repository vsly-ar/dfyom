// The pattern's Presets dialog (hardening DF107): a modal grid of preview cards, one per preset,
// each a window onto its lattice (`presetThumb` at PREVIEW size), its name, a one-line
// description and its key numbers. It is the shared PresetsDialog shell with the engraving's
// (P11): one radio group with a roving focus, arrows move (up/down a row), Home/End jump, Enter,
// Space or a click applies and closes, Escape or the footer's Close (P10) closes without a change.
// The preset the pattern already is is marked Current and focused on open. Applying is the
// caller's one `design.pattern.update` (one undo step).
// Doc: docs/modes/patterns.md#presets-dialog-and-more-presets-df107, docs/conventions/ui.md#pattern-inspector-p1
import { useId } from 'react'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import { PATTERN_PRESETS, type PatternPreset } from '../../../../core/design/pattern/presets'
import { designMessages } from '../../messages/design'
import { Button } from '../../ui'
import styles from './Design.module.css'
import { matchesPreset, presetNumbers } from './pattern-presets'
import { PREVIEW, presetRings, presetThumb, type RingGuide } from './pattern-thumbs'
import { PresetsDialog } from './PresetsDialog'

const p = designMessages.features.pattern

/** Cards per row (the grid's columns; Up/Down move by a row). */
export const PRESET_COLUMNS = 4

/** The previews, computed once. */
const PREVIEWS = new Map(PATTERN_PRESETS.map((preset) => [preset.id, presetThumb(preset, PREVIEW)]))
/** P10: a polar preset's ring guides, drawn faint behind its cells. */
const RINGS = new Map(PATTERN_PRESETS.map((preset) => [preset.id, presetRings(preset, PREVIEW)]))

export function PatternPresetsDialog({
  feature,
  onApply,
}: {
  feature: FeatureDTO
  /** Applies the preset's args (one `design.pattern.update`). */
  onApply: (preset: PatternPreset) => void
}): React.JSX.Element {
  return (
    <PresetsDialog
      title={p.presetsTitle}
      description={p.presetsDescription}
      closeLabel={p.presetsClose}
      currentLabel={p.presetCurrent}
      trigger={
        <Button size="sm" data-pattern-presets>
          {p.presetsButton}
        </Button>
      }
      presets={PATTERN_PRESETS}
      current={PATTERN_PRESETS.findIndex((preset) => matchesPreset(feature, preset))}
      columns={PRESET_COLUMNS}
      name={(preset) => p.presetNames[preset.id] ?? preset.id}
      describe={(preset) => p.presetDescriptions[preset.id] ?? ''}
      numbers={(preset) => presetNumbers(preset, p.presetWords)}
      preview={(preset) => (
        <PresetPreview cells={PREVIEWS.get(preset.id) ?? []} rings={RINGS.get(preset.id) ?? []} />
      )}
      onApply={onApply}
    />
  )
}

/**
 * A preset's preview: a window onto its lattice, drawn as the mini outlines at PREVIEW size; a
 * polar one over its faint ring guides (P10).
 */
function PresetPreview({
  cells,
  rings,
}: {
  cells: readonly (readonly (readonly [number, number])[])[]
  rings: readonly RingGuide[]
}): React.JSX.Element {
  const r = (v: number) => Math.round(v * 10) / 10
  const d = cells.map((c) => `M${c.map(([x, y]) => `${r(x)} ${r(y)}`).join('L')}Z`).join('')
  const mask = useId()
  return (
    <svg
      className={styles['presetPreview']}
      viewBox={`0 0 ${PREVIEW.w} ${PREVIEW.h}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {rings.length > 0 ? (
        <>
          {/* the guides only between the cells, never across a hole */}
          <mask id={mask}>
            <rect width={PREVIEW.w} height={PREVIEW.h} fill="white" />
            <path d={d} fill="black" />
          </mask>
          <g mask={`url(#${mask})`}>
            {rings.map((g) => (
              <circle
                key={g.r}
                className={styles['presetRing']}
                cx={r(g.cx)}
                cy={r(g.cy)}
                r={r(g.r)}
                data-ring=""
              />
            ))}
          </g>
        </>
      ) : null}
      <path className={styles['miniFill']} d={d} />
      <path className={styles['miniEdge']} d={d} />
    </svg>
  )
}
