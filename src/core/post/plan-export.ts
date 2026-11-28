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
import { PlanIdSchema, PlanRecordIdSchema, type SetupDTO } from '../plan/plan.dto'
import { loadPlan, type LoadedPlan } from '../plan/plan'
import { setupAlignment, setupAlignmentErrors } from '../plan/alignment'
import type { Region2dPort } from '../geometry/2d/port'
import type { SetupHeader } from './program'
import { aidName, planOpLabel, positionComment } from '../plan/labels'
import { setupHeader } from '../plan/setup-header'
import { runStickoutNeeded, toolRuns } from '../plan/tool-runs'
import { chooseSetup, setupStockSize } from '../plan/setups'
import { checkAllowed } from '../plan/status'
import { setupZReferences, zRefText } from '../plan/z-reference'
import type { ProjectDoc } from '../project/document'
import type { PartDTO } from '../design/part.dto'
import { cacheOf, ensureToolpath, inputOverreach } from '../toolpath/generate'
import type { Vec3 } from '../toolpath/model'
import { maxOverreach, type Overreach } from '../toolpath/overreach'
import {
  exportGrbl,
  type ExportInput,
  type ExportOperation,
  type GrblExport,
  type TravelFit,
} from './export'
import { gcodeFileStem } from './file-name'
import { commentLine, MAX_LINE_BYTES, sanitizeComment } from './grbl/format'
import { machineKeyOf } from '../run/machine-key'
import { cachedSetupLinks, linkSettings } from '../plan/setup-links'
import type { LinkSettings } from '../toolpath/links'
import type { Toolpath } from '../toolpath/model'
import { resolveHolder } from '../library/holder'
import {
  checkOperations,
  holderSizes,
  moveFindings,
  setupStickouts,
  staticWorkholdingFindings,
} from '../plan/workholding/findings'
import type { HolderSizes } from '../plan/workholding/envelope'
import { deviceLabel } from '../plan/workholding/devices'
import { itemSummary, lengthText } from '../plan/workholding/items'
import { setupWorkholding } from '../plan/workholding/setup'

/** The generator string of exported programs' header, without the app version. */
export const PROGRAM_GENERATOR = 'DFYOM'

/** `DFYOM <version>` (the app's version, injected as `services.appVersion`), else `DFYOM`. */
export function programGenerator(appVersion: string | undefined): string {
  return appVersion === undefined || appVersion === ''
    ? PROGRAM_GENERATOR
    : `${PROGRAM_GENERATOR} ${appVersion}`
}

/**
 * gCode with its `Generator:` header line reduced to `DFYOM` (no version), so golden files stay
 * stable across version bumps (tests only compare programs this way).
 */
export function withoutAppVersion(gcode: string): string {
  return gcode.replace(/^\(Generator: DFYOM [^)]*\)$/m, `(Generator: ${PROGRAM_GENERATOR})`)
}

/** gCode file extensions `plan.export` writes (case-insensitive). */
export const GCODE_EXTENSIONS = ['.nc', '.gcode', '.ngc'] as const

/** The file name (last segment, `/` or `\\` separated) has a stem and a gCode extension. */
export function isGcodeFileName(path: string): boolean {
  const name = (path.split(/[\\/]/).at(-1) ?? '').toLowerCase()
  return GCODE_EXTENSIONS.some((ext) => name.endsWith(ext) && name.length > ext.length)
}

/** A `plan.export` target naming a folder: it ends in `/` or `\\` (DF62). */
export function isFolderTarget(path: string): boolean {
  return /[\\/]$/.test(path)
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
  /** The setup whose program to export; required when the plan has several (task E2). */
  readonly setupId?: string
  /** MPos of the work zero (the connected controller's G54): enables the soft-limit check. */
  readonly workZero?: Vec3
  /** Header `Generator:` text; default `PROGRAM_GENERATOR`. */
  readonly generator?: string
  /** Aborts a running regeneration (`op.aborted`). */
  readonly signal?: AbortSignal
  /** Per plan operation while toolpaths are checked or regenerated. */
  readonly progress?: (p: JobProgress) => void
  /**
   * Section resume (hardening M5): the plan operation of the setup to start at, with the safe
   * re-entry (docs/modes/run-machine.md#section-resume-m5); another id is `input.malformed`, rule
   * `unknownOperation`.
   */
  readonly resumeFrom?: string
  /** v0.5 RV10: follow a surface map (`ExportInput.heightMap`, docs/modes/run-surface.md). */
  readonly heightMap?: ExportInput['heightMap']
}

