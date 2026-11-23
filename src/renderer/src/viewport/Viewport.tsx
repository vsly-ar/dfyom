// The 3D viewport: one react-three-fiber canvas showing an evaluated part and its stock, with
// orbit / pan / zoom-to-cursor, the view cube with Fit and the Views menu, hover,
// click-to-select and pick mode. Props-driven:
// it never owns the document; the shell passes the mesh, selection and pick request in and gets
// surface targets back. Doc: docs/conventions/ui.md#selection-and-picking,
// docs/architecture/geometry.md#worker-and-renderer, docs/conventions/ui-view-cube.md, ADR 0010
import { Canvas } from '@react-three/fiber'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Vector3, type PerspectiveCamera } from 'three'
import type { Placement } from '../../../core/geometry/model'
import type { EvaluationStatus } from '../../../core/design/evaluation'
import type { SurfaceId } from '../../../core/geometry/model'
import type { UnitSystem } from '../../../core/project/document'
import { snapMessages } from '../messages/snap'
import { viewportMessages as msg } from '../messages/viewport'
import { measureBetween } from './MeasureTool'
import { Measure3d, type MeasurePoints } from './Measure3d'
import {
  Menu,
  Toolbar,
  ToolbarButton,
  Icon,
  Tooltip,
  useReducedMotion,
  type MenuEntry,
} from '../ui'
import {
  FOV_DEG,
  fitPose,
  isClick,
  mouseButtons,
  normalize,
  PAN_STEP,
  VIEW_PRESETS,
  viewportKey,
  ZOOM_STEP,
  type CameraAction,
  type MousePreset,
  type ViewPreset,
} from './camera'
import { paletteFrom, PALETTE_TOKENS, type SurfaceState } from './colours'
import {
  cameraDirection,
  CUBE_REGIONS,
  CUBE_TOKENS,
  cubeColours,
  faceRegionOf,
  inCubeBox,
  PRESET_REGION,
  PRESET_SHORTCUT,
  regionAlong,
  regionKey,
  regionKind,
  regionShortcut,
  regionView,
  regionWords,
  sameRegion,
  sameShownView,
  setupView,
  shownView,
  showsView,
  type CameraAxes,
  type CubeRegion,
  type CubeView,
  type ShownView,
} from './view-cube'
import { ViewCube } from './ViewCube'
import {
  meshBounds,
  meshOperations,
  surfaceGlyphs,
  unionBox,
  type Box,
  type SurfaceTarget,
  type OutlineLoop,
  type Vec3,
  type ViewportMesh,
} from './mesh'
import type { AnchorOverlay, FrameOverlay } from './Overlays'
import type { TabOverlay } from './TabMarkers'
import type { ClonePathOverlay } from './clone-path'
import type { ReferenceGhostView } from './ReferenceGhost'
import type { RunScene } from './RunLayer'
import { CameraControlsImpl, Scene } from './Scene'
import { linesBounds, placeBox } from './toolpath-lines'
import { classifyWheel, type WheelHistory } from './wheel'
import { useTokens } from './useTokens'
import styles from './Viewport.module.css'

/** `--delay-indicator` (tokens.css): the outdated tint of a pending evaluation waits this long. */
export const DELAY_INDICATOR_MS = 300

export interface PickRequest {
  /** Surfaces that may be picked (ui.md: horizontal surfaces of the stock and earlier operations). */
  readonly eligible: ReadonlySet<SurfaceId>
  /** The field asking, for the banner ("Pick a surface for On"). */
  readonly field: string
}

