// The Reference panel's Levels and Section rows (DF60 P1): the flat floors of the reference seen
// from a stock face and its opposite (`design.reference.find { kind: 'levels' }`), the fitted
// section at a depth with its inside corners (`kind: 'section'`), and "Create shape(s)" with
// optional rounding of sharp inside corners (`design.shape.import { from }`). The queries run in
// the compute worker; the rows show the last answer while a new one is read. The face and the
// depth are per-window view state (the depth is the Shape Editor's section depth too). The Holes
// list (P3, `kind: 'holes'`) groups the round holes by size with their pattern and adds a group as
// a Bolt hole or Drillings with Clones in one undo step (one gesture id for its commands). X2: the
// rounded figures carry their 0.001 mm values as tooltips, a hole row says where the holes are, a
// Bolt hole whose mouth is below the face goes on the floor at the mouth, and "Inset from" reads
// how far the section's outline lies inside a shape, with "Create offset" of that shape.
// Doc: docs/conventions/ui.md#reference-tools-df60, docs/modes/reference-tools.md#ui,
// docs/modes/reference-tools.md#ui-reach-of-the-agents-values-x2
import { useEffect, useMemo, useState } from 'react'
import { STOCK_FACE, faceFrame, type Direction } from '../../../../core/geometry/face'
import { setupDirection } from '../../../../core/plan/setups'
import { Quantity } from '../../../../core/quantity/quantity'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type { ReferenceDTO } from '../../../../core/design/reference.dto'
import type { FittedLoop } from '../../../../core/design/reference-section'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { lengthSource as displayLength } from '../../messages/dfm'
import { referenceMessages } from '../../messages/reference'
import { shapeMessages } from '../../messages/shape'
import { useShell, useUi } from '../../shell/ShellContext'
import {
  Button,
  Checkbox,
  ErrorMessage,
  Field,
  Icon,
  QuantityInput,
  SegmentedControl,
  Select,
  InspectorGroup,
} from '../../ui'
import styles from './Design.module.css'
import { defaultUnit, surfaceLabel, type DesignPart } from './model'
import { keepLoop, type ReferenceOverlayState } from './reference-overlay'
import {
  ghostMatrix,
  lengthQuantity,
  lengthSource,
  middleDepth,
  referenceBox,
  referencePlacement,
  sectionMatrix,
  stockSizeOf,
} from './reference-view'
import { useCommand } from './useDesign'
import { ReferenceCompare } from './ReferenceCompare'
import { useShapeList, type ShapeRow } from './useShapes'

const t = referenceMessages.tools

/** A setup of the part's plans, offered in "Read from" (DF60 P2). */
export interface SetupFace {
  readonly id: string
  readonly name: string
  readonly plan: string
  readonly direction: Direction
}

/** The setups of the plans of `part`, in plan then machining order. */
export function partSetups(part: DesignPart): SetupFace[] {
  return Object.values(part.doc.plans ?? {}).flatMap((p) =>
    p.design.partId !== part.dto.id
      ? []
      : p.setups.map((x) => ({
          id: x.id,
          name: x.name,
          plan: p.name,
          direction: setupDirection(x),
        })),
  )
}
const FACES: readonly Direction[] = ['+z', '-z', '-y', '+x', '+y', '-x']
/** A level chosen in the list sets the section this far inside the walls that bound it (mm). */
export const LEVEL_INSET_MM = 0.01

export interface FoundLevel {
  readonly depth: number
  readonly facing: 'face' | 'opposite'
  readonly area: number
  readonly visibleArea: number
  readonly depthFromOpposite?: number
}
interface FoundLevels {
  readonly face: string
  readonly opposite: string
  readonly levels: readonly FoundLevel[]
  readonly more?: number
}
export interface FoundLoop {
  readonly role: 'outer' | 'hole'
  readonly area: number
  readonly bounds: readonly [readonly [number, number], readonly [number, number]]
  readonly elements: number
  readonly circle?: { readonly center: readonly [number, number]; readonly diameter: number }
  readonly corners: { readonly minInsideRadius?: number; readonly sharpCount: number }
  readonly open?: true
}
interface FoundSection {
  readonly loops: readonly FoundLoop[]
  readonly fit: { readonly elements: number; readonly maxDeviation: number }
  readonly more?: number
}

