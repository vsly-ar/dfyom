// The presets dialogs' one shell (P12): the Pattern presets (DF107) and the Engraving presets (E3)
// share it so they cannot drift. A modal grid of preview cards, one per preset: its preview, name
// (with Current), one-line description and key numbers; optional group headings before the first
// preset of each group. The cards are one radio group with a roving focus: arrows move (Up/Down
// by a row of `columns`), Home/End jump, Enter, Space or a click applies and closes, Escape or the
// footer's Close closes without a change. The current preset is marked and focused on open, and
// scrolled fully into view above the sticky footer. H1 (pattern-presets.md § UI): optional
// `header` above the grid (the Pattern dialog's group control), `onChoose` taking a card without
// closing (a heatsink card opens its parameter step), and `step` shown in place of the grid with
// its own footer; Escape while a step shows goes back to the grid (`step.onBack`), a second one
// closes. `open`/`onOpenChange` let the caller close it from the step's Apply.
// Doc: docs/modes/patterns.md#presets-dialog-and-more-presets-df107, docs/modes/engraved-patterns.md#implementation-e3
import { Fragment, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Button, Dialog, DialogClose } from '../../ui'
import styles from './Design.module.css'

export interface PresetsDialogProps<P extends { readonly id: string }> {
  title: string
  description: string
  /** The footer's Close. */
  closeLabel: string
  /** The marker on the current preset's card. */
  currentLabel: string
  /** The inspector's Presets… button. */
  trigger: ReactElement
  presets: readonly P[]
  /** Index of the preset the item already is; -1 for none. */
  current: number
  /** Cards per row (the grid's columns; Up/Down move by a row). */
  columns: number
  name: (preset: P) => string
  describe: (preset: P) => string
  numbers: (preset: P) => string
  preview: (preset: P) => ReactNode
  /** The preset's icon before its name (H1: the heatsink cards). */
  icon?: ((preset: P) => ReactNode) | undefined
  /** The heading shown before the first preset of each group (none: no headings). */
  group?: ((preset: P) => string) | undefined
  /** Applies the preset (the caller's one update command, one undo step). */
  onApply: (preset: P) => void
  /** Shown above the grid (H1: the group control). */
  header?: ReactNode
  /** Takes a chosen card first: true keeps the dialog open and does not apply (H1). */
  onChoose?: ((preset: P) => boolean) | undefined
  /** Shown in place of the grid, with its footer; Escape calls `onBack` (H1). */
  step?: { content: ReactNode; footer: ReactNode; onBack: () => void } | undefined
  /** Controlled open state (the step's Apply closes it). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function PresetsDialog<P extends { readonly id: string }>({
  title,
  description,
  closeLabel,
  currentLabel,
  trigger,
  presets,
  current,
  columns,
  name,
  describe,
  numbers,
  preview,
  icon,
  group,
  onApply,
  header,
  onChoose,
  step,
  open: openProp,
  onOpenChange,
}: PresetsDialogProps<P>): React.JSX.Element {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = (o: boolean) => {
    setOpenState(o)
    onOpenChange?.(o)
  }
  const [active, setActive] = useState(Math.max(current, 0))
  const cards = useRef<(HTMLButtonElement | null)[]>([])

  // on open the current preset (else the first) is the tabbable card, so it takes the focus
  const openChange = (o: boolean) => {
    // Escape (or a click outside) on a step goes back to the grid first
    if (!o && step !== undefined) return step.onBack()
    if (o) setActive(Math.max(current, 0))
    setOpen(o)
  }
  // focus alone may leave the card cut at the dialog's edge (P12): show it whole
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => {
      const card = cards.current[Math.max(current, 0)]
      card?.scrollIntoView?.({ block: 'nearest' })
      // a header (H1's group control) comes first in the tab order: the card still takes focus
      if (header !== undefined) card?.focus()
    })
    return () => cancelAnimationFrame(id)
    // on open only: choosing a group keeps the focus on the group control
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current])

  // H4: keyboard flow through a step: its `data-step-focus` element (else its first control)
  // takes the focus when it opens, and the card it came from takes it back on Back or Escape
  // (the grid remounts; the focus would fall to the dialog)
  const stepRef = useRef<HTMLDivElement | null>(null)
  const inStep = step !== undefined
  const wasInStep = useRef(false)
  useEffect(() => {
    if (!open) {
      wasInStep.current = false
      return
    }
    if (inStep === wasInStep.current) return
    wasInStep.current = inStep
    const id = requestAnimationFrame(() => {
      if (inStep)
        stepRef.current
          ?.querySelector<HTMLElement>('[data-step-focus], input, button, [tabindex]')
          ?.focus()
      else cards.current[active]?.focus()
    })
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inStep])

  const move = (to: number) => {
    const i = Math.min(Math.max(to, 0), presets.length - 1)
    setActive(i)
    cards.current[i]?.focus()
  }
  const apply = (preset: P) => {
    if (onChoose?.(preset) === true) return
    setOpen(false)
    onApply(preset)
  }
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns,
      ArrowUp: -columns,
    }
    if (e.key in step) move(i + step[e.key]!)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(presets.length - 1)
    else return
    e.preventDefault()
  }

  return (
    <Dialog
      title={title}
      description={description}
      size="xl"
      open={open}
      onOpenChange={openChange}
      footer={
        step !== undefined ? (
          step.footer
        ) : (
          <DialogClose>
            <Button>{closeLabel}</Button>
          </DialogClose>
        )
      }
      trigger={trigger}
    >
      {header}
      {step !== undefined ? (
        <div ref={stepRef}>{step.content}</div>
      ) : (
        <div
          role="radiogroup"
          aria-label={title}
          className={styles['presetGrid']}
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {presets.map((preset, i) => {
            const label = name(preset)
            const heading = group?.(preset)
            const opensGroup =
              heading !== undefined && (i === 0 || group?.(presets[i - 1]!) !== heading)
            return (
              <Fragment key={preset.id}>
                {opensGroup ? <h3 className={styles['presetGroup']}>{heading}</h3> : null}
                <button
                  ref={(el) => {
                    cards.current[i] = el
                  }}
                  type="button"
                  role="radio"
                  aria-label={label}
                  aria-description={`${describe(preset)} ${numbers(preset)}`}
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
                  {preview(preset)}
                  <span className={styles['presetName']}>
                    {icon?.(preset)}
                    {label}
                    {i === current ? (
                      <span className={styles['presetCurrent']}>{currentLabel}</span>
                    ) : null}
                  </span>
                  <span className={styles['presetDescription']}>{describe(preset)}</span>
                  <span className={styles['presetNumbers']}>
                    {/* H4: a line breaks only between two numbers, never inside one */}
                    {numbers(preset)
                      .split(' · ')
                      .map((n, k) => (
                        <Fragment key={k}>
                          {k > 0 ? ' · ' : null}
                          <span>{n}</span>
                        </Fragment>
                      ))}
                  </span>
                </button>
              </Fragment>
            )
          })}
        </div>
      )}
    </Dialog>
  )
}
