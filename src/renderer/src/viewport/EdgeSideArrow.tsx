// The side arrow of a selected one-sided chamfer (DF147 SL4 follow-up): an arrow at the groove's
// middle from the kept wall out into the side that stays (`--vp-selected`), drawn over everything.
// Each side of the groove is a pick strip: hovering one shows its arrow (`--vp-hover`) and a light
// tint, a click keeps that side. Each arrow also has a focusable anchor (an Html button, the
// pointer passes to the canvas) named "<side> stays", pressed for the kept side; Enter or Space
// picks it. Locked (a Clones instance): the arrow only. Positions come from `edge-side.ts`.
// Doc: docs/conventions/ui.md#chamfer-inspector, docs/modes/engraved-patterns.md#implementation-sl3sl4
import { Html, Line } from '@react-three/drei'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import { BufferAttribute, BufferGeometry, Color, DoubleSide, SRGBColorSpace } from 'three'
import type { Palette, Rgb } from './colours'
import type { Vec3 } from './mesh'
import styles from './Viewport.module.css'

export type EdgeSideKey = 'left' | 'right'

export interface EdgeSideArrowView {
  readonly kept: EdgeSideKey
  readonly arrows: Readonly<
    Record<
      EdgeSideKey,
      { readonly from: Vec3; readonly to: Vec3; readonly head: readonly [Vec3, Vec3] }
    >
  >
  readonly strips: Readonly<Record<EdgeSideKey, readonly (readonly [Vec3, Vec3, Vec3, Vec3])[]>>
  /** Each side's accessible name ("Inside stays", "Left stays"). */
  readonly labels: Readonly<Record<EdgeSideKey, string>>
  /** The side cannot be picked here (a Clones instance; its source picks it). */
  readonly locked: boolean
  onPick(side: EdgeSideKey): void
}

const SIDES = ['left', 'right'] as const
const noRaycast = (): void => {}
const p3 = (p: Vec3): [number, number, number] => [p[0], p[1], p[2]]
const colour = (c: Rgb): Color => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)

/** The strips of one side as one triangle mesh (two triangles a quad). */
function stripGeometry(quads: readonly (readonly [Vec3, Vec3, Vec3, Vec3])[]): BufferGeometry {
  const pos = new Float32Array(quads.length * 18)
  quads.forEach((q, i) => {
    const t = [q[0], q[1], q[2], q[0], q[2], q[3]]
    t.forEach((p, k) => pos.set(p, i * 18 + k * 3))
  })
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.computeBoundingSphere()
  return g
}

function Strip({
  quads,
  hovered,
  tint,
  onHover,
  onPick,
}: {
  quads: readonly (readonly [Vec3, Vec3, Vec3, Vec3])[]
  hovered: boolean
  tint: Color
  onHover(on: boolean): void
  onPick(): void
}): React.JSX.Element {
  const geometry = useMemo(() => stripGeometry(quads), [quads])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <mesh
      geometry={geometry}
      renderOrder={6}
      userData={{ edgeSideStrip: true }}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation()
        onHover(true)
      }}
      onPointerOut={() => onHover(false)}
      onPointerDown={(e: ThreeEvent<PointerEvent>) => e.stopPropagation()}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation()
        onPick()
      }}
    >
      <meshBasicMaterial
        color={tint}
        depthTest={false}
        depthWrite={false}
        side={DoubleSide}
        transparent
        opacity={hovered ? 0.18 : 0}
      />
    </mesh>
  )
}

export function EdgeSideArrow({
  view,
  palette,
}: {
  view: EdgeSideArrowView
  palette: Palette
}): React.JSX.Element {
  const [hovered, setHovered] = useState<EdgeSideKey | null>(null)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate(), [view, hovered, invalidate])
  const selected = useMemo(() => colour(palette.selected), [palette.selected])
  const hover = useMemo(() => colour(palette.hover), [palette.hover])
  const shown = SIDES.filter((s) => s === view.kept || s === hovered)
  return (
    <group userData={{ edgeSideArrow: true }}>
      {shown.map((s) => {
        const a = view.arrows[s]
        const c = s === view.kept ? selected : hover
        return (
          <group key={s}>
            <Line
              points={[p3(a.from), p3(a.to)]}
              color={c}
              lineWidth={2}
              depthTest={false}
              renderOrder={9}
              raycast={noRaycast}
            />
            <Line
              points={[p3(a.head[0]), p3(a.to), p3(a.head[1])]}
              color={c}
              lineWidth={2}
              depthTest={false}
              renderOrder={9}
              raycast={noRaycast}
            />
          </group>
        )
      })}
      {view.locked
        ? null
        : SIDES.map((s) => (
            <Strip
              key={`strip-${s}`}
              quads={view.strips[s]}
              hovered={hovered === s}
              tint={hover}
              onHover={(on) => setHovered((h) => (on ? s : h === s ? null : h))}
              onPick={() => s !== view.kept && view.onPick(s)}
            />
          ))}
      {view.locked
        ? null
        : SIDES.map((s) => (
            <Html
              key={`key-${s}`}
              position={p3(view.arrows[s].to)}
              center
              zIndexRange={[10, 0]}
              className={styles['tabAnchor']}
            >
              <button
                type="button"
                aria-label={view.labels[s]}
                aria-pressed={s === view.kept}
                data-edge-side={s}
                onFocus={() => setHovered(s)}
                onBlur={() => setHovered((h) => (h === s ? null : h))}
                onClick={() => s !== view.kept && view.onPick(s)}
              />
            </Html>
          ))}
    </group>
  )
}
