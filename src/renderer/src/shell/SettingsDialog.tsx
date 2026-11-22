// Settings dialog: theme (Light / Dark / System), reduced motion, "Allow local agents to connect",
// the default placement anchor of new pockets and profiles (task F2).
// Changes apply at once to every window and persist (main's settings store).
// Doc: docs/conventions/ui.md#settings
import { useEffect, useId, useState } from 'react'
import type { LocalHttpState } from '../../../shared/preload-api'
import { THEMES, type ThemeSetting } from '../../../shared/settings'
import { designMessages } from '../messages/design'
import { shellMessages } from '../messages/shell'
import { AnchorPicker, Button, Dialog, DialogClose, SegmentedControl, Switch } from '../ui'
import styles from './AppShell.module.css'
import { useSettings, useShell, useUi } from './ShellContext'

const m = shellMessages.settingsDialog

export function SettingsDialog(): React.JSX.Element {
  const { bridge } = useShell()
  const open = useUi((s) => s.settingsOpen)
  const setOpen = useUi((s) => s.setSettingsOpen)
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const [http, setHttp] = useState<LocalHttpState | undefined>(undefined)
  const motionHint = useId()
  const agentsHint = useId()
  const anchorHint = useId()

  // the server's state follows the setting asynchronously: re-read it when either changes
  useEffect(() => {
    if (!open) return
    let live = true
    const read = () =>
      void bridge.agents.localHttp().then((s) => {
        if (live) setHttp(s)
      })
    read()
    const id = setTimeout(read, 300)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [bridge, open, settings.allowLocalAgents])

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={m.title}
      description={m.description}
      footer={
        <DialogClose>
          <Button>{m.done}</Button>
        </DialogClose>
      }
    >
      <div className={styles['settings']}>
        <div className={styles['settingRow']}>
          {/* the group is named by its own aria-label; this is the visible caption */}
          <span className={styles['settingLabel']} aria-hidden="true">
            {m.theme}
          </span>
          <SegmentedControl<ThemeSetting>
            label={m.theme}
            options={THEMES.map((t) => ({ value: t, label: m.themes[t] }))}
            value={settings.theme}
            onValueChange={(theme) => update({ theme })}
          />
        </div>
        <div className={styles['settingRow']}>
          <Switch
            label={m.reduceMotion}
            checked={settings.reduceMotion}
            onCheckedChange={(reduceMotion) => update({ reduceMotion })}
            aria-describedby={motionHint}
          />
          <p id={motionHint} className={styles['settingHint']}>
            {m.reduceMotionHint}
          </p>
        </div>
        <div className={styles['settingRow']}>
          <Switch
            label={m.allowAgents}
            checked={settings.allowLocalAgents}
            onCheckedChange={(allowLocalAgents) => update({ allowLocalAgents })}
            aria-describedby={agentsHint}
          />
          <p id={agentsHint} className={styles['settingHint']}>
            {m.allowAgentsHint(http?.enabled === true ? http.port : undefined)}
          </p>
        </div>
        <div className={styles['settingRow']}>
          <span className={styles['settingLabel']} aria-hidden="true">
            {m.defaultAnchor}
          </span>
          {/* named in the top face's frame: new operations start on the stock top */}
          <AnchorPicker
            label={m.defaultAnchor}
            value={settings.defaultAnchor}
            caption={designMessages.anchorPoint('+z', settings.defaultAnchor)}
            pointLabel={(p) => designMessages.anchorPoint('+z', p)}
            onValueChange={(defaultAnchor) => update({ defaultAnchor })}
            aria-describedby={anchorHint}
          />
          <p id={anchorHint} className={styles['settingHint']}>
            {m.defaultAnchorHint}
          </p>
        </div>
      </div>
    </Dialog>
  )
}
