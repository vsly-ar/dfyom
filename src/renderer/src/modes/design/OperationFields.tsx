// The per-kind parameter fields of one design operation, grouped as in the parameter tables of
// design.md (Shape, Position, Depth, Corners, Hole, Slot, Tabs): each a QuantityInput (or a
// choice) whose commit is one update command through `ctx.send`, with its warnings and errors at
// the field. Shared by the Design inspector (`design.<kind>.update`) and the plan inspector's
// "Part (plan copy)" group (`plan.design.operation.update`, task E3b), never copied. The tool
// field (task F5, design only) comes in as `tool`. Layout per kind (DF110, S3): the target table of
// inspector-layout.md – rarely used fields (Anchor, Rotation, Floor fillet radius, tab positions)
// behind a More row, Corners / Tabs / Slot as accordions; a hidden field with an error or a
// finding opens its More row or accordion (`problemAt`), so nothing is hidden with a problem.
// Doc: docs/conventions/ui.md#quantity-and-expression-input, #selection-and-picking,
// #design-and-plan-controls-v02; docs/modes/design.md#operations-v01;
// docs/conventions/inspector-layout.md#per-inspector-target-layout
import { useEffect } from 'react'
import type { ConstructionEntry } from '../../../../core/design/evaluation'
import type { FieldKind } from '../../../../core/design/operation'
import type { OperationDTO } from '../../../../core/design/part.dto'
import { derivedLength } from '../../../../core/design/hole'
import { STOCK_FACE } from '../../../../core/geometry/face'
import { Rational } from '../../../../core/quantity/rational'
import { Quantity } from '../../../../core/quantity/quantity'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { UnitSystem } from '../../../../core/project/document'
import type { QuantityKind } from '../../../../core/quantity/units'
import type { AppErrorData, Issue } from '../../../../shared/errors/app-error'
import { designMessages } from '../../messages/design'
import { dfmMessages } from '../../messages/dfm'
import { useRegion2d, useShell, useUi } from '../../shell/ShellContext'
import type { PickInsert } from '../../ui/QuantityInput/QuantityInput'
import {
  Icon,
  AnchorPicker,
  Field,
  FieldIcon,
  IconButton,
  InspectorGroup,
  QuantityInput,
  SegmentedControl,
  Select,
  Switch,
  type FieldIconName,
  type FieldMessage,
  type GroupSeverity,
  type StepKind,
} from '../../ui'
import { ChamferInspector } from './ChamferInspector'
import { LineInspector } from './LineInspector'
import { isOpenNamed } from './operation-shape'
import { isRotated, ShapePicker, type ShapeActions } from './ShapePicker'
import { RoundField } from './RoundField'
import { TabPositions } from './TabsFields'
import { profileTabs } from './tabs-model'
import styles from './Design.module.css'
import {
  axisNames,
  defaultUnit,
  constructionAt,
  depthPickTargets,
  isFormula,
  onChoices,
  quantityAt,
  quantityOf,
  referenceChoices,
  surfaceDirection,
  surfaceLabel,
  shapeArgs,
  updateArgs,
  type DesignPart,
  dfmNames,
} from './model'

const t = designMessages.inspector
const dc = designMessages.construction

const sentence = (s: string) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1))

export interface FieldError {
  readonly path: string
  readonly text: string
}

export interface OperationFieldsContext {
  readonly part: DesignPart
  readonly op: OperationDTO
  readonly units: UnitSystem
  readonly warnings: readonly DfmWarning[]
  readonly errors: readonly FieldError[]
  /** Shown, never committed (a plan copy outside settled design). */
  readonly readOnly: boolean
  /**
   * Whether references can be picked in the viewport (the design scene handles pick mode); without
   * it they are chosen from the field's list only.
   */
  readonly pickable: boolean
  /**
   * One update command with these args; `path` is where its errors show, `gesture` a live step,
   * `draft` the field text it came from (kept as "not applied" if the command refuses it, DF117).
   */
  send(args: Record<string, unknown>, path: string, gesture?: string, draft?: string): void
  /** DF117: refused field texts by path, kept by the owner (ui.md#quantity-and-expression-input). */
  readonly drafts?: Readonly<Record<string, string>> | undefined
  /** DF117: drop the refused text at `path` (Revert, Escape, typed back to the applied value). */
  revertDraft?(path: string): void
  cancelGesture(gesture: string): Promise<boolean>
  /** The shape picker's design-only actions (task U2): New shape…, Edit shape, Convert, fixes. */
  readonly shapeActions?: ShapeActions | undefined
  /**
   * Read-only fields of an owned operation (v0.4 task U1): a finding with a suggestion offers this
   * fix instead of "Use …" ("Fix in Hole 1": select the feature, focus the mapped field).
   */
  readonly fixElsewhere?: ((w: DfmWarning) => { label: string; onApply: () => void }) | undefined
  /**
   * The part's construction surfaces (`design.warning.list`, DF118 V3): a reference to one shows
   * a note "Cut away by …" at its field (construction-surfaces.md#ui).
   */
  readonly construction?: readonly ConstructionEntry[] | undefined
  /**
   * Recommended values by parameter path (the facing's depth down to the reference, DF4): the
   * field's adjust panel offers "Use …" (QuantityInput `recommended`); never on read-only fields.
   */
  readonly recommended?: Readonly<Record<string, { source: string; text: string }>> | undefined
}

