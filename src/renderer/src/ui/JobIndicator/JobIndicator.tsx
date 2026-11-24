// JobIndicator: the status bar's view of running jobs (count, the newest job's label and
// progress), shown only after --delay-indicator so fast work never flickers; opens JobList with
// each job's progress, pause/resume and cancel. Doc: docs/conventions/ui.md#jobs-and-progress
import { Icon } from '../icons/Icon'
import { useEffect, useState } from 'react'
import { IconButton } from '../IconButton/IconButton'
import { Popover } from '../Popover/Popover'
import { Progress } from '../Progress/Progress'
import styles from './JobIndicator.module.css'

/** `--delay-indicator` (tokens.css). */
export const INDICATOR_DELAY_MS = 300

export interface JobView {
  readonly id: string
  /** User-facing label ("Evaluate part"). */
  readonly label: string
  readonly state: 'running' | 'paused'
  /** False: `job.pause` is refused (homing, DF82), so no Pause button. Default true. */
  readonly pausable?: boolean
  /** Determinate when `total` is known. */
  readonly progress?: { readonly done: number; readonly total?: number | undefined } | undefined
}

export interface JobListProps {
  jobs: readonly JobView[]
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
}

function progressOf(job: JobView): { value: number | null; max: number } {
  const p = job.progress
  if (p?.total === undefined || p.total <= 0) return { value: null, max: 100 }
  return { value: p.done, max: p.total }
}

/** Every job with its progress and controls (inside the indicator's popover). */
export function JobList({ jobs, onPause, onResume, onCancel }: JobListProps): React.JSX.Element {
  return (
    <ul className={styles['list']} aria-label="Jobs">
      {jobs.map((j) => {
        const { value, max } = progressOf(j)
        return (
          <li key={j.id} className={styles['item']}>
            <span className={styles['label']}>
              {j.label}
              {j.state === 'paused' ? <span className={styles['muted']}> · Paused</span> : null}
            </span>
            <span className={styles['controls']}>
              {j.state === 'paused' ? (
                <IconButton
                  label={`Resume ${j.label}`}
                  icon={<Icon name="play" />}
                  onClick={() => onResume(j.id)}
                />
              ) : j.pausable === false ? null : (
                <IconButton
                  label={`Pause ${j.label}`}
                  icon={<Icon name="pause" />}
                  onClick={() => onPause(j.id)}
                />
              )}
              <IconButton
                label={`Cancel ${j.label}`}
                icon={<Icon name="close" />}
                onClick={() => onCancel(j.id)}
              />
            </span>
            <Progress label={j.label} value={value} max={max} className={styles['bar']} />
          </li>
        )
      })}
    </ul>
  )
}

export interface JobIndicatorProps extends JobListProps {
  /** Test seam; default `--delay-indicator`. */
  delayMs?: number
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
}

/** True once `active` has stayed true for `delayMs`; false at once when it turns false. */
function useDelayed(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) return
    const id = setTimeout(() => setShown(true), delayMs)
    return () => {
      clearTimeout(id)
      setShown(false)
    }
  }, [active, delayMs])
  return active && shown
}

export function JobIndicator({
  jobs,
  delayMs = INDICATOR_DELAY_MS,
  className,
  ...handlers
}: JobIndicatorProps): React.JSX.Element | null {
  const shown = useDelayed(jobs.length > 0, delayMs)
  const newest = jobs.at(-1)
  if (!shown || newest === undefined) return null
  const { value, max } = progressOf(newest)
  const text = jobs.length > 1 ? `${jobs.length} jobs · ${newest.label}` : newest.label
  return (
    <Popover label="Jobs" title="Jobs" side="top" content={<JobList jobs={jobs} {...handlers} />}>
      <button type="button" className={[styles['trigger'], className].filter(Boolean).join(' ')}>
        <Icon name="busy" className={styles['spinner']} />
        {text}
        {/* decorative; the list has the accessible progress bars */}
        <span className={styles['mini']} data-indeterminate={value === null || undefined}>
          <span
            className={styles['miniBar']}
            style={value === null ? undefined : { width: `${(100 * value) / max}%` }}
          />
        </span>
      </button>
    </Popover>
  )
}
