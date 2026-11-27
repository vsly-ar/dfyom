// The keyboard shortcut list (`?`, Help → Keyboard shortcuts; ui.md#accessibility).
// Doc: docs/conventions/ui.md#keyboard-shortcuts
import type { JogKeyStyle } from '../../../shared/settings'
import { projectMessages } from '../messages/project'
import { JOG_KEY_LABELS } from '../modes/run/jog-keys'
import { Button, Dialog, DialogClose } from '../ui'
import styles from './AppShell.module.css'
import { useSettings, useUi } from './ShellContext'
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
      ['D', m.what.measure],
      ['← → ↑ ↓', m.what.orbit],
      ['+ −', m.what.zoom],
    ],
  },
  {
    group: 'design',
    items: [
      [shortcutLabel('E', { shift: true }), m.what.openShapeEditor],
      [`${alt}↑ ${alt}↓`, m.what.move],
      [`${shift}F10`, m.what.rowMenu],
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
      [shortcutLabel('↓'), m.what.adjust],
      [`${alt}P`, m.what.pick],
      [IS_MAC ? '⌃Space' : 'Ctrl+Space', m.what.references],
    ],
  },
]

/** DF88: the chosen jog hotkey style's keys and Escape (docs/conventions/ui.md#jog-hotkeys). */
export function jogShortcuts(style: JogKeyStyle): [string, string][] {
  const keys: [string, string][] =
    style === 'off'
      ? [['–', m.what.jogOff]]
      : JOG_KEY_LABELS[style].map(([dir, key]) => [key, m.what.jog(dir)])
  return [...keys, ['Esc', m.what.stopJog], ['G', m.what.goTo]]
}

export function ShortcutsDialog(): React.JSX.Element {
  const open = useUi((s) => s.shortcutsOpen)
  const setOpen = useUi((s) => s.setShortcutsOpen)
  const jogKeys = useSettings((s) => s.settings.jogKeys)
  const groups = [...SHORTCUTS, { group: 'runJog' as const, items: jogShortcuts(jogKeys) }]
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
        {groups.map((g) => (
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