export interface ViewportProps {
  /** The current (or last good) evaluation; `null` before the first one. */
  mesh: ViewportMesh | null
  /** Stock box in the part frame, drawn as a dashed outline. */
  stock?: Box | null
  /** Evaluation status (ui.md#evaluation-status-pending-outdated-failed). */
  status?: EvaluationStatus
  /** Operation (or `stock`) shown as selected; a new selection pulses (`--motion-emphasis`). */
  selectedOperation?: string | null
  /**
   * Live outline of the edited operation while its evaluation is pending (closed loops in the
   * part frame, from the field values; ui.md#evaluation-status-pending-outdated-failed).
   */
  outline?: readonly OutlineLoop[] | null
  /** Error marker at the failing operation (evaluation `failed`). */
  marker?: Vec3 | null
  /** Face-frame axes of the selected operation's face (`u`, `v`, labelled; task F1). */
  frame?: FrameOverlay | null
  /** Anchor marker: the point the selected feature's position gives (task F2). */
  anchor?: AnchorOverlay | null
  /** Tab markers and the start point of the selected profile, draggable (task U2). */
  tabs?: TabOverlay | null
  /** Thin dashed guide loops (part frame): the rotated bounding box while rotation has focus (U2). */
  guide?: readonly OutlineLoop[] | null
  /**
   * Reference model ghosts (task R3): translucent, never pickable; `box` (the placed bounding box,
   * part frame) widens the framing bounds.
   */
  ghosts?: readonly (ReferenceGhostView & { readonly box: Box })[] | null
  /** Operations drawn with a light `--info` tint (edited in the plan: the plan scene, task E3b). */
  tinted?: ReadonlySet<string> | null
  /** Operations drawn selected besides `selectedOperation` (a Clones' source, v0.4 task U3). */
  selectedAlso?: ReadonlySet<string> | null
  /** The clone path of the selected Clones feature or the open draft (v0.4 task U3). */
  clonePath?: ClonePathOverlay | null
  /** Polite announcement under the viewport ("Clone 4 skipped."; task U3). */
  announcement?: string | null
  /** Click on a surface → its target; click on empty space or Escape → `null`. */
  onSelect?: (target: SurfaceTarget | null) => void
  /** Pointer hover over a surface (for a navigator row highlight); `null` when it leaves. */
  onHover?: (target: SurfaceTarget | null) => void
  /** Pick mode: crosshair, eligible surfaces highlighted, others dimmed. */
  pick?: PickRequest | null
  onPick?: (target: SurfaceTarget) => void
  /** Escape in pick mode. */
  onPickCancel?: () => void
  /** Mouse mapping setting (ui.md decision 10). */
  mousePreset?: MousePreset
  /** Project units of the measure tool's distances (task U3). */
  units?: UnitSystem
  /** The window's "Snap" toggle: the measure tool snaps to vertices and stock corners (task U3). */
  snap?: boolean
  /** Draw the part translucent so a reference ghost inside shows ("See through stock", DF2). */
  seeThrough?: boolean
  /** Run mode (task 3.12): toolpath playback, tool marker at `wpos`, work zero; `null` = none. */
  run?: RunScene | null
  /**
   * Px of the viewport's right edge covered by an overlay (the inspector in narrow windows): the
   * view cube and its toolbar move left beside it (ui-view-cube.md § Rendering).
   */
  insetRight?: number
  /** Accessible text summary; defaults to the operation count and status. */
  summary?: string
  className?: string | undefined
}

const TOKEN_NAMES = [
  ...Object.values(PALETTE_TOKENS),
  ...Object.values(CUBE_TOKENS),
  '--font-ui',
  '--weight-medium',
]

/** `--delay-tooltip` (tokens.css): the view cube's tooltip waits this long. */
export const DELAY_TOOLTIP_MS = 450

const regionName = (r: CubeRegion): string => msg.cubeRegion(regionKind(r), regionWords(r))

/** Face labels for the cube's textures, by region key. */
const FACE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  CUBE_REGIONS.filter((r) => regionKind(r) === 'face').map((r) => [regionKey(r), regionName(r)]),
)

const ACTIONS: Record<CameraAction, CameraControlsImpl['mouseButtons']['left']> = {
  orbit: CameraControlsImpl.ACTION.ROTATE,
  pan: CameraControlsImpl.ACTION.TRUCK,
  none: CameraControlsImpl.ACTION.NONE,
}

/** `--motion-emphasis` (tokens.css): the selection pulse. */
export const PULSE_MS = 450

/** 1 when `key` changes to a value, easing out to 0 over `PULSE_MS`; 0 under reduced motion. */
function usePulse(key: string | null, reduced: boolean): number {
  const [pulse, setPulse] = useState(0)
  useEffect(() => {
    if (key === null || reduced || typeof requestAnimationFrame === 'undefined') return
    let frame = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / PULSE_MS)
      setPulse((1 - t) ** 2) // eases out: fades fast at first, then settles
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      setPulse(0)
    }
  }, [key, reduced])
  return pulse
}

/** True `delay` ms after `on` became true (false at once when it turns false). */
function useDelayed(on: boolean, delay: number): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!on) return
    const t = setTimeout(() => setLate(true), delay)
    return () => {
      clearTimeout(t)
      setLate(false)
    }
  }, [on, delay])
  return on && late
}

