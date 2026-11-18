/**
 * Export of a plan's GRBL program: `exportPlan` (the path `plan.export` and run mode share)
 * regenerates missing or stale toolpaths, maps the plan to `ExportInput` and calls `exportGrbl`;
 * the `plan.export` effect command writes the text through the `ExportFiles` port.
 * Doc: docs/architecture/grbl.md#plan-export-command; cache: docs/architecture/workers.md#toolpath-cache
 */
import { z } from 'zod'
import { Err, fail, Ok, type AsyncAppResult } from '../../shared/result'
import { defineCommand } from '../commands/define'
import type { JobProgress, Services } from '../commands/context'
import { PlanWarningSchema } from '../plan/checks'
import { planOperationInputs } from '../plan/inputs'
import { PlanIdSchema } from '../plan/plan.dto'
import { loadPlan } from '../plan/plan'
import { checkAllowed } from '../plan/status'
import type { ProjectDoc } from '../project/document'
import { cacheOf, ensureToolpath } from '../toolpath/generate'
import type { Vec3 } from '../toolpath/model'
import { exportGrbl, type ExportOperation, type GrblExport } from './export'

/** The generator string of exported programs' header (no version: same input, same file). */
export const PROGRAM_GENERATOR = 'DFYOM'

/** gCode file extensions `plan.export` writes (case-insensitive). */
export const GCODE_EXTENSIONS = ['.nc', '.gcode', '.ngc'] as const

/** The file name (last segment, `/` or `\\` separated) has a stem and a gCode extension. */
export function isGcodeFileName(path: string): boolean {
  const name = (path.split(/[\\/]/).at(-1) ?? '').toLowerCase()
  return GCODE_EXTENSIONS.some((ext) => name.endsWith(ext) && name.length > ext.length)
}

/**
 * Writes an exported text file; src/main implements it with an atomic write
 * (src/main/persistence/export-file.ts). Injected as `services.exportFiles`.
 */
export interface ExportFiles {
  /**
   * `target`: an absolute path. An existing file is replaced only with `confirm`
   * (`input.malformed`, rule `confirmOverwrite`); a directory is never replaced.
   */
  write(
    target: string,
    text: string,
    opts: { readonly confirm: boolean },
  ): AsyncAppResult<{ readonly filePath: string }>
}

export interface PlanExportOptions {
  /** MPos of the work zero (the connected controller's G54): enables the soft-limit check. */
  readonly workZero?: Vec3
  /** Header `Generator:` text; default `PROGRAM_GENERATOR`. */
  readonly generator?: string
  /** Aborts a running regeneration (`op.aborted`). */
  readonly signal?: AbortSignal
  /** Per plan operation while toolpaths are checked or regenerated. */
  readonly progress?: (p: JobProgress) => void
}

export interface PlanExport extends GrblExport {
  /** Plan operations whose toolpath was missing or stale and was generated, in machining order. */
  readonly regenerated: readonly string[]
  /** Whether the soft-limit check ran (only with `workZero`). */
  readonly softLimitChecked: boolean
}

const neverAborted = new AbortController().signal

/**
 * The GRBL program of a plan (its one setup). Fails like `plan.toolpath.generate` on plan
 * findings, with `plan.status` for an archived plan, `post.noMachine` without a machine copy
 * (before any generator runs) and with the first generator error (context names the plan
 * operation); toolpaths generated before it stay cached.
 */
