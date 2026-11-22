// The clone path in the viewport (v0.4 task U3): the reference chain per row as a thin `--vp-edge`
// line (the focused row's segment amber), an arc's centre cross and dashed construction circle,
// the source's footprint ghosts (draft clones solid, skipped positions dashed), and a marker per
// numbered position – a 7 px handle-look dot inside a 24 px target with its instance number in a
// chip (`--text` on `--bg-raised`), hidden where markers sit closer than 24 px on screen and shown
// on hover; the source "1" with a ring. While the Clones feature is selected a click (or Space on
// the focused marker; Tab walks them in number order) toggles a clone's skip; the source is not
// a target. The path draws in from the source when it appears (`--motion-slow`, cut under
// reduced motion). Everything comes from props (`clonePathOverlay`).
// Doc: docs/conventions/ui.md#clone-path-in-the-viewport
import { Html, Line } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Color, SRGBColorSpace, Vector3 } from 'three'
import type { Palette, Rgb } from './colours'
import { chipsShown, type ClonePathOverlay } from './clone-path'
import styles from './Viewport.module.css'

const noRaycast = (): void => {}

function colour(c: Rgb): Color {
  return new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)
}

/** `--motion-slow` (tokens.css): the path draws in from the source. */
export const DRAW_IN_MS = 400

type P3 = [number, number, number]
const p3 = (p: readonly number[]): P3 => [p[0]!, p[1]!, p[2]!]

/**
 * 0 → 1 over `DRAW_IN_MS` when `key` changes; 1 under reduced motion. A timer finishes it where
 * animation frames do not run (a hidden window).
 */
function useDrawIn(key: string, reduced: boolean): number {
  const [t, setT] = useState(0)
  useEffect(() => {
    if (reduced) return
    let frame = 0
    const start = performance.now()
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / DRAW_IN_MS)
      setT(1 - (1 - k) ** 3)
      if (k < 1) frame = requestAnimationFrame(tick)
    }
    if (typeof requestAnimationFrame !== 'undefined') frame = requestAnimationFrame(tick)
    const done = setTimeout(() => setT(1), DRAW_IN_MS + 50)
    return () => {
      if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(frame)
      clearTimeout(done)
      setT(0)
    }
  }, [key, reduced])
  return reduced ? 1 : t
}

/** The first `t` (0…1) of a chain of rows' polylines, by point count (the draw-in). */
function partial(rows: readonly (readonly P3[])[], t: number): P3[][] {
  if (t >= 1) return rows.map((r) => [...r])
  const total = rows.reduce((n, r) => n + Math.max(0, r.length - 1), 0)
  let left = total * t
  return rows.map((r) => {
    if (r.length < 2 || left <= 0) return r.slice(0, 1)
    const segs = r.length - 1
    if (left >= segs) {
      left -= segs
      return [...r]
    }
    const whole = Math.floor(left)
    const f = left - whole
    const out = r.slice(0, whole + 1)
    const a = r[whole]!
    const b = r[whole + 1]!
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f])
    left = 0
    return out
  })
}

