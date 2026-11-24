// Stop from every window (docs/conventions/ui.md#run-mode-safety-ui, docs/modes/run.md#run-without-a-project-df80):
// a `job.abort` its own session refused is tried in every other open project. The machine scope
// (homing and probing jobs started without a project, DF80) needs no step here: a bound session
// already sends a job its project does not know there (`AgentSession`), an unbound one runs there.
// Spec: docs/architecture/llm-api.md#machine-scope-df80
import type { CommandOutcome } from '../../core/commands/dispatcher'
import type { Source } from '../../core/commands/context'
import type { AppResult } from '../../shared/result'
import type { AppHost } from './app-host'

/**
 * `job.abort` with `args` in each open project other than `ownKey` (the refusing session's bound
 * project), as `source`, until one knows the job: that project's result, or undefined.
 */
export async function abortElsewhere(
  host: Pick<AppHost, 'openSession' | 'list'>,
  source: Source,
  ownKey: string | undefined,
  args: unknown,
): Promise<AppResult<CommandOutcome> | undefined> {
  const session = host.openSession(source)
  try {
    for (const p of host.list()) {
      if (p.key === ownKey || session.bind(p.key).isErr()) continue
      const r = (await session.call('job.abort', args ?? {})).result
      if (r.isOk()) return r
    }
    return undefined
  } finally {
    session.end()
  }
}
