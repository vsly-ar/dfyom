// The view cube (B25): a chamfered cube in the viewport's top right, drawn in the one canvas as a
// HUD layer (drei's `Hud`: its own scene and orthographic camera in px, rendered after the scene)
// that turns with the camera in lockstep. 26 clickable regions, face labels in the face frame,
// the amber outline of the current view, the axis triad at part zero and, in Plan and Run, the
// spindle glyph on the setup's up face. Translucent until the pointer is over its square (DF19):
// a depth-only pass of the regions first, so only the front faces blend with the scene. Colours come from tokens (props); what a click does is
// the Viewport's business. Doc: docs/conventions/ui-view-cube.md, ADR 0010
import { Hud, Line, OrthographicCamera } from '@react-three/drei'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Matrix4,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Camera,
  type Group,
  type MeshBasicMaterial,
} from 'three'
import type { Rgb } from './colours'
import type { Vec3 } from './mesh'
import {
  CHAMFER,
  CUBE_BOX_PX,
  CUBE_HALF_EDGE_PX,
  CUBE_IDLE_OPACITY,
  CUBE_TOOLBAR_PX,
  CUBE_MARGIN_PX,
  CUBE_REGIONS,
  faceRight,
  faceUp,
  regionColour,
  regionKey,
  regionKind,
  regionPolygon,
  sameRegion,
  type CameraAxes,
  type CubeColours,
  type CubeRegion,
} from './view-cube'

export interface ViewCubeProps {
  colours: CubeColours
  axes: { readonly x: Rgb; readonly y: Rgb; readonly z: Rgb }
  /** Face labels by face region key ("0,0,1" → "Top"). */
  labels: Readonly<Record<string, string>>
  /** `--font-ui` and `--weight-medium` for the label textures. */
  font: string
  weight: string
  hovered: CubeRegion | null
  /** The region the camera looks exactly along: amber outline. */
  current: CubeRegion | null
  /** The setup's up face (Plan, Run): spindle glyph. */
  setupFace: CubeRegion | null
  /** Px of the viewport's right edge covered (the inspector overlay): the cube moves left. */
  insetRight: number
  /** The pointer is over the cube's square, or a press on it is held: opaque (DF19). */
  active: boolean
  reducedMotion: boolean
  onHover: (region: CubeRegion | null) => void
  onClick: (region: CubeRegion, event: MouseEvent) => void
  /** Called on every rendered frame with the main camera's axes (current view, summary). */
  onCamera: (axes: CameraAxes) => void
}

const noRaycast = (): void => {}
/** `--motion-fast` (hover tints) and `--motion-base` (moving beside the overlay), in seconds. */
const HOVER_S = 0.12
const SLIDE_S = 0.18
/** `--motion-base`: the fade between translucent and opaque (DF19). */
const FADE_S = 0.18

function colour(c: Rgb): Color {
  return new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)
}

export function ViewCube(props: ViewCubeProps): React.JSX.Element {
  const main = useThree((s) => s.camera)
  return (
    <Hud renderPriority={1}>
      <CubeHud {...props} main={main} />
    </Hud>
  )
}

function regionGeometry(r: CubeRegion): BufferGeometry {
  const p = regionPolygon(r)
  const positions: number[] = []
  for (let i = 1; i + 1 < p.length; i++) positions.push(...p[0]!, ...p[i]!, ...p[i + 1]!)
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  g.computeBoundingSphere()
  return g
}

/** Every region outline, lifted slightly off the surface (hairlines over the faces). */
function outlinePoints(regions: readonly CubeRegion[], lift: number): [number, number, number][] {
  const out: [number, number, number][] = []
  for (const r of regions) {
    const p = regionPolygon(r).map((v) => v.map((c) => c * lift) as [number, number, number])
    for (let i = 0; i < p.length; i++) out.push(p[i]!, p[(i + 1) % p.length]!)
  }
  return out
}

/** Direction of the triad's corner (front-left-top, part zero). */
const TRIAD_CORNER = new Vector3(-1, -1, 1).normalize()
const FACES = CUBE_REGIONS.filter((r) => regionKind(r) === 'face')
const EDGE_POINTS = outlinePoints(CUBE_REGIONS, 1.004)

