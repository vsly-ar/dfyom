// The operation's tool field (task F5): a combobox of `design.tool.candidates` (the generalized
// tool auto would pick, then the fitting library tools in auto-choice order with their reasons,
// then the library's other tools of the type with why they don't fit (DF42), and the current tool
// when it is none of them), the near match offered at `dfm.toolNotInLibrary` and "Widen slot"
// at a locked tool wider than a profile's slot (DF42, design-v0.2.md § Library tools of the type), the tool lock (always shown: released = auto), the
// source note ("Chosen by you.", "Chosen automatically: …", "Chosen again on Apply." with the
// value muted) and the checks against the tool (`dfm.toolUnfit`, `dfm.toolNotInLibrary`; soft
// with a clock while Apply may change them). Picking and the lock commit only (one command, one
// undo step each); the auto choice runs on Apply. "New tool…" at the end of the list (and the fix
// "Add to library" of `dfm.toolNotInLibrary`) adds a library tool prefilled from the generalized
// one and locks it (docs/conventions/ui-library-window.md L4).
// Doc: docs/modes/design-v0.2.md#operation-tool, #implementation-task-f5;
// docs/conventions/ui.md#design-and-plan-controls-v02; docs/architecture/apply.md#stale-derived-results
import { useEffect, useId, useState } from 'react'
import type { DesignToolDTO, OperationDTO, PartDTO } from '../../../../core/design/part.dto'
import { designChangeTargets } from '../../../../core/design/shape-users'
import { designToolFromDTO, generalizedLabel } from '../../../../core/design/tool'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { UnitSystem } from '../../../../core/project/document'
import { isExpression } from '../../../../core/design/anchor'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { ToolPrefill } from '../../library/form'
import { NewToolDialog } from '../../library/NewToolDialog'
import { applyMessages } from '../../messages/apply'
import { designMessages } from '../../messages/design'
import { dfmMessages, lengthSource } from '../../messages/dfm'
import { libraryMessages } from '../../messages/library'
import { useLibraryVersion, usePending, useReplica, useShell } from '../../shell/ShellContext'
import type { PendingChangeView, ToolChangeView } from '../../state/pending'
import { toolChangeKey } from '../../state/pending'
import type { ToolType } from '../../../../core/library/tool.dto'
import { TOOL_TYPE_ICON } from '../../library/toolTypeIcon'
import { Field, FieldIcon, Icon, Select, type FieldMessage, type SelectOption } from '../../ui'
import { chamferDiameter } from './chamfer-view'
import styles from './Design.module.css'
import { dfmNames, pendingApply, quantityAt, type DesignPart } from './model'
import { useCommand } from './useDesign'

const t = designMessages.tool

/** A library tool of `design.tool.candidates`. */
interface LibraryToolEntry {
  readonly toolLibraryItemId: string
  readonly name: string
  readonly type: ToolType
  /** mm */
  readonly diameter: number
  /** mm, bull nose only */
  readonly cornerRadius?: number
  readonly fluteCount: number
}

/** `design.tool.candidates` (src/core/design/tool-commands.ts). */
export interface ToolCandidates {
  readonly fitting: readonly (LibraryToolEntry & { readonly reasons: readonly string[] })[]
  /** Library tools of a type that can make the operation but failing another fit rule (DF42). */
  readonly unfitting?: readonly (LibraryToolEntry & { readonly rule: string })[]
  /** The library tool offered for a generalized tool the library lacks (DF42). */
  readonly nearMatch?: string | null
  readonly generalized: DesignToolDTO | null
  readonly current: {
    readonly tool: DesignToolDTO
    readonly locked: boolean
    readonly fits: boolean
    readonly rule?: string
    readonly detail?: string
  } | null
}

const GENERALIZED = 'generalized'
const CURRENT = 'current'
const LIB = 'lib:'
/** The list's last item: "New tool…" (ui-library-window.md L4). */
export const NEW_TOOL = 'new-tool'

