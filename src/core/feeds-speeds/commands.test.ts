// Spec: docs/architecture/feeds-speeds.md#api (task 2.12)
import { describe, expect, it } from 'vitest'
import { None, Some } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createDispatcher } from '../commands/dispatcher'
import { inProcessWorkers } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { agentSource, fakeClock, fakeIds } from '../commands/testing'
import { newProjectDoc } from '../project/document'
import { Library } from '../library/library'
import { flatEndMillValues, libraryInput, machineValues } from '../library/library.fixture'
import { createMemoryLibraryStorage } from '../library/memory-storage'
import { suggestionToDTO } from './commands'

const agent = agentSource()

async function setup() {
  const library = expectOk(await Library.open(createMemoryLibraryStorage()))
  const d = createDispatcher({
    registry: expectOk(createAppRegistry()),
    doc: newProjectDoc({ name: 'Bracket', unitSystem: 'mm' }),
    ids: fakeIds(),
    clock: fakeClock(Date.UTC(2026, 10, 17, 10)),
    services: { workers: inProcessWorkers, library },
  })
  const add = async (kind: string, values: object) =>
    (expectOk(await d.dispatch(`library.${kind}.add`, { values }, agent)).value as { id: string })
      .id
  return { d, add }
}

describe('feedsSpeeds.suggest', () => {
  it('is registered and answers for a library tool and machine (carbide data; HSS → noData)', async () => {
    const { d, add } = await setup()
    const ask = async (toolMaterial: string) => {
      const toolId = await add('tool', { ...libraryInput(flatEndMillValues()), toolMaterial })
      const machineId = await add('machine', libraryInput(machineValues()))
      return expectOk(
        d.query(
          'feedsSpeeds.suggest',
          {
            toolLibraryItemId: toolId,
            materialClass: 'aluminum',
            engagement: { kind: 'slot' },
            machineLibraryItemId: machineId,
          },
          agent,
        ),
      ).value as { spindleSpeed: { value: number } | null; warnings: { code: string }[] }
    }
    const carbide = await ask('carbide')
    expect(carbide.spindleSpeed?.value).toBeGreaterThan(0)
    expect(carbide.warnings.map((w) => w.code)).toEqual(['feeds.powerSkipped'])
    const hss = await ask('hss')
    expect(hss.spindleSpeed).toBeNull()
    expect(hss.warnings.map((w) => w.code)).toEqual(['feeds.noData'])
  })

  it('unknown tool or machine id is input.malformed', async () => {
    const { d, add } = await setup()
    const args = { materialClass: 'aluminum', engagement: { kind: 'slot' } }
    expectErrCode(
      d.query('feedsSpeeds.suggest', { ...args, toolLibraryItemId: 'nope' }, agent),
      'input.malformed',
    )
    const toolId = await add('tool', libraryInput(flatEndMillValues()))
    expectErrCode(
      d.query(
        'feedsSpeeds.suggest',
        { ...args, toolLibraryItemId: toolId, machineLibraryItemId: toolId },
        agent,
      ),
      'input.malformed',
    )
  })

  it('rejects a malformed engagement', async () => {
    const { d, add } = await setup()
    const toolId = await add('tool', libraryInput(flatEndMillValues()))
    const args = { toolLibraryItemId: toolId, materialClass: 'aluminum' }
    expectErrCode(
      d.query('feedsSpeeds.suggest', { ...args, engagement: { kind: 'stepover' } }, agent),
      'input.malformed',
    )
    expectErrCode(
      d.query('feedsSpeeds.suggest', { ...args, locked: { stepdown: -1 } }, agent),
      'input.malformed',
    )
  })

  it('serializes Options as null and keeps derivations verbatim', () => {
    const step = {
      step: 'F1' as const,
      formula: 'n = …',
      inputs: { vc: 1 },
      result: 2,
      unit: 'rpm',
    }
    const dto = suggestionToDTO({
      spindleSpeed: Some({ value: 2, unit: 'rpm', derivation: [step] }),
      feedRate: None,
      plungeRate: None,
      stepdown: None,
      stepover: None,
      display: Some({
        dCalc: 6,
        vc: 1,
        fz: 0.02,
        chipThinning: 1,
        Q: None,
        Pc: Some(0.1),
        spindleLoad: None,
      }),
      warnings: [],
    })
    expect(dto.spindleSpeed).toEqual({ value: 2, unit: 'rpm', derivation: [step] })
    expect(dto.feedRate).toBeNull()
    expect(dto.display).toMatchObject({ Q: null, Pc: 0.1, spindleLoad: null })
  })
})
