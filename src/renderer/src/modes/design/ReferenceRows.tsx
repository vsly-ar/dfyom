// The Reference dialog's body (task R3; the navigator's "Reference" group until D45): import an STL through
// the native dialog (`design.reference.import` with the chosen absolute path, fitted centre + top),
// one row per reference (its name over the triangle count, each one line) – select it (the inspector follows), the eye toggles its visibility in this
// window only (decision D17: no command, no undo step, never unsaved), remove with the navigator's
// undo toast. Choosing a row or a finished import selects the reference and closes the dialog
// (`onChosen`); the eye and Remove keep it open.
// Doc: docs/modes/reference-model.md#display, docs/conventions/ui.md#reference-ghost-v02,
// docs/conventions/ui.md#design-sidebar-and-setup-dialogs-v04-d45
import { useState } from 'react'
import type { ReferenceWarning } from '../../../../core/design/reference'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { referenceMessages } from '../../messages/reference'
import { useShell, useUi } from '../../shell/ShellContext'
import { Icon, Button, ErrorMessage, IconButton } from '../../ui'
import styles from './Design.module.css'
import type { DesignPart } from './model'
import { useCommand, useDesignReferences, useDesignSelection } from './useDesign'

const m = referenceMessages

interface Imported {
  readonly referenceId: string
  readonly warnings: readonly ReferenceWarning[]
}

export function ReferenceRows({
  part,
  onRemoved,
  onChosen,
}: {
  part: DesignPart
  /** A reference was removed: the navigator shows its undo toast. */
  onRemoved: (name: string) => void
  /** A reference was chosen or imported and is selected: the dialog closes so its inspector shows. */
  onChosen: () => void
}): React.JSX.Element {
  const { bridge } = useShell()
  const call = useCommand()
  const [selected, select] = useDesignSelection()
  const references = useDesignReferences(part)
  const setVisible = useUi((s) => s.setReferenceVisible)
  const setNotes = useUi((s) => s.setReferenceNotes)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppErrorData | undefined>(undefined)

  const importReference = async () => {
    const path = await bridge.files.chooseReference()
    if (path === null) return
    setBusy(true)
    const r = await call('design.reference.import', { partId: part.dto.id, path })
    setBusy(false)
    setError(r.ok ? undefined : r.error)
    if (!r.ok) return
    const { referenceId, warnings } = r.value as Imported
    setNotes(referenceId, warnings)
    select(referenceId)
    onChosen()
  }
  const remove = async (id: string, name: string) => {
    const r = await call('design.reference.remove', { partId: part.dto.id, referenceId: id })
    if (!r.ok) return
    if (selected === id) select(null)
    onRemoved(name)
  }

  return (
    <div className={[styles['setupList'], styles['references']].join(' ')}>
      <div className={styles['setupActions']}>
        <Button
          size="sm"
          icon={<Icon name="import" />}
          disabled={busy}
          onClick={() => void importReference()}
        >
          {m.importStl}
        </Button>
      </div>
      {references.length === 0 ? (
        <p className={styles['setupEmpty']}>{m.empty}</p>
      ) : (
        <ul className={styles['ops']} aria-label={m.listLabel}>
          {references.map(({ ref, visible }) => (
            <li
              key={ref.id}
              className={styles['op']}
              data-selected={selected === ref.id ? '' : undefined}
              data-hidden={visible ? undefined : ''}
            >
              <button
                type="button"
                className={styles['opSelect']}
                aria-pressed={selected === ref.id}
                onClick={() => {
                  if (selected !== ref.id) select(ref.id)
                  onChosen()
                }}
              >
                <Icon name="reference" />
                <span className={styles['referenceText']}>
                  <span className={styles['opName']} title={ref.name}>
                    {ref.name}
                  </span>
                  <span className={styles['referenceMeta']}>
                    {visible ? m.triangles(ref.asset.triangles) : m.hidden}
                  </span>
                </span>
              </button>
              <span className={styles['referenceActions']}>
                <IconButton
                  label={m.show}
                  pressed={visible}
                  icon={visible ? <Icon name="eye" /> : <Icon name="eye-off" />}
                  onClick={() => setVisible(ref.id, !visible)}
                />
                <IconButton
                  label={m.remove(ref.name)}
                  icon={<Icon name="delete" />}
                  onClick={() => void remove(ref.id, ref.name)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {busy ? (
        <p className={styles['note']} role="status">
          {m.importing}
        </p>
      ) : null}
      {error ? (
        <div className={styles['referenceError']}>
          <ErrorMessage error={error} message={m.importFailed} />
        </div>
      ) : null}
    </div>
  )
}
