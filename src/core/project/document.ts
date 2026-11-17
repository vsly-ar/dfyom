/**
 * `ProjectDoc` – the state document commands act on.
 * Doc: docs/architecture/commands.md#project-state
 *
 * One immutable tree of plain JSON DTOs (records keyed by id once domain content exists).
 * Handlers build models from it with `Model.create()` and write DTOs back, so Immer patches
 * and the action log stay JSON. Selection, camera, run/machine and job state do not belong here.
 */
import { freeze } from 'immer'
import { z } from 'zod'
import { parseWith } from '../../shared/parse'
import type { AppResult } from '../../shared/result'
import { PartDtoSchema } from '../design/part.dto'
import { SnapshotDtoSchema } from '../library/snapshot'

/** Display unit system of a project (docs/architecture/quantities.md, glossary "Unit system"). */
export const UnitSystemSchema = z.enum(['mm', 'inch']).describe('Project display unit system')
export type UnitSystem = z.output<typeof UnitSystemSchema>

/**
 * Shape of the document. `parts` and `snapshots` are record collections keyed by id
 * (docs/architecture/persistence.md#working-folder-layout; parts: docs/modes/design.md).
 * Plans are added by task 2.13.
 */
export const ProjectDocSchema = z.object({
  name: z.string().describe('Project name'),
  unitSystem: UnitSystemSchema,
  parts: z.record(z.string(), PartDtoSchema).default({}).describe('Parts by id (v0.1: one)'),
  snapshots: z
    .record(z.string(), SnapshotDtoSchema)
    .default({})
    .describe('Library snapshots used by the design, by id'),
})

export type ProjectDoc = Readonly<z.output<typeof ProjectDocSchema>>

/** A new, deeply frozen document. */
export function newProjectDoc(init: Pick<ProjectDoc, 'name' | 'unitSystem'>): ProjectDoc {
  return freeze({ name: init.name, unitSystem: init.unitSystem, parts: {}, snapshots: {} }, true)
}

/** Shape check of untrusted document data (files, IPC); result is deeply frozen. */
export function parseProjectDoc(raw: unknown, where: string): AppResult<ProjectDoc> {
  return parseWith(ProjectDocSchema, raw, where).map((d) => freeze(d, true))
}
