// The Run navigator's connect choice (serial port first and chosen by default, DF101; or the
// virtual machine) with the port and baud selects, and the settings-check warning of an open
// serial connection.
// Doc: docs/modes/run-machine.md#ports-and-the-port-picker, #settings-check
import type { SettingsCheck } from '../../../../core/run/settings-check'
import { BAUD_RATES, type SerialPortInfo } from '../../../../core/run/serial'
import { LibraryLink } from '../../library/LibraryLink'
import { runMessages } from '../../messages/run'
import { Icon, IconButton, SegmentedControl, Select } from '../../ui'
import type { ConnectTo } from './run-store'
import styles from './Run.module.css'

const m = runMessages.serial

export function portLabel(p: SerialPortInfo): string {
  return p.manufacturer === undefined ? p.path : `${p.path} · ${p.manufacturer}`
}

export function SerialPicker({
  connectTo,
  ports,
  portPath,
  baud,
  scanning,
  disabled,
  onConnectTo,
  onPort,
  onBaud,
  onScan,
}: {
  connectTo: ConnectTo
  ports: readonly SerialPortInfo[] | undefined
  portPath: string | undefined
  baud: number
  scanning: boolean
  disabled: boolean
  onConnectTo: (to: ConnectTo) => void
  onPort: (path: string) => void
  onBaud: (baud: number) => void
  onScan: () => void
}): React.JSX.Element {
  const none = ports !== undefined && ports.length === 0
  return (
    <>
      <SegmentedControl
        label={m.connectTo}
        size="sm"
        disabled={disabled}
        options={[
          { value: 'serial', label: m.serialPort },
          { value: 'virtual', label: m.virtual },
        ]}
        value={connectTo}
        onValueChange={onConnectTo}
      />
      {connectTo === 'serial' ? (
        <>
          <div className={styles['portRow']}>
            <Select
              aria-label={m.port}
              placeholder={none ? m.noPortsShort : m.portPlaceholder}
              disabled={disabled || ports === undefined || none}
              options={(ports ?? []).map((p) => ({ value: p.path, label: portLabel(p) }))}
              {...(portPath === undefined ? {} : { value: portPath })}
              onValueChange={onPort}
            />
            <IconButton
              label={m.refresh}
              icon={<Icon name="refresh" />}
              disabled={disabled || scanning}
              onClick={onScan}
            />
          </div>
          <div className={styles['row']}>
            <span className={styles['rowLabel']} aria-hidden="true">
              {m.baud}
            </span>
            <Select
              aria-label={m.baud}
              disabled={disabled}
              options={BAUD_RATES.map((b) => ({ value: String(b), label: String(b) }))}
              value={String(baud)}
              onValueChange={(v) => onBaud(Number(v))}
            />
          </div>
          {none ? <p className={styles['hint']}>{m.noPorts}</p> : null}
        </>
      ) : null}
    </>
  )
}

/** The hard warning under an open serial connection whose `$$` differs from the machine copy. */
export function SettingsWarning({
  check,
  machineId,
}: {
  check: SettingsCheck
  /** The library machine to review (manual control); with a plan the Library opens on machines. */
  machineId: string | undefined
}): React.JSX.Element | null {
  if (check.matches) return null
  return (
    <div className={styles['settingsWarning']} role="alert">
      <Icon name="warning" />
      <div>
        <p className={styles['why']}>
          {check.homingEnabled ? m.mismatch(check.against, check.differences) : m.homingOff}
        </p>
        <LibraryLink
          target={{ kind: 'machine', ...(machineId === undefined ? {} : { itemId: machineId }) }}
          label={m.review}
        />
      </div>
    </div>
  )
}
