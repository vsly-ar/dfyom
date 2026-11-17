// Test-only setup for plan commands: the design test part, a tool library and a machine.
// Not app code. Doc: docs/modes/plan-v0.1.md (Implementation (task 2.13))
import { expect } from 'vitest'
import type { AppError } from '../../shared/errors/app-error'
import type { ErrorCode } from '../../shared/errors/codes'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import type { DocumentCommand } from '../commands/define'
import { applyDocPatches } from '../commands/history'
import { inProcessWorkers } from '../commands/jobs'
import { runCommand, uiSource } from '../commands/testing'
import { buildTestPart, designSetup, type DesignSetup } from '../design/design.fixture'
import {
  deg,
  feed,
  flatEndMillValues,
  len,
  machineValues,
  num,
  rpm,
} from '../library/library.fixture'
import { draftPlanAutoRebuild, PLAN_COMMANDS } from './commands'
import type { PlanDTO } from './plan.dto'

const ui = uiSource()

/** 6 mm 2F carbide flat with an aluminum preset; long enough for the 20 mm profile. */
export const flat6 = () => {
  const { kind: _, ...v } = flatEndMillValues()
  return {
    ...v,
    name: 'Flat 6',
    fluteLength: len('25'),
    overallLength: len('60'),
    toolMaterial: 'carbide' as const,
  }
}
/** 4 mm flat without presets (helical boring of 6 mm holes). */
export const flat4 = () => ({
  ...flat6(),
  name: 'Flat 4',
  diameter: len('4'),
  presets: [],
})
/** 6 mm bull nose, RE 2 (the pocket's floor fillet). */
export const bull6 = () => ({
  ...flat6(),
  name: 'Bull 6',
  type: 'bullNoseEndMill' as const,
  cornerRadius: len('2'),
})
/** 6 mm 118° drill, no tool material (no calculator data). */
export const drill6 = () => ({
  name: 'Drill 6',
  type: 'drill' as const,
  diameter: len('6'),
  fluteLength: len('30'),
  overallLength: len('66'),
  fluteCount: num('2'),
  pointAngle: deg('118'),
  presets: [],
})
export const drillPreset = () => ({
  name: 'Alu drill',
  materialClass: 'aluminum' as const,
  spindleSpeed: rpm('3000'),
  feedRate: feed('150'),
  plungeRate: feed('150'),
})

export interface PlanSetup extends DesignSetup {
  /** Library item ids. */
  readonly tools: { flat6: string; flat4: string; bull6: string; drill6: string }
  readonly machineId: string
  plan(planId: string): PlanDTO
  /** Dispatch a plan query that must succeed; returns its value. */
  query(name: string, args: object): unknown
  create(args?: object): Promise<string>
  /** Move a plan through allowed transitions to `status`. */
  toStatus(planId: string, status: PlanDTO['status']): Promise<void>
  failWith(name: string, args: object, code: ErrorCode): Promise<AppError>
}

export async function planSetup(opts: { part?: boolean } = {}): Promise<PlanSetup> {
  const s = await designSetup()
  if (opts.part !== false) await buildTestPart(s)
  const add = async (kind: string, values: object) =>
    ((await s.run(`library.${kind}.add`, { values })) as { id: string }).id
  const tools = {
    flat6: await add('tool', flat6()),
    flat4: await add('tool', flat4()),
    bull6: await add('tool', bull6()),
    drill6: await add('tool', drill6()),
  }
  const { kind: _, ...m } = machineValues()
  const machineId = await add('machine', m)
  const query = (name: string, args: object) => expectOk(s.d.query(name, args, ui)).value
  const PATH: Record<PlanDTO['status'], PlanDTO['status'][]> = {
    draft: [],
    settledDesign: ['settledDesign'],
    finalized: ['settledDesign', 'finalized'],
    inUse: ['settledDesign', 'finalized', 'inUse'],
    archived: ['archived'],
  }
  return {
    ...s,
    tools,
    machineId,
    plan: (id) => {
      const p = s.d.doc.plans[id]
      expect(p, id).toBeDefined()
      return p!
    },
    query,
    create: async (args = {}) =>
      ((await s.run('plan.create', { partId: s.partId, ...args })) as { planId: string }).planId,
    toStatus: async (planId, status) => {
      for (const st of PATH[status]) await s.run('plan.status.set', { planId, status: st })
    },
    failWith: async (name, args, code) => expectErrCode(await s.d.dispatch(name, args, ui), code),
  }
}

export const opsOf = (p: PlanDTO) => p.setups[0]!.operations
export const designIds = (p: PlanDTO) => opsOf(p).map((o) => o.designOperationIds.join('+'))
export const src = (q: unknown) => (q as { source: string }).source

export interface Stale {
  partRemoved: boolean
  partChanged: string[]
  rebuildBlocked: string | null
  operations: {
    operationId: string
    changedInDesign: boolean
    removedFromDesign: boolean
    editedInPlan: boolean
  }[]
  libraryCopies: {
    snapshotId: string
    kind: string
    status: string
    blocked: string | null
  }[]
}
export const stale = (s: PlanSetup, planId: string) =>
  s.query('plan.stale.list', { planId }) as Stale

/**
 * Patch laws of a document command run without a dispatcher, with the setup's library and the
 * app's document hooks: apply(next, inverse) ≡ before and apply(before, patches) ≡ next.
 */
export function expectPatchLaw(s: PlanSetup, def: DocumentCommand, args: object): void {
  const before = s.d.doc
  const r = runCommand(
    before,
    def,
    args,
    { services: { workers: inProcessWorkers, library: s.library } },
    [draftPlanAutoRebuild],
  )
  expect(r.result.isOk(), `${def.name} failed`).toBe(true)
  expect(expectOk(applyDocPatches(r.next, r.inversePatches)), `inverse of ${def.name}`).toEqual(
    before,
  )
  expect(expectOk(applyDocPatches(before, r.patches)), `patches of ${def.name}`).toEqual(r.next)
}

/** Runs a plan command; patch laws hold, undo restores the document before and redo the one after. */
export async function expectUndoRedo(s: PlanSetup, name: string, args: object): Promise<unknown> {
  const before = s.d.doc
  expectPatchLaw(s, PLAN_COMMANDS.find((c) => c.name === name) as DocumentCommand, args)
  const value = await s.run(name, args)
  const after = s.d.doc
  await s.undo()
  expect(s.d.doc, `undo of ${name}`).toEqual(before)
  await s.redo()
  expect(s.d.doc, `redo of ${name}`).toEqual(after)
  return value
}
