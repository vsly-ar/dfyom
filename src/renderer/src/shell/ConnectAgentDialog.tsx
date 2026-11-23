// Help → Connect an agent… (hardening A4): the `claude mcp add` lines and the launcher with this
// installation's real path (main builds them, src/main/connect-agent.ts), each with Copy.
// Doc: docs/conventions/ui.md#connect-an-agent-hardening-a4
import { useEffect, useId, useState } from 'react'
import type { ConnectInfo } from '../../../shared/preload-api'
import { shellMessages } from '../messages/shell'
import { Button, Dialog, DialogClose } from '../ui'
import styles from './ConnectAgentDialog.module.css'
import { useSettings, useShell, useUi } from './ShellContext'

const m = shellMessages.connectAgent

/** How long the Copy button says "Copied". */
const COPIED_MS = 1500

function CommandLine({
  title,
  hint,
  line,
  onCopied,
  children,
}: {
  title: string
  hint: string
  line: string
  onCopied: (announce: string) => void
  children?: React.ReactNode
}): React.JSX.Element {
  const hintId = useId()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state !== 'copied') return
    const id = setTimeout(() => setState('idle'), COPIED_MS)
    return () => clearTimeout(id)
  }, [state])
  const copy = () => {
    void (navigator.clipboard?.writeText(line) ?? Promise.reject(new Error('no clipboard')))
      .then(() => {
        setState('copied')
        onCopied(m.copiedAnnounce(title))
      })
      .catch(() => {
        setState('failed')
        onCopied(m.copyFailed)
      })
  }
  return (
    <section className={styles['section']} aria-label={title}>
      <h3 className={styles['title']}>{title}</h3>
      <p id={hintId} className={styles['hint']}>
        {hint}
      </p>
      <div className={styles['row']}>
        {/* wraps, so the whole path stays visible in the dialog's width */}
        <textarea
          className={styles['line']}
          readOnly
          rows={1}
          value={line}
          aria-label={title}
          aria-describedby={hintId}
          spellCheck={false}
        />
        <Button size="sm" onClick={copy} aria-label={m.copyLabel(title)}>
          {state === 'copied' ? m.copied : m.copy}
        </Button>
      </div>
      {state === 'failed' ? <p className={styles['hint']}>{m.copyFailed}</p> : null}
      {children}
    </section>
  )
}

export function ConnectAgentDialog(): React.JSX.Element {
  const { bridge } = useShell()
  const open = useUi((s) => s.connectAgentOpen)
  const setOpen = useUi((s) => s.setConnectAgentOpen)
  const openSettings = useUi((s) => s.setSettingsOpen)
  const allowLocalAgents = useSettings((s) => s.settings.allowLocalAgents)
  const [info, setInfo] = useState<ConnectInfo | null>(null)
  const [announce, setAnnounce] = useState('')

  // the server follows the setting asynchronously: read again shortly after it changes
  useEffect(() => {
    if (!open) return
    let live = true
    const read = () =>
      void bridge.agents.connectInfo().then((i) => {
        if (live) setInfo(i)
      })
    read()
    const id = setTimeout(read, 300)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [bridge, open, allowLocalAgents])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setAnnounce('')
        setOpen(next)
      }}
      title={m.title}
      description={m.description}
      footer={
        <DialogClose>
          <Button>{m.close}</Button>
        </DialogClose>
      }
    >
      <div className={styles['body']}>
        {info === null ? (
          <p className={styles['hint']}>{m.loading}</p>
        ) : (
          <>
            {info.development ? <p className={styles['note']}>{m.development}</p> : null}
            <CommandLine
              title={m.connectTitle}
              hint={m.connectHint}
              line={info.connect}
              onCopied={setAnnounce}
            >
              {info.localAgents ? null : (
                <p className={styles['note']}>
                  {m.localAgentsOff}{' '}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setAnnounce('')
                      setOpen(false)
                      openSettings(true)
                    }}
                  >
                    {m.openSettings}
                  </Button>
                </p>
              )}
            </CommandLine>
            <CommandLine
              title={m.headlessTitle}
              hint={m.headlessHint}
              line={info.headless}
              onCopied={setAnnounce}
            />
            <CommandLine
              title={m.cliTitle}
              hint={m.cliHint}
              line={info.cli}
              onCopied={setAnnounce}
            />
          </>
        )}
        <p className={styles['srOnly']} role="status" aria-live="polite">
          {announce}
        </p>
      </div>
    </Dialog>
  )
}