export interface PlanExport extends GrblExport {
  /** The exported setup (one program per setup). */
  readonly setupId: string
  /** Plan operations whose toolpath was missing or stale and was generated, in machining order. */
  readonly regenerated: readonly string[]
  /** Whether the soft-limit check ran (only with `workZero`). */
  readonly softLimitChecked: boolean
  /** Links lowered below the clearance height (DF64). */
  readonly lowLinks: number
  /** The first line (1-based) of each plan operation in the program, in machining order. */
  readonly operationLines: readonly {
    readonly planOperationId: string
    readonly fromLine: number
  }[]
}

const neverAborted = new AbortController().signal

/**
 * The GRBL program of one setup of a plan (`opts.setupId`, or the only setup; `plan.setup`, rule
 * `setupRequired`, when the plan has several and none is named). Fails like
 * `plan.toolpath.generate` on the setup's plan findings, with `plan.status` for an archived plan, `post.noMachine` without a machine copy
 * (before any generator runs) and with the first generator error (context names the plan
 * operation); toolpaths generated before it stay cached.
 */
export async function exportPlan(
  doc: ProjectDoc,
  planId: string,
  services: Pick<Services, 'workers' | 'toolpaths' | 'region2d' | 'appVersion'>,
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
  // one program per setup (task E2, docs/modes/plan-v0.2.md#implementation-task-e2)
  const chosen = chooseSetup(plan.setups, opts.setupId, where)
  if (chosen.isErr()) return Err(chosen.unwrapErr().withContext(where, { planId }))
  const setup = chosen.unwrap().setup
  const setupIndex = plan.setups.findIndex((s) => s.id === setup.id)
  // only this setup's findings block its program (as plan.toolpath.generate per operation)
  const inputs = planOperationInputs(
    doc,
    planId,
    setup.operations.map((o) => o.id),
    services.region2d,
  )
  if (inputs.isErr()) return inputs
  const all = inputs.unwrap()
  const resumeFrom =
    opts.resumeFrom === undefined
      ? undefined
      : all.findIndex((x) => x.planOperationId === opts.resumeFrom)
  if (resumeFrom === -1 || (resumeFrom !== undefined && all[resumeFrom]!.cut === true))
    return fail('input.malformed', `operation ${opts.resumeFrom} is not in this setup`, {
      where,
      data: { planId, setupId: setup.id },
      issues: [
        { path: ['from'], rule: 'unknownOperation', message: 'not an operation of the setup' },
      ],
    })
  if (all.length === 0)
    return fail('plan.check', 'the plan has no operations to export', {
      where,
      data: { planId },
      issues: [{ path: ['planId'], rule: 'empty', message: 'the plan has no operations' }],
    })
  // DF135: already-cut operations are generated (their removal counts for the links) but never
  // exported; a setup with only cut ones has no program (docs/modes/cut-state.md)
  const kept = all.flatMap((x, i) => (x.cut === true ? [] : [i]))
  if (kept.length === 0)
    return fail('plan.check', `${setup.name} is cut: every operation is already cut`, {
      where,
      data: { planId, setupId: setup.id },
      issues: [
        {
          path: [setup.id],
          rule: 'allCut',
          message: 'every operation of the setup is already cut',
          params: { setupId: setup.id },
        },
      ],
    })
  // DF69: the setup's Z references; their errors block its program like a plan finding
  const zRefs = setupZReferences(plan, setup.id, services.region2d)
  const zErrors = [...zRefs.values()].flatMap((r) =>
    r.findings.filter((f) => f.severity === 'error'),
  )
  const firstZ = zErrors[0]
  if (firstZ !== undefined)
    return fail('plan.check', firstZ.message, {
      where,
      data: { planId },
      issues: zErrors.map((f) => ({
        path: [f.planOperationId ?? planId, 'zRef'],
        rule: f.rule,
        message: f.message,
        params: f.params,
      })),
    })
  // alignment phase 1: the setup's alignment errors block its program like a plan finding
  const alignErrors = setupAlignmentErrors(plan, setup.id, services.region2d)
  const firstAlign = alignErrors[0]
  if (firstAlign !== undefined)
    return fail('plan.check', firstAlign.message, {
      where,
      data: { planId },
      issues: alignErrors.map((f) => ({
        path: [setup.id, 'alignment'],
        rule: f.rule,
        message: f.message,
        params: f.params,
      })),
    })
  const total = all.length
  const generated: { toolpath: Toolpath; ids: string[]; label: string }[] = []
  const reaches: Overreach[] = []
  const regenerated: string[] = []
  const part = plan.dto.design.part
  for (const [i, input] of all.entries()) {
    const id = input.planOperationId
    const ids = input.operations.map((o) => o.id)
    // progress names the operation, never its id (DF43: "Export: Pocket 1: pass 2/4")
    const label = planOpLabel(part, { designOperationIds: ids, ...aidName(plan.dto, id) })
    opts.progress?.({ done: i, total, label })
    const tp = await ensureToolpath(
      cache.unwrap(),
      services.workers,
      input,
      {
        signal: opts.signal ?? neverAborted,
        progress: (p) =>
          opts.progress?.({
            done: i,
            total,
            label: p.label === undefined ? label : `${label}: ${p.label}`,
          }),
      },
      services.region2d,
    )
    if (tp.isErr()) return Err(tp.unwrapErr().withContext(where, { planId, planOperationId: id }))
    if (tp.unwrap().status === 'generated') regenerated.push(id)
    const toolpath = tp.unwrap().toolpath
    reaches.push(inputOverreach(input, toolpath))
    generated.push({ toolpath, ids, label })
  }
  // DF64: links between operations over the in-process stock (docs/modes/safe-links.md)
  const settings = linkSettings(setup, plan.stock, plan.machine)
  // a section resume (M5) links only from its operation on: the resumed operation starts as
  // generated, from the clearance height (safe-links.md#not-covered), and the field ignores the
  // operations left out (higher, so never less safe)
  const from = resumeFrom ?? 0
  const links =
    settings.retraction === 'full'
      ? undefined
      : cachedSetupLinks(
          all.slice(from),
          generated.slice(from).map((g) => g.toolpath),
          settings,
        )
  const hit = links?.collisions[0]
  if (hit !== undefined)
    return fail('plan.links.collision', 'a link between operations would hit the material', {
      where,
      data: { planId, setupId: setup.id },
      issues: links!.collisions.map((c) => ({
        path: [all[from + c.index]!.planOperationId, 'link'],
        rule: 'collision',
        message: `the link into this operation runs at Z ${c.to[2]}, below the safe Z ${c.needed}`,
        params: { z: c.to[2], needed: c.needed },
      })),
    })
  const linkedPath = (i: number) =>
    (i < from ? undefined : links?.toolpaths[i - from]) ?? generated[i]!.toolpath
  // from here on the exported operations only (DF135: cut ones left out)
  const inProgram = kept.map((i) => all[i]!)
  const finalPath = (k: number) => linkedPath(kept[k]!)
  const exportedFrom = resumeFrom === undefined ? undefined : kept.indexOf(resumeFrom)
  // the items are in the setup frame, the moves in the WCS: a moved work zero is added back
  // (docs/modes/alignment.md S12, as workholdingFindings does)
  const zero = all[0]!.setup.zero ?? [0, 0]
  const checked = checkOperations(
    inProgram.map((input, i) => ({ input, toolpath: finalPath(i) })),
    zero,
  )
  // DF130: each tool run's minimum stickout (docs/modes/plan-v0.1.md#minimum-stickout-hardening-df130);
  // DF132 H3: with the clamp term over the final moves (tool-holder.md#minimum-stickout-gains-the-clamp-term)
  const needs = setupStickouts(plan, setup, checked, zero)
  // H6: each operation's holder (its tool's own, else the machine's)
  const holderOf = inProgram.map((input) =>
    resolveHolder(input.tool, plan.machine).map(holderSizes),
  )
  const ownHolder = inProgram.map((input) => input.tool.holder.isSome())
  const runNeeded = toolRuns(
    inProgram.map((x, i) => ({
      tool: x.toolSnapshotId,
      needed: needs?.get(x.planOperationId)?.needed ?? x.stickoutNeeded,
      reason: needs?.get(x.planOperationId)?.reason,
      holder: holderOf[i]!,
    })),
  )
  const runOf = runNeeded.flatMap((r) => {
    const needed = runStickoutNeeded(r.operations.map((o) => o.needed))
    // the operation that decides the run's number (the first on a tie)
    const decides = r.operations.find((o) => o.needed === needed)?.reason
    const reason =
      decides?.kind !== 'workholding'
        ? undefined
        : {
            part: decides.part ?? ('nut' as const),
            item: decides.itemName ?? 'an item',
            // H6: the holder of the operation that decides (its tool's own or the machine's)
            ...(r.operations
              .find((o) => o.needed === needed)
              ?.holder.mapOr<{ holder?: string }>({}, (h) =>
                h.name === undefined ? {} : { holder: h.name },
              ) ?? {}),
          }
    return r.operations.map(() => ({ needed, reason }))
  })
  const programUnits = plan.machine.unwrap().programUnits
  const operations: ExportOperation[] = inProgram.map((input, i) => {
    const { needed: stickoutNeeded, reason: stickoutReason } = runOf[i]!
    const { ids, label } = generated[kept[i]!]!
    const toolpath = finalPath(i)
    const positions: Record<string, string> = {}
    for (const id of ids) {
      const text = positionComment(part, id)
      if (text !== undefined) positions[id] = text
    }
    // a plan operation of one design operation: its passes name it (joined ones already do)
    const only = ids.length === 1 ? ids[0]! : undefined
    return {
      toolpath:
        only === undefined
          ? toolpath
          : {
              ...toolpath,
              passes: toolpath.passes.map((p) => ({ ...p, operationId: p.operationId ?? only })),
            },
      tool: {
        name: input.tool.name,
        diameter: input.tool.diameter.canonical,
        type: input.tool.type,
        ...(input.tool.type === 'taperedBallEndMill' && {
          tipDiameter: input.tool.tipDiameterMm,
          ...(input.tool.taperAngle.isSome() && {
            taperAngle: input.tool.taperAngle.unwrap().canonical,
          }),
        }),
        ...(stickoutNeeded === undefined ? {} : { stickoutNeeded }),
        ...(stickoutReason === undefined ? {} : { stickoutReason }),
        // H6: the tool's own holder for the header (the machine's is the workholding line)
        ...(ownHolder[i] && holderOf[i]!.isSome()
          ? { holder: holderLine(holderOf[i]!.unwrap(), programUnits) }
          : {}),
      },
      stickout: input.stickout,
      label,
      ...programZRef(zRefs.get(input.planOperationId)?.zRef),
      ...(Object.keys(positions).length === 0 ? {} : { positions }),
    }
  })
  opts.progress?.({ done: total, total })
  // the export guard (WH-E): the final moves, links included, against the setup's workholding
  const guard = [
    ...staticWorkholdingFindings(plan, setup.id),
    ...moveFindings(plan, setup, checked, zero),
  ].filter((f) => f.severity === 'error')
  const firstHit = guard[0]
  if (firstHit !== undefined)
    return fail('plan.check', firstHit.message, {
      where,
      data: { planId, setupId: setup.id },
      issues: guard.map((f) => ({
        path: [f.planOperationId ?? setup.id, ...(f.field === undefined ? [] : [f.field])],
        rule: f.code,
        message: f.message,
        params: f.params,
      })),
    })
  const holding = setupWorkholding(setup, plan.stock)
  const exported = exportGrbl(
    {
      name: plan.dto.name,
      ...pieceLine(doc, plan.dto.design.part),
      setup: {
        name: setup.name,
        id: setup.id,
        clearanceHeight: all[0]!.setup.clearanceHeight,
        stockThickness: setupStockSize(plan.stock, setup).z[1],
        header: {
          ...setupHeader(
            plan.setups,
            setupIndex,
            {
              length: plan.stock.length.canonical,
              width: plan.stock.width.canonical,
              thickness: plan.stock.thickness.canonical,
            },
            maxOverreach(kept.map((i) => reaches[i]!)),
            headerAlignment(plan, setup, services.region2d),
            holding.items.length === 0
              ? undefined
              : {
                  // in the WCS like every other coordinate of the program: what the DRO
                  // shows (DF81, docs/modes/alignment.md S12)
                  // a device from the user's library is named so the operator picks the right
                  // clamp (workholding-library.md § Snapshots and persistence); a line too long
                  // for GRBL names it on the next one instead of being cut
                  items: holding.items.flatMap((i) => {
                    const device = deviceLabel(
                      plan.dto.snapshots,
                      setup.workholding?.find((w) => w.id === i.id) ?? {},
                    )
                    const line = `${i.name}: ${itemSummary(i, programUnits, zero)}`
                    if (device === undefined) return [line]
                    const one = `${line} · ${device}`
                    return sanitizeComment(`Workholding: ${one}`).length <= MAX_LINE_BYTES - 2
                      ? [one]
                      : [line, `${i.name} device: ${device}`]
                  }),
                  margin: holding.margin,
                  // DF132 H3: the holder the program was checked with (tool-holder.md#run-mode)
                  // (H6: only while an operation runs in it; a tool's own holder is its line)
                  ...plan.machine
                    .andThen((m) => m.holder)
                    .filter(() => ownHolder.some((own) => !own))
                    .mapOr<{ holder?: string }>({}, (h) => ({
                      holder: holderLine(holderSizes(h), programUnits),
                    })),
                },
          ),
          ...clampLine(settings),
        },
      },
      operations,
      machine: plan.machine,
      ...(opts.workZero === undefined ? {} : { workZero: opts.workZero }),
      ...(exportedFrom === undefined ? {} : { resumeFrom: exportedFrom }),
      ...(opts.heightMap === undefined ? {} : { heightMap: opts.heightMap }),
    },
    {
      generator: opts.generator ?? programGenerator(services.appVersion),
      // a resume always waits at its tool (run-machine.md#section-resume-m5)
      ...(exportedFrom === undefined ? {} : { firstToolLoaded: false }),
    },
  )
  return exported
    .map((e) => ({
      ...e,
      setupId: setup.id,
      regenerated,
      softLimitChecked: opts.workZero !== undefined,
      lowLinks: links?.summary.low ?? 0,
      operationLines: operationLines(
        e.lines,
        operations.slice(exportedFrom ?? 0).map((o) => o.label),
        inProgram.slice(exportedFrom ?? 0).map((x) => x.planOperationId),
      ),
    }))
    .mapErr((e) => e.withContext(where, { planId }))
}