/**
 * A failed update's issues: those at a field of the operation show there, the rest at the top
 * (ui.md#errors); `summary` is set when something is left for the top.
 */
export function placeErrors(
  error: AppErrorData,
  path: string | undefined,
): { errors: FieldError[]; summary: AppErrorData | undefined } {
  const mine: FieldError[] = []
  const rest: Issue[] = []
  for (const issue of error.issues) {
    const p = issue.path.join('.')
    const at = p.length > 0 && !p.startsWith('operations.') ? p : path
    if (at !== undefined && issue.path[0] !== 'operations')
      mine.push({ path: at, text: sentence(issue.message) })
    else rest.push(issue)
  }
  return { errors: mine, summary: mine.length === 0 || rest.length > 0 ? error : undefined }
}

/**
 * The field a warning is shown at (a shape or center warning at its first field; a general
 * shape's warnings and the corner warnings at the shape picker, path `shape`; tab warnings at the
 * positions while they are entered).
 */
export function warningPath(w: DfmWarning, op: OperationDTO): string | undefined {
  // v0.4 U4: "no library tool fits the chamfer" shows at the tool field, with "New tool…"
  if (w.code === 'dfm.chamferNoTool') return 'tool'
  // U9 P1: a chamfer's reach is about the tools, not its width: at the tool field too
  if (w.code === 'dfm.reach' && op.kind === 'chamfer') return 'tool'
  const p = w.parameter
  if (p === undefined) return undefined
  if (p === 'center') return 'center.0'
  if (p === 'tabs')
    return op.kind === 'profile' && op.tabs.positions !== undefined
      ? 'tabs.positions'
      : 'tabs.count'
  if (p === 'shape' && 'shape' in op) {
    if (op.shape.kind === 'named' || isRotated(op.shape) || w.params['at'] !== undefined)
      return 'shape'
    return op.shape.kind === 'circle' ? 'shape.diameter' : 'shape.length'
  }
  return p
}

const QUANTITY_KIND: Record<FieldKind, QuantityKind> = {
  length: 'length',
  angle: 'angle',
  scalar: 'scalar',
}

/**
 * The worst problem at these field paths (an error at the path or below it, a finding shown
 * there): a More row or accordion holding them opens while there is one (DF110 "never hides a
 * problem"); `undefined` = none.
 */
export function problemAt(
  ctx: OperationFieldsContext,
  paths: readonly string[],
): GroupSeverity | undefined {
  const at = (p: string | undefined) =>
    p !== undefined && paths.some((x) => p === x || p.startsWith(`${x}.`))
  if (ctx.errors.some((e) => at(e.path))) return 'error'
  if (ctx.warnings.some((w) => at(warningPath(w, ctx.op)))) return 'warning'
  return undefined
}

/** One edited parameter as an update command. */
const commit = (ctx: OperationFieldsContext, path: string, source: string, gesture?: string) =>
  ctx.send(updateArgs(ctx.op, path, source), path, gesture)

