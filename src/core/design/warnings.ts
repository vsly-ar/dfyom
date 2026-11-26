/**
 * DFM warnings of a design part: the synchronous parameter and tool checks (`parameterChecks`)
 * against the whole tool library and each operation's own tool, for `design.warning.list` and
 * every design command result. The geometry checks come from the evaluation (worker, task 2.9).
 * Doc: docs/modes/design.md#dfm-warnings-task-28-wiring, docs/modes/design-v0.2.md#dfm-with-the-tool
 */
import { None, type AppResult } from '../../shared/result'
import { parameterChecks, type DfmTool } from '../geometry/dfm'
import type { Region2dPort } from '../geometry/2d/port'
import type { DfmWarning, PartGeometryInput } from '../geometry/model'
import { DfmWarningSchema } from '../geometry/schemas'
import type { Library } from '../library/library'
import type { Stock } from '../library/stock'
import { Tool } from '../library/tool'
import type { ProjectDoc, UnitSystem } from '../project/document'
import { toGeometryInput } from './geometry-input'
import { featureBlock, ownedOperationId, type LoadedFeature, type SpanGeometry } from './feature'
import type { Part } from './operation'
import { shapeFacts } from './placement'
import type { ShapeDTO } from './shape.dto'
import { designToolLabel } from './tool'
import { dfmTool, noFittingTool, operationTools } from './tool-choice'
import { checkOperations } from './validate'

/** `DfmWarning` as a result schema (defined with the other boundary schemas). */
export { DfmWarningSchema }
export { dfmTool }

/** Every readable tool of the library; files that do not load are skipped. */
export function libraryTools(library: Library): DfmTool[] {
  return library
    .list('tool')
    .items.flatMap((i) => (i.values instanceof Tool ? [dfmTool(i.values)] : []))
}

/**
 * The parameter and tool warnings of a (valid) part, in operation order; specific tools of the
 * tool field resolve in `snapshots`.
 */
export function partWarnings(
  part: Part,
  stock: Stock,
  units: UnitSystem,
  tools: readonly DfmTool[],
  snapshots: ProjectDoc['snapshots'] = {},
  region2d?: Region2dPort,
  features: readonly LoadedFeature[] = [],
  shapes: readonly ShapeDTO[] = [],
): AppResult<DfmWarning[]> {
  return toGeometryInput(part, stock, region2d, snapshots).map((input) =>
    insertInOrder(
      part.operations,
      parameterChecks(input, {
        tools,
        unitSystem: units === 'inch' ? 'inch' : 'metric',
        operationTools: operationTools(part.operations, snapshots),
        ...(region2d !== undefined && { region2d }),
      }),
      [
        ...featureWarnings(part.operations, features, stock, units, shapes, {
          operations: input.operations,
          region2d,
        }),
        ...noToolWarnings(part, input, stock, units, tools, snapshots, features, region2d),
        ...stockLimitWarnings(part, stock, region2d),
      ],
    ),
  )
}

/**
 * `dfm.stockLimit` (hardening DF95, docs/modes/design.md#changing-the-stock-df95): an operation
 * limit the part's stock no longer allows (a depth below the new stock bottom, a tab as thick as
 * the stock), after the stock was changed (`design.part.update { stock }`, or from the library).
 * Commands check these limits, so a part edited only by them has none; nothing is clamped.
 * Shapes that do not load or place leave this check out (their own warnings say why).
 */
function stockLimitWarnings(
  part: Part,
  stock: Stock,
  region2d: Region2dPort | undefined,
): DfmWarning[] {
  const facts = shapeFacts(part.operations, part.shapes, region2d)
  if (facts.isErr()) return []
  const checked = checkOperations(part.operations, stock, undefined, facts.unwrap(), part.shapes)
  if (checked.isOk()) return []
  return checked.unwrapErr().issues.flatMap((issue): DfmWarning[] => {
    const [head, operation, ...rest] = issue.path
    if (head !== 'operations' || typeof operation !== 'string') return []
    const parameter = rest.join('.')
    const values = Object.fromEntries(
      Object.entries(issue.params ?? {}).filter(([, v]) =>
        ['number', 'string', 'boolean'].includes(typeof v),
      ),
    ) as Record<string, number | string | boolean>
    return [
      {
        code: 'dfm.stockLimit',
        severity: 'warning',
        message: `${operation}${parameter === '' ? '' : `.${parameter}`}: ${issue.message} (the stock changed)`,
        operation,
        ...(parameter === '' ? {} : { parameter }),
        params: { ...values, rule: issue.rule, detail: issue.message },
      },
    ]
  })
}

