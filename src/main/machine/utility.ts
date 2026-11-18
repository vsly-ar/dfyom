// Electron utility-process entry of the machine host (the app): `process.parentPort` as an
// `Endpoint`. Built as its own main-process chunk (`?modulePath`, bundled.ts); forked by
// electron.ts. Doc: docs/modes/run-v0.1.md#processes
import { serveMachineHost } from './serve'

const port = process.parentPort
serveMachineHost(
  {
    post: (message) => port.postMessage(message),
    onMessage: (listener) => port.on('message', (e) => listener(e.data)),
  },
  'utility',
  (code) => process.exit(code),
)
