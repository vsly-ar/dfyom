// Test-only worker entry: the production tasks plus fixtures that loop, throw, exit and hang.
// Bundled by the Vitest global setup (global-setup.ts). Doc: docs/architecture/workers.md#testing
import { WORKER_TASKS } from '../../core/workers/tasks'
import { serveWorker } from './port'
import { TEST_TASKS } from './test-tasks'

serveWorker([...WORKER_TASKS, ...TEST_TASKS])
