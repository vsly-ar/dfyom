// The clone path's drawing maths (v0.4 task U3), pure: the path data (from `design.clones.preview`
// or the stored feature) placed on the Clones' face as the overlay the viewport draws – the
// reference chain per row (the focused row's segment amber), an arc's centre cross and dashed
// construction circle, a marker per numbered position (the source "1" with a ring), the source's
// footprint as ghosts at draft positions (solid) and skipped ones (dashed) – and which instance
// numbers show, hiding those whose markers sit closer than 24 px on screen.
// Doc: docs/conventions/ui.md#clone-path-in-the-viewport
import type { Vec3 } from './mesh'

type UV = readonly [number, number]

/** The path in the face frame (mm): instance 1 is the source; rows in path order. */
export interface ClonePathData {
  readonly instances: readonly { readonly n: number; readonly at: UV }[]
  readonly rows: readonly {
    /** What to draw: straight through the positions, along the arc or the shape. */
    readonly path: readonly UV[]
    readonly centre?: UV
    readonly points: readonly {
      readonly at: UV
      readonly kind: 'clone' | 'skipped' | 'closes' | 'duplicate' | 'onLine'
      readonly n?: number
    }[]
  }[]
}

export type CloneMarkerState = 'source' | 'clone' | 'skipped' | 'duplicate'

export interface CloneMarker {
  readonly n: number
  readonly at: Vec3
  readonly state: CloneMarkerState
  /** Its reference point is off the stock face (`dfm.cloneOutsideStock`): the warning triangle. */
  readonly outside: boolean
  /** Accessible name: "Clone 4 at u 9.00 mm, v 15.59 mm, skipped". */
  readonly label: string
  /** Hover chip of a clickable marker ("Clone 4 · click to skip"); none: just the number. */
  readonly hint?: string
}

export interface ClonePathOverlay {
  readonly rows: readonly {
    readonly line: readonly Vec3[]
    readonly focused: boolean
    readonly centre?: Vec3
    /** The arc's construction circle (dashed). */
    readonly circle?: readonly Vec3[]
  }[]
  readonly markers: readonly CloneMarker[]
  /** The face's unit axes in the part frame (an arc centre's cross lies in the face). */
  readonly axes: { readonly u: Vec3; readonly v: Vec3 }
  /** The source's footprint at instance positions: draft clones solid, skipped dashed. */
  readonly ghosts: readonly {
    readonly loops: readonly (readonly Vec3[])[]
    readonly dashed: boolean
  }[]
  /** Click (and Space) on a marker toggles its skip: the Clones feature is selected. */
  readonly interactive: boolean
  /** Tooltip of the source marker while interactive ("The source can't be skipped."). */
  readonly sourceHint?: string
  onToggle(n: number): void
}

/** Where a face point lands in the part frame, and a face vector. */
export interface FacePlacement {
  at(u: number, v: number): Vec3
  shift(du: number, dv: number): Vec3
}

export interface OverlayOptions {
  /** The focused row (amber segment), or null. */
  readonly focusedRow: number | null
  /** Footprint loops of the source in the part frame (at instance 1). */
  readonly footprint: readonly (readonly Vec3[])[]
  /** A draft: every clone a solid ghost (nothing is cut yet). */
  readonly draft: boolean
  readonly interactive: boolean
  /** Instance numbers off the stock face. */
  readonly outside: ReadonlySet<number>
  label(n: number, at: UV, skipped: boolean): string
  hint?(n: number, skipped: boolean): string | undefined
  readonly sourceHint?: string
  onToggle(n: number): void
}

/** Samples of an arc's construction circle. */
const CIRCLE_SAMPLES = 72

/** The path data as the overlay the viewport draws. */
export function clonePathOverlay(
  data: ClonePathData,
  face: FacePlacement,
  o: OverlayOptions,
): ClonePathOverlay {
  const at = (p: UV) => face.at(p[0], p[1])
  const origin = data.instances[0]?.at ?? [0, 0]
  const rows = data.rows.map((r, i) => {
    const centre = r.centre
    let circle: Vec3[] | undefined
    if (centre !== undefined && r.path.length > 0) {
      const p0 = r.path[0]!
      const radius = Math.hypot(p0[0] - centre[0], p0[1] - centre[1])
      circle = Array.from({ length: CIRCLE_SAMPLES + 1 }, (_, k) => {
        const t = (k / CIRCLE_SAMPLES) * 2 * Math.PI
        return face.at(centre[0] + radius * Math.cos(t), centre[1] + radius * Math.sin(t))
      })
    }
    return {
      line: r.path.map(at),
      focused: o.focusedRow === i,
      ...(centre === undefined ? {} : { centre: at(centre) }),
      ...(circle === undefined ? {} : { circle }),
    }
  })
  const markers: CloneMarker[] = [
    {
      n: 1,
      at: at(origin),
      state: 'source',
      outside: false,
      label: o.label(1, origin, false),
    },
  ]
  const ghost = (p: UV, dashed: boolean) => {
    const d = face.shift(p[0] - origin[0], p[1] - origin[1])
    return {
      loops: o.footprint.map((l) => l.map((q): Vec3 => [q[0] + d[0], q[1] + d[1], q[2] + d[2]])),
      dashed,
    }
  }
  const ghosts: { loops: Vec3[][]; dashed: boolean }[] = []
  for (const r of data.rows)
    for (const p of r.points) {
      // a mirror image on its original is dropped silently (clones-mirror.md, Q165)
      if (p.n === undefined || p.kind === 'closes' || p.kind === 'onLine') continue
      const skipped = p.kind === 'skipped'
      const hint = o.interactive && p.kind !== 'duplicate' ? o.hint?.(p.n, skipped) : undefined
      markers.push({
        n: p.n,
        at: at(p.at),
        state: p.kind,
        outside: o.outside.has(p.n),
        label: o.label(p.n, p.at, skipped),
        ...(hint === undefined ? {} : { hint }),
      })
      if (skipped) ghosts.push(ghost(p.at, true))
      else if (o.draft && p.kind === 'clone') ghosts.push(ghost(p.at, false))
    }
  markers.sort((a, b) => a.n - b.n)
  return {
    rows,
    markers,
    axes: { u: face.shift(1, 0), v: face.shift(0, 1) },
    ghosts,
    interactive: o.interactive,
    ...(o.sourceHint === undefined ? {} : { sourceHint: o.sourceHint }),
    onToggle: o.onToggle,
  }
}

/** Instance numbers hide where markers sit closer than this on screen (px). */
export const CHIP_MIN_PX = 24

/**
 * Which markers show their number: those with no other marker within `min` px on screen (`null`:
 * behind the camera or off screen, never shown and never crowding others).
 */
export function chipsShown(
  screen: readonly (readonly [number, number] | null)[],
  min: number = CHIP_MIN_PX,
): boolean[] {
  const shown = screen.map((p) => p !== null)
  const n = screen.length
  for (let i = 0; i < n; i++) {
    const a = screen[i]
    if (a == null) continue
    for (let j = i + 1; j < n; j++) {
      const b = screen[j]
      if (b == null) continue
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < min) {
        shown[i] = false
        shown[j] = false
      }
    }
  }
  return shown
}