/**
 * The header's holder line (DF132 H3, tool-holder.md#run-mode) after the workholding lines:
 * "ER11 nut dia 19 x 12 mm, body dia 52 mm" (program units; "dia" as the tool lines, ASCII).
 */
function holderLine(h: HolderSizes, units: 'mm' | 'in'): string {
  const l = (v: number) => lengthText(v, units)
  const name = h.name === undefined ? 'Nut' : `${h.name} nut`
  return `${name} dia ${l(h.nutDiameter)} x ${l(h.nutLength)} ${units}, body dia ${l(h.bodyDiameter)} ${units}`
}

/**
 * The header's clamp line (DF64, safe-links.md#clamps): only when links fly over the clamps,
 * i.e. with `minimum` and a clamp height whose margin stays below the clearance height.
 */
/**
 * A split piece's header line (split parts 4a): "Piece 3 of 8 of Enclosure 1", its name after a
 * colon when renamed (the default "<source> · <n>" is not repeated); the count and the source name
 * from the document, the piece itself from the plan's part copy. Docs:
 * docs/modes/split-parts.md#plan-export-and-run-per-piece, docs/architecture/grbl.md
 */
function pieceLine(doc: ProjectDoc, part: PartDTO): { piece?: string } {
  const from = part.derivedFrom
  if (from === undefined) return {}
  const source = Object.hasOwn(doc.parts, from.partId) ? doc.parts[from.partId] : undefined
  const count = Object.values(doc.parts).filter((p) => p.derivedFrom?.partId === from.partId).length
  const sourceName = source?.name ?? part.name
  const renamed = part.name !== `${sourceName} · ${from.index}`
  return {
    piece: `Piece ${from.index} of ${Math.max(count, from.index)} of ${sourceName}${renamed ? `: ${part.name}` : ''}`,
  }
}

