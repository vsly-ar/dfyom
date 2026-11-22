// A context link to the Library window (L2): "Edit in library" beside a plan operation's tool and
// the plan's machine, "Open library" in the stock setup. Opens (or focuses) the window on the
// item's tab with the item selected, with this window's project as its context.
// Doc: docs/conventions/ui-library-window.md#decisions-assumed
import type { LibraryTarget } from '../../../shared/preload-api'
import { libraryMessages } from '../messages/library'
import { useShell } from '../shell/ShellContext'
import { Icon, Button } from '../ui'

export function LibraryLink({
  target,
  label = target.itemId === undefined ? libraryMessages.links.open : libraryMessages.links.edit,
}: {
  target: LibraryTarget
  label?: string
}): React.JSX.Element {
  const { bridge } = useShell()
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<Icon name="library" />}
      onClick={() => void bridge.library.open(target)}
    >
      {label}
    </Button>
  )
}
