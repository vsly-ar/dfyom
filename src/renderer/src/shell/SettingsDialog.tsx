// Settings dialog: theme (Light / Dark / System), reduced motion, "Allow local agents to connect",
// the default placement anchor of new pockets and profiles (task F2), the snap grid per unit
// system (task U3), the jog hotkey style and "Ask again" for the skipped homing confirmations
// (DF88). The rows are grouped (Appearance, Editing, Run, Agents) with the inspectors' group
// header style (DF110 S6, docs/conventions/inspector-layout.md#group-header-style).
// Changes apply at once to every window and persist (main's settings store).
// Doc: docs/conventions/ui.md#settings
import { useEffect, useId, useState } from 'react'
import type { LocalHttpState } from '../../../shared/preload-api'
import {
  JOG_KEY_STYLES,
  SURFACE_MAX_RANGE,
  THEMES,
  type ThemeSetting,
} from '../../../shared/settings'
import { Quantity } from '../../../core/quantity/quantity'
import { BACK_OFF_MAX_MM, BACK_OFF_MIN_MM } from '../../../core/run/back-off'
import type { UnitId } from '../../../core/quantity/units'
import { fail, Ok, type AppResult } from '../../../shared/result'
import { designMessages } from '../messages/design'
import { shellMessages } from '../messages/shell'
import {
  AnchorPicker,
  Button,
  Dialog,
  DialogClose,
  InspectorGroup,
  QuantityInput,
  SegmentedControl,
  Select,
  Switch,
} from '../ui'
import styles from './AppShell.module.css'
import { useSettings, useShell, useUi } from './ShellContext'

const m = shellMessages.settingsDialog

/** Auto-apply delays offered (s; 0 = off, DF28); a stored value outside the list is kept as an option. */
const AUTO_APPLY_DELAYS = [0, 3, 5, 10, 30, 60] as const

/** The stored grid step (a number in `unit`) as a field value. */
const gridValue = (n: number, unit: UnitId): Quantity | undefined => {
  const q = Quantity.parse(String(+n.toPrecision(10)), { kind: 'length', defaultUnit: unit })
  return q.isOk() ? q.unwrap() : undefined
}
const positive = (q: Quantity): AppResult<Quantity> =>
  q.canonical > 0
    ? Ok(q)
    : fail('model.invariant', 'must be positive', {
        issues: [{ path: ['exact'], rule: 'positive', message: m.snapGridPositive }],
      })

/** DF143: the back-off distance's range (mm). */
const backOffRange = (q: Quantity): AppResult<Quantity> =>
  q.canonical >= BACK_OFF_MIN_MM && q.canonical <= BACK_OFF_MAX_MM
    ? Ok(q)
    : fail('model.invariant', 'out of range', {
        issues: [
          {
            path: ['exact'],
            rule: 'range',
            message: `${BACK_OFF_MIN_MM}–${BACK_OFF_MAX_MM} mm`,
          },
        ],
      })

/** v0.5 RV11: the bed map age choices (days). */
const BED_MAP_AGES: readonly number[] = [7, 14, 30, 60, 90, 180, 365]

