// ApplyButton: the main toolbar's "Apply N" (v0.2, D13; task P3). A primary Button (icon
// `check-all`, the count as a tabular badge that rolls when it changes) with a rich tooltip that
// explains Apply and lists the pending changes. Hidden while nothing is pending: its slot collapses
// (`--motion-base`) and stays mounted but inert, so appearing never moves the controls to its
// right. "Applying…" with a progress ring after `--delay-indicator`; "Apply failed" (retries);
// "Applied by agent" for 2 s. A polite live region announces the count (debounced 1 s) and the
// outcome. Under reduced motion nothing slides, rolls, spins or fades (tokens zero the durations;
// the indeterminate ring is static). Doc: docs/architecture/apply.md#apply-button, #tooltip
import { Icon } from '../icons/Icon'
import { useEffect, useState } from 'react'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { ERROR_CODES } from '../../../../shared/errors/codes'
import { applyMessages as m } from '../../messages/apply'
import { Button } from '../Button/Button'
import { INDICATOR_DELAY_MS } from '../JobIndicator/JobIndicator'
import { useReducedMotion } from '../motion'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './ApplyButton.module.css'

/** What the button shows (apply.md § Apply button, states). */
export type ApplyButtonState =
  /** Nothing pending; `applied`: because this window just applied (announced). */
  | { readonly kind: 'clean'; readonly applied?: boolean }
  | { readonly kind: 'pending'; readonly count: number }
  /** Apply jobs running; `progress` 0..1 or null (indeterminate); `count` edits made meanwhile. */
  | { readonly kind: 'applying'; readonly count: number; readonly progress: number | null }
  | { readonly kind: 'failed'; readonly count: number; readonly error: AppErrorData }
  /** Another source just applied ("agent"). */
  | { readonly kind: 'appliedBy'; readonly by: string }

export interface ApplyButtonProps {
  state: ApplyButtonState
  /** The tooltip's list of pending changes ("Pocket 1: depth · Drilling 2 added"). */
  list: string
  /** Shortcut text: "⌘↵" or "Ctrl+Enter". */
  shortcut: string
  /** `aria-keyshortcuts`: "Meta+Enter" or "Control+Enter". */
  keyShortcuts: string
  onApply: () => void
  /**
   * When the pending changes apply by themselves (DF28): a thin bar along the button's bottom
   * drains until then (static under reduced motion) and the tooltip says so. Pending state only.
   */
  autoApply?: { readonly at: number; readonly durationMs: number } | null | undefined
  /** Test seam; default `--delay-indicator` (applying) and 1 s (live count). */
  delayMs?: number
  liveDelayMs?: number
  /** Layout only; appended to the slot's class. */
  className?: string | undefined
}

/** Debounce of the live region's "3 changes not applied". */
export const LIVE_DELAY_MS = 1000

function useDelayed(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false)
  // reset when it turns off (state adjusted during render, not in an effect)
  const [wasOn, setWasOn] = useState(on)
  if (wasOn !== on) {
    setWasOn(on)
    if (!on) setLate(false)
  }
  useEffect(() => {
    if (!on) return
    const t = setTimeout(() => setLate(true), ms)
    return () => clearTimeout(t)
  }, [on, ms])
  return on && late
}

/** A state's identity for the live region and the kept content (kind, count, source, applied). */
function signatureOf(state: ApplyButtonState): string {
  return [
    state.kind,
    'count' in state ? state.count : '',
    state.kind === 'appliedBy' ? state.by : '',
    state.kind === 'clean' && state.applied === true ? 'applied' : '',
  ].join(':')
}

/** The shown state: "applying" waits for the indicator delay (fast jobs never flicker). */
function visibleState(state: ApplyButtonState, late: boolean): ApplyButtonState {
  if (state.kind !== 'applying' || late) return state
  return state.count > 0 ? { kind: 'pending', count: state.count } : { kind: 'clean' }
}

function liveText(state: ApplyButtonState, prev: ApplyButtonState | undefined): string | null {
  switch (state.kind) {
    case 'pending':
      return m.live.pending(state.count)
    case 'failed':
      return m.live.failed
    case 'appliedBy':
      return m.live.appliedBy(state.by)
    case 'clean':
      return state.applied === true && !(prev?.kind === 'clean' && prev.applied === true)
        ? m.live.applied
        : null
    case 'applying':
      return null
  }
}