function CubeHud({
  main,
  colours,
  axes,
  labels,
  font,
  weight,
  hovered,
  current,
  setupFace,
  insetRight,
  active,
  reducedMotion,
  onHover,
  onClick,
  onCamera,
}: ViewCubeProps & { main: Camera }): React.JSX.Element {
  const opacity = useRef(active ? 1 : CUBE_IDLE_OPACITY)
  const size = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)
  const group = useRef<Group>(null)
  const catcher = useRef<Group>(null)
  const triad = useRef<Group>(null)
  const materials = useRef(new Map<string, MeshBasicMaterial>())
  const hoverAmount = useRef(new Map<string, number>())
  const offset = useRef(insetRight)

  const geometries = useMemo(() => CUBE_REGIONS.map(regionGeometry), [])
  useEffect(() => () => geometries.forEach((g) => g.dispose()), [geometries])

  // label textures (face frame: `u` right, `v` up), redrawn when a token or the setup changes
  const textures = useMemo(
    () =>
      Object.fromEntries(
        FACES.map((r) => [
          regionKey(r),
          labelTexture(
            FACES.map((f) => labels[regionKey(f)] ?? ''),
            labels[regionKey(r)] ?? '',
            sameRegion(r, setupFace),
            { font, weight, text: colours.text, muted: colours.muted },
          ),
        ]),
      ),
    [labels, setupFace, font, weight, colours.text, colours.muted],
  )
  useEffect(() => () => Object.values(textures).forEach((t) => t?.dispose()), [textures])

  const letters = useMemo(
    () => ({
      x: letterTexture('X', axes.x, font),
      y: letterTexture('Y', axes.y, font),
      z: letterTexture('Z', axes.z, font),
    }),
    [axes, font],
  )
  useEffect(() => () => Object.values(letters).forEach((t) => t?.dispose()), [letters])

  useEffect(
    () => invalidate(),
    [colours, hovered, current, setupFace, insetRight, active, invalidate],
  )

  useFrame((_, delta) => {
    const g = group.current
    if (!g) return
    let moving = false
    // lockstep: the cube shows the camera's rotation
    g.quaternion.copy(main.quaternion).invert()
    // beside the inspector overlay (--motion-base)
    const step = reducedMotion ? Infinity : (delta / SLIDE_S) * Math.max(1, insetRight)
    const gap = insetRight - offset.current
    offset.current = Math.abs(gap) <= step ? insetRight : offset.current + Math.sign(gap) * step
    if (offset.current !== insetRight) moving = true
    const x = size.width / 2 - CUBE_MARGIN_PX - CUBE_TOOLBAR_PX - CUBE_BOX_PX / 2 - offset.current
    const y = size.height / 2 - CUBE_MARGIN_PX - CUBE_BOX_PX / 2
    g.position.set(x, y, 0)
    catcher.current?.position.set(x, y, -100)
    // hover tints (--motion-fast)
    for (const r of CUBE_REGIONS) {
      const key = regionKey(r)
      const target = sameRegion(r, hovered) ? 1 : 0
      const was = hoverAmount.current.get(key) ?? 0
      const now = reducedMotion
        ? target
        : was + Math.sign(target - was) * Math.min(Math.abs(target - was), delta / HOVER_S)
      if (now !== target) moving = true
      hoverAmount.current.set(key, now)
      const c = regionColour(r, colours, now)
      materials.current.get(key)?.color.setRGB(c[0], c[1], c[2], SRGBColorSpace)
    }
    // translucent until hovered (--motion-base; instant under reduced motion)
    const goal = active ? 1 : CUBE_IDLE_OPACITY
    const fade = reducedMotion ? Infinity : (delta / FADE_S) * (1 - CUBE_IDLE_OPACITY)
    const was = opacity.current
    opacity.current = Math.abs(goal - was) <= fade ? goal : was + Math.sign(goal - was) * fade
    if (opacity.current !== goal) moving = true
    g.traverse((o) => {
      const m = (o as { material?: unknown }).material
      if (m === undefined || o.userData['depthOnly'] === true) return
      for (const mat of Array.isArray(m) ? m : [m]) {
        const material = mat as { opacity: number; transparent: boolean }
        material.transparent = true
        material.opacity = opacity.current
      }
    })
    const back = new Vector3(0, 0, 1).applyQuaternion(main.quaternion)
    // the triad only while its corner faces the camera (from below it would stick out behind)
    if (triad.current) triad.current.visible = back.dot(TRIAD_CORNER) > -0.2
    onCamera({
      back: back.toArray() as Vec3,
      up: new Vector3(0, 1, 0).applyQuaternion(main.quaternion).toArray() as Vec3,
    })
    if (moving) invalidate()
  })

  // the colours at rest; the frame loop applies the hover tint on top
  const restColours = useMemo(
    () => CUBE_REGIONS.map((r) => colour(regionColour(r, colours))),
    [colours],
  )
  const edge = useMemo(() => colour(colours.edge), [colours])
  const accent = useMemo(() => colour(colours.accent), [colours])
  const currentPoints = useMemo(() => (current ? outlinePoints([current], 1.008) : null), [current])

  const move = (r: CubeRegion | null) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    onHover(r)
  }

  return (
    <>
      <OrthographicCamera makeDefault position={[0, 0, 200]} near={1} far={1000} />
      {/* the square takes the pointer: clicks inside it never reach the scene */}
      <group ref={catcher}>
        <mesh
          onPointerMove={move(null)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <planeGeometry args={[CUBE_BOX_PX, CUBE_BOX_PX]} />
          <meshBasicMaterial colorWrite={false} depthWrite={false} />
        </mesh>
      </group>
      <group ref={group} scale={CUBE_HALF_EDGE_PX}>
        {/* depth only, drawn first (opaque queue): the translucent faces blend only at the front */}
        {geometries.map((g, i) => (
          <mesh
            key={`depth:${i}`}
            geometry={g}
            raycast={noRaycast}
            userData={{ depthOnly: true }}
            renderOrder={-1}
          >
            <meshBasicMaterial
              colorWrite={false}
              polygonOffset
              polygonOffsetFactor={1}
              polygonOffsetUnits={1}
            />
          </mesh>
        ))}
        {CUBE_REGIONS.map((r, i) => (
          <mesh
            key={regionKey(r)}
            geometry={geometries[i]!}
            userData={{ region: r }}
            onPointerMove={move(r)}
            onPointerOut={() => onHover(null)}
            onClick={(e) => {
              e.stopPropagation()
              onClick(r, e.nativeEvent)
            }}
          >
            <meshBasicMaterial
              ref={(m: MeshBasicMaterial | null) => {
                if (m) materials.current.set(regionKey(r), m)
                else materials.current.delete(regionKey(r))
              }}
              color={restColours[i]!}
              transparent
              polygonOffset
              polygonOffsetFactor={1}
              polygonOffsetUnits={1}
            />
          </mesh>
        ))}
        {FACES.map((r) => (
          <FaceLabel key={regionKey(r)} region={r} texture={textures[regionKey(r)] ?? null} />
        ))}
        <Line points={EDGE_POINTS} segments color={edge} lineWidth={1} raycast={noRaycast} />
        {currentPoints ? (
          <Line
            points={currentPoints}
            segments
            color={accent}
            lineWidth={1.5}
            renderOrder={2}
            raycast={noRaycast}
          />
        ) : null}
        <group ref={triad}>
          <Triad axes={axes} letters={letters} />
        </group>
      </group>
    </>
  )
}

