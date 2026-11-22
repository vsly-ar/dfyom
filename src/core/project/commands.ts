/**
 * Project-level commands. Doc: docs/architecture/persistence.md#save
 */
import { z } from 'zod'
import { fail } from '../../shared/result'
import { defineCommand } from '../commands/define'
import { isProjectFileName } from './storage'

const SaveOutcomeSchema = z.object({
  filePath: z.string(),
  revision: z.number().int(),
  savedAt: z.string(),
  sha256: z.string(),
  warnings: z.array(z.string()),
})

/** Effect command: holds the project queue, so the save sees one stable revision. */
export const projectSave = defineCommand({
  kind: 'effect',
  name: 'project.save',
  summary: 'Save the project to its file, or to a new file (Save As).',
  title: (a) => (a.target === undefined ? 'Save' : 'Save as'),
  machine: false,
  // apply first: docs/architecture/apply.md#implicit-apply
  applyFirst: true,
  args: z.object({
    target: z
      .string()
      .min(1)
      .refine(isProjectFileName, 'must be a .dfyom file')
      .optional()
      .describe('Absolute path of a new project file (Save As); omit to save to the current file'),
    confirm: z
      .boolean()
      .default(false)
      .describe('Must be true to replace an existing file that is not this project'),
  }),
  result: SaveOutcomeSchema,
  async run(doc, args, ctx) {
    const session = ctx.services.project
    if (session === undefined)
      return fail('internal.unexpected', 'no project storage service', { where: 'project.save' })
    if (args.target === undefined && session.filePath === null)
      return fail('input.malformed', 'an untitled project needs a target file', {
        where: 'project.save',
        issues: [
          { path: ['target'], rule: 'required', message: 'choose a file for the new project' },
        ],
      })
    return session.save(
      doc,
      args.target === undefined
        ? { confirm: args.confirm }
        : { target: args.target, confirm: args.confirm },
    )
  },
})
