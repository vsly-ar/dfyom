// The navigator's "Reference" group (task R3), under the part and its stock: import an STL through
// the native dialog (`design.reference.import` with the chosen absolute path, fitted centre + top),
// one row per reference (its name over the triangle count, each one line) – select it (the inspector follows), the eye toggles its visibility in this
// window only (decision D17: no command, no undo step, never unsaved), remove with the navigator's
// undo toast.
// Doc: docs/modes/reference-model.md#display, docs/conventions/ui.md#reference-ghost-v02
import { Box, Eye, EyeOff, FileUp, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { ReferenceWarning } from '../../../../core/design/reference'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { referenceMessages } from '../../messages/reference'
import { useShell, useUi } from '../../shell/ShellContext'
import { Button, ErrorMessage, IconButton, PanelHeader } from '../../ui'
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
}: {
  part: DesignPart
  /** A reference was removed: the navigator shows its undo toast. */
  onRemoved: (name: string) => void
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
  }
  const remove = async (id: string, name: string) => {
    const r = await call('design.reference.remove', { partId: part.dto.id, referenceId: id })
    if (!r.ok) return
    if (selected === id) select(null)
    onRemoved(name)
  }

  return (
    <section className={styles['references']} aria-label={m.title}>
      <PanelHeader
        title={m.title}
        meta={references.length > 0 ? String(references.length) : undefined}
        actions={
          <IconButton
            label={m.import}
            icon={<FileUp aria-hidden="true" />}
            disabled={busy}
            onClick={() => void importReference()}
          />
        }
      />
      {references.length === 0 ? (
        <div className={styles['emptyReference']}>
          <p className={styles['muted']}>{m.empty}</p>
          <Button
            size="sm"
            icon={<FileUp aria-hidden="true" />}
            disabled={busy}
            onClick={() => void importReference()}
          >
            {busy ? m.importing : m.importStl}
          </Button>
        </div>
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
                onClick={() => select(selected === ref.id ? null : ref.id)}
              >
                <Box aria-hidden="true" />
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
                  icon={visible ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                  onClick={() => setVisible(ref.id, !visible)}
                />
                <IconButton
                  label={m.remove(ref.name)}
                  icon={<Trash2 aria-hidden="true" />}
                  onClick={() => void remove(ref.id, ref.name)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {busy && references.length > 0 ? (
        <p className={styles['note']} role="status">
          {m.importing}
        </p>
      ) : null}
      {error ? (
        <div className={styles['referenceError']}>
          <ErrorMessage error={error} message={m.importFailed} />
        </div>
      ) : null}
    </section>
  )
}
