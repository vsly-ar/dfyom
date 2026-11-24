// The Reference panel's Levels and Section rows (DF60 P1): the flat floors of the reference seen
// from a stock face and its opposite (`design.reference.find { kind: 'levels' }`), the fitted
// section at a depth with its inside corners (`kind: 'section'`), and "Create shape(s)" with
// optional rounding of sharp inside corners (`design.shape.import { from }`). The queries run in
// the compute worker; the rows show the last answer while a new one is read. The face and the
// depth are per-window view state (the depth is the Shape Editor's section depth too).
// Doc: docs/conventions/ui.md#reference-tools-df60, docs/modes/reference-tools.md#ui
import { useEffect, useMemo, useState } from 'react'
import { STOCK_FACE, faceFrame, type Direction } from '../../../../core/geometry/face'
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
  lengthSource,
  middleDepth,
  referenceBox,
  referencePlacement,
  sectionMatrix,
  stockSizeOf,
} from './reference-view'
import { useCommand } from './useDesign'

const t = referenceMessages.tools
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

const lengthQuantity = (mm: number, units: DesignPart['units']) => {
  const q = Quantity.parse(lengthSource(mm, units), {
    kind: 'length',
    defaultUnit: units === 'mm' ? 'mm' : 'in',
  })
  return q.isOk() ? q.unwrap() : undefined
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
  const [direction, setDirection] = useState<Direction>('+z')
  const storedDepth = useUi((s) => s.sectionDepth)
  const setDepth = useUi((s) => s.setSectionDepth)
  const [loops, setLoops] = useState<'all' | 'outer' | 'holes'>('all')
  const [round, setRound] = useState(false)
  const endMill = useSmallestEndMillRadius()
  const [roundRadius, setRoundRadius] = useState<Quantity | undefined>(undefined)
  const [created, setCreated] = useState<{ n: number } | { error: AppErrorData } | null>(null)
  const stock = stockSizeOf(part)
  const face = STOCK_FACE[direction]
  const box = referenceBox(ref)
  const depth =
    storedDepth ??
    (stock !== undefined && box !== undefined
      ? middleDepth(box, faceFrame(direction, stock), 0)
      : 0)
  // what the reads depend on: the record (placement, asset), the stock and the face
  const base = useMemo(
    () =>
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
          ]),
    [ref, stock, face],
  )
  const args = { partId: part.dto.id, referenceId: ref.id, face }
  const levels = useFind<FoundLevels>(base, { ...args, kind: 'levels' })
  const depthSource = lengthSource(depth, units)
  const section = useFind<FoundSection>(base === null ? null : `${base}|${depthSource}|${loops}`, {
    ...args,
    kind: 'section',
    depth: depthSource,
    loops,
  })
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
    })
  }, [setOverlay, ref.id, direction, depth, fitted, loops, hover])
  useEffect(() => () => setOverlay(null), [setOverlay])
  const radius = roundRadius ?? (endMill !== undefined ? lengthQuantity(endMill, units) : undefined)

  const create = async (split: 'file' | 'loop') => {
    const r = await call('design.shape.import', {
      partId: part.dto.id,
      split,
      from: {
        referenceId: ref.id,
        face,
        depth: depthSource,
        loops,
        ...(round && radius !== undefined ? { roundInside: radius.source } : {}),
      },
    })
    setCreated(
      r.ok ? { n: (r.value as { shapeIds: string[] }).shapeIds.length } : { error: r.error },
    )
  }

  const faceName = t.faces[face] ?? face
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
          options={FACES.map((d) => ({ value: d, label: t.faces[STOCK_FACE[d]] ?? d }))}
          value={direction}
          onValueChange={(d) => setDirection(d as Direction)}
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
            kind="length"
            defaultUnit={defaultUnit('length', units)}
            value={radius}
            onCommit={(q) => setRoundRadius(q)}
            messages={[{ id: 'roundHint', severity: 'note', text: t.roundHint }]}
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