/** A hole group of `design.reference.find { kind: 'holes' }` (reference-commands.ts). */
export interface FoundHoleGroup {
  readonly count: number
  readonly holes: readonly (readonly [number, number])[]
  readonly size: {
    readonly diameter: number
    readonly top: number
    readonly depth: number
    readonly bottom: 'through' | 'flat' | 'cone'
    readonly coneAngle?: number
    readonly mouth?:
      | { readonly type: 'countersink'; readonly diameter: number; readonly angle: number }
      | { readonly type: 'counterbore'; readonly diameter: number; readonly depth: number }
    readonly steps?: readonly { readonly diameter: number; readonly depth: number }[]
  }
  readonly pattern?:
    | {
        readonly kind: 'grid'
        readonly count: readonly [number, number]
        readonly pitch: readonly [number, number]
      }
    | {
        readonly kind: 'circle'
        readonly count: number
        readonly pitchDiameter: number
        readonly center: readonly [number, number]
      }
  readonly suggest: {
    readonly command: string
    readonly args: Record<string, unknown>
    readonly also?: readonly Record<string, unknown>[]
    readonly clones?: { readonly rows: readonly object[] }
    readonly note?: 'belowFace'
  }
  readonly note?: 'noTool'
  readonly smallestTool?: number
}
interface FoundHoles {
  readonly groups: readonly FoundHoleGroup[]
  readonly holeCount: number
  readonly more?: number
}

let gestureCounter = 0
const newGestureId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `holes-gesture-${++gestureCounter}`
const r3 = (v: number) => Math.round(v * 1000) / 1000
const mm = (v: number) => `${r3(v)} mm`
/** A length at full precision (X2-1): 0.001 mm, 0.0001″ (the results' own rounding). */
export const exactLength = (v: number, units: DesignPart['units']): string =>
  units === 'mm' ? `${r3(v)} mm` : `${Math.round((v / 25.4) * 10_000) / 10_000}"`

/**
 * X2-3: how far the section's outline lies inside a shape: the mean gap of the four sides of their
 * bounds (each rounded to 0.001 mm first, as the results give them), positive inside, and the
 * smallest and largest side. X1's arithmetic (exit-criteria.llm-first.fixture.ts).
 */
export function insetOf(
  loop: FoundLoop['bounds'],
  shape: NonNullable<ShapeRow['bounds']>,
): { inset: number; sides: readonly [number, number] } {
  const gaps = [
    loop[0][0] - r3(shape.min[0]),
    loop[0][1] - r3(shape.min[1]),
    r3(shape.max[0]) - loop[1][0],
    r3(shape.max[1]) - loop[1][1],
  ]
  return {
    inset: Math.round((gaps.reduce((a, b) => a + b, 0) / 4) * 1000) / 1000,
    sides: [r3(Math.min(...gaps)), r3(Math.max(...gaps))],
  }
}

type Answer<T> =
  | { readonly key: string; readonly ok: true; readonly value: T }
  | { readonly key: string; readonly ok: false; readonly error: AppErrorData }

