/**
 * `ProjectDoc` ↔ working-folder files, the archive manifest and the project load pipeline.
 * Doc: docs/architecture/persistence.md#working-folder-layout
 *
 * Pure and headless: the file system and hashing live in src/main/persistence. The layout is
 * generic over record kinds: a top-level `ProjectDoc` key listed in `collections` holds records
 * keyed by id and becomes `<key>/<id>.json`; every other top-level field goes to `project.json`.
 */
import { freeze, type Patch } from 'immer'
import { z } from 'zod'
import { migrate, type MigrationPlan } from '../../shared/migrate'
import { parseWith } from '../../shared/parse'
import {
  Err,
  fail,
  None,
  Ok,
  Some,
  tryCatch,
  type AppResult,
  type Option,
} from '../../shared/result'
import { parseProjectDoc, type ProjectDoc } from './document'

/** Pre-alpha: stays 1, no migrations (docs/conventions/error-handling/migrations.md). */
export const PROJECT_SCHEMA_VERSION = 1

/** The project's migration plan; the manifest's `schemaVersion` covers every document. */
export const projectMigrationPlan: MigrationPlan = {
  document: 'project',
  current: PROJECT_SCHEMA_VERSION,
  migrations: [],
}

export interface ProjectLayout {
  /** Top-level keys of `ProjectDoc` whose value is a record of DTOs keyed by id. */
  readonly collections: readonly string[]
}

/** v0.1 so far: `parts`, `plans` and `snapshots` are added by their tasks. */
export const PROJECT_LAYOUT: ProjectLayout = { collections: [] }

export const PROJECT_FILE = 'project.json'
export const MANIFEST_FILE = 'manifest.json'

/** Path → JSON text of one working-folder document. */
export type FileMap = ReadonlyMap<string, string>

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** JSON with sorted keys, two-space indent and a trailing newline (clean diffs). */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (typeof v === 'object' && v !== null)
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      )
    return v
  }
  return `${JSON.stringify(sort(value), null, 2)}\n`
}

/** `project.json` or `<collection>/<safe id>.json`; anything else is not part of a project. */
export function isLayoutPath(path: string, layout: ProjectLayout = PROJECT_LAYOUT): boolean {
  if (path === PROJECT_FILE) return true
  const m = /^([^/]+)\/([^/]+)\.json$/.exec(path)
  return m !== null && layout.collections.includes(m[1] ?? '') && SAFE_ID.test(m[2] ?? '')
}

function projectFields(doc: object, layout: ProjectLayout): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !layout.collections.includes(k)))
}

function recordsOf(doc: object, key: string): Record<string, unknown> {
  const v = (doc as Record<string, unknown>)[key]
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

/** One file per top-level record. */
export function docToFiles(
  doc: object,
  layout: ProjectLayout = PROJECT_LAYOUT,
): AppResult<FileMap> {
  const files = new Map<string, string>([[PROJECT_FILE, stableJson(projectFields(doc, layout))]])
  for (const key of layout.collections)
    for (const [id, record] of Object.entries(recordsOf(doc, key))) {
      if (!SAFE_ID.test(id))
        return fail('input.malformed', 'record id is not a safe file name', {
          where: 'layout.docToFiles',
          data: { collection: key },
          issues: [{ path: [key, id], rule: 'safeId', message: 'id must match [A-Za-z0-9_-]' }],
        })
      files.set(`${key}/${id}.json`, stableJson(record))
    }
  return Ok(files)
}

/**
 * Files whose content a commit may have changed, from its patches; `'all'` when a whole
 * collection or the document was replaced.
 */
export function touchedPaths(
  patches: readonly Patch[],
  layout: ProjectLayout = PROJECT_LAYOUT,
): Set<string> | 'all' {
  const paths = new Set<string>()
  for (const p of patches) {
    const [top, id] = p.path
    if (top === undefined) return 'all'
    const key = String(top)
    if (!layout.collections.includes(key)) paths.add(PROJECT_FILE)
    else if (id === undefined) return 'all'
    else paths.add(`${key}/${String(id)}.json`)
  }
  return paths
}

/** Current content of one layout file; `None` once its record no longer exists. */
export function fileContent(
  doc: object,
  path: string,
  layout: ProjectLayout = PROJECT_LAYOUT,
): Option<string> {
  if (path === PROJECT_FILE) return Some(stableJson(projectFields(doc, layout)))
  const m = /^([^/]+)\/([^/]+)\.json$/.exec(path)
  if (m === null) return None
  const records = recordsOf(doc, m[1] ?? '')
  const id = m[2] ?? ''
  return Object.hasOwn(records, id) ? Some(stableJson(records[id])) : None
}

// ---------------------------------------------------------------------------
// Manifest

const ManifestFileSchema = z.object({
  path: z.string().refine((p) => isLayoutPath(p), 'not a project document path'),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

export const ManifestSchema = z.object({
  format: z.literal('dfyom-project'),
  schemaVersion: z.number().int(),
  projectId: z.string().regex(SAFE_ID),
  appVersion: z.string(),
  savedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  files: z.array(ManifestFileSchema),
})

export type Manifest = z.output<typeof ManifestSchema>
export type ManifestFile = z.output<typeof ManifestFileSchema>

/** Version check first (a newer version is `persist.migration`), then the shape. */
export function parseManifest(raw: unknown): AppResult<Manifest> {
  if (typeof raw !== 'object' || raw === null)
    return fail('input.malformed', 'manifest is not an object', { where: 'layout.manifest' })
  const v = checkSchemaVersion(raw)
  if (v.isErr()) return Err(v.unwrapErr())
  const m = parseWith(ManifestSchema, raw, 'layout.manifest')
  if (m.isErr()) return m
  const paths = m.unwrap().files.map((f) => f.path)
  if (new Set(paths).size !== paths.length)
    return fail('input.malformed', 'manifest lists a file twice', { where: 'layout.manifest' })
  return Ok(freeze(m.unwrap(), true))
}

/** Runs the (empty) migration plan: refuses a newer or missing `schemaVersion`. */
export function checkSchemaVersion(raw: unknown): AppResult<void> {
  return migrate(raw, projectMigrationPlan).map(() => undefined)
}

// ---------------------------------------------------------------------------
// Load pipeline

/**
 * Files → `ProjectDoc`: JSON.parse → assemble → `parseWith` (→ `Model.create` once domain models
 * exist). The schema version was already checked on the manifest / state.json.
 */
export function loadProjectFiles(
  files: FileMap,
  layout: ProjectLayout = PROJECT_LAYOUT,
): AppResult<ProjectDoc> {
  const where = 'layout.load'
  let project: unknown
  const raw: Record<string, Record<string, unknown>> = {}
  for (const key of layout.collections) raw[key] = {}
  for (const [path, text] of files) {
    if (!isLayoutPath(path, layout))
      return fail('input.malformed', 'unknown file in project', { where, data: { path } })
    const parsed = tryCatch(() => JSON.parse(text) as unknown, 'input.malformed', 'invalid JSON')
    if (parsed.isErr()) return Err(parsed.unwrapErr().withContext(where, { path }))
    if (path === PROJECT_FILE) {
      project = parsed.unwrap()
      continue
    }
    const [key = '', file = ''] = path.split('/')
    const records = raw[key]
    if (records !== undefined) records[file.slice(0, -'.json'.length)] = parsed.unwrap()
  }
  if (typeof project !== 'object' || project === null || Array.isArray(project))
    return fail('input.malformed', 'project.json is missing or not an object', { where })
  return parseProjectDoc({ ...project, ...raw }, where)
}