/** The operation's parameter groups (its name and warnings not included). */
export function OperationFields({
  ctx,
  level = 3,
  tool,
}: {
  ctx: OperationFieldsContext
  /** Heading level of the group titles (4 when nested in another group). */
  level?: 3 | 4
  /** The tool field (Design inspector only), placed as the first group after `on`'s. */
  tool?: React.ReactNode
}): React.JSX.Element | null {
  const op = ctx.op
  const g = (title: string, children: React.ReactNode) => (
    <InspectorGroup title={title} level={level}>
      {children}
    </InspectorGroup>
  )
  const toolGroup = tool === undefined ? null : g(t.groups.tool, tool)
  switch (op.kind) {
    case 'facing':
      return (
        <>
          {g(
            t.groups.depth,
            <>
              <OnField ctx={ctx} />
              <ParamField
                ctx={ctx}
                path="depth"
                stepKind="depth"
                label={t.depth}
                kind="length"
                icon="depth"
              />
            </>,
          )}
          {toolGroup}
        </>
      )
    case 'pocket':
      return (
        <>
          <ShapeGroup ctx={ctx} level={level} />
          {g(
            t.groups.depth,
            <>
              <OnField ctx={ctx} />
              <ThroughField ctx={ctx} />
              {op.through === true ? null : (
                <ParamField
                  ctx={ctx}
                  path="depth"
                  stepKind="depth"
                  label={t.depth}
                  kind="length"
                  icon="depth"
                />
              )}
            </>,
          )}
          {toolGroup}
          <CornersGroup ctx={ctx} level={level} />
        </>
      )
    case 'drilling':
      return (
        <>
          {g(
            t.groups.position,
            <>
              <ParamField
                ctx={ctx}
                path="center.0"
                stepKind="xy"
                label={t.position('Centre', axes(ctx).u)}
                kind="length"
                icon="positionX"
              />
              <ParamField
                ctx={ctx}
                path="center.1"
                stepKind="xy"
                label={t.position('Centre', axes(ctx).v)}
                kind="length"
                icon="positionY"
              />
              <OnField ctx={ctx} />
            </>,
          )}
          {g(
            t.groups.hole,
            <>
              <ParamField
                ctx={ctx}
                path="diameter"
                stepKind="small"
                label={t.diameter}
                kind="length"
                icon="diameter"
              />
              <Field label={t.bottom} readOnly={ctx.readOnly}>
                <Select
                  options={(['through', 'flat', 'drillPoint'] as const).map((b) => ({
                    value: b,
                    label: t.bottoms[b],
                  }))}
                  value={op.bottom}
                  disabled={ctx.readOnly}
                  onValueChange={(bottom) =>
                    ctx.send(
                      {
                        bottom,
                        ...(bottom !== 'through' && op.depth === undefined
                          ? { depth: op.diameter.source }
                          : {}),
                      },
                      'bottom',
                    )
                  }
                />
              </Field>
              {op.bottom !== 'through' ? (
                <ParamField
                  ctx={ctx}
                  path="depth"
                  stepKind="depth"
                  label={t.depth}
                  kind="length"
                  icon="depth"
                />
              ) : null}
              {op.bottom === 'drillPoint' ? (
                <ParamField
                  ctx={ctx}
                  path="pointAngle"
                  stepKind="angle"
                  label={t.pointAngle}
                  kind="angle"
                  icon="chamfer"
                />
              ) : null}
            </>,
          )}
          {toolGroup}
        </>
      )
    case 'profile': {
      const named = op.shape.kind === 'named' ? op.shape.shapeId : undefined
      const open = isOpenNamed(ctx.part.dto.shapes?.find((x) => x.id === named))
      const sideMessages: FieldMessage[] = [
        ...ctx.errors
          .filter((e) => e.path === 'side')
          .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text })),
        ...(open
          ? [
              op.side !== 'on'
                ? {
                    id: 'openNeedsOn',
                    severity: 'error' as const,
                    text: t.openNeedsOn,
                    ...(ctx.readOnly
                      ? {}
                      : {
                          fix: {
                            label: t.useSideOn,
                            onApply: () => ctx.send({ side: 'on' }, 'side'),
                          },
                        }),
                  }
                : { id: 'openNote', severity: 'note' as const, text: t.openNeedsOn },
            ]
          : []),
      ]
      return (
        <>
          <ShapeGroup ctx={ctx} level={level} />
          {g(
            t.groups.cut,
            <>
              <OnField ctx={ctx} />
              <Field label={t.side} kind="toggle" messages={sideMessages} readOnly={ctx.readOnly}>
                <SegmentedControl<'outside' | 'inside' | 'on'>
                  label={t.side}
                  options={(['outside', 'inside', 'on'] as const).map((s) => ({
                    value: s,
                    label: t.sides[s],
                    disabled: open && s !== 'on',
                  }))}
                  value={op.side}
                  disabled={ctx.readOnly}
                  onValueChange={(side) => ctx.send({ side }, 'side')}
                />
              </Field>
              <ThroughField ctx={ctx} />
              <GrooveDepthField ctx={ctx} />
            </>,
          )}
          {toolGroup}
          <TabsGroup ctx={ctx} level={level} />
          <InspectorGroup
            title={t.groups.slot}
            level={level}
            collapsible
            rememberKey="profile.slot"
            summary={op.slotWidth.source}
            severity={problemAt(ctx, ['slotWidth'])}
            forceOpen={problemAt(ctx, ['slotWidth']) !== undefined}
          >
            <ParamField
              ctx={ctx}
              path="slotWidth"
              stepKind="small"
              label={t.slotWidth}
              kind="length"
              icon="slotWidth"
            />
          </InspectorGroup>
        </>
      )
    }
    case 'chamfer':
      return <ChamferInspector ctx={ctx} level={level} tool={toolGroup} />
    case 'line':
      return <LineInspector ctx={ctx} level={level} tool={toolGroup} />
    default:
      return null
  }
}

