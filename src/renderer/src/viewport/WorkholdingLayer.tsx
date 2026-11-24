// Workholding in the plan scene (docs/modes/workholding.md#ui-summary, ui.md#workholding): each
// obstacle prism as a neutral solid (`--vp-grid-major`, outlined in `--vp-edge`; not the accent,
// not the stock colour), the open item's keep-out zone as a faint dashed halo at its top + margin,
// and the first hit of each collision finding as a `--danger` ring with a vertical tick. Drawn in
// the setup's WCS inside the run layer's frame. Props only; nothing here is pickable.
import { Line } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { Color, ExtrudeGeometry, Shape, SRGBColorSpace, Vector2 } from 'three'
import type { Palette, Rgb } from './colours'

type P = readonly [number, number]

/** What the run layer draws for the setup's workholding (`RunScene.workholding`). */
export interface WorkholdingOverlay {
  /** One solid per prism (WCS, mm); `zMin` already clamped to the table. */
  readonly solids: readonly {
    readonly itemId: string
    readonly outline: readonly P[]
    readonly zMin: number
    readonly zMax: number
  }[]
  /** The open item's keep-out zone: outlines grown by the margin, drawn at `z`. */
  readonly halo?: { readonly outlines: readonly (readonly P[])[]; readonly z: number } | undefined
  /** The open item (its solids drawn a step stronger). */
  readonly selected?: string | undefined
  /** First hits of collision findings (WCS, mm). */
  readonly hits: readonly (readonly [number, number, number])[]
}

const noRaycast = (): void => {}
const colour = (c: Rgb) => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)

function Solid({
  outline,
  zMin,
  zMax,
  fill,
  edge,
  strong,
}: {
  outline: readonly P[]
  zMin: number
  zMax: number
  fill: Color
  edge: Color
  strong: boolean
}): React.JSX.Element | null {
  const depth = zMax - zMin
  const geometry = useMemo(() => {
    if (outline.length < 3 || !(depth > 0)) return null
    const shape = new Shape(outline.map((p) => new Vector2(p[0], p[1])))
    return new ExtrudeGeometry(shape, { depth, bevelEnabled: false })
  }, [outline, depth])
  useEffect(() => () => geometry?.dispose(), [geometry])
  const ring = useMemo(
    () => [...outline, outline[0]!].map((p): [number, number, number] => [p[0], p[1], zMax]),
    [outline, zMax],
  )
  if (geometry === null) return null
  return (
    <group>
      <mesh geometry={geometry} position={[0, 0, zMin]} raycast={noRaycast} renderOrder={1}>
        <meshStandardMaterial
          color={fill}
          roughness={0.85}
          metalness={0.05}
          transparent
          opacity={strong ? 0.95 : 0.8}
        />
      </mesh>
      <Line
        points={ring}
        color={edge}
        lineWidth={strong ? 1.5 : 1}
        raycast={noRaycast}
        renderOrder={2}
      />
    </group>
  )
}

export function WorkholdingLayer({
  workholding,
  palette,
}: {
  workholding: WorkholdingOverlay
  palette: Palette
}): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate(), [workholding, invalidate])
  const fill = useMemo(() => colour(palette.gridMajor), [palette])
  const edge = useMemo(() => colour(palette.edge), [palette])
  const halo = useMemo(() => colour(palette.edge), [palette])
  const danger = useMemo(() => colour(palette.danger), [palette])
  return (
    <group>
      {workholding.solids.map((s, i) => (
        <Solid
          key={`${s.itemId}-${i}`}
          outline={s.outline}
          zMin={s.zMin}
          zMax={s.zMax}
          fill={fill}
          edge={edge}
          strong={s.itemId === workholding.selected}
        />
      ))}
      {workholding.halo?.outlines.map((o, i) => (
        <Line
          key={`halo-${i}`}
          points={[...o, o[0]!].map((p): [number, number, number] => [
            p[0],
            p[1],
            workholding.halo!.z,
          ])}
          color={halo}
          lineWidth={1}
          dashed
          dashSize={1.5}
          gapSize={1}
          transparent
          opacity={0.7}
          raycast={noRaycast}
          renderOrder={3}
        />
      ))}
      {workholding.hits.map((h, i) => (
        <group key={`hit-${i}`} position={[h[0], h[1], h[2]]}>
          <mesh raycast={noRaycast} renderOrder={4}>
            <ringGeometry args={[2.2, 3, 32]} />
            <meshBasicMaterial color={danger} depthTest={false} transparent />
          </mesh>
          <Line
            points={[
              [0, 0, 0],
              [0, 0, 12],
            ]}
            color={danger}
            lineWidth={2}
            depthTest={false}
            raycast={noRaycast}
            renderOrder={4}
          />
        </group>
      ))}
    </group>
  )
}