/** v0.5 RV10: "Follow the surface map"'s largest map range (mm). */
const surfaceRange = (q: Quantity): AppResult<Quantity> =>
  q.canonical >= SURFACE_MAX_RANGE.min && q.canonical <= SURFACE_MAX_RANGE.max
    ? Ok(q)
    : fail('model.invariant', 'out of range', {
        issues: [
          {
            path: ['exact'],
            rule: 'range',
            message: `${SURFACE_MAX_RANGE.min}–${SURFACE_MAX_RANGE.max} mm`,
          },
        ],
      })

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
  const gridHint = useId()
  const autoApplyHint = useId()
  const jogKeysHint = useId()
  const homeHint = useId()
  const reconnectHint = useId()
  const advancedHint = useId()
  const backOffHint = useId()
  const delays: readonly number[] = AUTO_APPLY_DELAYS.includes(
    settings.autoApplyDelay as (typeof AUTO_APPLY_DELAYS)[number],
  )
    ? AUTO_APPLY_DELAYS
    : [...AUTO_APPLY_DELAYS, settings.autoApplyDelay].toSorted((a, b) => a - b)

  const ages = BED_MAP_AGES.includes(settings.bedMapMaxAge)
    ? BED_MAP_AGES
    : [...BED_MAP_AGES, settings.bedMapMaxAge].toSorted((a, b) => a - b)

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
        <InspectorGroup title={m.groups.appearance} className={styles['settingsGroup']}>
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
        </InspectorGroup>
        <InspectorGroup title={m.groups.editing} className={styles['settingsGroup']}>
          <div className={styles['settingRow']}>
            <span className={styles['settingLabel']} aria-hidden="true">
              {m.autoApply}
            </span>
            <div className={styles['settingSelect']}>
              <Select<string>
                aria-label={m.autoApply}
                aria-describedby={autoApplyHint}
                options={delays.map((s) => ({
                  value: String(s),
                  label: s === 0 ? m.autoApplyOff : m.autoApplySeconds(s),
                }))}
                value={String(settings.autoApplyDelay)}
                onValueChange={(v) => update({ autoApplyDelay: Number(v) })}
              />
            </div>
            <p id={autoApplyHint} className={styles['settingHint']}>
              {m.autoApplyHint}
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
          <div className={styles['settingRow']} role="group" aria-label={m.snapGrid}>
            <span className={styles['settingLabel']} aria-hidden="true">
              {m.snapGrid}
            </span>
            <div className={styles['settingPair']}>
              <QuantityInput
                label={m.snapGridMm}
                stepKind="small"
                kind="length"
                defaultUnit="mm"
                value={gridValue(settings.snapGrid.mm, 'mm')}
                validate={positive}
                onCommit={(q) => update({ snapGrid: { ...settings.snapGrid, mm: q.canonical } })}
              />
              <QuantityInput
                label={m.snapGridInch}
                stepKind="small"
                kind="length"
                defaultUnit="in"
                value={gridValue(settings.snapGrid.inch, 'in')}
                validate={positive}
                onCommit={(q) =>
                  update({ snapGrid: { ...settings.snapGrid, inch: q.canonical / 25.4 } })
                }
              />
            </div>
            <p id={gridHint} className={styles['settingHint']}>
              {m.snapGridHint}
            </p>
          </div>
        </InspectorGroup>
        <InspectorGroup title={m.groups.run} className={styles['settingsGroup']}>
          <div className={styles['settingRow']}>
            <span className={styles['settingLabel']} aria-hidden="true">
              {m.jogKeys}
            </span>
            <div className={styles['settingSelect']}>
              <Select<string>
                aria-label={m.jogKeys}
                aria-describedby={jogKeysHint}
                options={[
                  ...JOG_KEY_STYLES.map((s) => ({ value: s, label: m.jogKeyStyles[s] })),
                  { value: 'custom', label: m.jogKeysCustom, disabled: true },
                ]}
                value={settings.jogKeys}
                onValueChange={(v) => {
                  const style = JOG_KEY_STYLES.find((s) => s === v)
                  if (style !== undefined) update({ jogKeys: style })
                }}
              />
            </div>
            <p id={jogKeysHint} className={styles['settingHint']}>
              {m.jogKeysHint}
            </p>
          </div>
          <div className={styles['settingRow']}>
            <span className={styles['settingLabel']} aria-hidden="true">
              {m.homeConfirm}
            </span>
            <div>
              <Button
                disabled={settings.skipHomeConfirm.length === 0}
                aria-describedby={homeHint}
                onClick={() => update({ skipHomeConfirm: [] })}
              >
                {m.homeConfirmReset}
              </Button>
            </div>
            <p id={homeHint} className={styles['settingHint']}>
              {m.homeConfirmHint(settings.skipHomeConfirm.length)}
            </p>
          </div>
          <div className={styles['settingRow']}>
            <Switch
              label={m.autoReconnect}
              checked={settings.autoReconnect}
              onCheckedChange={(autoReconnect) => update({ autoReconnect })}
              aria-describedby={reconnectHint}
            />
            <p id={reconnectHint} className={styles['settingHint']}>
              {m.autoReconnectHint}
            </p>
          </div>
          {/* DF143: advanced user (docs/modes/run.md#advanced-user-df143) */}
          <div className={styles['settingRow']}>
            <Switch
              label={m.advancedUser}
              checked={settings.advancedUser}
              onCheckedChange={(advancedUser) => update({ advancedUser })}
              aria-describedby={advancedHint}
            />
            <p id={advancedHint} className={styles['settingHint']}>
              {m.advancedUserHint}
            </p>
          </div>
          {settings.advancedUser ? (
            <div className={styles['settingRow']}>
              <span className={styles['settingLabel']} aria-hidden="true">
                {m.limitBackOff}
              </span>
              <div className={styles['settingSelect']}>
                <QuantityInput
                  label={m.limitBackOff}
                  stepKind="small"
                  kind="length"
                  defaultUnit="mm"
                  value={gridValue(settings.limitBackOff, 'mm')}
                  validate={backOffRange}
                  onCommit={(q) => update({ limitBackOff: q.canonical })}
                />
              </div>
              <p id={backOffHint} className={styles['settingHint']}>
                {m.limitBackOffHint}
              </p>
            </div>
          ) : null}
          {/* v0.5 RV10: the surface map's follow limit (docs/modes/run-surface.md#refusals) */}
          <div className={styles['settingRow']}>
            <span className={styles['settingLabel']} aria-hidden="true">
              {m.surfaceMapMaxRange}
            </span>
            <div className={styles['settingSelect']}>
              <QuantityInput
                label={m.surfaceMapMaxRange}
                stepKind="small"
                kind="length"
                defaultUnit="mm"
                value={gridValue(settings.surfaceMapMaxRange, 'mm')}
                validate={surfaceRange}
                onCommit={(q) => update({ surfaceMapMaxRange: q.canonical })}
              />
            </div>
            <p className={styles['settingHint']}>{m.surfaceMapMaxRangeHint}</p>
          </div>
          {/* v0.5 RV11: a bed map older than this warns (docs/modes/run-surface.md#stale-and-old) */}
          <div className={styles['settingRow']}>
            <span className={styles['settingLabel']} aria-hidden="true">
              {m.bedMapMaxAge}
            </span>
            <div className={styles['settingSelect']}>
              <Select<string>
                aria-label={m.bedMapMaxAge}
                options={ages.map((d) => ({ value: String(d), label: m.bedMapAgeDays(d) }))}
                value={String(settings.bedMapMaxAge)}
                onValueChange={(v) => update({ bedMapMaxAge: Number(v) })}
              />
            </div>
            <p className={styles['settingHint']}>{m.bedMapMaxAgeHint}</p>
          </div>
        </InspectorGroup>
        <InspectorGroup title={m.groups.agents} className={styles['settingsGroup']}>
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
        </InspectorGroup>
      </div>
    </Dialog>
  )
}