export function Viewport({
  mesh,
  stock = null,
  status = 'done',
  selectedOperation = null,
  outline = null,
  marker = null,
  frame = null,
  anchor = null,
  tabs = null,
  guide = null,
  ghosts = null,
  tinted = null,
  selectedAlso = null,
  clonePath = null,
  announcement = null,
  onSelect,
  onHover,
  pick = null,
  onPick,
  onPickCancel,
  mousePreset = 'default',
  units = 'mm',
  snap = true,
  seeThrough = false,
  run = null,
  insetRight = 0,
  summary,
  className,
}: ViewportProps): React.JSX.Element {
  const regionRef = useRef<HTMLDivElement>(null)
  const controls = useRef<CameraControlsImpl>(null)
  const down = useRef<{ x: number; y: number } | null>(null)
  const summaryId = useId()
  const reducedMotion = useReducedMotion()
  const tokens = useTokens(regionRef, TOKEN_NAMES)
  const palette = useMemo(() => paletteFrom(tokens), [tokens])
  const cube = useMemo(() => cubeColours(tokens), [tokens])
  const axisColours = useMemo(
    () => ({ x: palette.axisX, y: palette.axisY, z: palette.axisZ }),
    [palette],
  )
  const [hovered, setHovered] = useState<SurfaceTarget | undefined>(undefined)

  const outdated = useDelayed(status === 'pending', DELAY_INDICATOR_MS) || status === 'failed'
  const pulse = usePulse(selectedOperation, reducedMotion)
  const surfaceState = useMemo<SurfaceState>(
    () => ({
      selectedOperation,
      hovered: hovered?.surface ?? null,
      pickEligible: pick?.eligible ?? null,
      outdated,
      pulse,
      tinted,
      selectedAlso,
    }),
    [selectedOperation, hovered, pick, outdated, pulse, tinted, selectedAlso],
  )
  const runLines = run?.lines ?? null
  const runFrame = run?.frame
  const bounds = useMemo(
    () =>
      (ghosts ?? []).reduce<Box | undefined>(
        (b, g) => unionBox(b, g.box),
        unionBox(
          unionBox(mesh ? meshBounds(mesh) : undefined, stock ?? undefined),
          runLines ? placeBox(linesBounds(runLines), runFrame) : undefined,
        ),
      ),
    [mesh, stock, runLines, runFrame, ghosts],
  )

  // pick mode: a normal glyph on every eligible face (ui.md#design-and-plan-controls-v02)
  const pickEligible = pick?.eligible
  const glyphs = useMemo(
    () => (mesh && pickEligible ? surfaceGlyphs(mesh, pickEligible) : null),
    [mesh, pickEligible],
  )

  const hoveredRef = useRef<SurfaceTarget | undefined>(undefined)
  const hover = useCallback(
    (target: SurfaceTarget | undefined) => {
      if (hoveredRef.current?.surface === target?.surface) return
      hoveredRef.current = target
      setHovered(target)
      onHover?.(target ?? null)
    },
    [onHover],
  )

  // --- camera commands (view cube, toolbar, menu, keys) ---
  const animate = !reducedMotion
  /** Looks at the part from `direction` and fits it; keeps the camera's up (Fit) unless given. */
  const lookFrom = useCallback(
    (
      direction: readonly [number, number, number],
      cameraUp?: readonly [number, number, number],
    ) => {
      const c = controls.current
      if (!c) return
      const camera = c.camera as PerspectiveCamera
      if (cameraUp && camera.up.distanceTo(new Vector3(...cameraUp)) > 1e-9) {
        camera.up.set(...cameraUp)
        c.updateCameraUp()
      }
      if (!bounds) {
        // nothing to fit yet: turn about the current target at the current distance
        const t = c.getTarget(new Vector3(), true)
        const d = c.distance
        const n = normalize(direction)
        void c.setLookAt(t.x + n[0] * d, t.y + n[1] * d, t.z + n[2] * d, t.x, t.y, t.z, animate)
        return
      }
      const { position: p, target: t } = fitPose(direction, bounds, camera.aspect || 1, FOV_DEG)
      void c.setLookAt(p[0], p[1], p[2], t[0], t[1], t[2], animate)
    },
    [bounds, animate],
  )
  const goTo = useCallback(
    (view: CubeView) => lookFrom(cameraDirection(view), view.cameraUp),
    [lookFrom],
  )
  const preset = useCallback((p: ViewPreset) => goTo(regionView(PRESET_REGION[p])), [goTo])
  const fit = useCallback(() => {
    const c = controls.current
    if (!c) return
    const pos = c.getPosition(new Vector3(), true)
    const tgt = c.getTarget(new Vector3(), true)
    lookFrom(normalize([pos.x - tgt.x, pos.y - tgt.y, pos.z - tgt.z]))
  }, [lookFrom])

  // --- view cube: the setup (Plan, Run), the view shown, hover and clicks ---
  const setupFrame: Placement | null = run?.frame ?? null
  const setup = useMemo(() => (setupFrame ? setupView(setupFrame) : null), [setupFrame])
  const setupFace = useMemo(
    () => (setupFrame ? (faceRegionOf(setupFrame.n) ?? null) : null),
    [setupFrame],
  )
  const axesRef = useRef<CameraAxes | null>(null)
  const [shown, setShown] = useState<ShownView>({ kind: 'custom' })
  const [along, setAlong] = useState<CubeRegion | null>(null)
  const onCamera = useCallback(
    (axes: CameraAxes) => {
      axesRef.current = axes
      const next = shownView(axes, setup)
      setShown((prev) => (sameShownView(prev, next) ? prev : next))
      const region = regionAlong(axes) ?? null
      setAlong((prev) => (prev === region || sameRegion(prev, region) ? prev : region))
    },
    [setup],
  )
  const [cubeHover, setCubeHover] = useState<CubeRegion | null>(null)
  const onCubeHover = useCallback(
    (r: CubeRegion | null) =>
      setCubeHover((prev) => (prev === r || sameRegion(prev, r) ? prev : r)),
    [],
  )
  /** The view a click on a region gives: the setup view on the setup's up face, else its own. */
  const isSetupFace = useCallback(
    (r: CubeRegion | null): boolean => setup !== null && sameRegion(r, setupFace),
    [setup, setupFace],
  )
  const onCubeClick = useCallback(
    (r: CubeRegion, e: MouseEvent) => {
      if (!isClick(down.current, { x: e.clientX, y: e.clientY })) return
      const view = isSetupFace(r) && setup ? setup : regionView(r)
      if (axesRef.current && showsView(axesRef.current, view)) return // already in view (C4)
      goTo(view)
    },
    [isSetupFace, setup, goTo],
  )
  const [pressing, setPressing] = useState(false)
  // the measure tool (task U3): on/off and the picked points, never stored
  const [measuring, setMeasuring] = useState(false)
  const [measurePoints, setMeasurePoints] = useState<MeasurePoints>({ a: null, b: null })
  // pick mode wins over the measure tool while it runs
  const measureOn = measuring && !pick
  const endMeasure = useCallback(() => {
    setMeasuring(false)
    setMeasurePoints({ a: null, b: null })
  }, [])
  const toggleMeasure = useCallback(() => {
    if (measuring) endMeasure()
    else setMeasuring(true)
  }, [measuring, endMeasure])
  const measurePick = useCallback((p: Vec3) => {
    setMeasurePoints((m) => (m.a === null || m.b !== null ? { a: p, b: null } : { a: m.a, b: p }))
  }, [])
  useEffect(() => {
    if (!pressing) return
    const up = (): void => setPressing(false)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [pressing])
  const tooltipOpen = useDelayed(cubeHover !== null, DELAY_TOOLTIP_MS) && !pressing
  const tooltipText = cubeHover
    ? isSetupFace(cubeHover)
      ? msg.setupRegion(regionName(cubeHover))
      : regionName(cubeHover)
    : ''
  const tooltipShortcut =
    cubeHover && !isSetupFace(cubeHover) ? regionShortcut(cubeHover) : undefined
  const shownName =
    shown.kind === 'region'
      ? regionName(shown.region)
      : shown.kind === 'setup'
        ? msg.setupView
        : null
  const viewItems = useMemo<MenuEntry[]>(
    () => [
      ...VIEW_PRESETS.map((p) => ({
        label: msg.preset[p],
        shortcut: PRESET_SHORTCUT[p],
        onSelect: () => preset(p),
      })),
      ...(setup
        ? (['separator', { label: msg.setupView, onSelect: () => goTo(setup) }] as const)
        : []),
    ],
    [preset, goTo, setup],
  )

  // Mouse preset: applied on every press (the Shift modifier selects the action).
  const applyButtons = (shift: boolean): void => {
    const c = controls.current
    if (!c) return
    const map = mouseButtons(mousePreset, shift)
    c.mouseButtons.left = ACTIONS[map.left]
    c.mouseButtons.middle = ACTIONS[map.middle]
    c.mouseButtons.right = ACTIONS[map.right]
    c.mouseButtons.wheel = CameraControlsImpl.ACTION.DOLLY
  }
  useEffect(() => applyButtons(false))

  // Wheel: a trackpad scroll pans, a pinch or a mouse wheel dollies to the cursor (wheel.ts).
  // Classified in the capture phase, before camera-controls' own listener on the canvas reads
  // `mouseButtons.wheel`. camera-controls turns any `ctrlKey` wheel (a pinch) into a field-of-view
  // zoom, which Fit does not undo, so a pinch is re-sent without `ctrlKey` and dollies instead.
  const wheelHistory = useRef<WheelHistory | null>(null)
  useEffect(() => {
    const region = regionRef.current
    if (!region) return
    const resent = new WeakSet<Event>()
    const onWheel = (e: WheelEvent): void => {
      const c = controls.current
      if (!c || resent.has(e)) return
      const gesture = classifyWheel(e, wheelHistory.current, e.timeStamp)
      wheelHistory.current = { gesture, time: e.timeStamp }
      c.mouseButtons.wheel =
        gesture === 'pan' ? CameraControlsImpl.ACTION.TRUCK : CameraControlsImpl.ACTION.DOLLY
      if (!e.ctrlKey || !e.target) return
      e.preventDefault()
      e.stopPropagation()
      const copy = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
      })
      resent.add(copy)
      e.target.dispatchEvent(copy)
    }
    region.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => region.removeEventListener('wheel', onWheel, { capture: true })
  }, [])

  // Escape cancels pick mode wherever focus is (the field that started it keeps focus).
  useEffect(() => {
    if (!pick) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onPickCancel?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pick, onPickCancel])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    if (
      (e.key === 'd' || e.key === 'D') &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      !pick
    ) {
      e.preventDefault()
      toggleMeasure()
      return
    }
    const key = viewportKey(e, e.target === e.currentTarget)
    if (!key) return
    if (key.kind === 'escape') {
      if (pick) return // handled by the document listener
      if (measuring) {
        e.preventDefault()
        endMeasure()
        return
      }
      e.preventDefault()
      onSelect?.(null)
      return
    }
    const c = controls.current
    if (!c) return
    e.preventDefault()
    const distance = c.distance
    switch (key.kind) {
      case 'preset':
        preset(key.preset)
        break
      case 'fit':
        fit()
        break
      case 'orbit':
        void c.rotate(key.azimuth, key.polar, animate)
        break
      case 'pan':
        void c.truck(key.x * distance * PAN_STEP, -key.y * distance * PAN_STEP, animate)
        break
      case 'zoom':
        void c.dolly(key.direction * distance * ZOOM_STEP, animate)
        break
    }
  }

  const operations = mesh ? meshOperations(mesh).filter((o) => o !== 'stock').length : 0
  const text = summary ?? msg.summary({ operations, status: mesh ? status : 'empty' })
  const measured =
    measurePoints.a !== null && measurePoints.b !== null
      ? measureBetween(measurePoints.a, measurePoints.b)
      : null

  return (
    <div
      ref={regionRef}
      role="region"
      aria-label={msg.region}
      aria-describedby={summaryId}
      tabIndex={0}
      className={[styles['viewport'], className].filter(Boolean).join(' ')}
      data-picking={pick ? '' : undefined}
      data-measuring={measureOn ? '' : undefined}
      data-hover={hovered && (!pick || pick.eligible.has(hovered.surface)) ? '' : undefined}
      onKeyDown={onKeyDown}
      onPointerDownCapture={(e) => {
        down.current = { x: e.clientX, y: e.clientY }
        const rect = e.currentTarget.getBoundingClientRect()
        const onCube =
          e.target instanceof HTMLCanvasElement && inCubeBox(e.clientX, e.clientY, rect, insetRight)
        if (!onCube) {
          applyButtons(e.shiftKey)
          return
        }
        // a drag on the cube orbits like the default left-drag, whatever the preset (C5)
        setPressing(true)
        const c = controls.current
        if (!c) return
        const map = mouseButtons('default', false)
        c.mouseButtons.left = ACTIONS[map.left]
        c.mouseButtons.middle = ACTIONS[map.middle]
        c.mouseButtons.right = ACTIONS[map.right]
      }}
    >
      <Canvas
        className={styles['canvas']}
        data-testid="viewport-canvas"
        frameloop="demand"
        flat
        dpr={[1, 2]}
        camera={{ fov: FOV_DEG, near: 0.5, far: 50000, up: [0, 0, 1], position: [200, -200, 200] }}
        onPointerMissed={(e) => {
          if (!pick && !measureOn && isClick(down.current, { x: e.clientX, y: e.clientY }))
            onSelect?.(null)
        }}
      >
        <Scene
          mesh={mesh}
          stock={stock}
          bounds={bounds}
          palette={palette}
          surfaceState={surfaceState}
          outline={status === 'pending' ? outline : null}
          marker={status === 'failed' ? marker : null}
          glyphs={glyphs}
          hovered={pick && hovered && pick.eligible.has(hovered.surface) ? hovered.surface : null}
          frame={frame}
          anchor={anchor}
          tabs={pick ? null : tabs}
          clonePath={pick ? null : clonePath}
          guide={guide}
          ghosts={ghosts}
          seeThrough={seeThrough}
          reducedMotion={reducedMotion}
          controlsRef={controls}
          run={run}
          onHover={hover}
          onClick={(target, e) => {
            if (measureOn) return
            if (!isClick(down.current, { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY }))
              return
            if (pick) {
              if (pick.eligible.has(target.surface)) onPick?.(target)
            } else onSelect?.(target)
          }}
        />
        {measureOn ? (
          <Measure3d
            points={measurePoints}
            onPick={measurePick}
            stock={stock}
            snap={snap}
            units={units}
            palette={palette}
          />
        ) : null}
        <ViewCube
          colours={cube}
          axes={axisColours}
          labels={FACE_LABELS}
          font={tokens['--font-ui'] ?? ''}
          weight={tokens['--weight-medium'] ?? ''}
          hovered={cubeHover}
          current={along}
          setupFace={setup ? setupFace : null}
          insetRight={insetRight}
          reducedMotion={reducedMotion}
          onHover={onCubeHover}
          onClick={onCubeClick}
          onCamera={onCamera}
        />
      </Canvas>
      <div
        className={styles['cube']}
        style={insetRight ? { transform: `translateX(${-insetRight}px)` } : undefined}
      >
        <Tooltip
          content={tooltipText}
          {...(tooltipShortcut ? { shortcut: tooltipShortcut } : {})}
          side="left"
          open={tooltipOpen}
        >
          <span className={styles['cubeAnchor']} aria-hidden="true" />
        </Tooltip>
        <Toolbar label={msg.toolbar} floating className={styles['toolbar']}>
          <ToolbarButton
            label={msg.fit}
            shortcut="F"
            icon={<Icon name="fit" />}
            tooltipSide="bottom"
            onClick={fit}
          />
          <Menu label={msg.views} align="end" items={viewItems}>
            <ToolbarButton label={msg.views} icon={<Icon name="iso" />} tooltipSide="bottom" />
          </Menu>
          {run ? null : (
            <ToolbarButton
              label={snapMessages.measure.tool}
              shortcut="D"
              icon={<Icon name="measure" />}
              pressed={measureOn}
              tooltipSide="bottom"
              onClick={toggleMeasure}
            />
          )}
        </Toolbar>
      </div>
      {pick ? (
        <div className={styles['banner']} role="status">
          {msg.pickPrompt(pick.field)} · {msg.pickCancel}
        </div>
      ) : null}
      {measureOn ? (
        <div className={styles['banner']} role="status">
          {measurePoints.a !== null && measurePoints.b === null
            ? snapMessages.measure.second
            : snapMessages.measure.prompt}
        </div>
      ) : null}
      <p id={summaryId} className={styles['srOnly']}>
        {text} {msg.shownView(shownName)} {msg.keys}
      </p>
      <p className={styles['srOnly']} aria-live="polite">
        {msg.shownView(shownName)}
        {measured
          ? ` ${snapMessages.measure.summary(
              measured.distance,
              [
                ['x', measured.deltas[0]!],
                ['y', measured.deltas[1]!],
                ['z', measured.deltas[2]!],
              ],
              units,
            )}`
          : ''}
      </p>
      <p className={styles['srOnly']} aria-live="polite">
        {announcement ?? ''}
      </p>
    </div>
  )
}
