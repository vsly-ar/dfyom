// ApplyScope: what Enter in a field does besides committing (v0.2 field rule, task P3). The shell
// provides the project's Apply around the window; a modal Dialog and forms with local state
// (stock setup) provide `null`, so Enter there only commits, as before. Fields read it with
// `useApplyOnEnter()`. Doc: docs/architecture/apply.md#field-rule, #keyboard
import { createContext, useContext, type ReactNode } from 'react'

const ApplyContext = createContext<(() => void) | null>(null)

/** Attribute on modal dialog content: Cmd/Ctrl+Enter is inactive while one is open. */
export const MODAL_ATTR = 'data-modal-dialog'

/** Whether a modal dialog is open in the document (its content carries `MODAL_ATTR`). */
export function modalDialogOpen(root: ParentNode = document): boolean {
  return root.querySelector(`[${MODAL_ATTR}]`) !== null
}

export function ApplyScope({
  onApply,
  children,
}: {
  /** Called after Enter committed a valid value (or an unchanged one); null: Enter only commits. */
  onApply: (() => void) | null
  children: ReactNode
}): React.JSX.Element {
  return <ApplyContext.Provider value={onApply}>{children}</ApplyContext.Provider>
}

/** The Apply that Enter in a field runs after its commit, or null (outside a scope, in a dialog). */
export function useApplyOnEnter(): (() => void) | null {
  return useContext(ApplyContext)
}