/** "6 mm flat end mill", or the library tool's name (its snapshot), or undefined. */
export function toolLabel(tool: DesignToolDTO, doc: DesignPart['doc']): string | undefined {
  if (tool.kind === 'specific') {
    const snap = Object.hasOwn(doc.snapshots, tool.snapshotId)
      ? doc.snapshots[tool.snapshotId]
      : undefined
    const name = (snap?.values as { name?: unknown } | undefined)?.name
    return typeof name === 'string' ? name : undefined
  }
  const g = designToolFromDTO(tool)
  return g.isOk() && g.unwrap().kind === 'generalized'
    ? generalizedLabel(g.unwrap() as Parameters<typeof generalizedLabel>[0])
    : undefined
}

/** The tool's type: the generalized tool's, or the library tool's (its snapshot). */
export function toolType(tool: DesignToolDTO, doc: DesignPart['doc']): ToolType | undefined {
  if (tool.kind === 'generalized') return tool.type
  const snap = Object.hasOwn(doc.snapshots, tool.snapshotId)
    ? doc.snapshots[tool.snapshotId]
    : undefined
  const type = (snap?.values as { type?: unknown } | undefined)?.type
  return typeof type === 'string' && Object.hasOwn(TOOL_TYPE_ICON, type)
    ? (type as ToolType)
    : undefined
}

/** The tool type's icon at the picker's size (20 px, B22-4), beside the tool's name. */
function typeIcon(type: ToolType | undefined): { icon?: React.ReactNode } {
  return type === undefined ? {} : { icon: <Icon name={TOOL_TYPE_ICON[type]} size="lg" /> }
}

/** Whether two tool field values name the same tool (generalized by value). */
export function sameTool(
  a: DesignToolDTO | undefined | null,
  b: DesignToolDTO | undefined | null,
): boolean {
  if (a == null || b == null) return false
  if (a.kind === 'specific' || b.kind === 'specific')
    return a.kind === 'specific' && b.kind === 'specific' && a.snapshotId === b.snapshotId
  const ga = designToolFromDTO(a)
  const gb = designToolFromDTO(b)
  if (ga.isErr() || gb.isErr()) return false
  const x = ga.unwrap()
  const y = gb.unwrap()
  if (x.kind !== 'generalized' || y.kind !== 'generalized') return false
  return (
    x.type === y.type &&
    x.diameter.exact.equals(y.diameter.exact) &&
    x.cornerRadius.mapOr(-1, (r) => r.canonical) === y.cornerRadius.mapOr(-1, (r) => r.canonical) &&
    x.angle.mapOr(-1, (a) => a.canonical) === y.angle.mapOr(-1, (a) => a.canonical)
  )
}

/**
 * Whether the operation has changes waiting for Apply: its own, its part's stock, a new part, or
 * a named shape it uses (core `designChangeTargets`).
 */
export function operationPending(
  changes: readonly PendingChangeView[],
  part: PartDTO,
  operationId: string,
): boolean {
  return changes.some(
    (c) =>
      c.kind === 'design' &&
      c.partId === part.id &&
      designChangeTargets(part, c).includes(operationId),
  )
}

/** A length parameter of the operation in the project units, undefined for a formula or none. */
function lengthAt(op: OperationDTO, path: string, units: UnitSystem): string | undefined {
  const q = quantityAt(op, path)
  if (q === undefined || isExpression(q) || !Number.isFinite(q.canonical)) return undefined
  return lengthSource(q.canonical, units)
}

/**
 * Why the auto choice replaced the tool ("the 6 mm flat end mill didn't fit the 2 mm corner"),
 * from the old tool's failed fit rule and the operation's current values; undefined for a first
 * choice (nothing was replaced).
 */
