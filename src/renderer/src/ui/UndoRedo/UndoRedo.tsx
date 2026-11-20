// UndoRedo: the main toolbar's undo and redo buttons; their names and tooltips name the step
// ("Undo Add pocket – by agent"). Render inside a Toolbar (roving focus). The shell wires them to
// `history.undo` / `history.redo` and the shortcuts. Doc: docs/conventions/ui.md#undo-and-redo
import { Redo2, Undo2 } from 'lucide-react'
import { ToolbarButton } from '../Toolbar/Toolbar'

export interface UndoRedoProps {
  /** The step undo would revert ("Add pocket – by agent"); `null` = nothing to undo. */
  undo: string | null
  /** The step redo would re-apply; `null` = nothing to redo. */
  redo: string | null
  onUndo: () => void
  onRedo: () => void
  undoShortcut?: string
  redoShortcut?: string
}

export function UndoRedo({
  undo,
  redo,
  onUndo,
  onRedo,
  undoShortcut,
  redoShortcut,
}: UndoRedoProps): React.JSX.Element {
  return (
    <>
      <ToolbarButton
        label={undo === null ? 'Undo' : `Undo ${undo}`}
        icon={<Undo2 aria-hidden="true" />}
        disabled={undo === null}
        onClick={onUndo}
        {...(undoShortcut ? { shortcut: undoShortcut } : {})}
      />
      <ToolbarButton
        label={redo === null ? 'Redo' : `Redo ${redo}`}
        icon={<Redo2 aria-hidden="true" />}
        disabled={redo === null}
        onClick={onRedo}
        {...(redoShortcut ? { shortcut: redoShortcut } : {})}
      />
    </>
  )
}
