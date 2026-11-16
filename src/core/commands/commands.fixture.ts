// Test-only commands and queries for the command-layer tests. Not app code: real commands are
// added with their features. Doc: docs/architecture/commands.md#testing
import { z } from 'zod'
import { fail, Ok } from '../../shared/result'
import { UnitSystemSchema } from '../project/document'
import { defineCommand, defineQuery } from './define'

export const renameProject = defineCommand({
  kind: 'document',
  name: 'project.name.update',
  summary: 'Rename the project.',
  title: () => 'Rename project',
  machine: false,
  args: z.object({ name: z.string().describe('New project name') }),
  result: z.object({ name: z.string() }),
  run(draft, args) {
    // Mutates first, then fails: the dispatcher must drop the draft (no partial patches).
    draft.name = args.name
    if (args.name.trim() === '')
      return fail('model.invariant', 'project name is empty', {
        issues: [{ path: ['name'], rule: 'nonEmpty', message: 'must not be empty' }],
      })
    return Ok({ name: args.name })
  },
})

export const setUnitSystem = defineCommand({
  kind: 'document',
  name: 'project.unitSystem.update',
  summary: 'Change the project display unit system.',
  title: (a) => `Use ${a.unitSystem}`,
  machine: false,
  args: z.object({ unitSystem: UnitSystemSchema }),
  result: z.null(),
  run(draft, args) {
    draft.unitSystem = args.unitSystem
    return Ok(null)
  },
})

/** Uses `ctx.ids`/`ctx.clock`: redo must not re-run it, so the generated name stays stable. */
export const generateName = defineCommand({
  kind: 'document',
  name: 'project.name.generate',
  summary: 'Give the project a generated name.',
  title: () => 'Generate name',
  machine: false,
  args: z.object({}),
  result: z.object({ name: z.string() }),
  run(draft, _args, ctx) {
    draft.name = `${ctx.ids.next('name')}@${ctx.clock.now()}`
    return Ok({ name: draft.name })
  },
})

export const crashCommand = defineCommand({
  kind: 'document',
  name: 'project.name.crash',
  summary: 'Throw (a bug) after touching the draft.',
  title: () => 'Crash',
  machine: false,
  args: z.object({}),
  result: z.null(),
  run(draft) {
    draft.name = 'half-done'
    throw new TypeError('boom')
  },
})

/** Effect that waits for a test-controlled promise, to observe queue holding. */
export function makeExportEffect(gate: () => Promise<void>) {
  return defineCommand({
    kind: 'effect',
    name: 'project.file.export',
    summary: 'Export the project name (test effect).',
    title: () => 'Export',
    machine: false,
    args: z.object({}),
    result: z.object({ name: z.string() }),
    async run(doc) {
      await gate()
      return Ok({ name: doc.name })
    },
  })
}

export const jogMachine = defineCommand({
  kind: 'effect',
  name: 'run.machine.jog',
  summary: 'Jog the machine (test machine command).',
  title: () => 'Jog',
  machine: true,
  args: z.object({ dxMm: z.number() }),
  result: z.object({ moved: z.number() }),
  run: async (_doc, args) => Ok({ moved: args.dxMm }),
})

export const getProject = defineQuery({
  name: 'project.doc.get',
  summary: 'Get the project name and unit system.',
  args: z.object({}),
  result: z.object({ name: z.string(), unitSystem: UnitSystemSchema }),
  run: (doc) => Ok({ name: doc.name, unitSystem: doc.unitSystem }),
})

export const FIXTURE_DOCUMENT_COMMANDS = [renameProject, setUnitSystem, generateName] as const
