/**
 * Discovery files of instances serving local HTTP: `<appData>/instances/<instanceId>.json`
 * `{ instanceId, pid, port, token, startedAt, appVersion }`, owner-only (mode 0600; Windows: the
 * user profile's ACL), deleted on quit; stale files (dead PID) are ignored and removed.
 * Doc: docs/architecture/llm-api.md#coexistence-with-a-running-gui
 */
import { chmod, lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { fail, Ok, tryAsync, type AppResult, type AsyncAppResult } from '../../shared/result'
import { errnoCode } from '../persistence/fs'
import { isPidAlive as realIsPidAlive } from '../persistence/lock'

export const InstanceRecordSchema = z.object({
  instanceId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65_535),
  token: z.string().min(16),
  startedAt: z.string(),
  appVersion: z.string(),
})
export type InstanceRecord = z.output<typeof InstanceRecordSchema>

export function instancesDir(appData: string): string {
  return join(appData, 'instances')
}

function recordPath(appData: string, instanceId: string): string {
  return join(instancesDir(appData), `${instanceId}.json`)
}

/** The current user's id; `undefined` on Windows (the user profile's ACL protects the folder). */
const currentUid = (): number | undefined => process.getuid?.()

/**
 * The folder must be a real directory (not a symlink) owned by this user and closed to others:
 * otherwise another local user could read or plant tokens. Returns why not, or `undefined`.
 */
export async function checkInstancesDir(dir: string): Promise<string | undefined> {
  const st = await lstat(dir)
  if (!st.isDirectory()) return 'not a directory (or a symlink)'
  const uid = currentUid()
  if (uid === undefined) return undefined
  if (st.uid !== uid) return 'owned by another user'
  if ((st.mode & 0o077) !== 0) return 'accessible by other users'
  return undefined
}

/** Writes the record atomically with mode 0600 (folder 0700, checked). */
export async function writeDiscovery(appData: string, rec: InstanceRecord): AsyncAppResult<string> {
  const dir = instancesDir(appData)
  const path = recordPath(appData, rec.instanceId)
  const written = await tryAsync(
    async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const unsafe = await checkInstancesDir(dir)
      if (unsafe !== undefined) return unsafe
      const tmp = `${path}.tmp-${randomUUID()}`
      await writeFile(tmp, JSON.stringify(rec, null, 2), { mode: 0o600, flag: 'wx' })
      await chmod(tmp, 0o600) // the umask may have widened it
      await rename(tmp, path)
      return undefined
    },
    'persist.io',
    'writing the discovery file failed',
  )
  if (written.isErr()) return written
  const unsafe = written.unwrap()
  if (unsafe !== undefined)
    return fail('persist.io', `the instances folder is unsafe: ${unsafe}`, {
      where: 'writeDiscovery',
      data: { dir },
    })
  return Ok(path)
}

/** Deletes the record; a missing file is fine. */
export async function removeDiscovery(appData: string, instanceId: string): Promise<void> {
  try {
    await unlink(recordPath(appData, instanceId))
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT') throw e
  }
}

/** Live instances; records of dead processes are removed, unreadable ones skipped. */
export async function listInstances(
  appData: string,
  isPidAlive: (pid: number) => boolean = realIsPidAlive,
): Promise<InstanceRecord[]> {
  let names: string[]
  try {
    names = await readdir(instancesDir(appData))
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return []
    throw e
  }
  const out: InstanceRecord[] = []
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const path = join(instancesDir(appData), name)
    let parsed: z.ZodSafeParseResult<InstanceRecord>
    try {
      // Only regular files of this user (a planted file could redirect the token elsewhere).
      const st = await lstat(path)
      const uid = currentUid()
      if (!st.isFile() || (uid !== undefined && st.uid !== uid)) continue
      parsed = InstanceRecordSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    } catch {
      continue
    }
    if (!parsed.success) continue
    if (isPidAlive(parsed.data.pid)) out.push(parsed.data)
    else await unlink(path).catch(() => undefined)
  }
  return out
}

/** The live instance `id`; without an id the only live one, else `input.malformed` listing them. */
export async function findInstance(
  appData: string,
  id?: string,
  isPidAlive?: (pid: number) => boolean,
): AsyncAppResult<InstanceRecord> {
  const live = await tryAsync(
    () => listInstances(appData, isPidAlive),
    'persist.io',
    'reading the discovery files failed',
  )
  if (live.isErr()) return live
  return pick(live.unwrap(), id)
}

function pick(live: readonly InstanceRecord[], id: string | undefined): AppResult<InstanceRecord> {
  const where = 'findInstance'
  if (id !== undefined) {
    const found = live.find((r) => r.instanceId === id)
    return found === undefined
      ? fail('input.malformed', `no running instance ${id} serves local HTTP`, {
          where,
          data: { live: live.map((r) => r.instanceId) },
        })
      : Ok(found)
  }
  if (live.length === 1 && live[0] !== undefined) return Ok(live[0])
  return fail(
    'input.malformed',
    live.length === 0
      ? 'no running DFYOM instance serves local HTTP'
      : `several instances are running; pass one of: ${live.map((r) => r.instanceId).join(', ')}`,
    { where, data: { live: live.map((r) => r.instanceId) } },
  )
}