export function autoChangeReason(
  change: ToolChangeView,
  op: OperationDTO,
  units: UnitSystem,
  doc: DesignPart['doc'],
): string | undefined {
  if (change.from === null || change.reason === 'unset') return undefined
  const w = t.why
  if (change.reason === 'unresolved') return w.unresolved
  const from =
    change.from.kind === 'specific'
      ? (change.fromName ?? toolLabel(change.from, doc) ?? t.previousTool)
      : (toolLabel(change.from, doc) ?? t.previousTool)
  switch (change.reason) {
    case 'cornerRadius':
      return w.cornerRadius(from, lengthAt(op, 'shape.cornerRadius', units))
    case 'width':
      return op.kind === 'profile' ? w.slot(from, lengthAt(op, 'slotWidth', units)) : w.pocket(from)
    case 'floorRadius': {
      const q = quantityAt(op, 'floorRadius')
      return w.floorRadius(
        from,
        q !== undefined && q.canonical > 0 ? lengthAt(op, 'floorRadius', units) : undefined,
      )
    }
    case 'diameter':
      return w.diameter(from, lengthAt(op, 'diameter', units))
    case 'type':
      return w.type(from, designMessages.kinds[op.kind].toLowerCase())
    case 'reach':
      return w.reach(from)
    case 'libraryFits':
      return w.libraryFits(from)
    default:
      return w.other(from)
  }
}

/**
 * Why a listed library tool does not fit the operation ("wider than the 6 mm slot"), from its
 * failed fit rule and the operation's current values (DF42).
 */
export function unfitWhy(rule: string, op: OperationDTO, units: UnitSystem): string {
  const w = t.unfitWhy
  switch (rule) {
    case 'width':
      return op.kind === 'profile' ? w.slot(lengthAt(op, 'slotWidth', units)) : w.pocket
    case 'cornerRadius':
      return w.cornerRadius(lengthAt(op, 'shape.cornerRadius', units))
    case 'floorRadius': {
      const q = quantityAt(op, 'floorRadius')
      return w.floorRadius(
        q !== undefined && q.canonical > 0 ? lengthAt(op, 'floorRadius', units) : undefined,
      )
    }
    case 'diameter':
      return w.diameter(lengthAt(op, 'diameter', units))
    case 'reach':
      return w.reach
    case 'angle':
      return w.angle
    default:
      return w.other
  }
}

/**
 * The operation's candidates, re-read on every revision and pending change, and by `reread()`
 * when the list opens (the library can change without either).
 */
function useCandidates(
  partId: string,
  operationId: string,
): [ToolCandidates | undefined, () => void] {
  const { bridge } = useShell()
  const replica = useReplica()
  const revision = replica.status === 'open' ? replica.revision : -1
  const version = usePending().version
  const [asked, setAsked] = useState(0)
  const library = useLibraryVersion()
  const [value, setValue] = useState<ToolCandidates | undefined>(undefined)
  useEffect(() => {
    let live = true
    void bridge.call('design.tool.candidates', { partId, operationId }).then((r) => {
      if (live && r.ok) setValue(r.value as ToolCandidates)
    })
    return () => {
      live = false
    }
  }, [bridge, partId, operationId, revision, version, asked, library])
  return [value, () => setAsked((n) => n + 1)]
}

/** The combobox options and the value the current tool is shown as. */
export function toolOptions(
  candidates: ToolCandidates | undefined,
  op: OperationDTO,
  part: Pick<DesignPart, 'doc' | 'units'>,
): { options: SelectOption<string>[]; value: string | undefined } {
  const r = listedOptions(candidates, op, part)
  return {
    ...r,
    options: [
      ...r.options,
      {
        value: NEW_TOOL,
        label: t.newTool,
        group: t.groups.add,
        description: t.newToolNote,
        icon: <Icon name="add" size="lg" />,
      },
    ],
  }
}

