// The presets dialogs' one shell (P12): the Pattern presets (DF107) and the Engraving presets (E3)
// share it so they cannot drift. A modal grid of preview cards, one per preset: its preview, name
// (with Current), one-line description and key numbers; optional group headings before the first
// preset of each group. The cards are one radio group with a roving focus: arrows move (Up/Down
// by a row of `columns`), Home/End jump, Enter, Space or a click applies and closes, Escape or the
// footer's Close closes without a change. The current preset is marked and focused on open, and
// scrolled fully into view above the sticky footer.
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
  /** The heading shown before the first preset of each group (none: no headings). */
  group?: ((preset: P) => string) | undefined
  /** Applies the preset (the caller's one update command, one undo step). */
  onApply: (preset: P) => void
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
  group,
  onApply,
}: PresetsDialogProps<P>): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(Math.max(current, 0))
  const cards = useRef<(HTMLButtonElement | null)[]>([])

  // on open the current preset (else the first) is the tabbable card, so it takes the focus
  const openChange = (o: boolean) => {
    if (o) setActive(Math.max(current, 0))
    setOpen(o)
  }
  // focus alone may leave the card cut at the dialog's edge (P12): show it whole
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() =>
      cards.current[Math.max(current, 0)]?.scrollIntoView?.({ block: 'nearest' }),
    )
    return () => cancelAnimationFrame(id)
  }, [open, current])

  const move = (to: number) => {
    const i = Math.min(Math.max(to, 0), presets.length - 1)
    setActive(i)
    cards.current[i]?.focus()
  }
  const apply = (preset: P) => {
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
        <DialogClose>
          <Button>{closeLabel}</Button>
        </DialogClose>
      }
      trigger={trigger}
    >
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
                  {label}
                  {i === current ? (
                    <span className={styles['presetCurrent']}>{currentLabel}</span>
                  ) : null}
                </span>
                <span className={styles['presetDescription']}>{describe(preset)}</span>
                <span className={styles['presetNumbers']}>{numbers(preset)}</span>
              </button>
            </Fragment>
          )
        })}
      </div>
    </Dialog>
  )
}
