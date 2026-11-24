// Slider: one value on a track; arrows move one step, Page Up/Down and Shift+arrows ten. A
// `limit` below `max` keeps the thumb at or under it and hatches the track past it (the reason
// is the caller's, through `aria-describedby`). `marks` are ticks (e.g. 100 %).
// Doc: docs/conventions/ui.md#components (Slider; never the only way to enter a quantity)
import { Slider as RadixSlider } from 'radix-ui'
import type { Ref } from 'react'
import styles from './Slider.module.css'

export interface SliderProps {
  /** Accessible name of the thumb. */
  label: string
  min: number
  max: number
  step?: number
  value: number
  /** While dragging or per key press. */
  onValueChange: (value: number) => void
  /** At the end of a drag or a key press. */
  onValueCommit?: (value: number) => void
  /** Highest value that can be reached (≤ `max`); the track past it is hatched. */
  limit?: number | undefined
  /** Values marked with a tick on the track. */
  marks?: readonly number[]
  /** Spoken value, e.g. "120 %, 1440 mm/min". */
  valueText?: (value: number) => string
  disabled?: boolean
  'aria-describedby'?: string | undefined
  /** Layout only; appended to the root's class. */
  className?: string | undefined
  ref?: Ref<HTMLSpanElement>
}

export function Slider({
  label,
  min,
  max,
  step = 1,
  value,
  onValueChange,
  onValueCommit,
  limit,
  marks = [],
  valueText,
  disabled = false,
  'aria-describedby': describedBy,
  className,
  ref,
}: SliderProps): React.JSX.Element {
  const top = limit === undefined ? max : Math.max(min, Math.min(max, limit))
  const clamp = (v: number) => Math.max(min, Math.min(top, v))
  const at = (v: number) => `${((v - min) / (max - min)) * 100}%`
  const shown = Math.max(min, Math.min(max, value))
  return (
    <RadixSlider.Root
      ref={ref}
      className={[styles['root'], className].filter(Boolean).join(' ')}
      min={min}
      max={max}
      step={step}
      value={[shown]}
      disabled={disabled}
      onValueChange={([v]) => {
        if (v !== undefined) onValueChange(clamp(v))
      }}
      {...(onValueCommit === undefined
        ? {}
        : {
            onValueCommit: ([v]: number[]) => {
              if (v !== undefined) onValueCommit(clamp(v))
            },
          })}
    >
      <RadixSlider.Track className={styles['track']}>
        {top < max ? (
          <span
            className={styles['beyond']}
            data-testid="slider-beyond"
            style={{ left: at(top), right: 0 }}
          />
        ) : null}
        {marks.map((v) => (
          <span key={v} className={styles['mark']} style={{ left: at(v) }} aria-hidden="true" />
        ))}
        <RadixSlider.Range className={styles['range']} />
      </RadixSlider.Track>
      <RadixSlider.Thumb
        className={styles['thumb']}
        aria-label={label}
        {...(valueText === undefined ? {} : { 'aria-valuetext': valueText(shown) })}
        {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
      />
    </RadixSlider.Root>
  )
}