function clampLine(s: LinkSettings): Pick<SetupHeader, 'clamp'> {
  const h = s.clampHeight
  if (s.retraction === 'full' || h === undefined || h + s.margin >= s.clearance - 1e-9) return {}
  return { clamp: { height: h, margin: s.margin } }
}

/** The header's zero and alignment points (alignment phase 1, docs/modes/alignment.md#export). */
function headerAlignment(
  plan: LoadedPlan,
  setup: SetupDTO,
  port: Region2dPort | undefined,
): Pick<SetupHeader, 'zero' | 'zeroOn' | 'alignment'> {
  const a = setupAlignment(plan, setup, port)
  const zeroOn = a.points.find((p) => p.id === a.zeroPoint)?.name
  return {
    zero: a.zero,
    ...(zeroOn === undefined ? {} : { zeroOn }),
    alignment: a.points.flatMap((p) =>
      p.wcs === undefined ? [] : [{ name: p.name, at: [p.wcs[0], p.wcs[1]] as const }],
    ),
  }
}

/** The program's view of a tool run's Z reference (DF69); none without one. */
function programZRef(
  z: { label: string; level: number; at: readonly [number, number]; top: boolean } | undefined,
): { zRef?: NonNullable<ExportOperation['zRef']> } {
  if (z === undefined) return {}
  return { zRef: { label: zRefText(z), level: z.level, at: [z.at[0], z.at[1]], top: z.top } }
}