/**
 * `dfm.noFittingTool` (hardening DF52, design-v0.2.md § Tool choice fixes): an operation without
 * a tool that neither a library tool nor a standard generalized tool fits, so the auto choice
 * leaves it without one. `params` as `dfm.toolUnfit`'s for the smallest generalized tool tried.
 * Clones instances (read-only, they follow their source) are left out.
 */
function noToolWarnings(
  part: Part,
  input: PartGeometryInput,
  stock: Stock,
  units: UnitSystem,
  tools: readonly DfmTool[],
  snapshots: ProjectDoc['snapshots'],
  features: readonly LoadedFeature[],
  region2d: Region2dPort | undefined,
): DfmWarning[] {
  const readOnly = new Set(
    features.filter((f) => f.spec.readOnly === true).map((f) => f.feature.id),
  )
  return part.operations.flatMap((op, i): DfmWarning[] => {
    if (op.tool.isSome() || op.owner.mapOr(false, (o) => readOnly.has(o.featureId))) return []
    // F7: a drilling under a stepped chamfer is bored by the chamfer's end mill
    const also = input.operations.filter(
      (g) => g.kind === 'chamfer' && g.stepdown !== undefined && g.edgeOf === op.id,
    )
    const why = noFittingTool(
      {
        op,
        geometry: input.operations[i]!,
        stock: input.stock,
        units,
        materialClass: stock.material.class,
        library: [],
        snapshots,
        ...(region2d !== undefined && { region2d }),
        ...(also.length > 0 && { also }),
      },
      tools,
    )
    if (why === undefined) return []
    const label = designToolLabel(why.tool, None)
    return [
      {
        code: 'dfm.noFittingTool',
        severity: 'warning',
        message: `${op.id}: no tool fits, not even the ${label}: ${why.unfit.detail}`,
        operation: op.id,
        parameter: 'tool',
        params: { ...why.unfit.values, rule: why.unfit.rule, tool: label },
        ...(why.unfit.need !== undefined && { suggestion: why.unfit.need }),
      },
    ]
  })
}

/**
 * The features' own notes (`FeatureKindSpec.warnings`, e.g. `dfm.holeCustomSize`, and
 * `spanWarnings`, e.g. `dfm.cloneOutsideStock`), for features that still own operations in `ops`
 * (a removed one is skipped).
 */
function featureWarnings(
  ops: Part['operations'],
  features: readonly LoadedFeature[],
  stock: Stock,
  units: UnitSystem,
  shapes: readonly ShapeDTO[],
  geometry: SpanGeometry,
): DfmWarning[] {
  return features.flatMap(({ spec, feature }) => {
    const { start, end } = featureBlock(ops, feature.id)
    if (start === end) return []
    return [
      ...(spec.warnings?.(feature, (role) => ownedOperationId(feature.id, role)) ?? []),
      ...(spec.spanWarnings?.(feature, ops, stock, units, shapes, geometry) ?? []),
    ]
  })
}

/**
 * `extra` inserted into `warnings` (left in their order) after the last warning of an operation
 * at or before each one's operation, so a list in design order stays so.
 */
function insertInOrder(
  ops: Part['operations'],
  warnings: DfmWarning[],
  extra: DfmWarning[],
): DfmWarning[] {
  if (extra.length === 0) return warnings
  const index = new Map(ops.map((o, i) => [o.id, i]))
  const at = (w: DfmWarning) => index.get(w.operation) ?? -1
  const out = [...warnings]
  for (const w of extra) {
    let i = out.length
    while (i > 0 && at(out[i - 1]!) > at(w)) i--
    out.splice(i, 0, w)
  }
  return out
}