function ShapeGroup({
  ctx,
  level,
}: {
  ctx: OperationFieldsContext
  level: 3 | 4
}): React.JSX.Element | null {
  const op = ctx.op
  if (!('shape' in op)) return null
  const shape = op.shape
  const names = axes(ctx)
  const rotates = shape.kind !== 'circle'
  // Anchor and Rotation are set once, if ever (inspector-layout.md § Per-inspector target layout)
  const problem = problemAt(ctx, rotates ? ['anchor', 'shape.rotation'] : ['anchor'])
  return (
    <InspectorGroup title={t.groups.shape} level={level}>
      <ShapePicker ctx={ctx} actions={ctx.shapeActions} />
      <ParamField
        ctx={ctx}
        path="shape.center.0"
        stepKind="xy"
        label={t.position('Position', names.u)}
        kind="length"
        icon="positionX"
      />
      <ParamField
        ctx={ctx}
        path="shape.center.1"
        stepKind="xy"
        label={t.position('Position', names.v)}
        kind="length"
        icon="positionY"
      />
      {shape.kind === 'rectangle' ? (
        <>
          <ParamField
            ctx={ctx}
            path="shape.length"
            stepKind="xy"
            label={t.lengthAlong(names.u)}
            kind="length"
            icon="length"
          />
          <ParamField
            ctx={ctx}
            path="shape.width"
            stepKind="xy"
            label={t.widthAlong(names.v)}
            kind="length"
            icon="width"
          />
        </>
      ) : shape.kind === 'circle' ? (
        <ParamField
          ctx={ctx}
          path="shape.diameter"
          stepKind="xy"
          label={t.diameter}
          kind="length"
          icon="diameter"
        />
      ) : null}
      {op.kind === 'profile' && shape.kind === 'rectangle' ? (
        <CornerRadiusFields ctx={ctx} />
      ) : null}
      {shape.kind === 'named' ? (
        // a toggle Field as every inspector switch: label and switch on one row (U9 Q130)
        <Field label={t.picker.mirror} kind="toggle" readOnly={ctx.readOnly}>
          <Switch
            label={t.picker.mirror}
            hideLabel
            checked={shape.mirror === true}
            disabled={ctx.readOnly}
            onCheckedChange={(mirror) => {
              const { mirror: _was, ...rest } = shapeArgs(shape)
              ctx.send({ shape: mirror ? { ...rest, mirror: true } : rest }, 'shape.mirror')
            }}
          />
        </Field>
      ) : null}
      {shape.kind === 'named' ? <ScaleField ctx={ctx} /> : null}
      <InspectorGroup.More
        fields={rotates ? [t.anchor, t.picker.rotation] : [t.anchor]}
        rememberKey={`${op.kind}.shape.more`}
        forceOpen={problem !== undefined}
      >
        <AnchorField ctx={ctx} />
        {rotates ? <RotationField ctx={ctx} /> : null}
      </InspectorGroup.More>
    </InspectorGroup>
  )
}

/**
 * A rectangle's Corner radius and its Round switch (DF120 R2): while Round is on the radius is
 * derived (half the narrowest side) and read-only; switching it off keeps the current radius.
 */
