import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { getProject, jogMachine, renameProject, setUnitSystem } from './commands.fixture'
import type { AnyCommand } from './define'
import { toolDescriptor, toolDescriptors } from './json-schema'
import { createAppRegistry, createRegistry, NAME_PATTERN } from './registry'

describe('registry', () => {
  it('looks up commands and queries by name, including built-ins', () => {
    const reg = expectOk(createRegistry({ commands: [renameProject], queries: [getProject] }))
    expect(reg.command('project.name.update').unwrap()).toBe(renameProject)
    expect(reg.query('project.doc.get').unwrap()).toBe(getProject)
    expect(reg.command('history.undo').isSome()).toBe(true)
    expect(reg.command('job.abort').isSome()).toBe(true)
    expect(reg.command('nope.x.y').isNone()).toBe(true)
  })

  it('rejects duplicate names across commands and queries', () => {
    const e = expectErrCode(
      createRegistry({
        commands: [renameProject, setUnitSystem, renameProject],
        queries: [{ ...getProject, name: 'project.unitSystem.update' }],
      }),
      'internal.unexpected',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['project.name.update', 'unique'],
      ['project.unitSystem.update', 'unique'],
    ])
    expectOk(createRegistry({ commands: [setUnitSystem] }))
  })

  it('enforces the naming convention and a non-empty summary', () => {
    const bad = (name: string, summary = 'Do it.') => ({ ...renameProject, name, summary })
    const e = expectErrCode(
      createRegistry({
        commands: [
          bad('Project.name.update'),
          bad('project'),
          bad('foo.bar.baz'),
          bad('project.x.y', ' '),
        ],
      }),
      'internal.unexpected',
    )
    expect(e.issues.map((i) => i.rule)).toEqual(['naming', 'naming', 'naming', 'summary'])
  })

  it.each([
    ['design.pocket.add', true],
    ['plan.operation.move', true],
    ['history.undo', true],
    ['run.job.start', true],
    ['library.tool.list', true],
    ['design.pocket', true],
    ['design.Pocket.add', false],
    ['design.pocket.add.more', false],
    ['design.pocket_x.add', false],
  ])('name %s valid: %s', (name, ok) => {
    expect(NAME_PATTERN.test(name)).toBe(ok)
  })
})

describe('JSON Schema for agent tools', () => {
  it('builds a descriptor with input and output schemas from Zod', () => {
    const d = expectOk(toolDescriptor(renameProject))
    expect(d).toMatchObject({
      name: 'project.name.update',
      description: 'Rename the project.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'New project name' } },
        required: ['name'],
      },
      outputSchema: { type: 'object', required: ['name'] },
    })
  })

  it('reports schemas that are not JSON-representable', () => {
    const dated: AnyCommand = { ...jogMachine, args: z.object({ at: z.date() }) }
    const e = expectErrCode(toolDescriptor(dated), 'internal.unexpected')
    expect(e.frames[0]?.where).toBe('toolDescriptor')
    expect(e.frames[0]?.data).toEqual({ name: 'run.machine.jog' })
  })

  it('every app command and query converts (registry test)', () => {
    const reg = expectOk(createAppRegistry())
    const tools = expectOk(toolDescriptors(reg))
    expect(tools.map((t) => t.name)).toEqual([
      ...reg.commands.map((c) => c.name),
      ...reg.queries.map((q) => q.name),
    ])
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'history.undo',
        'history.redo',
        'job.pause',
        'job.resume',
        'job.abort',
      ]),
    )
  })

  it('every fixture command and query converts', () => {
    const reg = expectOk(
      createRegistry({
        commands: [renameProject, setUnitSystem, jogMachine],
        queries: [getProject],
      }),
    )
    expectOk(toolDescriptors(reg))
  })
})
