// "Import $$…" in the Library window's machine editor: paste GRBL's `$$` answer, compare it with
// the saved machine (`library.machine.settings.preview`), tick the changes to keep (rows of a new
// all-axes group tick together) and apply them (`library.machine.settings.import`). Nothing is
// ever sent to GRBL. Doc: docs/conventions/ui-library-window.md#implementation-task-l1,
// docs/architecture/library.md#grbl--import
import { useId, useState } from 'react'
import type { AppErrorData } from '../../../shared/errors/app-error'
import { libraryMessages } from '../messages/library'
import { useCall } from '../shell/hooks'
import { Icon, Button, Checkbox, Dialog, ErrorMessage, Field } from '../ui'
import styles from './GrblImportDialog.module.css'
import formStyles from './LibraryForm.module.css'

const m = libraryMessages.machine
const t = m.grblImport

/** `library.machine.settings.preview`'s result (library.md#grbl--import). */
export interface SettingsDiffView {
  readonly read: number
  readonly changes: readonly {
    setting: string
    field: string
    from: string | null
    to: string
    together?: readonly string[]
  }[]
  readonly unchanged: readonly string[]
  readonly skipped: readonly {
    setting: string
    field: string
    rule: keyof typeof t.skipReasons
  }[]
  readonly ignored: readonly number[]
}

/** The machine form's label of a field path (`maxFeedRate.x` → "Max feed rate X"). */
export function settingFieldLabel(field: string): string {
  const [head, axis = ''] = field.split('.')
  const a = axis.toUpperCase()
  switch (head) {
    case 'travel':
      return m.travelAxis(a)
    case 'maxFeedRate':
      return m.maxFeedAxis(a)
    case 'acceleration':
      return m.accelerationAxis(a)
    case 'stepsPerMm':
      return m.stepsPerMmAxis(a)
    case 'junctionDeviation':
      return m.junctionDeviation
    case 'arcTolerance':
      return m.arcTolerance
    case 'spindle':
      return axis === 'minSpeed' ||
        axis === 'maxSpeed' ||
        axis === 'controllerMinSpeed' ||
        axis === 'controllerMaxSpeed'
        ? m[axis]
        : field
    case 'pullOff':
      return m.pullOff
    case 'softLimits':
      return m.softLimits
    case 'homingCorner':
      return m.homingCorner
    default:
      return field
  }
}

/** A diff value in words: the homing corner's name, soft limits on/off, else as given. */
export function settingValueText<T extends string | null>(field: string, v: T): string | T {
  if (v === null) return v
  if (field === 'homingCorner' && v in m.homingCorners)
    return m.homingCorners[v as keyof typeof m.homingCorners]
  if (field === 'softLimits') return t.onOff[v] ?? v
  return v
}

