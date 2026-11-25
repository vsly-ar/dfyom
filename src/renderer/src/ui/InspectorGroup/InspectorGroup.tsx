// InspectorGroup: the one group of every inspector and form (DF110) – a titled section with the
// group header style (bold `--text` eyebrow, a 1 px rule above every group but the first), or an
// accordion (`collapsible`: a chevron button, a one-line summary while closed, the severity of a
// problem inside, a remembered open state) – and `InspectorGroup.More`, the quiet "More (…)" row
// that holds one to three rarely used fields of an open group. Closed content stays mounted but
// hidden, so a message's target inside can be revealed (`revealInInspector`) and focused.
// Doc: docs/conventions/inspector-layout.md#inspector-structure-df110
import {
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { flushSync } from 'react-dom'
import { inspectorMessages as m } from '../../messages/inspector'
import { Icon } from '../icons/Icon'
import { motionMs } from '../motion'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './InspectorGroup.module.css'
import { REVEAL_EVENT, useInspectorMemory, useRememberedGroup } from './memory'

export type GroupSeverity = 'error' | 'warning'

/** Open state of an accordion or More row: controlled, remembered under a key, or local. */
interface DisclosureProps {
  /**
   * Remembered open state under this key (`<inspector kind>.<group id>`: `pocket.corners`), in
   * the app settings across selections and launches; not per item.
   */
  rememberKey?: string | undefined
  /** Open before the user ever toggled it (default: closed). */
  defaultOpen?: boolean | undefined
  /** Controlled open state (the caller keeps it; `rememberKey` is then unused). */
  open?: boolean | undefined
  onOpenChange?: ((open: boolean) => void) | undefined
  /**
   * Shown open while true, whatever was chosen (a field inside has an error, Save focuses it);
   * the chosen state comes back when it turns false.
   */
  forceOpen?: boolean | undefined
}

type SectionAttributes = Omit<
  HTMLAttributes<HTMLElement>,
  'title' | 'children' | 'aria-label' | 'className'
> & { [data: `data-${string}`]: string | boolean | undefined }

export interface InspectorGroupProps extends DisclosureProps, SectionAttributes {
  /** The group title; also the section's accessible name (`getByRole('region', { name })`). */
  title: string
  /** Shown in the heading instead of the title (`Split · 2 pieces`); the name stays `title`. */
  heading?: ReactNode
  /** `h3` (default) or `h4` inside a nested feature body. */
  level?: 3 | 4
  children?: ReactNode
  /** An accordion: the header is a disclosure button with a chevron. */
  collapsible?: boolean
  /** Muted text after the title while closed: the values that matter ("0° · Centre"). */
  summary?: string | undefined
  /** A problem inside: its icon shows in the header of a closed accordion. */
  severity?: GroupSeverity | undefined
  /** A count or state chip at the header's end (`3 rows`), muted. */
  meta?: ReactNode
  /** Actions at the header's end (small buttons). */
  actions?: ReactNode
  /** The group's static explanation as an (i) tip in the header (DF105 rule 7). */
  info?: ReactNode
  /** Layout only; appended to the section's class. */
  className?: string | undefined
  /** The section element (the plan inspector focuses its Checks group). */
  ref?: Ref<HTMLElement> | undefined
}

/** Open state with the remembered / controlled / local precedence and the fold motion. */
function useDisclosure(
  p: DisclosureProps,
  ref: RefObject<HTMLElement | null>,
): { open: boolean; anim: 'opening' | 'closing' | undefined; set: (open: boolean) => void } {
  const memory = useInspectorMemory()
  const remembered = useRememberedGroup(p.rememberKey)
  const [local, setLocal] = useState(p.defaultOpen ?? false)
  const chosen =
    p.open ?? remembered ?? (p.rememberKey === undefined ? local : p.defaultOpen) ?? false
  const open = chosen || p.forceOpen === true
  const [anim, setAnim] = useState<'opening' | 'closing' | undefined>(undefined)
  const set = (next: boolean) => {
    // reduced motion (or no tokens: tests) zeroes the duration: no fold, the change is instant
    setAnim(motionMs('--motion-base') > 0 ? (next ? 'opening' : 'closing') : undefined)
    if (p.open === undefined) {
      if (p.rememberKey !== undefined) memory.setGroup(p.rememberKey, next)
      else setLocal(next)
    }
    p.onOpenChange?.(next)
  }
  const setRef = useRef(set)
  const openRef = useRef(open)
  useEffect(() => {
    setRef.current = set
    openRef.current = open
  })
  // a field inside is revealed (a message's target, a pick): open at once, so it can take focus
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const reveal = () => {
      if (openRef.current) return
      flushSync(() => {
        setAnim(undefined)
        setRef.current(true)
      })
    }
    el.addEventListener(REVEAL_EVENT, reveal)
    return () => el.removeEventListener(REVEAL_EVENT, reveal)
  }, [ref])
  useEffect(() => {
    if (anim === undefined) return
    const t = setTimeout(() => setAnim(undefined), motionMs('--motion-base'))
    return () => clearTimeout(t)
  }, [anim])
  return { open, anim, set }
}

