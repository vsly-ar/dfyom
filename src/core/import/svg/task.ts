/**
 * The SVG import as a worker task (`svg.import`): reads a local file through `ctl.files`, decodes
 * it as UTF-8 and runs `importSvg`, so `design.shape.import`'s prepared input never blocks the host
 * thread and core reads no file itself. Doc: docs/architecture/shapes.md#implementation-i1-command
 */
import { z } from 'zod'
import { Err, tryAsync } from '../../../shared/result'
import type { WorkerTask } from '../../commands/jobs'
import { importSvg, SVG_LIMITS, type SvgImport, type SvgImportReport } from './import'
import { svgError } from './xml'

const Vec = z.tuple([z.number(), z.number()])
const ElementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('line'), a: Vec, b: Vec }),
  z.object({ kind: z.literal('arc'), a: Vec, b: Vec, centre: Vec, ccw: z.boolean() }),
])
const ChainSchema = z.object({ elements: z.array(ElementSchema) })
const Counts = z.record(z.string(), z.number())

export const SvgImportReportSchema = z.object({
  size: z.object({ width: z.number(), height: z.number() }).optional(),
  bounds: z.object({ min: Vec, max: Vec }).optional(),
  unit: z.string(),
  unitAssumed: z.boolean(),
  imported: Counts,
  skipped: Counts,
  beziersFitted: z.number(),
  ellipticalArcsFitted: z.number(),
  maxDeviation: z.number(),
  cornersAtCusps: z.number(),
  microCornersMerged: z.number(),
  tinySegmentsMerged: z.number(),
  loopsRepaired: z.number(),
  loopsDropped: z.number(),
  gapsClosed: z.number(),
  loops: z.number(),
  openPaths: z.number(),
  lines: z.number(),
  arcs: z.number(),
  warnings: z.array(
    z.object({ rule: z.string(), message: z.string(), element: z.string().optional() }),
  ),
}) as unknown as z.ZodType<SvgImportReport>

const SvgImportSchema = z.object({
  shapes: z.array(
    z.object({
      name: z.string(),
      source: z.object({ element: z.string() }),
      items: z.array(
        z.discriminatedUnion('kind', [
          // E2: levels (engraved-patterns.md § SVG encoding) cross the worker boundary too
          z.object({
            kind: z.literal('loop'),
            op: z.enum(['add', 'subtract']),
            loop: ChainSchema,
            level: z.number().optional(),
          }),
          z.object({
            kind: z.literal('path'),
            path: ChainSchema,
            levels: z.union([z.number(), z.array(z.number())]).optional(),
          }),
        ]),
      ),
    }),
  ),
  report: SvgImportReportSchema,
}) as unknown as z.ZodType<SvgImport>

export interface SvgImportInput {
  readonly path: string
  readonly unit?: 'mm' | 'in' | 'px96' | 'px72' | undefined
  readonly split?: 'file' | 'element' | 'loop' | undefined
}

export const svgImportTask: WorkerTask<SvgImportInput, SvgImport> = {
  name: 'svg.import',
  lane: 'geometry',
  input: z.object({
    path: z.string().min(1),
    unit: z.enum(['mm', 'in', 'px96', 'px72']).optional(),
    split: z.enum(['file', 'element', 'loop']).optional(),
  }),
  output: SvgImportSchema,
  timeoutMs: 30_000,
  async run({ path, unit, split }, ctl) {
    const opened = await ctl.files.open(path)
    if (opened.isErr()) return opened
    const { size, chunks } = opened.unwrap()
    if (size > SVG_LIMITS.maxBytes)
      return svgError(
        'svgLimit',
        `the drawing has more bytes than the limit (${SVG_LIMITS.maxBytes})`,
        {
          limit: SVG_LIMITS.maxBytes,
          actual: size,
        },
      )
    const read = await tryAsync(
      async (): Promise<Uint8Array> => {
        const bytes = new Uint8Array(size)
        let done = 0
        for await (const chunk of chunks) {
          // a file that grew while reading is cut at the size read first (within the limit)
          bytes.set(chunk.subarray(0, Math.max(0, size - done)), Math.min(done, size))
          done += chunk.length
        }
        return bytes.subarray(0, Math.min(done, size))
      },
      'persist.io',
      `reading ${path} failed`,
    )
    if (read.isErr()) return Err(read.unwrapErr().withContext('svg.import'))
    const text = new TextDecoder('utf-8').decode(read.unwrap())
    return importSvg(text, {
      ...(unit === undefined ? {} : { unit }),
      ...(split === undefined ? {} : { split }),
    })
  },
}
