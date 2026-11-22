// The keyboard shortcut list (`?`, Help → Keyboard shortcuts; ui.md#accessibility).
// Doc: docs/conventions/ui.md#keyboard-shortcuts
import { projectMessages } from '../messages/project'
import { Button, Dialog, DialogClose } from '../ui'
import styles from './AppShell.module.css'
import { useUi } from './ShellContext'
import { APPLY_SHORTCUT, IS_MAC, shortcutLabel } from './shortcuts'

const m = projectMessages.shortcuts
const alt = IS_MAC ? '⌥' : 'Alt+'
const shift = IS_MAC ? '⇧' : 'Shift+'

/** The list, grouped as the menu is (whole sentences live in messages; keys are symbols). */
export const SHORTCUTS: readonly { group: keyof typeof m.groups; items: [string, string][] }[] = [
  {
    group: 'file',
    items: [
      [shortcutLabel('N'), m.what.newProject],
      [shortcutLabel('O'), m.what.openProject],
      [shortcutLabel('S'), m.what.save],
      [shortcutLabel('S', { shift: true }), m.what.saveAs],
      [APPLY_SHORTCUT, m.what.apply],
      [shortcutLabel(','), m.what.settings],
    ],
  },
  {
    group: 'edit',
    items: [
      [shortcutLabel('Z'), m.what.undo],
      [shortcutLabel('Z', { shift: true }), m.what.redo],
      ['Esc', m.what.escape],
    ],
  },
  {
    group: 'modes',
    items: [
      [`${shortcutLabel('1')} ${shortcutLabel('2')} ${shortcutLabel('3')}`, m.what.modes],
      ['F6', m.what.regions],
      ['?', m.what.list],
    ],
  },
  {
    group: 'viewport',
    items: [
      ['1 2 3 4', m.what.views],
      [`${shift}1 ${shift}2 ${shift}3`, m.what.oppositeViews],
      ['F', m.what.fit],
      ['← → ↑ ↓', m.what.orbit],
      ['+ −', m.what.zoom],
    ],
  },
  {
    group: 'design',
    items: [
      [`${alt}↑ ${alt}↓`, m.what.move],
      ['M', m.what.measure],
      [`${alt}drag`, m.what.noSnap],
      [`${shift}drag`, m.what.angleStep],
    ],
  },
  {
    group: 'library',
    items: [
      [shortcutLabel('L', { shift: true }), m.what.openLibrary],
      [`${shortcutLabel('S')} ${APPLY_SHORTCUT}`, m.what.librarySave],
      ['↑ ↓', m.what.libraryList],
    ],
  },
  {
    group: 'fields',
    items: [
      ['Enter', m.what.commit],
      ['Tab', m.what.commitOnly],
      ['Esc', m.what.revert],
      ['↑ ↓', m.what.step],
      [`${alt}P`, m.what.pick],
      ['Ctrl+Space', m.what.references],
    ],
  },
]

export function ShortcutsDialog(): React.JSX.Element {
  const open = useUi((s) => s.shortcutsOpen)
  const setOpen = useUi((s) => s.setShortcutsOpen)
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={m.title}
      description={m.description}
      footer={
        <DialogClose>
          <Button>{m.close}</Button>
        </DialogClose>
      }
    >
      <div className={styles['shortcuts']}>
        {SHORTCUTS.map((g) => (
          <section key={g.group} aria-label={m.groups[g.group]}>
            <h3 className={styles['shortcutGroup']}>{m.groups[g.group]}</h3>
            <dl className={styles['shortcutList']}>
              {g.items.map(([keys, what]) => (
                <div key={what} className={styles['shortcutRow']}>
                  <dt>
                    <kbd>{keys}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