function CornerRadiusFields({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element | null {
  const op = ctx.op
  if (!('shape' in op) || op.shape.kind !== 'rectangle') return null
  const shape = op.shape
  const round = shape.round === true
  return (
    <>
      <ParamField
        ctx={ctx}
        path="shape.cornerRadius"
        stepKind="small"
        label={t.cornerRadius}
        kind="length"
        icon="corner"
        derived={round}
      />
      <RoundField
        checked={round}
        readOnly={ctx.readOnly}
        onChange={(on) => ctx.send({ shape: { ...shapeArgs(shape), round: on } }, 'shape.round')}
      />
    </>
  )
}

/**
 * A pocket's Corners accordion (open by default): Corner radius of a rectangle, the Floor fillet
 * radius behind More (directly, when it is the group's only field).
 */
function CornersGroup({
  ctx,
  level,
}: {
  ctx: OperationFieldsContext
  level: 3 | 4
}): React.JSX.Element | null {
  const op = ctx.op
  if (op.kind !== 'pocket') return null
  const corner = op.shape.kind === 'rectangle' ? op.shape.cornerRadius : undefined
  const problem = problemAt(ctx, ['shape.cornerRadius', 'floorRadius'])
  const floor = (
    <ParamField
      ctx={ctx}
      path="floorRadius"
      stepKind="small"
      label={t.floorRadius}
      kind="length"
      icon="floorRadius"
    />
  )
  return (
    <InspectorGroup
      title={t.groups.corners}
      level={level}
      collapsible
      defaultOpen
      rememberKey="pocket.corners"
      summary={t.summaries.corners(
        corner?.source,
        op.floorRadius.source,
        op.shape.kind === 'rectangle' && op.shape.round === true,
      )}
      severity={problem}
      forceOpen={problem !== undefined}
    >
      {corner !== undefined ? (
        <>
          <CornerRadiusFields ctx={ctx} />
          <InspectorGroup.More
            fields={[t.floorRadius]}
            rememberKey="pocket.corners.more"
            forceOpen={problemAt(ctx, ['floorRadius']) !== undefined}
          >
            {floor}
          </InspectorGroup.More>
        </>
      ) : (
        floor
      )}
    </InspectorGroup>
  )
}

/**
 * A profile's Tabs accordion (open by default): count, width, thickness; the entered positions
 * ("Add tab" while there are none) behind More. Entered positions replace the count, so once there
 * are some they show in the group itself.
 */
function TabsGroup({
  ctx,
  level,
}: {
  ctx: OperationFieldsContext
  level: 3 | 4
}): React.JSX.Element | null {
  const port = useRegion2d()
  const op = ctx.op
  if (op.kind !== 'profile') return null
  const entered = op.tabs.positions
  const problem = problemAt(ctx, ['tabs'])
  // no More row that would open on nothing (a plan copy, a blind profile: no "Add tab")
  const addable = !ctx.readOnly && profileTabs(ctx.part, op.id, port)?.allowed === true
  return (
    <InspectorGroup
      title={t.groups.tabs}
      level={level}
      collapsible
      defaultOpen
      rememberKey="profile.tabs"
      summary={t.summaries.tabs(op.tabs.count.source, entered?.length)}
      severity={problem}
      forceOpen={problem !== undefined}
    >
      {entered === undefined ? (
        <ParamField
          ctx={ctx}
          path="tabs.count"
          stepKind="count"
          label={t.tabsCount}
          kind="scalar"
          icon="tabs"
        />
      ) : null}
      <ParamField
        ctx={ctx}
        path="tabs.width"
        stepKind="small"
        label={t.tabsWidth}
        kind="length"
        icon="tabWidth"
      />
      <ParamField
        ctx={ctx}
        path="tabs.thickness"
        stepKind="depth"
        label={t.tabsThickness}
        kind="length"
        icon="tabThickness"
      />
      {entered !== undefined ? (
        <TabPositions ctx={ctx} />
      ) : addable ? (
        <InspectorGroup.More fields={[t.tabPositions]} rememberKey="profile.tabs.more">
          <TabPositions ctx={ctx} />
        </InspectorGroup.More>
      ) : null}
    </InspectorGroup>
  )
}

/**
 * Rotation in degrees (rectangles and named shapes); while it has focus the viewport draws the
 * placed, rotated bounding box the anchor uses (ui store `rotationGuide`).
 */
function RotationField({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element {
  const { ui } = useShell()
  const id = ctx.op.id
  return (
    <div
      onFocus={() => ui.getState().setRotationGuide(id)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          ui.getState().setRotationGuide(null)
      }}
    >
      <ParamField
        ctx={ctx}
        path="shape.rotation"
        stepKind="rotation"
        label={t.picker.rotation}
        kind="angle"
        icon="rotation"
        placeholder={t.picker.rotationNone}
      />
    </div>
  )
}

/**
 * A named placement's uniform Scale about the anchor point (D2,
 * docs/modes/design-llm-first.md#placement-scale); empty or 1 = unscaled. The full placement UI
 * is U3.
 */
function ScaleField({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element | null {
  const op = ctx.op
  if ((op.kind !== 'pocket' && op.kind !== 'profile') || op.shape.kind !== 'named') return null
  const shape = op.shape
  const k = shape.scale ?? 1
  const messages: FieldMessage[] = ctx.errors
    .filter((e) => e.path === 'shape.scale')
    .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text }))
  const value = Quantity.parse(String(k), {
    kind: 'scalar',
    defaultUnit: defaultUnit('scalar', ctx.units),
  })
  return (
    <QuantityInput
      label={t.picker.scale}
      kind="scalar"
      defaultUnit={defaultUnit('scalar', ctx.units)}
      value={value.isOk() ? value.unwrap() : undefined}
      stepKind="scale"
      stepKey="shape.scale"
      illustration={<FieldIcon name="length" />}
      messages={messages}
      readOnly={ctx.readOnly}
      onCommit={(q, gesture) => {
        const { scale: _was, ...rest } = shapeArgs(shape)
        const next = q?.canonical ?? 1
        ctx.send({ shape: next === 1 ? rest : { ...rest, scale: next } }, 'shape.scale', gesture)
      }}
      onCancelGesture={ctx.cancelGesture}
    />
  )
}

/**
 * A profile's blind depth below `on`: a groove (side On) or a step (Outside/Inside, DF53,
 * docs/modes/design-v0.3.md#steps-blind-side-profiles-df53); empty = through (`depth: null`).
 */
function GrooveDepthField({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element | null {
  const op = ctx.op
  // DF116: while through (no depth) the Through switch says so; the field shows when blind
  if (op.kind !== 'profile' || op.depth === undefined) return null
  const messages: FieldMessage[] = ctx.errors
    .filter((e) => e.path === 'depth')
    .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text }))
  return (
    <QuantityInput
      label={t.grooveDepth}
      kind="length"
      defaultUnit={defaultUnit('length', ctx.units)}
      value={op.depth === undefined ? undefined : quantityOf(op.depth)}
      placeholder={t.grooveThrough}
      optional
      stepKind="depth"
      stepKey="profile.depth"
      illustration={<FieldIcon name="depth" />}
      messages={messages}
      readOnly={ctx.readOnly}
      onCommit={(q, gesture) => ctx.send({ depth: q?.source ?? null }, 'depth', gesture)}
      onCancelGesture={ctx.cancelGesture}
    />
  )
}

/**
 * DF116: the Through switch of a pocket's Depth group (`through`) and a profile's Cut group (an
 * empty depth; off = a blind depth of a quarter of the material below `on`), design.md#pocket.
 */
function ThroughField({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element | null {
  const op = ctx.op
  if (op.kind !== 'pocket' && op.kind !== 'profile') return null
  const through = op.kind === 'pocket' ? op.through === true : op.depth === undefined
  const messages: FieldMessage[] = ctx.errors
    .filter((e) => e.path === 'through')
    .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text }))
  const change = (on: boolean) => {
    if (op.kind === 'pocket') return ctx.send({ through: on }, 'through')
    if (on) return ctx.send({ depth: null }, 'through')
    const table = ctx.part.table
    if (table === undefined) return
    const material = table.extent(surfaceDirection(table, onOf(op)))
    const quarter = derivedLength(material.div(Rational.int(4n)).unwrapOr(material), ctx.units)
    if (quarter.isOk()) ctx.send({ depth: quarter.unwrap().source }, 'through')
  }
  return (
    <Field
      label={t.through}
      kind="toggle"
      info={t.throughInfo}
      messages={messages}
      readOnly={ctx.readOnly}
    >
      <Switch
        label={t.through}
        hideLabel
        checked={through}
        disabled={ctx.readOnly}
        onCheckedChange={change}
      />
    </Field>
  )
}

