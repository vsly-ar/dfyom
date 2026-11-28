// Jog step picker (DF88): seven presets as a radio group (one tab stop, arrow keys move and
// choose) and an inline custom field as the eighth cell of one row (DF102: one line, scrolled
// sideways when the panel is narrower, the chosen cell kept in view; DF148: no scroll bar, the
// wheel scrolls it sideways) – no dialog, no popover. The step is in mm; presets and the field are in the project unit. A custom value
// is chosen when committed (Enter, leaving the field) or when the field is focused holding a
// valid value; an invalid one shows its reason in the caption row (reserved: nothing moves).
// Doc: docs/conventions/ui.md#jog-position-and-probing-df88
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { UnitSystem } from '../../../../core/project/document'
import { runMessages } from '../../messages/run'
import {
  formatStep,
  fromMm,
  jogPresetOf,
  JOG_PRESETS,
  MAX_JOG_STEP_MM,
  toMm,
} from './machine-state'
import styles from './JogStepPicker.module.css'

const m = runMessages.navigator

export interface JogStepPickerProps {
  units: UnitSystem
  /** The chosen step (mm). */
  step: number
  /** The custom field's value (mm), if one was entered. */
  custom: number | undefined
  onStep: (stepMm: number) => void
  onCustom: (stepMm: number) => void
  disabled?: boolean
}

/** A field text as a step (mm), if valid: a positive number up to `MAX_JOG_STEP_MM`. */
export function parseCustomStep(text: string, units: UnitSystem): number | undefined {
  const t = text.trim().replace(',', '.')
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return undefined
  const mm = toMm(Number(t), units)
  return mm > 0 && mm <= MAX_JOG_STEP_MM + 1e-9 ? mm : undefined
}