/** A face's label plane, just off the face, `u` right and `v` up (the face frame). */
function FaceLabel({
  region,
  texture,
}: {
  region: CubeRegion
  texture: CanvasTexture | null
}): React.JSX.Element | null {
  const placement = useMemo(() => {
    const n: Vec3 = [region[0], region[1], region[2]]
    const u = faceRight(n)
    const v = faceUp(n)
    const m = new Matrix4().makeBasis(new Vector3(...u), new Vector3(...v), new Vector3(...n))
    return {
      quaternion: new Quaternion().setFromRotationMatrix(m),
      position: new Vector3(...n).multiplyScalar(1.002),
    }
  }, [region])
  if (!texture) return null
  const side = 2 * (1 - CHAMFER)
  return (
    <mesh
      position={placement.position}
      quaternion={placement.quaternion}
      raycast={noRaycast}
      renderOrder={1}
    >
      <planeGeometry args={[side, side]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  )
}

/** X, Y, Z arrows at the front-left-top corner (part zero), with letters at their tips. */
function Triad({
  axes,
  letters,
}: {
  axes: ViewCubeProps['axes']
  letters: { x: CanvasTexture | null; y: CanvasTexture | null; z: CanvasTexture | null }
}): React.JSX.Element {
  const origin: Vec3 = [-0.92, -0.92, 0.92]
  const length = 0.52
  const items = [
    { key: 'x', dir: [1, 0, 0] as Vec3, c: axes.x, letter: letters.x },
    { key: 'y', dir: [0, 1, 0] as Vec3, c: axes.y, letter: letters.y },
    { key: 'z', dir: [0, 0, 1] as Vec3, c: axes.z, letter: letters.z },
  ]
  return (
    <group>
      {items.map(({ key, dir, c, letter }) => {
        const tip: Vec3 = [
          origin[0] + dir[0] * length,
          origin[1] + dir[1] * length,
          origin[2] + dir[2] * length,
        ]
        const head = 0.16
        const base: Vec3 = [tip[0] - dir[0] * head, tip[1] - dir[1] * head, tip[2] - dir[2] * head]
        const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...dir))
        const label: Vec3 = [tip[0] + dir[0] * 0.17, tip[1] + dir[1] * 0.17, tip[2] + dir[2] * 0.17]
        const col = colour(c)
        return (
          <group key={key}>
            <Line
              points={[[...origin], [...base]]}
              color={col}
              lineWidth={1.5}
              raycast={noRaycast}
            />
            <mesh
              position={[(base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2, (base[2] + tip[2]) / 2]}
              quaternion={q}
              raycast={noRaycast}
            >
              <coneGeometry args={[0.055, head, 12]} />
              <meshBasicMaterial color={col} />
            </mesh>
            {letter ? (
              <sprite position={label} scale={[0.36, 0.36, 1]} raycast={noRaycast}>
                <spriteMaterial map={letter} toneMapped={false} />
              </sprite>
            ) : null}
          </group>
        )
      })}
    </group>
  )
}

