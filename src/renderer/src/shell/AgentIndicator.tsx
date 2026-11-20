// "Agent connected" indicator in the status bar: visible while at least one agent session is
// attached, naming the sessions (client name and source id, bound project) and linking to the
// "Allow local agents to connect" setting. Doc: docs/architecture/llm-api.md#local-http
import { Bot, Settings } from 'lucide-react'
import type { AgentSessionInfo } from '../../../shared/preload-api'
import { shellMessages } from '../messages/shell'
import { Button, Popover } from '../ui'
import styles from './AppShell.module.css'

const m = shellMessages.agents

export interface AgentIndicatorProps {
  sessions: readonly AgentSessionInfo[]
  onOpenSettings: () => void
}

export function AgentIndicator({
  sessions,
  onOpenSettings,
}: AgentIndicatorProps): React.JSX.Element | null {
  if (sessions.length === 0) return null
  return (
    <Popover
      label={m.popoverTitle}
      title={m.popoverTitle}
      side="top"
      content={
        <div className={styles['agents']}>
          <ul className={styles['agentList']}>
            {sessions.map((s) => (
              <li key={s.source} className={styles['agent']}>
                <span>{s.client ?? m.unknownClient}</span>
                <code className={styles['mono']}>{s.source}</code>
                <span className={styles['muted']}>
                  {s.key === undefined ? m.noProject : m.boundTo(s.key)}
                </span>
              </li>
            ))}
          </ul>
          <p className={styles['muted']}>{m.explain}</p>
          <Button size="sm" icon={<Settings aria-hidden="true" />} onClick={onOpenSettings}>
            {m.openSettings}
          </Button>
        </div>
      }
    >
      <button type="button" className={styles['statusButton']} data-tone="info">
        <Bot aria-hidden="true" className={styles['statusIcon']} />
        {m.connected(sessions.length)}
      </button>
    </Popover>
  )
}
