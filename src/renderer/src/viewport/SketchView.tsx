// SketchView (v0.4 U2): renders sketch primitives (sketch.ts) as a small SVG at one uniform scale
// fitted to its width and height – the hole section now, the chamfer section and the Field info
// views' `sketch` view later. It knows only primitives and the highlighted part: the highlighted
// measure is the amber line with its value in a chip, a hovered one `--vp-hover`, an invalid one
// `--danger` with the error marker. Pointer over or on a measured part reports it (the caller
// highlights and focuses its field); the fields are the non-pointer path, so the image is one
// `role="img"` with the sketch's label and its targets are hidden from assistive tech. Paths morph
// between values with a CSS `d` transition (`--motion-base`, cut under reduced motion).
// Doc: docs/conventions/ui.md#section-illustration
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { fitSketch, sketchPath, toPx, type Sketch, type SketchPrimitive } from './sketch'
import styles from './SketchView.module.css'

export interface SketchViewProps {
  readonly sketch: Sketch
  /** The measured part drawn amber with its value chip (the focused field's). */
  readonly highlighted?: string | undefined
  /** Height in px (the width follows the container). */
  readonly height?: number
  /** Pointer entered (part) or left (null) a measured part. */
  readonly onPartHover?: ((part: string | null) => void) | undefined
  /** A measured part was clicked. */
  readonly onPartClick?: ((part: string) => void) | undefined
  readonly className?: string | undefined
}

const PAD = 14
const FALLBACK_WIDTH = 260

/** Approximate chip width for its text (mono 11 px). */
const chipWidth = (text: string) => text.length * 6.7 + 10
const CHIP_H = 17

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const read = () => {
      const w = el.getBoundingClientRect().width
      if (w > 0) setWidth(Math.round(w))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

export function SketchView({
  sketch,
  highlighted,
  height = 120,
  onPartHover,
  onPartClick,
  className,
}: SketchViewProps): React.JSX.Element {
  const [ref, width] = useWidth()
  const [hovered, setHovered] = useState<string | null>(null)
  const hatch = `sketch-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const fit = fitSketch(sketch.bounds, width, height, PAD)
  const d = (points: Parameters<typeof sketchPath>[1], closed = false) =>
    sketchPath(fit, points, closed)
  // CSS `d` (animatable in Chromium) and the attribute (everything else)
  const pathProps = (data: string) => ({
    d: data,
    style: { d: `path("${data}")` } as React.CSSProperties,
  })

  const measures = sketch.primitives.filter(
    (p): p is Extract<SketchPrimitive, { kind: 'measure' }> => p.kind === 'measure',
  )
  const hover = (part: string | null) => {
    setHovered(part)
    onPartHover?.(part)
  }

  return (
    <div ref={ref} className={[styles['root'], className].filter(Boolean).join(' ')}>
      <svg
        role="img"
        aria-label={sketch.label}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={styles['svg']}
      >
        <defs>
          <pattern
            id={hatch}
            patternUnits="userSpaceOnUse"
            width="5"
            height="5"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="5" className={styles['hatchLine']} />
          </pattern>
        </defs>
        <g aria-hidden="true">
          {sketch.primitives.map((p, i) =>
            p.kind === 'material' ? (
              <path
                key={`m${i}`}
                {...pathProps(d(p.points, true))}
                fill={`url(#${hatch})`}
                className={styles['material']}
              />
            ) : p.kind === 'line' ? (
              <path
                key={`l${i}`}
                {...pathProps(d(p.points, p.closed === true))}
                className={styles['line']}
                data-style={p.style}
              />
            ) : null,
          )}
          {measures.map((p) => {
            const state =
              p.invalid === true
                ? 'invalid'
                : highlighted === p.part
                  ? 'active'
                  : hovered === p.part
                    ? 'hover'
                    : undefined
            const data = p.paths.map((pts) => d(pts)).join('')
            return (
              <g key={p.part} data-part={p.part} data-state={state} className={styles['measure']}>
                <path {...pathProps(data)} className={styles['measureLine']} />
                <path
                  d={data}
                  className={styles['hit']}
                  onPointerEnter={() => hover(p.part)}
                  onPointerLeave={() => hover(null)}
                  onClick={() => onPartClick?.(p.part)}
                />
              </g>
            )
          })}
          {measures
            .filter((p) => p.invalid === true || highlighted === p.part)
            .map((p) => (
              <Chip
                key={`chip-${p.part}`}
                text={p.value}
                at={toPx(fit, p.chip)}
                side={p.side}
                invalid={p.invalid === true}
                box={[width, height]}
              />
            ))}
        </g>
      </svg>
    </div>
  )
}

function Chip({
  text,
  at,
  side,
  invalid,
  box,
}: {
  text: string
  at: readonly [number, number]
  side: 'left' | 'right' | 'above' | 'below'
  invalid: boolean
  box: readonly [number, number]
}): React.JSX.Element {
  const w = chipWidth(text) + (invalid ? 14 : 0)
  const gap = 6
  let x = side === 'right' ? at[0] + gap : side === 'left' ? at[0] - gap - w : at[0] - w / 2
  let y =
    side === 'above' ? at[1] - gap - CHIP_H : side === 'below' ? at[1] + gap : at[1] - CHIP_H / 2
  // keep it inside the drawing
  x = Math.min(Math.max(x, 1), box[0] - w - 1)
  y = Math.min(Math.max(y, 1), box[1] - CHIP_H - 1)
  return (
    <g
      className={styles['chip']}
      data-invalid={invalid || undefined}
      style={{ transform: `translate(${Math.round(x)}px, ${Math.round(y)}px)` }}
    >
      <rect width={w} height={CHIP_H} rx="3" className={styles['chipBox']} />
      {invalid ? (
        <g className={styles['marker']}>
          <circle cx="9" cy={CHIP_H / 2} r="5" />
          <path d={`M9 ${CHIP_H / 2 - 2.6}V${CHIP_H / 2 + 0.6}M9 ${CHIP_H / 2 + 2.4}v0.1`} />
        </g>
      ) : null}
      <text
        x={(invalid ? 14 : 0) + 5}
        y={CHIP_H / 2}
        dominantBaseline="central"
        className={styles['chipText']}
      >
        {text}
      </text>
    </g>
  )
}