export function GrblImportDialog({
  id,
  revision,
  disabled,
  onImported,
}: {
  /** The saved machine; the trigger is disabled without one or with unsaved changes. */
  id: string | null
  revision: number | null
  disabled: boolean
  onImported: () => void | Promise<void>
}): React.JSX.Element {
  const call = useCall()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [diff, setDiff] = useState<SettingsDiffView | null>(null)
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ data: AppErrorData; message: string } | null>(null)

  const onOpenChange = (o: boolean) => {
    if (o) {
      setText('')
      setDiff(null)
      setError(null)
    }
    setOpen(o)
  }

  const compare = async () => {
    if (id === null) return
    setBusy(true)
    const r = await call('library.machine.settings.preview', { id, text })
    setBusy(false)
    if (!r.ok) {
      const none = r.error.issues.some((i) => i.rule === 'noSettings')
      setError({ data: r.error, message: none ? t.noSettings : t.compareFailed })
      return
    }
    const d = r.value as SettingsDiffView
    setError(null)
    setDiff(d)
    setAccepted(new Set(d.changes.map((c) => c.setting)))
  }

  const toggle = (setting: string, together: readonly string[] | undefined, on: boolean) => {
    const next = new Set(accepted)
    for (const s of together ?? [setting]) {
      if (on) next.add(s)
      else next.delete(s)
    }
    setAccepted(next)
  }

  const apply = async () => {
    if (id === null || revision === null || diff === null) return
    setBusy(true)
    const accept = diff.changes.map((c) => c.setting).filter((s) => accepted.has(s))
    const r = await call('library.machine.settings.import', { id, revision, text, accept })
    setBusy(false)
    if (!r.ok) {
      setError({ data: r.error, message: t.failed })
      return
    }
    setOpen(false)
    await onImported()
  }

  const trigger = (
    <Button
      size="sm"
      variant="ghost"
      icon={<Icon name="paste" />}
      disabled={disabled}
      title={disabled ? t.saveFirst : undefined}
    >
      {t.open}
    </Button>
  )

  const footer =
    diff === null ? (
      <>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {libraryMessages.cancel}
        </Button>
        <Button
          variant="primary"
          icon={<Icon name="paste" />}
          disabled={busy || text.trim() === ''}
          onClick={() => void compare()}
        >
          {t.compare}
        </Button>
      </>
    ) : (
      <>
        <Button variant="ghost" onClick={() => setDiff(null)}>
          {t.back}
        </Button>
        <Button
          variant="primary"
          icon={<Icon name="download" />}
          disabled={busy || accepted.size === 0}
          onClick={() => void apply()}
        >
          {t.apply(accepted.size)}
        </Button>
      </>
    )

  return (
    <Dialog
      title={t.title}
      description={t.description}
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      footer={footer}
    >
      <div className={formStyles['body']}>
        {error !== null ? <ErrorMessage error={error.data} message={error.message} /> : null}
        {diff === null ? (
          <Field
            label={t.text}
            messages={[{ id: 'grbl-text-note', severity: 'note', text: t.textNote }]}
          >
            <textarea
              className={styles['text']}
              rows={12}
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
        ) : (
          <DiffView diff={diff} accepted={accepted} onToggle={toggle} />
        )}
      </div>
    </Dialog>
  )
}

function DiffView({
  diff,
  accepted,
  onToggle,
}: {
  diff: SettingsDiffView
  accepted: ReadonlySet<string>
  onToggle: (setting: string, together: readonly string[] | undefined, on: boolean) => void
}): React.JSX.Element {
  const changesId = useId()
  const skippedId = useId()
  return (
    <>
      <p className={styles['summary']}>{t.summary(diff.read, diff.unchanged.length)}</p>
      <section aria-labelledby={changesId} className={formStyles['group']}>
        <h3 id={changesId} className={formStyles['legend']}>
          {t.changes}
        </h3>
        {diff.changes.length === 0 ? (
          <p className={styles['empty']}>{t.noChanges}</p>
        ) : (
          <ul className={styles['list']}>
            {diff.changes.map((c) => (
              <li key={c.setting}>
                <Checkbox
                  label={`${settingFieldLabel(c.field)} (${c.setting}): ${settingValueText(c.field, c.from) ?? t.notSet} → ${settingValueText(c.field, c.to)}`}
                  checked={accepted.has(c.setting)}
                  onCheckedChange={(on) => onToggle(c.setting, c.together, on === true)}
                />
                {c.together !== undefined && c.together[0] === c.setting ? (
                  <p className={styles['note']}>{t.together}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {diff.skipped.length > 0 ? (
        <section aria-labelledby={skippedId} className={formStyles['group']}>
          <h3 id={skippedId} className={formStyles['legend']}>
            {t.skipped}
          </h3>
          <ul className={styles['list']}>
            {diff.skipped.map((s) => (
              <li key={s.setting} className={styles['skip']}>
                <span className={styles['skipName']}>
                  {settingFieldLabel(s.field)} ({s.setting})
                </span>
                <span>{t.skipReasons[s.rule]}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {diff.ignored.length > 0 ? (
        <p className={styles['note']}>{t.ignored(diff.ignored.map((n) => `$${n}`).join(', '))}</p>
      ) : null}
    </>
  )
}
