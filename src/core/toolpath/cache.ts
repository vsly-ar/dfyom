/**
 * In-memory toolpath cache of one project (per dispatcher), keyed by the content hash
 * `inputHash` of `planOperationInputs`; LRU by estimated size. Not persisted.
 * Doc: docs/architecture/workers.md#toolpath-cache
 */
import type { Toolpath } from './model'

/** Estimated bytes per move (objects cloned from the worker). */
export const MOVE_BYTES = 64
export const TOOLPATH_CACHE_MAX_BYTES = 128 * 2 ** 20

export interface ToolpathCache {
  /** The toolpath generated for `inputHash` (marks it recently used). */
  get(inputHash: string): Toolpath | undefined
  /** Stores a generated toolpath and remembers it as the plan operation's last one. */
  set(planId: string, planOperationId: string, inputHash: string, toolpath: Toolpath): void
  /** Remembers a cache hit as the plan operation's last toolpath. */
  remember(planId: string, planOperationId: string, inputHash: string): void
  /** The plan operation's last generated toolpath and its hash, while still cached. */
  last(
    planId: string,
    planOperationId: string,
  ): { inputHash: string; toolpath: Toolpath } | undefined
  /** Estimated size of the cached toolpaths (bytes). */
  readonly bytes: number
  clear(): void
}

export function toolpathBytes(tp: Toolpath): number {
  let moves = 0
  for (const p of tp.passes) moves += p.moves.length
  return Math.max(1, moves) * MOVE_BYTES
}

export function createToolpathCache(maxBytes = TOOLPATH_CACHE_MAX_BYTES): ToolpathCache {
  /** Insertion order = LRU order (oldest first). */
  const entries = new Map<string, { toolpath: Toolpath; bytes: number }>()
  const lastHash = new Map<string, string>()
  let bytes = 0
  const key = (planId: string, planOperationId: string) => `${planId}\0${planOperationId}`
  const evict = () => {
    for (const [hash, e] of entries) {
      if (bytes <= maxBytes || entries.size <= 1) return
      entries.delete(hash)
      bytes -= e.bytes
    }
  }
  return {
    get(inputHash) {
      const e = entries.get(inputHash)
      if (e === undefined) return undefined
      entries.delete(inputHash)
      entries.set(inputHash, e)
      return e.toolpath
    },
    set(planId, planOperationId, inputHash, toolpath) {
      const old = entries.get(inputHash)
      if (old !== undefined) {
        entries.delete(inputHash)
        bytes -= old.bytes
      }
      const size = toolpathBytes(toolpath)
      entries.set(inputHash, { toolpath, bytes: size })
      bytes += size
      lastHash.set(key(planId, planOperationId), inputHash)
      evict()
    },
    remember(planId, planOperationId, inputHash) {
      lastHash.set(key(planId, planOperationId), inputHash)
    },
    last(planId, planOperationId) {
      const hash = lastHash.get(key(planId, planOperationId))
      const e = hash === undefined ? undefined : entries.get(hash)
      return hash === undefined || e === undefined
        ? undefined
        : { inputHash: hash, toolpath: e.toolpath }
    },
    get bytes() {
      return bytes
    },
    clear() {
      entries.clear()
      lastHash.clear()
      bytes = 0
    },
  }
}
