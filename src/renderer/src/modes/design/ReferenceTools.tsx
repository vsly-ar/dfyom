// The Reference panel's Levels and Section rows (DF60 P1): the flat floors of the reference seen
// from a stock face and its opposite (`design.reference.find { kind: 'levels' }`), the fitted
// section at a depth with its inside corners (`kind: 'section'`), and "Create shape(s)" with
// optional rounding of sharp inside corners (`design.shape.import { from }`). The queries run in
// the compute worker; the rows show the last answer while a new one is read. The face and the
// depth are per-window view state (the depth is the Shape Editor's section depth too). The Holes
// list (P3, `kind: 'holes'`) groups the round holes by size with their pattern and adds a group as
// a Bolt hole or Drillings with Clones in one undo step (one gesture id for its commands).
// Doc: docs/conventions/ui.md#reference-tools-df60, docs/modes/reference-tools.md#ui
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
} from '../../ui'
import styles from './Design.module.css'
import { defaultUnit, type DesignPart } from './model'
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
    | { readonly kind: 'grid'; readonly count: readonly [number, number] }
    | { readonly kind: 'circle'; readonly count: number; readonly pitchDiameter: number }
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
const mm = (v: number) => `${Math.round(v * 1000) / 1000} mm`

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
  const addHoles = async (g: FoundHoleGroup) => {
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
          { partId: part.dto.id, ...a, center: [mm(c[0]), mm(c[1])] },
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
                    title={undercut ? t.undercut : undefined}
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

      <section className={styles['group']} aria-label={t.levels} aria-busy={levels.busy}>
        <h3 className={styles['groupTitle']}>{t.levels}</h3>
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
      </section>

      <section className={styles['group']} aria-label={t.section} aria-busy={section.busy}>
        <h3 className={styles['groupTitle']}>{t.section}</h3>
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
      </section>

      <section className={styles['group']} aria-label={t.holes} aria-busy={holes.busy}>
        <h3 className={styles['groupTitle']}>{t.holes}</h3>
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
                  onAdd={() => void addHoles(g)}
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
      </section>

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
  return (
    <li className={styles['loopRow']}>
      <span className={styles['loopName']} title={name}>
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
export function holeGroupText(g: FoundHoleGroup, units: DesignPart['units']): string {
  const L = (v: number) => displayLength(v, units)
  const m = g.size.mouth
  const s = g.size
  return t.holeGroup({
    count: g.count,
    diameter: L(s.diameter),
    ...(m !== undefined
      ? {
          mouth:
            m.type === 'countersink'
              ? t.countersunk(L(m.diameter), `${Math.round(m.angle)}°`)
              : t.counterbored(L(m.diameter), L(m.depth - s.top)),
        }
      : s.steps !== undefined
        ? { mouth: t.stepped(s.steps.length) }
        : {}),
    bottom:
      s.bottom === 'through'
        ? t.through
        : s.bottom === 'cone'
          ? t.pointed(L(s.depth - s.top), `${Math.round(s.coneAngle ?? 118)}°`)
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

function HoleRow({
  group: g,
  units,
  faceName,
  onAdd,
}: {
  group: FoundHoleGroup
  units: DesignPart['units']
  faceName: string
  onAdd: () => void
}) {
  const text = holeGroupText(g, units)
  const bolt = g.suggest.command === 'design.hole.add'
  const below = g.suggest.note === 'belowFace'
  const reason = below ? t.belowFace(displayLength(g.size.top, units), faceName) : undefined
  return (
    <li className={styles['holeRow']}>
      <span>{text}</span>
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
          disabled={below}
          title={reason}
          aria-label={`${bolt ? t.addBoltHole : t.addDrilling}: ${text}`}
          onClick={onAdd}
        >
          {bolt ? t.addBoltHole : t.addDrilling}
        </Button>
      </span>
      {reason !== undefined ? <span className={styles['muted']}>{reason}</span> : null}
    </li>
  )
}
