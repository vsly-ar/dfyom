// `worker_threads` entry of the compute workers (one per lane), for the app and headless/CLI.
// Built as its own main-process chunk (`?modulePath`, see bundled.ts).
// Doc: docs/architecture/workers.md#lanes-and-pool
import { WORKER_TASKS } from '../../core/workers/tasks'
import { serveWorker } from './port'

serveWorker(WORKER_TASKS)