function listedOptions(
  candidates: ToolCandidates | undefined,
  op: OperationDTO,
  part: Pick<DesignPart, 'doc' | 'units'>,
): { options: SelectOption<string>[]; value: string | undefined } {
  const options: SelectOption<string>[] = []
  const g = candidates?.generalized ?? null
  if (g !== null)
    options.push({
      value: GENERALIZED,
      label: toolLabel(g, part.doc) ?? designMessages.tool.previousTool,
      group: t.groups.generalized,
      description: t.generalizedNote,
      ...typeIcon(toolType(g, part.doc)),
    })
  // DF42: every library tool of a type that can make the operation; the fitting ones first (in
  // auto-choice order), then the others nearest in diameter first, saying what does not fit
  const geometry = (f: LibraryToolEntry) => [
    ...(f.cornerRadius !== undefined
      ? [t.cornerRadius(lengthSource(f.cornerRadius, part.units))]
      : []),
    t.flutes(f.fluteCount),
  ]
  for (const f of candidates?.fitting ?? []) {
    // the diameter is in the label; the reach reason (DF55, in mm) is for agents' ranking
    const reasons = f.reasons
      .filter((r) => !/^(diameter|stickout|flute length) /.test(r))
      .map(sentenceCase)
    options.push({
      value: `${LIB}${f.toolLibraryItemId}`,
      label: t.library(f.name, lengthSource(f.diameter, part.units)),
      group: t.groups.library,
      ...typeIcon(f.type),
      description: [...geometry(f), ...reasons].join(' · '),
    })
  }
  for (const f of candidates?.unfitting ?? []) {
    options.push({
      value: `${LIB}${f.toolLibraryItemId}`,
      label: t.library(f.name, lengthSource(f.diameter, part.units)),
      group: t.groups.library,
      ...typeIcon(f.type),
      description: [...geometry(f), t.unfit(unfitWhy(f.rule, op, part.units))].join(' · '),
    })
  }
  const current = op.tool
  if (current === undefined) return { options, value: undefined }
  if (sameTool(current, g)) return { options, value: GENERALIZED }
  if (current.kind === 'specific') {
    const snap = part.doc.snapshots[current.snapshotId]
    const id = snap?.libraryItemId
    if (id !== undefined && options.some((o) => o.value === `${LIB}${id}`))
      return { options, value: `${LIB}${id}` }
  }
  const fits = candidates?.current?.fits ?? true
  options.push({
    value: CURRENT,
    label: t.current(toolLabel(current, part.doc) ?? t.previousTool),
    group: t.groups.current,
    ...typeIcon(toolType(current, part.doc)),
    ...(fits ? {} : { description: t.currentUnfit }),
  })
  return { options, value: CURRENT }
}

/**
 * The generalized tool a new library tool starts from (type, diameter, corner radius, a chamfer
 * mill's angle; L4). A chamfer without one: a chamfer mill of its angle and diameter (U4).
 */
export function prefill(
  g: DesignToolDTO | null,
  op?: OperationDTO,
  part?: Pick<DesignPart, 'dto' | 'units'>,
): ToolPrefill | undefined {
  if (g === null || g.kind !== 'generalized') {
    if (op?.kind !== 'chamfer' || part === undefined) return undefined
    // D45: the chamfer's diameter at the face, derived from its edge and width
    const diameter = chamferDiameter(part.dto, op, part.units)
    if (diameter === undefined) return undefined
    return {
      type: 'chamferMill',
      diameter: diameter.toDTO() as ToolPrefill['diameter'],
      angle: op.angle as NonNullable<ToolPrefill['angle']>,
    }
  }
  return {
    type: g.type,
    diameter: g.diameter as ToolPrefill['diameter'],
    ...(g.cornerRadius !== undefined
      ? { cornerRadius: g.cornerRadius as ToolPrefill['diameter'] }
      : {}),
    ...(g.angle !== undefined ? { angle: g.angle as NonNullable<ToolPrefill['angle']> } : {}),
  }
}

const sentenceCase = (s: string) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1))

