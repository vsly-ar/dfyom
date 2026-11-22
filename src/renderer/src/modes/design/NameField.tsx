// A text field committing on Enter (and applying, task P3) or blur (Escape reverts), for names (part, operation,
// reference). Doc: docs/conventions/ui.md#panels-and-inspectors
import { useState } from 'react'
import { Field, FieldInput, useApplyOnEnter } from '../../ui'

/** A text field committing on Enter or blur (Escape reverts). */
export function NameField({
  label,
  name,
  onCommit,
}: {
  label: string
  name: string
  onCommit: (name: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(name)
  // the stored name changed (commit, undo, agent): follow it
  const [seen, setSeen] = useState(name)
  if (name !== seen) {
    setSeen(name)
    setDraft(name)
  }
  const applyOnEnter = useApplyOnEnter()
  const commit = () => {
    const v = draft.trim()
    if (v.length > 0 && v !== name) onCommit(v)
    else setDraft(name)
  }
  return (
    <Field label={label}>
      <FieldInput
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // commit and apply (apply.md#field-rule)
            e.preventDefault()
            commit()
            applyOnEnter?.()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(name)
          }
        }}
      />
    </Field>
  )
}
