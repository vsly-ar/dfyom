// Shared state of the "New tool" and "New machine" dialogs: open, busy, the last command error,
// its issues per field (ui.md#errors: at the field with aria-invalid, the rest as a summary above
// the fields, focus on the first invalid field after a failed submit).
// Doc: docs/conventions/ui.md#plan-mode-task-37, #errors
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { libraryMessages } from '../../messages/library'
import { sentence } from '../../messages/plan'
import { ErrorMessage, type FieldMessage } from '../../ui'
import { issuesAt, unmatchedIssues } from './library-form'
import styles from './LibraryForm.module.css'

export interface LibraryFormState {
  readonly open: boolean
  setOpen: (open: boolean) => void
  readonly busy: boolean
  readonly error: AppErrorData | undefined
  /** Bumped on every failed submit, so the body moves the focus once per failure. */
  readonly failures: number
  /** The error's issues at a field, as field messages. */
  messages: (field: string) => FieldMessage[]
  /** Runs the add; an error closes nothing, success closes the dialog. */
  submit: (run: () => Promise<AppErrorData | undefined>) => Promise<void>
  readonly fields: readonly string[]
}

export function useLibraryForm(fields: readonly string[]): LibraryFormState {
  const [open, setOpenState] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const [failures, setFailures] = useState(0)
  const issues = error?.issues ?? []
  return {
    open,
    setOpen: (o) => {
      if (o) setError(undefined)
      setOpenState(o)
    },
    busy,
    error,
    failures,
    fields,
    messages: (field) =>
      issuesAt(issues, field).map((i, n) => ({
        id: `${field}-${n}`,
        severity: 'error',
        text: sentence(i.message),
      })),
    submit: async (run) => {
      setBusy(true)
      const e = await run()
      setBusy(false)
      setError(e)
      if (e === undefined) setOpenState(false)
      else setFailures((n) => n + 1)
    },
  }
}

/**
 * The fields of a library form, not a `<form>`: Enter in a field commits that field
 * (QuantityInput), it does not submit (as the stock setup).
 */
export function LibraryFormBody({
  form,
  children,
}: {
  form: LibraryFormState
  children: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const { error, failures, fields } = form
  useEffect(() => {
    if (failures === 0) return
    ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [failures])
  const rest = error === undefined ? [] : unmatchedIssues(error.issues, fields)
  const summary =
    error === undefined
      ? null
      : error.issues.length === 0 || rest.length > 0
        ? { ...error, issues: rest }
        : null
  return (
    <div ref={ref} className={styles['body']}>
      {summary !== null ? (
        <ErrorMessage
          error={summary}
          message={
            rest.length > 0
              ? `${libraryMessages.failed} ${rest.map((i) => sentence(i.message)).join(' ')}`
              : libraryMessages.failed
          }
        />
      ) : null}
      {children}
    </div>
  )
}
