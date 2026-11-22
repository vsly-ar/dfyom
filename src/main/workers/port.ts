// Worker-thread side of the Node host: `parentPort` as an `Endpoint`, uncaught-error logging.
// Doc: docs/architecture/workers.md#hosting, #logging-from-workers
import { parentPort } from 'node:worker_threads'
import type { AnyWorkerTask } from '../../core/commands/jobs'
import type { Endpoint } from '../../core/workers/protocol'
import { runWorkerLoop } from '../../core/workers/worker-loop'
import { serializeErr } from '../../shared/logging'
import { nodeFiles } from './files'

function parentEndpoint(): Endpoint {
  const port = parentPort
  if (port === null) throw new Error('worker entry loaded outside a worker thread')
  return {
    post: (message, transfer) =>
      port.postMessage(message, transfer === undefined ? [] : [...transfer]),
    onMessage: (listener) => port.on('message', listener),
  }
}

/**
 * Serves the worker protocol on `parentPort` with `tasks`. Uncaught errors are logged at
 * `error` and the worker keeps running (docs/conventions/logging.md).
 */
export function serveWorker(tasks: readonly AnyWorkerTask[]): void {
  const loop = runWorkerLoop(parentEndpoint(), { tasks, files: nodeFiles })
  process.on('uncaughtException', (err) =>
    loop.log().error({ err: serializeErr(err), scope: 'workers' }, 'uncaught exception in worker'),
  )
  process.on('unhandledRejection', (reason) =>
    loop
      .log()
      .error({ err: serializeErr(reason), scope: 'workers' }, 'unhandled rejection in worker'),
  )
}