/**
 * Each operation's first line (1-based): its label comment, matched in machining order (a label
 * text may repeat; position comments come after their operation's label).
 */
function operationLines(
  lines: readonly string[],
  labels: readonly string[],
  ids: readonly string[],
): { planOperationId: string; fromLine: number }[] {
  const out: { planOperationId: string; fromLine: number }[] = []
  let at = 0
  labels.forEach((label, k) => {
    const i = lines.indexOf(commentLine(label), at)
    if (i < 0) return
    out.push({ planOperationId: ids[k]!, fromLine: i + 1 })
    at = i + 1
  })
  return out
}

/**
 * The connected controller's G54 when it can check this plan's soft limits: a connection is open,
 * homed, and emulates the plan's machine copy (docs/modes/run-v0.1.md#work-zero-and-the-soft-limit-check).
 */
export function connectedWorkZero(
  doc: ProjectDoc,
  planId: string,
  services: Pick<Services, 'machine'>,
): Vec3 | undefined {
  const m = services.machine
  if (m?.target === undefined || m.machineKey === undefined) return undefined
  const status = m.status()
  if (status.connection.state !== 'open' || !status.homed) return undefined
  const key = machineKeyOf(doc, planId, 'plan.export')
  return key.isOk() && key.unwrap() === m.machineKey ? status.workZero : undefined
}