function InfoTip({ id, children }: { id: string; children: ReactNode }): React.JSX.Element {
  return (
    <>
      <Tooltip content={<span className={styles['tip']}>{children}</span>} side="top" align="end">
        <span className={styles['info']} aria-hidden="true" data-testid="group-info">
          <Icon name="info" />
        </span>
      </Tooltip>
      <span id={id} hidden>
        {children}
      </span>
    </>
  )
}

function InspectorGroupRoot({
  title,
  heading,
  level = 3,
  children,
  collapsible = false,
  summary,
  severity,
  meta,
  actions,
  info,
  className,
  rememberKey,
  defaultOpen,
  open: openProp,
  onOpenChange,
  forceOpen,
  ref: outerRef,
  ...rest
}: InspectorGroupProps): React.JSX.Element {
  const Heading = level === 3 ? 'h3' : 'h4'
  const bodyId = useId()
  const infoId = useId()
  const ref = useRef<HTMLElement>(null)
  const { open, anim, set } = useDisclosure(
    { rememberKey, defaultOpen, open: openProp, onOpenChange, forceOpen },
    ref,
  )
  const shown = !collapsible || open
  const describedBy =
    [rest['aria-describedby'], info !== undefined ? infoId : undefined].filter(Boolean).join(' ') ||
    undefined
  return (
    <section
      {...rest}
      ref={(el) => {
        ref.current = el
        if (typeof outerRef === 'function') outerRef(el)
        else if (outerRef) outerRef.current = el
      }}
      aria-label={title}
      aria-describedby={describedBy}
      className={[styles['group'], className].filter(Boolean).join(' ')}
      data-level={level}
      data-collapsible={collapsible || undefined}
      data-open={collapsible ? open : undefined}
    >
      <div className={styles['header']}>
        <Heading className={styles['title']}>
          {collapsible ? (
            <button
              type="button"
              className={styles['toggle']}
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => set(!open)}
            >
              <span className={styles['chevron']} data-open={open || undefined}>
                <Icon name="chevron-down" size="sm" />
              </span>
              <span className={styles['titleText']}>{heading ?? title}</span>
              {!open && severity !== undefined ? (
                <Icon
                  name={severity}
                  size="sm"
                  label={m.severity[severity]}
                  className={styles['severity']}
                  data-severity={severity}
                />
              ) : null}
              {!open && summary ? (
                <>
                  <span className={styles['separator']}>· </span>
                  <span className={styles['summary']}>{summary}</span>
                </>
              ) : null}
            </button>
          ) : (
            (heading ?? title)
          )}
        </Heading>
        {meta !== undefined ? <span className={styles['meta']}>{meta}</span> : null}
        {info !== undefined ? <InfoTip id={infoId}>{info}</InfoTip> : null}
        {actions !== undefined ? <span className={styles['actions']}>{actions}</span> : null}
      </div>
      {collapsible ? (
        <div
          id={bodyId}
          className={styles['body']}
          hidden={!shown && anim !== 'closing'}
          data-anim={anim}
        >
          {children}
        </div>
      ) : (
        children
      )}
    </section>
  )
}

export interface InspectorMoreProps extends DisclosureProps {
  /** The rare fields inside, by their labels: the button reads "More (Rotation, Anchor)". */
  fields: readonly string[]
  children?: ReactNode
}

/** The advanced row: rarely used fields last in an open group, behind a quiet text button. */
function InspectorMore({
  fields,
  children,
  rememberKey,
  defaultOpen,
  open: openProp,
  onOpenChange,
  forceOpen,
}: InspectorMoreProps): React.JSX.Element {
  const bodyId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const { open, anim, set } = useDisclosure(
    { rememberKey, defaultOpen, open: openProp, onOpenChange, forceOpen },
    ref,
  )
  return (
    <div ref={ref} className={styles['more']} data-open={open}>
      <button
        type="button"
        className={styles['moreToggle']}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => set(!open)}
      >
        <span className={styles['chevron']} data-open={open || undefined}>
          <Icon name="chevron-down" size="sm" />
        </span>
        {m.more(fields)}
      </button>
      <div
        id={bodyId}
        className={styles['body']}
        hidden={!open && anim !== 'closing'}
        data-anim={anim}
      >
        {children}
      </div>
    </div>
  )
}

export const InspectorGroup = Object.assign(InspectorGroupRoot, { More: InspectorMore })