/** The operation's index in its part (the surface table's resolver position). */
const indexOf = (ctx: OperationFieldsContext) =>
  ctx.part.dto.operations.findIndex((o) => o.id === ctx.op.id)

/** Direction of the operation's `on` face. */
const directionOf = (ctx: OperationFieldsContext) => surfaceDirection(ctx.part.table, onOf(ctx.op))

/** The operation's `on` (absent on a facing or profile = the stock top, design-v0.2.md). */
const onOf = (op: OperationDTO): string => op.on ?? STOCK_FACE['+z']

/** Axis names of the operation's face frame in labels (X/Y on the top, u/v elsewhere). */
const axes = (ctx: OperationFieldsContext) => axisNames(directionOf(ctx))

/**
 * The placement anchor (task F2): which of the nine points of the shape's bounding box the
 * position fields give, beside them. Choosing re-anchors without moving the feature (one
 * `anchor` update, one undo step). Disabled with its reason while a coordinate is a formula.
 */
function AnchorField({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element | null {
  const { op } = ctx
  if (!('shape' in op)) return null
  const shape = op.shape
  const direction = directionOf(ctx)
  const value = shape.anchor ?? { u: 'centre' as const, v: 'centre' as const }
  const formula = isFormula(shape.center[0]) || isFormula(shape.center[1])
  const name = designMessages.anchorPoint
  const messages: FieldMessage[] = [
    ...ctx.errors
      .filter((e) => e.path === 'anchor')
      .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text })),
    ...(formula && !ctx.readOnly
      ? [{ id: 'formula', severity: 'note' as const, text: t.anchorFormula }]
      : []),
  ]
  return (
    <Field label={t.anchor} kind="toggle" messages={messages} readOnly={ctx.readOnly}>
      <AnchorPicker
        label={t.anchor}
        value={value}
        shape={shape.kind === 'circle' ? 'circle' : 'rectangle'}

        disabled={ctx.readOnly || formula}
        caption={name(direction, value)}
        pointLabel={(p) => name(direction, p)}
        onValueChange={(anchor) => ctx.send({ anchor }, 'anchor')}
      />
    </Field>
  )
}