export function JogStepPicker({
  units,
  step,
  custom,
  onStep,
  onCustom,
  disabled = false,
}: JogStepPickerProps): React.JSX.Element {
  const presets = JOG_PRESETS[units]
  const unit = runMessages.dro.units[units]
  const preset = jogPresetOf(step, units)
  // a step that is no preset of this unit (a custom one, or one from the other unit) is custom
  const customMm = preset === undefined ? step : custom
  const shown = (mm: number | undefined) => (mm === undefined ? '' : formatStep(fromMm(mm, units)))
  // the text being typed; undefined = the custom value as stored
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const text = draft ?? shown(customMm)
  const [invalid, setInvalid] = useState(false)
  const radios = useRef<(HTMLButtonElement | null)[]>([])
  const row = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const errorId = useId()
  const captionId = useId()

  const commit = () => {
    if (text.trim() === '') {
      setInvalid(false)
      setDraft(undefined)
      return
    }
    const mm = parseCustomStep(text, units)
    setInvalid(mm === undefined)
    if (mm !== undefined) {
      setDraft(undefined)
      onCustom(mm)
    }
  }
  const onRadioKey = (e: React.KeyboardEvent, i: number) => {
    const delta =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0
    if (delta === 0) return
    e.preventDefault()
    const next = (i + delta + presets.length) % presets.length
    onStep(toMm(presets[next]!, units))
    radios.current[next]?.focus()
  }
  const tabStop = preset === undefined ? 0 : presets.indexOf(preset)
  const chosenIndex = preset === undefined ? -1 : presets.indexOf(preset)
  // DF102: the chosen cell stays in view in the scrolled row (sideways only: the panel never moves)
  const [more, setMore] = useState<{ start: boolean; end: boolean }>({ start: false, end: false })
  const measure = () => {
    if (row.current === null) return
    const next = hiddenEdges(row.current)
    setMore((m) => (m.start === next.start && m.end === next.end ? m : next))
  }
  useLayoutEffect(() => {
    const el = chosenIndex < 0 ? field.current : radios.current[chosenIndex]
    if (row.current !== null && el != null) keepInView(row.current, el)
    measure()
  }, [chosenIndex])
  // the edge with cells out of view fades (the scroll bar may be hidden until scrolled, macOS)
  useEffect(() => {
    const el = row.current
    if (el === null) return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    // DF148: no scroll bar, so a plain mouse wheel scrolls the row sideways (not the panel) while
    // the row can still move that way; non-passive to keep the panel still
    const wheel = (e: WheelEvent) => {
      if (e.deltaX !== 0 || e.deltaY === 0) return
      const max = el.scrollWidth - el.clientWidth
      if (max <= 0 || (e.deltaY < 0 ? el.scrollLeft <= 0 : el.scrollLeft >= max)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      observer.disconnect()
      el.removeEventListener('wheel', wheel)
    }
  }, [])

  return (
    <div className={styles['root']} role="group" aria-labelledby={captionId}>
      <div className={styles['caption']}>
        <span id={captionId}>
          <span aria-hidden="true">
            {m.stepCaption} · {unit}
          </span>
          <span className={styles['srOnly']}>{m.step}</span>
        </span>
        {/* role="status", not an aria-live attribute: Radix's modal hiding (aria-hidden) keeps every
            [aria-live] element's ancestors exposed, which would leave the navigator readable
            behind a tool-change dialog */}
        <span id={errorId} className={styles['error']} role="status">
          {invalid ? m.customInvalid(formatStep(fromMm(MAX_JOG_STEP_MM, units)), unit) : null}
        </span>
      </div>
      <div
        ref={row}
        className={styles['grid']}
        data-jog-steps=""
        data-more={more.start ? (more.end ? 'both' : 'start') : more.end ? 'end' : undefined}
        onScroll={measure}
      >
        <div role="radiogroup" aria-label={m.stepPresets} className={styles['presets']}>
          {presets.map((p, i) => {
            const checked = p === preset
            return (
              <button
                key={p}
                ref={(el) => {
                  radios.current[i] = el
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={m.stepPreset(formatStep(p), unit)}
                tabIndex={i === tabStop ? 0 : -1}
                disabled={disabled}
                className={styles['cell']}
                data-state={checked ? 'on' : 'off'}
                onClick={() => onStep(toMm(p, units))}
                onKeyDown={(e) => onRadioKey(e, i)}
              >
                {formatStep(p).replace(/^0\./, '.')}
              </button>
            )
          })}
        </div>
        <input
          ref={field}
          type="text"
          inputMode="decimal"
          className={styles['custom']}
          aria-label={`${m.customStep} (${unit})`}
          placeholder={m.customPlaceholder}
          data-state={preset === undefined ? 'on' : 'off'}
          aria-invalid={invalid || undefined}
          {...(invalid ? { 'aria-describedby': errorId } : {})}
          disabled={disabled}
          value={text}
          onFocus={() => {
            const mm = parseCustomStep(text, units)
            if (mm !== undefined && preset !== undefined) onCustom(mm)
          }}
          onChange={(e) => {
            setDraft(e.target.value)
            setInvalid(false)
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape' && draft !== undefined) {
              // the typed text goes back, the dialog around stays open
              e.stopPropagation()
              setDraft(undefined)
              setInvalid(false)
            }
          }}
        />
      </div>
    </div>
  )
}

/** Scrolls `row` sideways just enough to show `el` (its offset parent) with the row's padding. */
export function keepInView(row: HTMLElement, el: HTMLElement): void {
  const pad = 2
  const start = el.offsetLeft - pad
  const end = el.offsetLeft + el.offsetWidth + pad
  if (start < row.scrollLeft) row.scrollLeft = start
  else if (end > row.scrollLeft + row.clientWidth) row.scrollLeft = end - row.clientWidth
}

/** Which ends of the scrolled row have cells (partly) out of view. */
export function hiddenEdges(row: HTMLElement): { start: boolean; end: boolean } {
  return {
    start: row.scrollLeft > 1,
    end: row.scrollLeft + row.clientWidth < row.scrollWidth - 1,
  }
}
