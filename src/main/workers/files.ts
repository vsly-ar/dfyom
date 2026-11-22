// `FileSource` of the Node worker host: `node:fs` read streams in 1 MB chunks.
// Doc: docs/architecture/workers.md#file-access
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FileSource } from '../../core/commands/jobs'
import { fail, Ok } from '../../shared/result'

const CHUNK_BYTES = 1024 * 1024

export const nodeFiles: FileSource = {
  async open(path) {
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || !info.isFile())
      return fail('input.malformed', `cannot read ${path}`, {
        where: 'files.open',
        issues: [
          {
            path: ['path'],
            rule: 'unreadableFile',
            message: info === undefined ? 'no such file' : 'not a regular file',
          },
        ],
      })
    async function* chunks(): AsyncIterable<Uint8Array> {
      for await (const chunk of createReadStream(path, { highWaterMark: CHUNK_BYTES }))
        yield chunk as Buffer
    }
    return Ok({ size: info.size, chunks: chunks() })
  },
}