/** One quantity parameter: stored value, commit = one update command, warnings and errors here. */
export function ParamField({
  ctx,
  path,
  label,
  kind,
  icon,
  placeholder,
  stepKind,
  info,
  derived = false,
}: {
  ctx: OperationFieldsContext
  path: string
  label: string
  kind: FieldKind
  icon: FieldIconName
  placeholder?: string
  /** What the field measures, for its adjust steps (inspector-layout.md § Step kinds). */
  stepKind: StepKind
  /** Static explanation: the (i) tip (inspector-layout.md § Info tips). */
  info?: string
  /** The value follows other fields (a Round corner radius, DF120): shown read-only. */
  derived?: boolean
}): React.JSX.Element {
  const pick = useUi((s) => s.pick)
  const setPick = useUi((s) => s.setPick)
  const { ui } = useShell()
  const { part, op } = ctx
  const readOnly = ctx.readOnly || derived
  const index = indexOf(ctx)
  const table = part.table
  const choices = table ? referenceChoices(part.dto, table, index) : []
  const references = choices.map((c) => ({ id: c.id, label: c.label }))
  const messages: FieldMessage[] = [
    ...ctx.errors
      .filter((e) => e.path === path)
      .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text })),
    ...ctx.warnings
      .filter((w) => warningPath(w, op) === path)
      .map((w): FieldMessage => {
        const source = dfmMessages.suggestionSource(w, part.units)
        return {
          id: `${w.code}:${w.parameter ?? ''}`,
          severity: dfmMessages.tier(w),
          text: dfmMessages.text(w, part.units, dfmNames(part.dto)),
          ...(source !== undefined && w.suggestion && w.parameter === path && !readOnly
            ? {
                fix: {
                  label: dfmMessages.useValue(w.suggestion.relation, source),
                  onApply: () => commit(ctx, path, source),
                },
              }
            : w.suggestion && ctx.readOnly && ctx.fixElsewhere
              ? { fix: ctx.fixElsewhere(w) }
              : {}),
        }
      }),
  ]
  // DF118 V3: a formula referring to a construction surface shows a quiet note
  const cut = constructionAt(part.dto, ctx.construction, op.id, path)
  if (cut !== undefined && !messages.some((x) => x.id.startsWith('dfm.surfaceCutAway')))
    messages.push({ id: 'construction', severity: 'note', text: dc.noteOf(cut.label, cut.by) })
  const fieldId = `${op.id}:${path}`
  const recommended = ctx.recommended?.[path]
  // DF115: a Depth pick takes the surface the cut goes down to (ui.md#depth-pick-df115)
  const depthTargets =
    path === 'depth' &&
    table !== undefined &&
    (op.kind === 'facing' || op.kind === 'pocket' || op.kind === 'drilling')
      ? depthPickTargets(part.dto, table, index, onOf(op), op.kind)
      : undefined
  const pickDepth = (insert: PickInsert) =>
    setPick({
      owner: fieldId,
      field: t.depthPickField(label),
      eligible: new Set(depthTargets!.keys()),
      onPick: (surface) => {
        const target = depthTargets!.get(surface)
        if (target === undefined) return
        if (target.kind === 'level') return insert(target.source, 'replace')
        // the far side of the part: through, one command (pocket Through, drilling Bottom)
        if (op.kind === 'pocket') ctx.send({ through: true }, 'through')
        else ctx.send({ bottom: 'through' }, 'bottom')
        ui.getState().setRemovedToast(
          t.depthPickedThrough(op.name, surfaceLabel(part.dto, surface)),
        )
      },
    })
  const draft = ctx.drafts?.[path]
  return (
    <QuantityInput
      label={label}
      kind={QUANTITY_KIND[kind]}
      defaultUnit={defaultUnit(kind, ctx.units)}
      value={quantityAt(op, path)}
      onCommit={(q, gesture) =>
        ctx.send(updateArgs(ctx.op, path, q.source), path, gesture, q.source)
      }
      {...(draft !== undefined ? { pending: draft } : {})}
      {...(ctx.revertDraft !== undefined ? { onRevert: () => ctx.revertDraft?.(path) } : {})}
      stepKind={stepKind}
      stepKey={`${op.kind}.${path}`}
      {...(info !== undefined ? { info } : {})}
      onCancelGesture={ctx.cancelGesture}
      illustration={<FieldIcon name={icon} />}
      messages={messages}
      {...(placeholder !== undefined ? { placeholder } : {})}
      references={references}
      readOnly={readOnly}
      {...(recommended !== undefined && !readOnly ? { recommended } : {})}
      picking={ctx.pickable && pick?.owner === fieldId}
      {...(table ? { resolver: table.resolver(index) } : {})}
      {...(table && kind === 'length' && ctx.pickable && !readOnly
        ? {
            onPick: (insert: PickInsert) => {
              if (depthTargets !== undefined) return pickDepth(insert)
              setPick({
                owner: fieldId,
                field: label,
                eligible: new Set(choices.map((c) => c.surface)),
                onPick: (surface) => {
                  const c = choices.find((x) => x.surface === surface)
                  if (c) insert(c.id)
                },
              })
            },
            onPickCancel: () => setPick(null),
          }
        : {})}
    />
  )
}

