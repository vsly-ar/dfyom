// `worker_threads` entry of the machine host (headless/CLI, and the real-thread tests): the same
// host and protocol as the app's utility process (docs/modes/run-v0.1.md decision 2).
import { parentPort } from 'node:worker_threads'
import { serveMachineHost } from './serve'

const port = parentPort
if (port === null) throw new Error('machine host entry loaded outside a worker thread')
serveMachineHost(
  {
    post: (message) => port.postMessage(message),
    onMessage: (listener) => port.on('message', listener),
  },
  'worker',
  (code) => process.exit(code),
)