/** Runs `design.reference.find` whenever `key` changes; keeps the last answer meanwhile. */
function useFind<T>(key: string | null, args: object): { answer: Answer<T> | null; busy: boolean } {
  const { bridge } = useShell()
  const [answer, setAnswer] = useState<Answer<T> | null>(null)
  useEffect(() => {
    if (key === null) return
    let live = true
    void bridge.call('design.reference.find', args).then((r) => {
      if (!live) return
      setAnswer(r.ok ? { key, ok: true, value: r.value as T } : { key, ok: false, error: r.error })
    })
    return () => {
      live = false
    }
    // args are derived from key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, key])
  return { answer, busy: key !== null && answer?.key !== key }
}

/**
 * The fitted loops of the section for the viewport (DF60): the window's `reference.section` with
 * `fit` (the agent result is a summary, RT-G); the last answer stays while a new one is cut.
 */
function useFittedLoops(
  key: string | null,
  request: { referenceId: string; matrix: number[]; level: number } | null,
): readonly FittedLoop[] | null {
  const { bridge } = useShell()
  const [answer, setAnswer] = useState<readonly FittedLoop[] | null>(null)
  useEffect(() => {
    if (key === null || request === null) return
    let live = true
    void bridge.reference.section({ ...request, fit: true }).then((r) => {
      if (live) setAnswer(r.ok ? (r.loops ?? []) : null)
    })
    return () => {
      live = false
    }
    // the request is derived from key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, key])
  return answer
}

/** The smallest radius of the library's end mills (flat, bull nose, ball), if any. */
function useSmallestEndMillRadius(): number | undefined {
  const { bridge } = useShell()
  const [radius, setRadius] = useState<number | undefined>(undefined)
  useEffect(() => {
    let live = true
    void bridge.call('library.tool.list', {}).then((r) => {
      if (!live || !r.ok) return
      const items = (r.value as { items: { type?: string; diameter?: QuantityDTO }[] }).items
      let best: number | undefined
      for (const it of items) {
        if (it.diameter === undefined || !/EndMill$/.test(it.type ?? '')) continue
        const d = Quantity.fromDTO(it.diameter)
        if (d.isOk() && d.unwrap().canonical > 0)
          best = Math.min(best ?? Infinity, d.unwrap().canonical / 2)
      }
      setRadius(best)
    })
    return () => {
      live = false
    }
  }, [bridge])
  return radius
}

export function ReferenceTools({
  part,
  reference: ref,
}: {
  part: DesignPart
  reference: ReferenceDTO
}): React.JSX.Element {
  const call = useCommand()
  const units = part.units
  // a stock face direction, or `setup:<id>` (a setup of the part's plans, DF60 P2)
  const [choice, setChoice] = useState<string>('+z')
  const setups = useMemo(() => partSetups(part), [part])
  const setup = setups.find((x) => `setup:${x.id}` === choice)
  // a setup reads as its direction's stock face; one that disappeared falls back to Top
  const direction: Direction =
    setup?.direction ?? (FACES.includes(choice as Direction) ? (choice as Direction) : '+z')
  const storedDepth = useUi((s) => s.sectionDepth)
  const setDepth = useUi((s) => s.setSectionDepth)
  const [loops, setLoops] = useState<'all' | 'outer' | 'holes'>('all')
  const [round, setRound] = useState(false)
  const endMill = useSmallestEndMillRadius()
  const [roundRadius, setRoundRadius] = useState<Quantity | undefined>(undefined)
  const [created, setCreated] = useState<{ n: number } | { error: AppErrorData } | null>(null)
  const [insetShape, setInsetShape] = useState<string | undefined>(undefined)
  const [offsetMade, setOffsetMade] = useState<{ name: string } | { error: AppErrorData } | null>(
    null,
  )
  const shapeRows = useShapeList(part)
  const [holesAdded, setHolesAdded] = useState<
    { n: number; bolt: boolean } | { error: AppErrorData } | null
  >(null)
  const stock = stockSizeOf(part)
  const face = STOCK_FACE[direction]
  const setupId = setup?.id
  const faceArg = setupId === undefined ? face : { setupId }
  const box = referenceBox(ref)
  const depth =
    storedDepth ??
    (stock !== undefined && box !== undefined
      ? middleDepth(box, faceFrame(direction, stock), 0)
      : 0)
  // what the reads depend on: the record (placement, asset), the stock and the face
  const base =
    stock === undefined
      ? null
      : JSON.stringify([
          ref.asset.sha256,
          ref.scale,
          ref.rotation,
          ref.position,
          ref.sourceUnit,
          stock,
          face,
          setupId ?? null,
        ])
  const args = { partId: part.dto.id, referenceId: ref.id, face: faceArg }
  const levels = useFind<FoundLevels>(base, { ...args, kind: 'levels' })
  const depthSource = lengthSource(depth, units)
  const section = useFind<FoundSection>(base === null ? null : `${base}|${depthSource}|${loops}`, {
    ...args,
    kind: 'section',
    depth: depthSource,
    loops,
  })
  const holes = useFind<FoundHoles>(base, { ...args, kind: 'holes' })
  const holeGroups = holes.answer?.ok === true ? holes.answer.value.groups : undefined
  // the fitted loops and the hovered level, drawn on the ghost by the viewport (DF60)
  const placement = referencePlacement(ref)
  const sectionKey = base === null ? null : `${base}|${depthSource}`
  const fitted = useFittedLoops(
    sectionKey,
    stock === undefined || placement === undefined
      ? null
      : {
          referenceId: ref.id,
          matrix: sectionMatrix(
            ghostMatrix(ref.asset.bounds, placement),
            faceFrame(direction, stock),
          ),
          level: -depth,
        },
  )
  const [hover, setHover] = useState<ReferenceOverlayState['hover']>(null)
  const setOverlay = useUi((s) => s.setReferenceOverlay)
  useEffect(() => {
    setOverlay({
      referenceId: ref.id,
      direction,
      depth,
      loops: fitted === null ? null : fitted.filter((l) => keepLoop(l, loops)),
      hover,
      ...(holeGroups === undefined || holeGroups.length === 0
        ? {}
        : {
            holes: holeGroups.flatMap((g) =>
              g.holes.map((c) => ({ center: c, diameter: g.size.diameter, top: g.size.top })),
            ),
          }),
    })
  }, [setOverlay, ref.id, direction, depth, fitted, loops, hover, holeGroups])
  useEffect(() => () => setOverlay(null), [setOverlay])
  const radius = roundRadius ?? (endMill !== undefined ? lengthQuantity(endMill, units) : undefined)

  const create = async (split: 'file' | 'loop') => {
    const r = await call('design.shape.import', {
      partId: part.dto.id,
      split,
      from: {
        referenceId: ref.id,
        face: faceArg,
        depth: depthSource,
        loops,
        ...(round && radius !== undefined ? { roundInside: radius.source } : {}),
      },
    })
    setCreated(
      r.ok ? { n: (r.value as { shapeIds: string[] }).shapeIds.length } : { error: r.error },
    )
  }

  /**
   * Adds a hole group as suggested: one command per hole of a list, or the first hole and a Clones
   * of it for a pattern; all with one gesture id, so the click is one undo step.
   */
  const addHoles = async (g: FoundHoleGroup, on?: string) => {
    const gesture = newGestureId()
    const s = g.suggest
    const centres = g.pattern === undefined ? g.holes : g.holes.slice(0, 1)
    const featureIds: string[] = []
    const operationIds: string[] = []
    let n = 0
    for (const c of centres)
      for (const a of [s.args, ...(s.also ?? [])]) {
        const r = await call(
          s.command,
          { partId: part.dto.id, ...a, center: [mm(c[0]), mm(c[1])], ...(on ? { on } : {}) },
          { gesture },
        )
        if (!r.ok) return setHolesAdded({ error: r.error })
        const v = r.value as { featureId?: string; operationId?: string }
        if (v.featureId !== undefined) featureIds.push(v.featureId)
        if (v.operationId !== undefined) operationIds.push(v.operationId)
        if (a === s.args) n++
      }
    if (s.clones !== undefined) {
      const r = await call(
        'design.clones.add',
        {
          partId: part.dto.id,
          source: featureIds[0] !== undefined ? { featureId: featureIds[0] } : { operationIds },
          rows: s.clones.rows,
        },
        { gesture },
      )
      if (!r.ok) return setHolesAdded({ error: r.error })
      n = g.count
    }
    setHolesAdded({ n, bolt: s.command === 'design.hole.add' })
  }

  /**
   * X2-1/X2-9: the floor a Bolt hole whose mouth lies `top` below the face goes on: the first
   * operation floor on this face (facing, pocket or blind profile) at that depth within 0.01 mm.
   */
  const floorAt = (top: number): { id: string; name: string } | undefined => {
    const table = part.table
    if (table === undefined) return undefined
    const e = table
      .before(part.dto.operations.length)
      .find(
        (x) =>
          x.owner >= 0 &&
          x.onTarget &&
          x.direction === direction &&
          x.id.endsWith('.floor') &&
          Math.abs(-x.faceZ.toNumber() - top) <= 0.01,
      )
    return e === undefined ? undefined : { id: e.id, name: surfaceLabel(part.dto, e.id) }
  }

  /** X2-3: "Create offset" of the chosen shape by the inset, a new shape (the Offset dialog's). */
  const makeOffset = async (shape: ShapeRow, inset: number) => {
    const name = shapeMessages.offset.name(shape.name)
    const r = await call('design.shape.add', {
      partId: part.dto.id,
      name,
      items: [
        {
          kind: 'offset',
          shapeId: shape.id,
          distance: exactLength(Math.abs(inset), units),
          direction: inset >= 0 ? 'inward' : 'outward',
        },
      ],
    })
    setOffsetMade(r.ok ? { name } : { error: r.error })
  }

  const faceName = setup?.name ?? t.faces[face] ?? face
  const oppositeName =
    levels.answer?.ok === true ? (t.faces[levels.answer.value.opposite] ?? '') : ''
  const levelRows = (facing: FoundLevel['facing']) => {
    if (levels.answer?.ok !== true) return null
    const rows = levels.answer.value.levels.filter((l) => l.facing === facing)
    return (
      <div className={styles['levelGroup']}>
        <h4 className={styles['levelHeading']}>
          {t.fromFace(facing === 'face' ? faceName : oppositeName)}
        </h4>
        {rows.length === 0 ? (
          <p className={styles['muted']}>{t.noLevels}</p>
        ) : (
          <ul className={styles['levelList']}>
            {rows.map((l) => {
              const shown = facing === 'face' ? l.depth : (l.depthFromOpposite ?? l.depth)
              const undercut = l.visibleArea === 0
              const text = t.level(
                displayLength(shown, units),
                t.area(l.area),
                t.area(l.visibleArea),
              )
              return (
                <li key={`${l.facing}:${l.depth}`}>
                  <button
                    type="button"
                    className={styles['levelRow']}
                    data-undercut={undercut ? '' : undefined}
                    aria-label={undercut ? `${text}. ${t.undercut}` : text}
                    title={
                      undercut
                        ? `${t.exactDepth(exactLength(shown, units))}. ${t.undercut}`
                        : t.exactDepth(exactLength(shown, units))
                    }
                    onPointerEnter={() => setHover({ depth: l.depth, facing: l.facing })}
                    onPointerLeave={() => setHover(null)}
                    onFocus={() => setHover({ depth: l.depth, facing: l.facing })}
                    onBlur={() => setHover(null)}
                    onClick={() =>
                      setDepth(
                        Math.max(
                          0,
                          l.depth + (facing === 'face' ? -LEVEL_INSET_MM : LEVEL_INSET_MM),
                        ),
                      )
                    }
                  >
                    <span className={styles['levelDepth']}>{displayLength(shown, units)}</span>
                    <span className={styles['levelArea']}>{t.area(l.visibleArea)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    )
  }

  const sectionValue = section.answer?.ok === true ? section.answer.value : undefined
  return (
    <>
      <Field label={t.face} kind="toggle">
        <Select
          aria-label={t.face}
          options={[
            ...FACES.map((d) => ({
              value: d as string,
              label: t.faces[STOCK_FACE[d]] ?? d,
              ...(setups.length > 0 ? { group: t.stockGroup } : {}),
            })),
            ...setups.map((x) => ({
              value: `setup:${x.id}`,
              label: t.setupFace(x.name, x.plan),
              group: t.setupsGroup,
            })),
          ]}
          value={setup === undefined ? direction : choice}
          onValueChange={setChoice}
        />
      </Field>

      <InspectorGroup title={t.levels} aria-busy={levels.busy}>
        {levels.answer === null ? (
          <p className={styles['muted']} role="status">
            {t.finding}
          </p>
        ) : levels.answer.ok ? (
          <>
            {levelRows('face')}
            {levelRows('opposite')}
            {levels.answer.value.more ? (
              <p className={styles['muted']}>{t.more(levels.answer.value.more)}</p>
            ) : null}
            <p className={styles['muted']}>{t.levelsHint}</p>
          </>
        ) : (
          <ErrorMessage error={levels.answer.error} message={t.findFailed} />
        )}
      </InspectorGroup>

      <InspectorGroup title={t.section} aria-busy={section.busy}>
        <QuantityInput
          label={t.depth}
          stepKind="depth"
          kind="length"
          defaultUnit={defaultUnit('length', units)}
          value={lengthQuantity(depth, units)}
          onCommit={(q) => setDepth(q.canonical)}
          {...(part.table ? { resolver: part.table.resolver(0) } : {})}
        />
        <Field label={t.loops} kind="toggle">
          <SegmentedControl
            label={t.loops}
            size="sm"
            options={(['all', 'outer', 'holes'] as const).map((v) => ({
              value: v,
              label: t.loopKinds[v] ?? v,
            }))}
            value={loops}
            onValueChange={setLoops}
          />
        </Field>
        {section.answer === null ? (
          <p className={styles['muted']} role="status">
            {t.finding}
          </p>
        ) : !section.answer.ok ? (
          <ErrorMessage error={section.answer.error} message={t.findFailed} />
        ) : sectionValue!.loops.length === 0 ? (
          <p className={styles['muted']}>{t.noLoops}</p>
        ) : (
          <>
            <ul className={styles['loopList']} aria-label={t.loops}>
              {sectionValue!.loops.map((l, i) => (
                <LoopRow key={i} loop={l} units={units} />
              ))}
            </ul>
            <p className={styles['muted']}>
              {t.fit(
                sectionValue!.fit.elements,
                displayLength(sectionValue!.fit.maxDeviation, units),
              )}
            </p>
          </>
        )}
        <InsetFrom
          shapes={shapeRows}
          value={insetShape}
          onValueChange={(id) => {
            setInsetShape(id)
            setOffsetMade(null)
          }}
          loops={sectionValue?.loops}
          units={units}
          onOffset={(shape, inset) => void makeOffset(shape, inset)}
        />
        {offsetMade === null ? null : 'name' in offsetMade ? (
          <p className={styles['muted']} role="status">
            {t.offsetMade(offsetMade.name)}
          </p>
        ) : (
          <ErrorMessage error={offsetMade.error} message={t.offsetFailed} />
        )}
        <Checkbox
          label={t.roundInside}
          checked={round}
          onCheckedChange={(c) => setRound(c === true)}
        />
        {round ? (
          <QuantityInput
            label={t.roundInside}
            stepKind="small"
            kind="length"
            defaultUnit={defaultUnit('length', units)}
            value={radius}
            onCommit={(q) => setRoundRadius(q)}
            info={t.roundHint}
          />
        ) : null}
        <div className={styles['setupActions']}>
          <Button
            size="sm"
            icon={<Icon name="shapes" />}
            disabled={!sectionValue || sectionValue.loops.length === 0}
            onClick={() => void create('file')}
          >
            {t.createShape}
          </Button>
          <Button
            size="sm"
            disabled={!sectionValue || sectionValue.loops.length === 0}
            onClick={() => void create('loop')}
          >
            {t.createShapes}
          </Button>
        </div>
        {created === null ? null : 'n' in created ? (
          <p className={styles['muted']} role="status">
            {t.created(created.n)}
          </p>
        ) : (
          <ErrorMessage error={created.error} message={t.createFailed} />
        )}
      </InspectorGroup>

      <InspectorGroup title={t.holes} aria-busy={holes.busy}>
        {holes.answer === null ? (
          <p className={styles['muted']} role="status">
            {t.finding}
          </p>
        ) : !holes.answer.ok ? (
          <ErrorMessage error={holes.answer.error} message={t.findFailed} />
        ) : holes.answer.value.groups.length === 0 ? (
          <p className={styles['muted']}>{t.noHoles}</p>
        ) : (
          <>
            <ul className={styles['holeList']} aria-label={t.holes}>
              {holes.answer.value.groups.map((g, i) => (
                <HoleRow
                  key={i}
                  group={g}
                  units={units}
                  faceName={faceName}
                  direction={direction}
                  floor={g.suggest.note === 'belowFace' ? floorAt(g.size.top) : undefined}
                  onAdd={(on) => void addHoles(g, on)}
                />
              ))}
            </ul>
            {holes.answer.value.more ? (
              <p className={styles['muted']}>{t.holesMore(holes.answer.value.more)}</p>
            ) : null}
            <p className={styles['muted']}>{t.holesHint}</p>
          </>
        )}
        {holesAdded === null ? null : 'n' in holesAdded ? (
          <p className={styles['muted']} role="status">
            {t.added(holesAdded.n, holesAdded.bolt)}
          </p>
        ) : (
          <ErrorMessage error={holesAdded.error} message={t.addFailed} />
        )}
      </InspectorGroup>

      <ReferenceCompare part={part} reference={ref} />
    </>
  )
}

function LoopRow({ loop: l, units }: { loop: FoundLoop; units: DesignPart['units'] }) {
  const size = l.circle
    ? t.circle(displayLength(l.circle.diameter, units))
    : `${displayLength(l.bounds[1][0] - l.bounds[0][0], units)} × ${displayLength(l.bounds[1][1] - l.bounds[0][1], units)}`
  const r = l.corners.minInsideRadius
  const name = l.circle ? size : t.loop(l.role, size)
  const E = (v: number) => exactLength(v, units)
  const exact = l.circle
    ? t.circle(E(l.circle.diameter))
    : t.loop(
        l.role,
        `${E(l.bounds[1][0] - l.bounds[0][0])} × ${E(l.bounds[1][1] - l.bounds[0][1])}`,
      )
  return (
    <li className={styles['loopRow']}>
      <span className={styles['loopName']} title={exact}>
        {name}
      </span>
      <span className={styles['loopCorners']} role="group" aria-label={t.corners}>
        {l.corners.sharpCount > 0 ? (
          <span className={styles['cornerChip']} data-sharp="">
            {t.sharpChip(l.corners.sharpCount)}
          </span>
        ) : null}
        {r !== undefined ? (
          <span className={styles['cornerChip']}>{t.radiusChip(displayLength(r, units))}</span>
        ) : null}
        {r === undefined && l.corners.sharpCount === 0 ? (
          <span className={styles['muted']}>{t.noInsideCorners}</span>
        ) : null}
      </span>
    </li>
  )
}

/** The text of a hole group: count, diameter, mouth, bottom and pattern. */
export function holeGroupText(
  g: FoundHoleGroup,
  units: DesignPart['units'],
  exact = false,
): string {
  const L = (v: number) => (exact ? exactLength(v, units) : displayLength(v, units))
  const deg = (a: number) => `${exact ? Math.round(a * 10) / 10 : Math.round(a)}°`
  const m = g.size.mouth
  const s = g.size
  return t.holeGroup({
    count: g.count,
    diameter: L(s.diameter),
    ...(m !== undefined
      ? {
          mouth:
            m.type === 'countersink'
              ? t.countersunk(L(m.diameter), deg(m.angle))
              : t.counterbored(L(m.diameter), L(m.depth - s.top)),
        }
      : s.steps !== undefined
        ? { mouth: t.stepped(s.steps.length) }
        : {}),
    bottom:
      s.bottom === 'through'
        ? t.through
        : s.bottom === 'cone'
          ? t.pointed(L(s.depth - s.top), deg(s.coneAngle ?? 118))
          : t.deep(L(s.depth - s.top)),
    ...(g.pattern === undefined
      ? {}
      : {
          pattern:
            g.pattern.kind === 'grid'
              ? t.grid(g.pattern.count[0], g.pattern.count[1])
              : t.boltCircle(g.pattern.count, L(g.pattern.pitchDiameter)),
        }),
  })
}

/** X2-1: where a group's holes are, in the face frame at 0.001 mm (X/Y on the top). */
export function holePositionsText(
  g: FoundHoleGroup,
  units: DesignPart['units'],
  direction: Direction,
): string {
  const E = (v: number) => exactLength(v, units)
  const [u, v] = direction === '+z' ? ['X', 'Y'] : ['u', 'v']
  const at = (c: readonly [number, number]) => `${u} ${E(c[0])} ${v} ${E(c[1])}`
  const first = g.holes[0]
  const p = g.pattern
  if (p?.kind === 'grid' && first !== undefined)
    return t.gridAt(at(first), `${E(p.pitch[0])} × ${E(p.pitch[1])}`)
  if (p?.kind === 'circle') return t.circleAt(at(p.center), E(p.pitchDiameter))
  const shown = g.holes.slice(0, 4).map(at)
  return t.holesAt(shown, g.holes.length - shown.length)
}

function HoleRow({
  group: g,
  units,
  faceName,
  direction,
  floor,
  onAdd,
}: {
  group: FoundHoleGroup
  units: DesignPart['units']
  faceName: string
  direction: Direction
  /** The floor a `belowFace` Bolt hole goes on (X2-1), if the part has it. */
  floor: { id: string; name: string } | undefined
  onAdd: (on?: string) => void
}) {
  const text = holeGroupText(g, units)
  const bolt = g.suggest.command === 'design.hole.add'
  const below = g.suggest.note === 'belowFace'
  const blocked = below && floor === undefined
  const reason = blocked ? t.belowFace(displayLength(g.size.top, units), faceName) : undefined
  const label =
    below && floor !== undefined
      ? t.addBoltHoleOn(floor.name)
      : bolt
        ? t.addBoltHole
        : t.addDrilling
  return (
    <li className={styles['holeRow']}>
      <span title={holeGroupText(g, units, true)}>{text}</span>
      <span className={styles['holeActions']}>
        {g.note === 'noTool' && g.smallestTool !== undefined ? (
          <span className={styles['cornerChip']} data-sharp="">
            {t.noToolChip(displayLength(g.smallestTool, units))}
          </span>
        ) : null}
        <Button
          size="sm"
          icon={
            <Icon
              name={
                !bolt
                  ? 'drilling'
                  : g.size.mouth?.type === 'countersink'
                    ? 'hole-countersink'
                    : g.size.mouth?.type === 'counterbore'
                      ? 'hole-counterbore'
                      : 'hole-simple'
              }
            />
          }
          disabled={blocked}
          title={reason}
          aria-label={`${label}: ${text}`}
          onClick={() => onAdd(below ? floor?.id : undefined)}
        >
          {label}
        </Button>
      </span>
      <span className={styles['holeWhere']}>{holePositionsText(g, units, direction)}</span>
      {reason !== undefined ? <span className={styles['muted']}>{reason}</span> : null}
    </li>
  )
}

/**
 * X2-3 "Inset from": a shape chosen here, the section's largest outline read against its bounds
 * (both in the face frame), and "Create offset" of the shape by that inset.
 */
function InsetFrom({
  shapes,
  value,
  onValueChange,
  loops,
  units,
  onOffset,
}: {
  shapes: readonly ShapeRow[]
  value: string | undefined
  onValueChange: (id: string) => void
  loops: readonly FoundLoop[] | undefined
  units: DesignPart['units']
  onOffset: (shape: ShapeRow, inset: number) => void
}): React.JSX.Element | null {
  const closed = shapes.filter((r) => r.kind === 'region' && r.bounds !== undefined)
  if (closed.length === 0) return null
  const shape = closed.find((r) => r.id === value)
  const outline = (loops ?? [])
    .filter((l) => l.role === 'outer' && l.open !== true)
    .reduce<FoundLoop | undefined>(
      (a, l) => (a === undefined || l.area > a.area ? l : a),
      undefined,
    )
  const measured = shape && outline ? insetOf(outline.bounds, shape.bounds!) : undefined
  const num = (v: number) => displayLength(v, units).replace(/ mm$|"$/, '')
  return (
    <>
      <Field label={t.insetFrom} kind="toggle" info={t.insetHint}>
        <Select
          aria-label={t.insetFrom}
          placeholder={t.insetChoose}
          options={closed.map((r) => ({ value: r.id, label: r.name }))}
          {...(shape === undefined ? {} : { value: shape.id })}
          onValueChange={onValueChange}
        />
      </Field>
      {shape === undefined ? null : measured === undefined ? (
        <p className={styles['muted']}>{t.noOutline}</p>
      ) : (
        <div className={styles['insetRow']}>
          <span role="status" className={styles['insetValue']}>
            {t.inset(
              exactLength(Math.abs(measured.inset), units),
              measured.inset >= 0,
              shape.name,
              num(measured.sides[0]),
              displayLength(measured.sides[1], units),
            )}
          </span>
          {measured.inset === 0 ? null : (
            <Button
              size="sm"
              icon={<Icon name="kind-offset" />}
              onClick={() => onOffset(shape, measured.inset)}
            >
              {t.createOffset}
            </Button>
          )}
        </div>
      )}
    </>
  )
}