// --- Textures (canvas 2D; jsdom has none, so they may be null) ---

const TEXTURE_PX = 256
const css = (c: Rgb): string =>
  `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)})`

function texture(canvas: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(canvas)
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 4
  return t
}

/**
 * A face label: the text sized so the longest label of all faces fits (one size for all), and on
 * the setup's up face a spindle glyph under it (`--text-muted`).
 */
function labelTexture(
  all: readonly string[],
  text: string,
  spindle: boolean,
  style: { font: string; weight: string; text: Rgb; muted: Rgb },
): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = TEXTURE_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const family = style.font || 'system-ui, sans-serif'
  const weight = style.weight || '500'
  const base = 100
  ctx.font = `${weight} ${base}px ${family}`
  const widest = Math.max(1, ...all.map((s) => ctx.measureText(s).width))
  const px = Math.min(TEXTURE_PX * 0.27, (base * TEXTURE_PX * 0.84) / widest)
  ctx.font = `${weight} ${px}px ${family}`
  ctx.fillStyle = css(style.text)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, TEXTURE_PX / 2, TEXTURE_PX * (spindle ? 0.36 : 0.5))
  if (spindle) drawSpindle(ctx, TEXTURE_PX / 2, TEXTURE_PX * 0.7, TEXTURE_PX * 0.34, style.muted)
  return texture(canvas)
}

/** Spindle pictogram centred at (cx, cy), `h` tall: the spindle nose, the tool, the face under it. */
function drawSpindle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  h: number,
  c: Rgb,
): void {
  const top = cy - h / 2
  ctx.fillStyle = css(c)
  ctx.strokeStyle = css(c)
  // nose: a short wide block narrowing to the collet
  const nose = h * 0.34
  ctx.beginPath()
  ctx.moveTo(cx - h * 0.22, top)
  ctx.lineTo(cx + h * 0.22, top)
  ctx.lineTo(cx + h * 0.22, top + nose * 0.62)
  ctx.lineTo(cx + h * 0.12, top + nose)
  ctx.lineTo(cx - h * 0.12, top + nose)
  ctx.lineTo(cx - h * 0.22, top + nose * 0.62)
  ctx.closePath()
  ctx.fill()
  // tool
  const tool = h * 0.4
  ctx.fillRect(cx - h * 0.055, top + nose, h * 0.11, tool)
  // the face it points at
  ctx.lineWidth = Math.max(2, h * 0.07)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(cx - h * 0.36, top + h - ctx.lineWidth / 2)
  ctx.lineTo(cx + h * 0.36, top + h - ctx.lineWidth / 2)
  ctx.stroke()
}

function letterTexture(letter: string, c: Rgb, font: string): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.font = `600 44px ${font || 'system-ui, sans-serif'}`
  ctx.fillStyle = css(c)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(letter, 32, 34)
  return texture(canvas)
}