/** The `tool` arg of `design.operation.tool.set` for a chosen option. */
function toolArg(value: string, candidates: ToolCandidates | undefined): object | undefined {
  if (value.startsWith(LIB)) return { kind: 'specific', toolLibraryItemId: value.slice(LIB.length) }
  const g = candidates?.generalized
  if (value !== GENERALIZED || g == null || g.kind !== 'generalized') return undefined
  return {
    kind: 'generalized',
    type: g.type,
    diameter: g.diameter.source,
    ...(g.cornerRadius !== undefined ? { cornerRadius: g.cornerRadius.source } : {}),
    ...(g.angle !== undefined ? { angle: g.angle.source } : {}),
  }
}

export function ToolField({
  part,
  op,
  warnings,
  label = t.label,
}: {
  part: DesignPart
  op: OperationDTO
  /** The operation's DFM warnings (those at `tool` show here). */
  warnings: readonly DfmWarning[]
  /** The field's label; the hole inspector's Tools group names the role ("Counterbore"). */
  label?: string
}): React.JSX.Element {
  const call = useCommand()
  const pending = usePending()
  const [candidates, reread] = useCandidates(part.dto.id, op.id)
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const sourceId = useId()
  const partId = part.dto.id
  const locked = op.toolLocked === true
  const waiting = !locked && operationPending(pending.changes, part.dto, op.id)
  const { options, value } = toolOptions(candidates, op, part)
  const currentType = op.tool === undefined ? undefined : toolType(op.tool, part.doc)

  const send = async (name: string, args: object = {}) => {
    const r = await call(name, { partId, operationId: op.id, ...args })
    setError(r.ok ? undefined : r.error)
  }
  const [adding, setAdding] = useState(false)
  const choose = (v: string) => {
    if (v === NEW_TOOL) return setAdding(true)
    if (v === value || v === CURRENT) return
    const tool = toolArg(v, candidates)
    if (tool !== undefined) void send('design.operation.tool.set', { tool })
  }

  // the fix of a tool check: the first fitting tool (it locks), else "Unlock"
  const unfitting = new Set(
    (candidates?.unfitting ?? []).map((u) => `${LIB}${u.toolLibraryItemId}`),
  )
  const first = options.find(
    (o) =>
      o.value !== CURRENT && o.value !== value && o.value !== NEW_TOOL && !unfitting.has(o.value),
  )
  const fix =
    first !== undefined
      ? { label: t.use(first.label), onApply: () => choose(first.value) }
      : locked
        ? { label: t.unlock, onApply: () => void send('design.operation.tool.unlock') }
        : undefined
  // DF42: a locked tool wider than the profile's slot: widening the slot to it is the user's
  // explicit choice (the slot is as wide as it is designed; nothing widens it automatically)
  const widen = (w: DfmWarning) => {
    const dc = w.params?.['toolDiameter']
    if (
      !locked ||
      op.kind !== 'profile' ||
      op.featureId !== undefined ||
      w.params?.['rule'] !== 'width' ||
      typeof dc !== 'number'
    )
      return undefined
    const width = lengthSource(dc, part.units, 'up')
    return {
      label: t.widenSlot(width),
      onApply: () => void send('design.profile.update', { slotWidth: width }),
    }
  }
  // DF42: the library's tool offered for the generalized tool it lacks
  const nearId = candidates?.nearMatch ?? null
  const near =
    nearId === null
      ? undefined
      : [...(candidates?.fitting ?? []), ...(candidates?.unfitting ?? [])].find(
          (f) => f.toolLibraryItemId === nearId,
        )
  const addToLibrary = {
    label: t.addToLibrary,
    icon: <Icon name="add" />,
    onApply: () => setAdding(true),
  }

  const messages: FieldMessage[] = [
    ...(error === undefined
      ? []
      : [{ id: 'error', severity: 'error' as const, text: sentenceCase(error.message) }]),
    ...warnings
      // v0.4 U4: no library tool fits the chamfer – shown here, its fix is "New tool…"
      .filter((w) => w.parameter === 'tool' || w.code === 'dfm.chamferNoTool')
      .map((w): FieldMessage => {
        const text = dfmMessages.text(w, part.units, dfmNames(part.dto))
        return pendingApply(w)
          ? {
              id: w.code,
              severity: 'soft',
              icon: <Icon name="clock" />,
              text: `${text} ${applyMessages.warningPending}`,
            }
          : {
              id: w.code,
              severity: dfmMessages.tier(w),
              text,
              ...(w.code === 'dfm.toolUnfit'
                ? (() => {
                    const wider = widen(w)
                    if (wider === undefined) return fix !== undefined ? { fix } : {}
                    return { fix: wider, ...(fix !== undefined ? { alternative: fix } : {}) }
                  })()
                : {}),
              ...(w.code === 'dfm.chamferNoTool' || w.code === 'dfm.noFittingTool'
                ? {
                    fix: {
                      label: t.newTool,
                      icon: <Icon name="add" />,
                      onApply: () => setAdding(true),
                    },
                  }
                : {}),
              ...(w.code === 'dfm.toolNotInLibrary'
                ? near === undefined
                  ? { fix: addToLibrary }
                  : {
                      fix: {
                        label: t.useNear(near.name, lengthSource(near.diameter, part.units)),
                        onApply: () => choose(`${LIB}${near.toolLibraryItemId}`),
                      },
                      alternative: addToLibrary,
                    }
                : {}),
            }
      }),
  ]

  // the source line stays visible under the field (not folded into the support area's "n more")
  function sourceNote(): string | undefined {
    if (locked) return t.chosenByYou
    if (op.tool === undefined) return undefined // the lock's reason says it
    if (waiting) return t.chosenAgain
    const change = pending.toolChanges.get(toolChangeKey(partId, op.id))
    const why =
      change !== undefined && sameTool(change.to, op.tool)
        ? autoChangeReason(change, op, part.units, part.doc)
        : undefined
    return why === undefined ? t.chosenAuto : t.chosenAutoBecause(why)
  }

  const source = sourceNote()
  return (
    <div className={styles['toolField']}>
      <Field
        label={label}
        illustration={<FieldIcon name="tool" />}
        messages={messages}
        lock={{
          locked,
          name: label === t.label ? t.lock : t.lockOf(label),
          disabledReason: !locked && op.tool === undefined ? t.lockNoTool : undefined,
          onLockedChange: (l) =>
            void send(l ? 'design.operation.tool.lock' : 'design.operation.tool.unlock'),
        }}
      >
        <Select
          options={options}
          value={value ?? ''}
          placeholder={
            candidates !== undefined && options.length === 1 ? t.noChoice : t.placeholder
          }
          muted={waiting}
          {...(currentType === undefined
            ? {}
            : { valueIcon: <Icon name={TOOL_TYPE_ICON[currentType]} /> })}
          onValueChange={choose}
          onOpenChange={(open) => {
            if (open) reread()
          }}
          {...(source === undefined ? {} : { 'aria-describedby': sourceId })}
        />
      </Field>
      {source !== undefined ? (
        // keyed by its text: a new reason slides in (--motion-base; none with reduced motion)
        <p
          key={source}
          id={sourceId}
          className={styles['toolSource']}
          data-waiting={waiting || undefined}
        >
          {waiting ? <Icon name="clock" /> : null}
          <span>{source}</span>
        </p>
      ) : null}
      <NewToolDialog
        units={part.units}
        operationKind={op.kind}
        prefill={prefill(
          candidates?.generalized ?? (op.tool?.kind === 'generalized' ? op.tool : null),
          op,
          part,
        )}
        description={libraryMessages.tool.designDescription}
        trigger={null}
        open={adding}
        onOpenChange={setAdding}
        onAdded={async (id) => {
          const r = await call('design.operation.tool.set', {
            partId,
            operationId: op.id,
            tool: { kind: 'specific', toolLibraryItemId: id },
          })
          if (r.ok) setError(undefined)
          return r.ok ? undefined : r.error
        }}
      />
    </div>
  )
}