/**
 * `plan.export`'s note when the soft limits were not checked (hardening DF58): where to check them.
 * Doc: docs/architecture/grbl.md#plan-export-command
 */
const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0

/** A `TravelFit` rounded to 0.001 mm for the result. */
function roundFit(f: TravelFit): TravelFit {
  return {
    axis: f.axis,
    min: round3(f.min),
    max: round3(f.max),
    travel: round3(f.travel),
    from: round3(f.from),
    to: round3(f.to),
  }
}

export const SOFT_LIMIT_NOTE =
  "Soft limits not checked: no homed connection to this plan's machine. Before running, set the work zero and check with run.job.check (or the Run pre-flight); run.job.start checks too."

/**
 * `plan.export`'s note when links run below the clearance height (DF64, Q105): one air pass before
 * the first real cut. Doc: docs/modes/safe-links.md#verification-on-the-virtual-machine
 */
export const LINKS_NOTE =
  'Links between operations run low over the stock (minimum retraction). Before the first real cut with such a program, run it once in the air with Z0 set 30 mm above the stock.'

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
    "Export a plan's GRBL gCode, one program per setup: regenerates stale toolpaths, writes the file, returns stats and machine-check warnings.",
  title: () => 'Export gCode',
  machine: false,
  // apply first: docs/architecture/apply.md#implicit-apply
  applyFirst: true,
  args: z.object({
    planId: PlanIdSchema,
    target: z
      .string()
      .min(1)
      .refine(
        (t) => isGcodeFileName(t) || isFolderTarget(t),
        `must be a ${GCODE_EXTENSIONS.join(', ')} file or a folder ending in /`,
      )
      .describe(
        'Absolute path of the gCode file to write, or of a folder ending in / to use the short suggested name (project-s1.nc)',
      ),
    setupId: PlanRecordIdSchema.optional().describe(
      'Setup to export; required when the plan has several',
    ),
    confirm: z.boolean().default(false).describe('Must be true to replace an existing file'),
  }),
  result: z.object({
    filePath: z.string(),
    setupId: z.string(),
    lines: z.number().int().describe('gCode lines (what a sender streams)'),
    stats: ProgramStatsSchema,
    warnings: z
      .array(PlanWarningSchema)
      .describe('plan.machine findings; they never block the export'),
    softLimitChecked: z
      .boolean()
      .describe('Whether the soft-limit check ran (needs the work zero of a connected machine)'),
    softLimitNote: z
      .string()
      .optional()
      .describe('Without the check: how to check the soft limits before running'),
    travelFit: z
      .array(
        z.object({
          axis: z.enum(['x', 'y', 'z']),
          min: z.number(),
          max: z.number(),
          travel: z.number(),
          from: z.number(),
          to: z.number(),
        }),
      )
      .optional()
      .describe(
        'Without the check, per axis: program extent (work coords, mm) and the work-zero machine positions [from, to] that stay within soft limits [-travel, 0]; from > to: none fits',
      ),
    regenerated: z
      .array(z.string())
      .describe('Plan operations whose toolpath was missing or stale and was generated'),
    linksNote: z
      .string()
      .optional()
      .describe('With links lowered over the stock (DF64): the air pass advice'),
  }),
  async run(doc, args, ctx) {
    const files = ctx.services.exportFiles
    if (files === undefined)
      return fail('internal.unexpected', 'no export file service', { where: 'plan.export' })
    const workZero = connectedWorkZero(doc, args.planId, ctx.services)
    const exported = await exportPlan(doc, args.planId, ctx.services, {
      ...(args.setupId === undefined ? {} : { setupId: args.setupId }),
      ...(workZero === undefined ? {} : { workZero }),
    })
    if (exported.isErr()) return exported
    const e = exported.unwrap()
    const target = isFolderTarget(args.target)
      ? `${args.target}${gcodeFileStem(doc, args.planId, e.setupId)}.nc`
      : args.target
    const written = await files.write(target, e.text, { confirm: args.confirm })
    if (written.isErr())
      return Err(written.unwrapErr().withContext('plan.export', { planId: args.planId }))
    return Ok({
      filePath: written.unwrap().filePath,
      setupId: e.setupId,
      lines: e.lines.length,
      stats: e.stats,
      warnings: [...e.warnings],
      softLimitChecked: e.softLimitChecked,
      ...(e.softLimitChecked
        ? {}
        : { softLimitNote: SOFT_LIMIT_NOTE, travelFit: e.travelFit.map(roundFit) }),
      regenerated: [...e.regenerated],
      ...(e.lowLinks > 0 ? { linksNote: LINKS_NOTE } : {}),
    })
  },
})
