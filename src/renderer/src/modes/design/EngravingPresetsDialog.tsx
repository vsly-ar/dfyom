// The engraved pattern's Presets dialog (engraved-patterns.md E3, § Presets dialog): a modal grid
// of the 13 shipped presets in three groups (Tiles, Motifs, Round), each card the motif's lines
// (light lines drawn light), its name, a one-line description and its size. It is the shared
// PresetsDialog shell with the pattern's (P12): one radio group with a roving focus (arrows,
// Up/Down by a row, Home/End), Enter, Space or a click applies and closes, Escape or the footer's
// Close closes without a change; the current preset is marked and focused on open.
// Applying is the caller's one `design.engraving.update` (one undo step).
// Doc: docs/modes/engraved-patterns.md#presets, docs/modes/engraved-patterns.md#implementation-e3
import { ENGRAVING_PRESETS, type EngravingPreset } from '../../../../core/design/engraving/presets'
import type { UnitSystem } from '../../../../core/project/document'
import { engravingMessages } from '../../messages/engraving'
import { lengthSource } from '../../messages/dfm'
import { Button } from '../../ui'
import styles from './Design.module.css'
import { presetThumb, type MotifThumb } from './engraving-thumbs'
import { PresetsDialog } from './PresetsDialog'

const e = engravingMessages

/** Cards per row (Up/Down move by a row). */
export const ENGRAVING_PRESET_COLUMNS = 4

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
  return (
    <PresetsDialog
      title={e.presetsTitle}
      description={e.presetsDescription}
      closeLabel={e.presetsClose}
      currentLabel={e.presetCurrent}
      trigger={
        <Button size="sm" data-engraving-presets>
          {e.presetsButton}
        </Button>
      }
      presets={ENGRAVING_PRESETS}
      current={ENGRAVING_PRESETS.findIndex((p) => p.id === current)}
      columns={ENGRAVING_PRESET_COLUMNS}
      name={(p) => e.presetNames[p.id] ?? p.id}
      describe={(p) => e.presetDescriptions[p.id] ?? ''}
      numbers={(p) => e.presetSize(lengthSource(p.size[0], units), lengthSource(p.size[1], units))}
      preview={(p) => (
        <MotifPreview thumb={presetThumb(p.id)} className={styles['presetPreview']} />
      )}
      // the manifest lists the presets group by group: Tiles, Motifs, Round
      group={(p) => e.presetGroups[p.kind] ?? p.kind}
      onApply={onApply}
    />
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