/**
 * `on`: the face the operation starts from – a list of its face targets grouped by direction, or
 * pick it in the viewport (every direction, with a normal glyph; task F1).
 */
export function OnField({ ctx }: { ctx: OperationFieldsContext }): React.JSX.Element | null {
  const pick = useUi((s) => s.pick)
  const setPick = useUi((s) => s.setPick)
  const highlight = useUi((s) => s.setSurfaceHighlight)
  // the highlight lives while the list is open; a field that goes away takes it along
  useEffect(() => () => highlight(null), [highlight])
  const { part, op } = ctx
  if (part.table === undefined) return null
  const choices = onChoices(part.dto, part.table, indexOf(ctx), op.kind)
  const owner = `${op.id}:on`
  const picking = pick?.owner === owner
  const onWarnings = ctx.warnings.filter((w) => w.parameter === 'on')
  // DF118 V3: a construction surface shows a quiet note, unless a cut-away warning replaces it
  const cut = constructionAt(part.dto, ctx.construction, op.id, 'on')
  const consumed = new Set(ctx.construction?.map((c) => c.surface))
  const messages: FieldMessage[] = [
    ...ctx.errors
      .filter((e) => e.path === 'on')
      .map((e, i): FieldMessage => ({ id: `error-${i}`, severity: 'error', text: e.text })),
    ...onWarnings.map((w): FieldMessage => ({
      id: w.code,
      severity: dfmMessages.tier(w),
      text: dfmMessages.text(w, part.units, dfmNames(part.dto)),
    })),
    ...(cut !== undefined && !onWarnings.some((w) => w.code === 'dfm.surfaceCutAway')
      ? [{ id: 'construction', severity: 'note' as const, text: dc.note(cut.by) }]
      : []),
  ]
  return (
    <div className={styles['onRow']}>
      <Field
        label={t.on}
        messages={messages}
        readOnly={ctx.readOnly}
        {...(cut !== undefined ? { info: dc.info } : {})}
      >
        <Select
          options={choices.map((c) => ({
            value: c.id,
            label: consumed.has(c.id) ? `${c.label} ${dc.suffix}` : c.label,
            group: c.group,
          }))}
          value={onOf(op)}
          disabled={ctx.readOnly}
          onValueChange={(on) => commit(ctx, 'on', on)}
          // DF118 follow-up: the highlighted option's surface is highlighted in the viewport
          onHighlight={highlight}
        />
      </Field>
      {ctx.pickable && !ctx.readOnly ? (
        <IconButton
          label={t.pickOn}
          shortcut="Alt+P"
          icon={<Icon name="pick" />}
          pressed={picking}
          className={styles['pickButton']}
          onClick={() =>
            picking
              ? setPick(null)
              : setPick({
                  owner,
                  field: t.on,
                  eligible: new Set(choices.map((c) => c.id)),
                  onPick: (surface) => commit(ctx, 'on', surface),
                })
          }
        />
      ) : null}
    </div>
  )
}