export async function exportPlan(
  doc: ProjectDoc,
  planId: string,
  services: Pick<Services, 'workers' | 'toolpaths'>,
  opts: PlanExportOptions = {},
): AsyncAppResult<PlanExport> {
  const where = 'plan.export'
  const cache = cacheOf(services, where)
  if (cache.isErr()) return cache
  const loaded = loadPlan(doc, planId, where)
  if (loaded.isErr()) return loaded
  const plan = loaded.unwrap()
  const allowed = checkAllowed(planId, plan.dto.status, where)
  if (allowed.isErr()) return allowed
  if (plan.machine.isNone())
    return fail('post.noMachine', 'gCode export needs a machine', { where, data: { planId } })
  const inputs = planOperationInputs(doc, planId)
  if (inputs.isErr()) return inputs
  const all = inputs.unwrap()
  if (all.length === 0)
    return fail('plan.check', `plan ${planId} has no operations to export`, {
      where,
      data: { planId },
      issues: [{ path: ['planId'], rule: 'empty', message: 'the plan has no operations' }],
    })
  const total = all.length
  const operations: ExportOperation[] = []
  const regenerated: string[] = []
  for (const [i, input] of all.entries()) {
    const id = input.planOperationId
    opts.progress?.({ done: i, total, label: id })
    const tp = await ensureToolpath(cache.unwrap(), services.workers, input, {
      signal: opts.signal ?? neverAborted,
      progress: (p) =>
        opts.progress?.({
          done: i,
          total,
          label: p.label === undefined ? id : `${id}: ${p.label}`,
        }),
    })
    if (tp.isErr()) return Err(tp.unwrapErr().withContext(where, { planId, planOperationId: id }))
    if (tp.unwrap().status === 'generated') regenerated.push(id)
    operations.push({
      toolpath: tp.unwrap().toolpath,
      tool: { name: input.tool.name, diameter: input.tool.diameter.canonical },
      label: input.operations.map((o) => o.name).join(', '),
    })
  }
  opts.progress?.({ done: total, total })
  const exported = exportGrbl(
    {
      name: plan.dto.name,
      setup: { name: plan.setup.name, clearanceHeight: all[0]!.setup.clearanceHeight },
      operations,
      machine: plan.machine,
      ...(opts.workZero === undefined ? {} : { workZero: opts.workZero }),
    },
    { generator: opts.generator ?? PROGRAM_GENERATOR },
  )
  return exported
    .map((e) => ({ ...e, regenerated, softLimitChecked: opts.workZero !== undefined }))
    .mapErr((e) => e.withContext(where, { planId }))
}

const ProgramStatsSchema = z.object({
  cutLength: z.number().describe('mm'),
  rapidLength: z.number().describe('mm'),
  estimatedSeconds: z.number().describe('Without acceleration, incl. dwells'),
  dwellSeconds: z.number(),
  toolChanges: z.number().int().describe('Tool changes that pause the program (M0)'),
})

export const planExport = defineCommand({
  kind: 'effect',
  name: 'plan.export',
  summary:
    "Export a plan's GRBL gCode file: regenerates missing or stale toolpaths, writes the program and returns its stats and machine-check warnings.",
  title: () => 'Export gCode',
  machine: false,
  args: z.object({
    planId: PlanIdSchema,
    target: z
      .string()
      .min(1)
      .refine(isGcodeFileName, `must be a ${GCODE_EXTENSIONS.join(', ')} file`)
      .describe('Absolute path of the gCode file to write'),
    confirm: z.boolean().default(false).describe('Must be true to replace an existing file'),
  }),
  result: z.object({
    filePath: z.string(),
    lines: z.number().int().describe('gCode lines (what a sender streams)'),
    stats: ProgramStatsSchema,
    warnings: z
      .array(PlanWarningSchema)
      .describe('plan.machine findings; they never block the export'),
    softLimitChecked: z
      .boolean()
      .describe('Whether the soft-limit check ran (needs the work zero of a connected machine)'),
    regenerated: z
      .array(z.string())
      .describe('Plan operations whose toolpath was missing or stale and was generated'),
  }),
  async run(doc, args, ctx) {
    const files = ctx.services.exportFiles
    if (files === undefined)
      return fail('internal.unexpected', 'no export file service', { where: 'plan.export' })
    // run mode (task 3.9) passes the connected G54 here: docs/modes/run-v0.1.md#work-zero-and-the-soft-limit-check
    const exported = await exportPlan(doc, args.planId, ctx.services)
    if (exported.isErr()) return exported
    const e = exported.unwrap()
    const written = await files.write(args.target, e.text, { confirm: args.confirm })
    if (written.isErr())
      return Err(written.unwrapErr().withContext('plan.export', { planId: args.planId }))
    return Ok({
      filePath: written.unwrap().filePath,
      lines: e.lines.length,
      stats: e.stats,
      warnings: [...e.warnings],
      softLimitChecked: e.softLimitChecked,
      regenerated: [...e.regenerated],
    })
  },
})