export function ClonePathLayer({
  overlay,
  palette,
  reducedMotion,
}: {
  overlay: ClonePathOverlay
  palette: Palette
  reducedMotion: boolean
}): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  const getState = useThree((s) => s.get)
  const edge = useMemo(() => colour(palette.edge), [palette])
  const accent = useMemo(() => colour(palette.selected), [palette])
  // the path draws in again when the set of rows changes shape (a new selection or draft)
  const shapeKey = `${overlay.rows.length}:${overlay.markers[0]?.at.join(',') ?? ''}`
  const t = useDrawIn(shapeKey, reducedMotion)
  const lines = useMemo(
    () =>
      partial(
        overlay.rows.map((r) => r.line.map(p3)),
        t,
      ),
    [overlay.rows, t],
  )
  useEffect(() => invalidate(), [overlay, t, invalidate])

  // which numbers show: re-measured on every rendered frame (the camera moved or the path did)
  const [shown, setShown] = useState<readonly boolean[]>([])
  const markers = overlay.markers
  const v = useRef(new Vector3())
  useFrame(() => {
    const { camera, size } = getState()
    const screen = markers.map((m) => {
      v.current.set(m.at[0], m.at[1], m.at[2]).project(camera)
      if (v.current.z > 1 || v.current.z < -1) return null
      return [((v.current.x + 1) / 2) * size.width, ((1 - v.current.y) / 2) * size.height] as const
    })
    const next = chipsShown(screen)
    setShown((prev) =>
      prev.length === next.length && prev.every((x, i) => x === next[i]) ? prev : next,
    )
  })

  return (
    <group>
      {overlay.ghosts.map((g, i) =>
        g.loops
          .filter((l) => l.length >= 2)
          .map((l, j) => (
            <Line
              key={`g${i}-${j}`}
              points={[...l, l[0]!].map(p3)}
              color={edge}
              lineWidth={1}
              transparent
              opacity={0.5}
              depthTest={false}
              renderOrder={3}
              raycast={noRaycast}
              {...(g.dashed ? { dashed: true, dashSize: 1.2, gapSize: 1.2 } : {})}
            />
          )),
      )}
      {overlay.rows.map((r, i) => (
        <group key={`r${i}`}>
          {r.circle ? (
            <Line
              points={r.circle.map(p3)}
              color={edge}
              lineWidth={1}
              dashed
              dashSize={1.5}
              gapSize={1.5}
              transparent
              opacity={0.45}
              depthTest={false}
              renderOrder={3}
              raycast={noRaycast}
            />
          ) : null}
          {r.centre ? <Cross at={p3(r.centre)} axes={overlay.axes} colour={edge} /> : null}
          {lines[i] && lines[i]!.length >= 2 ? (
            <Line
              points={lines[i]!}
              color={r.focused ? accent : edge}
              lineWidth={r.focused ? 2 : 1.25}
              depthTest={false}
              renderOrder={4}
              raycast={noRaycast}
            />
          ) : null}
        </group>
      ))}
      {markers.map((m, i) => {
        const source = m.state === 'source'
        const clickable = overlay.interactive && !source && m.state !== 'duplicate'
        const body = (
          <>
            <span className={styles['cloneDot']} aria-hidden="true" />
            <span className={styles['cloneChip']} aria-hidden="true">
              {m.n}
              {m.outside ? <span className={styles['cloneWarn']}>▲</span> : null}
            </span>
            {m.hint !== undefined ? (
              <span className={styles['cloneHint']} aria-hidden="true">
                {m.hint}
              </span>
            ) : null}
          </>
        )
        return (
          <Html
            key={`m${m.n}`}
            position={p3(m.at)}
            center
            zIndexRange={[12, 2]}
            className={styles['cloneAnchor']}
          >
            {overlay.interactive ? (
              <button
                type="button"
                className={styles['cloneMarker']}
                data-clone-marker={m.n}
                data-state={m.state}
                data-chip={shown[i] === true ? '' : undefined}
                aria-label={m.label}
                {...(source || m.state === 'duplicate' ? { 'aria-disabled': true } : {})}
                {...(source && overlay.sourceHint !== undefined
                  ? { title: overlay.sourceHint }
                  : {})}
                onClick={(e) => {
                  e.stopPropagation()
                  if (clickable) overlay.onToggle(m.n)
                }}
              >
                {body}
              </button>
            ) : (
              <span
                className={styles['cloneMarker']}
                data-clone-marker={m.n}
                data-state={m.state}
                data-chip={shown[i] === true ? '' : undefined}
              >
                {body}
              </span>
            )}
          </Html>
        )
      })}
    </group>
  )
}

/** An arc's centre: a small cross in the face (strokes along its u and v). */
function Cross({
  at,
  axes,
  colour: c,
}: {
  at: P3
  axes: ClonePathOverlay['axes']
  colour: Color
}): React.JSX.Element {
  const camera = useThree((s) => s.camera)
  // about a fixed size on screen: 1.2 % of the distance to the camera
  const r = Math.max(0.5, camera.position.distanceTo(new Vector3(...at)) * 0.012)
  return (
    <>
      {[axes.u, axes.v].map((d, k) => (
        <Line
          key={k}
          points={[
            [at[0] - d[0] * r, at[1] - d[1] * r, at[2] - d[2] * r],
            [at[0] + d[0] * r, at[1] + d[1] * r, at[2] + d[2] * r],
          ]}
          color={c}
          lineWidth={1}
          depthTest={false}
          renderOrder={4}
          raycast={noRaycast}
        />
      ))}
    </>
  )
}