function Ring({ progress }: { progress: number | null }): React.JSX.Element {
  const reduced = useReducedMotion()
  const r = 6
  const c = 2 * Math.PI * r
  const shown = progress ?? 0.25
  return (
    <svg
      viewBox="0 0 16 16"
      className={styles['ring']}
      data-indeterminate={progress === null && !reduced ? '' : undefined}
      role="progressbar"
      aria-label={m.progress}
      {...(progress === null
        ? {}
        : {
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': Math.round(progress * 100),
          })}
    >
      <circle cx="8" cy="8" r={r} className={styles['track']} />
      <circle
        cx="8"
        cy="8"
        r={r}
        className={styles['value']}
        strokeDasharray={`${shown * c} ${c}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

/**
 * The auto-apply wait (DF28): a 2 px bar along the button's bottom edge that drains to nothing
 * when the changes apply; restarts (remounts) with every edit. Decorative: the tooltip says it in
 * words. Under reduced motion it stays as a static full bar (pending, applies by itself).
 */
function Countdown({
  due,
}: {
  due: { readonly at: number; readonly durationMs: number }
}): React.JSX.Element {
  const reduced = useReducedMotion()
  // the share left when it mounts (a re-render keeps the running animation)
  const [left] = useState(() =>
    Math.max(0, Math.min(1, (due.at - Date.now()) / Math.max(1, due.durationMs))),
  )
  return (
    <span
      aria-hidden="true"
      className={styles['countdown']}
      data-static={reduced || undefined}
      style={
        reduced
          ? undefined
          : ({
              '--countdown-from': left,
              animationDuration: `${Math.round(left * due.durationMs)}ms`,
            } as React.CSSProperties)
      }
    />
  )
}

function TooltipBody({
  state,
  list,
  shortcut,
  autoSeconds,
}: {
  state: ApplyButtonState
  list: string
  shortcut: string
  /** DF28: the auto-apply wait while it runs. */
  autoSeconds?: number | undefined
}): React.JSX.Element {
  const count = 'count' in state ? state.count : 0
  return (
    <div className={styles['tip']}>
      <p className={styles['tipTitle']}>
        <b>{m.tooltip.title}</b>
        <kbd className={styles['kbd']}>{shortcut}</kbd>
      </p>
      {state.kind === 'failed' ? (
        <p className={styles['tipError']}>
          {ERROR_CODES[state.error.code]?.userMessage ?? state.error.message}{' '}
          {m.tooltip.failedRetry}
        </p>
      ) : null}
      {state.kind === 'applying' ? <p>{m.tooltip.applying}</p> : null}
      <p>
        {count > 0 ? `${m.tooltip.pending(count)} ` : null}
        {m.tooltip.concept} {m.tooltip.how(shortcut)}
      </p>
      {autoSeconds !== undefined ? <p>{m.tooltip.auto(autoSeconds)}</p> : null}
      {count > 0 && list !== '' ? <p className={styles['tipList']}>{list}</p> : null}
    </div>
  )
}

export function ApplyButton({
  state,
  list,
  shortcut,
  keyShortcuts,
  onApply,
  autoApply,
  delayMs = INDICATOR_DELAY_MS,
  liveDelayMs = LIVE_DELAY_MS,
  className,
}: ApplyButtonProps): React.JSX.Element {
  const late = useDelayed(state.kind === 'applying', delayMs)
  const shown = visibleState(state, late)
  const visible = shown.kind !== 'clean'
  const signature = signatureOf(shown)
  // keep the last visible content while the slot collapses
  const [kept, setKept] = useState({ signature, state: shown })
  if (visible && kept.signature !== signature) setKept({ signature, state: shown })
  const content = visible ? shown : kept.state

  // live region: the count after a pause, the outcome at once; computed when the state changes
  const [announced, setAnnounced] = useState<{
    signature: string
    state: ApplyButtonState
    text: string | null
  }>({ signature: '', state: shown, text: null })
  if (announced.signature !== signature)
    setAnnounced({
      signature,
      state: shown,
      text: liveText(shown, announced.signature === '' ? undefined : announced.state),
    })
  const [live, setLive] = useState('')
  const text = announced.text
  const wait = shown.kind === 'pending' ? liveDelayMs : 0
  useEffect(() => {
    if (text === null) return
    const t = setTimeout(() => setLive(text), wait)
    return () => clearTimeout(t)
  }, [announced, text, wait])

  const count = 'count' in content ? content.count : 0
  const name =
    content.kind === 'applying'
      ? m.applyingName(count)
      : content.kind === 'failed'
        ? m.failed
        : content.kind === 'appliedBy'
          ? m.appliedBy(content.by)
          : m.name(count)

  const countdown = shown.kind === 'pending' && autoApply ? autoApply : null

  const button = (
    <Button
      variant="primary"
      icon={
        content.kind === 'failed' ? (
          <Icon name="error" className={styles['danger']} />
        ) : (
          <Icon name="check-all" />
        )
      }
      aria-label={name}
      aria-keyshortcuts={keyShortcuts}
      data-state={content.kind}
      data-auto-apply={countdown ? '' : undefined}
      className={styles['button']}
      onClick={content.kind === 'appliedBy' ? undefined : onApply}
      tabIndex={visible ? undefined : -1}
    >
      {content.kind === 'applying' ? (
        <>
          <Ring progress={content.progress} />
          {count > 0 ? (
            <>
              {m.label}
              <span key={count} className={styles['badge']}>
                {count}
              </span>
            </>
          ) : (
            m.applying
          )}
        </>
      ) : content.kind === 'failed' ? (
        <span className={styles['danger']}>{m.failed}</span>
      ) : content.kind === 'appliedBy' ? (
        <span className={styles['fade']}>{m.appliedBy(content.by)}</span>
      ) : (
        <>
          {m.label}
          <span key={count} className={styles['badge']}>
            {count}
          </span>
          {countdown ? <Countdown key={countdown.at} due={countdown} /> : null}
        </>
      )}
    </Button>
  )

  return (
    <>
      {/* outside the slot: it is aria-hidden while collapsed, and "Changes applied" comes then */}
      <span aria-live="polite" aria-atomic="true" className={styles['srOnly']}>
        {live}
      </span>
      <div
        className={[styles['slot'], className].filter(Boolean).join(' ')}
        data-shown={visible || undefined}
        {...(visible ? {} : { inert: true, 'aria-hidden': true })}
      >
        <div className={styles['inner']}>
          {content.kind === 'appliedBy' ? (
            button
          ) : (
            <Tooltip
              rich
              content={
                <TooltipBody
                  state={content}
                  list={list}
                  shortcut={shortcut}
                  autoSeconds={countdown ? Math.round(countdown.durationMs / 1000) : undefined}
                />
              }
            >
              {button}
            </Tooltip>
          )}
        </div>
      </div>
    </>
  )
}
