// The operation's tool field (task F5): a combobox of `design.tool.candidates` (the generalized
// tool auto would pick, then the fitting library tools in auto-choice order with their reasons,
// and the current tool when it is neither), the tool lock (always shown: released = auto), the
// source note ("Chosen by you.", "Chosen automatically: …", "Chosen again on Apply." with the
// value muted) and the checks against the tool (`dfm.toolUnfit`, `dfm.toolNotInLibrary`; soft
// with a clock while Apply may change them). Picking and the lock commit only (one command, one
// undo step each); the auto choice runs on Apply. "New tool…" at the end of the list (and the fix
// "Add to library" of `dfm.toolNotInLibrary`) adds a library tool prefilled from the generalized
// one and locks it (docs/conventions/ui-library-window.md L4).
// Doc: docs/modes/design-v0.2.md#operation-tool, #implementation-task-f5;
// docs/conventions/ui.md#design-and-plan-controls-v02; docs/architecture/apply.md#stale-derived-results
import { Clock } from 'lucide-react'
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
import { Field, FieldIcon, Select, type FieldMessage, type SelectOption } from '../../ui'
import styles from './Design.module.css'
import { pendingApply, quantityAt, type DesignPart } from './model'
import { useCommand } from './useDesign'

const t = designMessages.tool

/** `design.tool.candidates` (src/core/design/tool-commands.ts). */
export interface ToolCandidates {
  readonly fitting: readonly {
    readonly toolLibraryItemId: string
    readonly name: string
    /** mm */
    readonly diameter: number
    readonly reasons: readonly string[]
  }[]
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
    x.cornerRadius.mapOr(-1, (r) => r.canonical) === y.cornerRadius.mapOr(-1, (r) => r.canonical)
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
    default:
      return w.other(from)
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
      { value: NEW_TOOL, label: t.newTool, group: t.groups.add, description: t.newToolNote },
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
    })
  for (const f of candidates?.fitting ?? []) {
    const reasons = f.reasons.filter((r) => !r.startsWith('diameter '))
    options.push({
      value: `${LIB}${f.toolLibraryItemId}`,
      label: t.library(f.name, lengthSource(f.diameter, part.units)),
      group: t.groups.library,
      ...(reasons.length > 0 ? { description: reasons.map(sentenceCase).join(' · ') } : {}),
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
    ...(fits ? {} : { description: t.currentUnfit }),
  })
  return { options, value: CURRENT }
}

/** The generalized tool a new library tool starts from (type, diameter, corner radius; L4). */
function prefill(g: DesignToolDTO | null): ToolPrefill | undefined {
  if (g === null || g.kind !== 'generalized') return undefined
  return {
    type: g.type,
    diameter: g.diameter as ToolPrefill['diameter'],
    ...(g.cornerRadius !== undefined
      ? { cornerRadius: g.cornerRadius as ToolPrefill['diameter'] }
      : {}),
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
  }
}

export function ToolField({
  part,
  op,
  warnings,
}: {
  part: DesignPart
  op: OperationDTO
  /** The operation's DFM warnings (those at `tool` show here). */
  warnings: readonly DfmWarning[]
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
  const first = options.find(
    (o) => o.value !== CURRENT && o.value !== value && o.value !== NEW_TOOL,
  )
  const fix =
    first !== undefined
      ? { label: t.use(first.label), onApply: () => choose(first.value) }
      : locked
        ? { label: t.unlock, onApply: () => void send('design.operation.tool.unlock') }
        : undefined

  const name = (id: string) => part.dto.operations.find((o) => o.id === id)?.name ?? id
  const messages: FieldMessage[] = [
    ...(error === undefined
      ? []
      : [{ id: 'error', severity: 'error' as const, text: sentenceCase(error.message) }]),
    ...warnings
      .filter((w) => w.parameter === 'tool')
      .map((w): FieldMessage => {
        const text = dfmMessages.text(w, part.units, name)
        return pendingApply(w)
          ? {
              id: w.code,
              severity: 'soft',
              icon: <Clock aria-hidden="true" />,
              text: `${text} ${applyMessages.warningPending}`,
            }
          : {
              id: w.code,
              severity: dfmMessages.tier(w),
              text,
              ...(w.code === 'dfm.toolUnfit' && fix !== undefined ? { fix } : {}),
              ...(w.code === 'dfm.toolNotInLibrary'
                ? { fix: { label: t.addToLibrary, onApply: () => setAdding(true) } }
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
        label={t.label}
        illustration={<FieldIcon name="tool" />}
        messages={messages}
        lock={{
          locked,
          name: t.lock,
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
          {waiting ? <Clock aria-hidden="true" /> : null}
          <span>{source}</span>
        </p>
      ) : null}
      <NewToolDialog
        units={part.units}
        operationKind={op.kind}
        prefill={prefill(
          candidates?.generalized ?? (op.tool?.kind === 'generalized' ? op.tool : null),
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
