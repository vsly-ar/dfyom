import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector3,
} from 'three'
import { describe, expect, it } from 'vitest'
import { DIRECTION, DIRECTIONS } from '../../../core/geometry/face'
import { setupFrame, type WcsRotation } from '../../../core/toolpath/wcs'
import { viewportMessages as msg } from '../messages/viewport'
import { VIEW_PRESETS } from './camera'
import type { Vec3 } from './mesh'
import {
  cameraDirection,
  CHAMFER,
  CUBE_BOX_PX,
  CUBE_MARGIN_PX,
  CUBE_REGIONS,
  cubeColours,
  faceRegionOf,
  faceRight,
  inCubeBox,
  PRESET_REGION,
  presetDirection,
  regionAlong,
  regionColour,
  regionKey,
  regionKind,
  regionPolygon,
  regionShortcut,
  regionView,
  regionWords,
  screenUp,
  setupView,
  shownView,
  type CameraAxes,
  type CubeRegion,
  type CubeView,
} from './view-cube'

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const expectVec = (a: Vec3 | undefined, b: Vec3, digits = 6) => {
  expect(a).toBeDefined()
  for (let i = 0; i < 3; i++) expect(a![i]).toBeCloseTo(b[i]!, digits)
}
const name = (r: CubeRegion) => msg.cubeRegion(regionKind(r), regionWords(r))

/**
 * What the viewport's camera shows for a view: it goes to `cameraDirection(view)` with
 * `view.cameraUp` as its up vector (camera-controls keeps the up and looks at the target).
 */
function cameraOf(view: CubeView): CameraAxes & { right: Vec3 } {
  const back = cameraDirection(view)
  const up = screenUp(back, view.cameraUp)!
  return { back, up, right: cross(up, back) }
}

describe('view cube regions (ui-view-cube.md C2)', () => {
  it('has 26 distinct regions: 6 faces, 12 edges, 8 corners', () => {
    expect(CUBE_REGIONS).toHaveLength(26)
    expect(new Set(CUBE_REGIONS.map(regionKey)).size).toBe(26)
    const kinds = CUBE_REGIONS.map(regionKind)
    expect(kinds.filter((k) => k === 'face')).toHaveLength(6)
    expect(kinds.filter((k) => k === 'edge')).toHaveLength(12)
    expect(kinds.filter((k) => k === 'corner')).toHaveLength(8)
  })

  it('names regions vertical first, then front/back, then left/right; all names distinct', () => {
    expect(CUBE_REGIONS.slice(0, 6).map(name)).toEqual([
      'Top',
      'Bottom',
      'Front',
      'Right',
      'Back',
      'Left',
    ])
    expect(name([0, -1, 1])).toBe('Top front edge')
    expect(name([1, -1, 0])).toBe('Front right edge')
    expect(name([-1, 0, -1])).toBe('Bottom left edge')
    expect(name([1, -1, 1])).toBe('Top front right corner')
    expect(name([-1, 1, -1])).toBe('Bottom back left corner')
    expect(new Set(CUBE_REGIONS.map(name)).size).toBe(26)
  })

  it('gives the named views their shortcuts', () => {
    expect(regionShortcut([0, 0, 1])).toBe('1')
    expect(regionShortcut([0, -1, 0])).toBe('2')
    expect(regionShortcut([1, 0, 0])).toBe('3')
    expect(regionShortcut([1, -1, 1])).toBe('4')
    expect(regionShortcut([0, 0, -1])).toBe('Shift+1')
    expect(regionShortcut([0, 1, 0])).toBe('Shift+2')
    expect(regionShortcut([-1, 0, 0])).toBe('Shift+3')
    expect(regionShortcut([0, -1, 1])).toBeUndefined()
  })
})

describe('region → view', () => {
  it('a face looks straight at it, an edge from 45°, a corner isometrically', () => {
    expectVec(regionView([0, -1, 0]).direction, [0, -1, 0])
    expectVec(regionView([0, -1, 1]).direction, [0, -Math.SQRT1_2, Math.SQRT1_2])
    const s = 1 / Math.sqrt(3)
    expectVec(regionView([1, -1, 1]).direction, [s, -s, s]) // today's Iso
  })

  it('every region looks from its own direction with the screen up it promises', () => {
    for (const r of CUBE_REGIONS) {
      const view = regionView(r)
      const camera = cameraOf(view)
      expect(dot(camera.back, view.direction)).toBeGreaterThan(Math.cos(1e-3 * 1.01))
      expectVec(camera.up, view.up, 2)
    }
  })

  it('shows each face in its face frame: u right, v up (C3, design-v0.2 § Face frame)', () => {
    // the face-frame table of design-v0.2.md
    const table: Record<string, { u: Vec3; v: Vec3 }> = {
      '+z': { u: [1, 0, 0], v: [0, 1, 0] },
      '-z': { u: [1, 0, 0], v: [0, -1, 0] },
      '-y': { u: [1, 0, 0], v: [0, 0, 1] },
      '+x': { u: [0, 1, 0], v: [0, 0, 1] },
      '+y': { u: [-1, 0, 0], v: [0, 0, 1] },
      '-x': { u: [0, -1, 0], v: [0, 0, 1] },
    }
    for (const d of DIRECTIONS) {
      const n = DIRECTION[d].n as unknown as Vec3
      expectVec(DIRECTION[d].u as unknown as Vec3, table[d]!.u)
      const region = faceRegionOf(n)!
      const camera = cameraOf(regionView(region))
      expectVec(camera.right, table[d]!.u, 2)
      expectVec(camera.up, table[d]!.v, 2)
      expectVec(faceRight(n), table[d]!.u)
    }
  })

  it('keeps the named views as before and adds the opposite faces', () => {
    const top = presetDirection('top')
    expect(top[2]).toBeCloseTo(1, 5)
    expect(top[1]).toBeLessThan(0) // +Y up on screen
    expect(presetDirection('front')).toEqual([0, -1, 0])
    expect(presetDirection('right')).toEqual([1, 0, 0])
    const iso = presetDirection('iso')
    for (const c of iso) expect(Math.abs(c)).toBeCloseTo(1 / Math.sqrt(3), 9)
    expect(iso[0] > 0 && iso[1] < 0 && iso[2] > 0).toBe(true)
    const bottom = presetDirection('bottom')
    expect(bottom[2]).toBeCloseTo(-1, 5)
    expect(bottom[1]).toBeLessThan(0) // tilted towards the front: −Y up on screen
    expect(presetDirection('back')).toEqual([0, 1, 0])
    expect(presetDirection('left')).toEqual([-1, 0, 0])
    for (const p of VIEW_PRESETS) expect(regionKey(PRESET_REGION[p])).toBeTruthy()
  })
})

describe('setup view (C7)', () => {
  const stock = { length: 100, width: 60, thickness: 20 }
  it('looks down the spindle axis with WCS X right and Y up, for every face and rotation', () => {
    for (const d of DIRECTIONS)
      for (const rotation of [0, 90, 180, 270] as WcsRotation[]) {
        const frame = setupFrame(d, rotation, stock)
        const view = setupView(frame)
        const camera = cameraOf(view)
        expect(dot(camera.back, frame.n as unknown as Vec3)).toBeGreaterThan(0.999999)
        expectVec(camera.up, frame.v as unknown as Vec3, 2)
        expectVec(camera.right, frame.u as unknown as Vec3, 2)
        // the orbit axis stays +Z unless the screen up must be horizontal (a turned side setup)
        const sideTurned = d[1] !== 'z' && rotation !== 0
        expect(view.cameraUp[2] === 1).toBe(!sideTurned)
      }
  })

  it('names the setup view only when it differs from a region view', () => {
    const top0 = setupView(setupFrame('+z', 0, stock))
    expect(shownView(cameraOf(top0), top0)).toEqual({ kind: 'region', region: [0, 0, 1] })
    const top90 = setupView(setupFrame('+z', 90, stock))
    expect(shownView(cameraOf(top90), top90)).toEqual({ kind: 'setup' })
    expect(shownView(cameraOf(top90))).toEqual({ kind: 'custom' })
    // the outline still marks the face it looks at
    expect(regionAlong(cameraOf(top90))).toEqual([0, 0, 1])
  })
})

describe('which view the camera shows', () => {
  it('finds every region view and calls anything else custom', () => {
    for (const r of CUBE_REGIONS) {
      const camera = cameraOf(regionView(r))
      expect(shownView(camera)).toEqual({ kind: 'region', region: r })
      expect(regionAlong(camera)).toEqual(r)
    }
    const nearly: CameraAxes = {
      back: [0.02, -1, 0],
      up: [0, 0, 1],
    }
    expect(shownView(nearly)).toEqual({ kind: 'custom' })
    expect(regionAlong(nearly)).toBeUndefined()
  })

  it('a top view turned about the view axis is not Top, but is along it', () => {
    const turned: CameraAxes = { back: [0, 0, 1], up: [1, 0, 0] }
    expect(shownView(turned)).toEqual({ kind: 'custom' })
    expect(regionAlong(turned)).toEqual([0, 0, 1])
  })
})

describe('region polygons and hit-testing', () => {
  const e = 1 - CHAMFER
  it('faces are squares, edges strips, corners triangles, counter-clockwise from outside', () => {
    for (const r of CUBE_REGIONS) {
      const p = regionPolygon(r)
      expect(p).toHaveLength(regionKind(r) === 'corner' ? 3 : 4)
      const n = cross(
        [p[1]![0] - p[0]![0], p[1]![1] - p[0]![1], p[1]![2] - p[0]![2]],
        [p[2]![0] - p[0]![0], p[2]![1] - p[0]![1], p[2]![2] - p[0]![2]],
      )
      const len = Math.hypot(...n)
      expectVec([n[0] / len, n[1] / len, n[2] / len], regionView(r).direction)
      // every vertex lies on the chamfered cube: one coordinate at ±1, the others within ±e
      for (const v of p) {
        expect(Math.max(...v.map(Math.abs))).toBeCloseTo(1, 9)
        expect(v.filter((c) => Math.abs(c) < 1 - 1e-9).every((c) => Math.abs(c) <= e + 1e-9)).toBe(
          true,
        )
      }
    }
    // a face starts at its lower-left corner in the face frame
    expectVec(regionPolygon([0, 0, -1])[0], [-e, e, -1]) // bottom: u = +X, v = −Y
  })

  it('a ray from outside hits the region it aims at, edges and corners included', () => {
    const meshes = CUBE_REGIONS.map((r) => {
      const p = regionPolygon(r)
      const positions: number[] = []
      for (let i = 1; i + 1 < p.length; i++) positions.push(...p[0]!, ...p[i]!, ...p[i + 1]!)
      const g = new BufferGeometry()
      g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
      const m = new Mesh(g, new MeshBasicMaterial({ side: DoubleSide }))
      m.userData['region'] = r
      return m
    })
    const raycaster = new Raycaster()
    const hit = (from: Vec3, towards: Vec3 = [0, 0, 0]): CubeRegion | undefined => {
      const o = new Vector3(...from)
      raycaster.set(o, new Vector3(...towards).sub(o).normalize())
      return raycaster.intersectObjects(meshes)[0]?.object.userData['region'] as
        CubeRegion | undefined
    }
    for (const r of CUBE_REGIONS) {
      const d = regionView(r).direction
      expect(hit([d[0] * 5, d[1] * 5, d[2] * 5])).toEqual(r)
    }
    // straight down near the top face's front border: the face, then the top front edge strip
    expect(hit([0, -(e - 0.02), 5], [0, -(e - 0.02), 0])).toEqual([0, 0, 1])
    expect(hit([0, -(e + 0.05), 5], [0, -(e + 0.05), 0])).toEqual([0, -1, 1])
  })
})

describe('look and layout', () => {
  const colours = cubeColours({
    '--bg-raised': '#ffffff',
    '--bg-hover': 'rgb(28 33 33 / 0.06)',
    '--border-control': '#848d9b',
    '--accent': '#f5b700',
    '--text': '#1c2121',
    '--text-muted': '#5b6462',
  })

  it('reads the tokens, the hover alpha included', () => {
    expect(colours.face).toEqual([1, 1, 1])
    expect(colours.hoverAlpha).toBeCloseTo(0.06, 9)
  })

  it('shades faces by orientation (top lightest, bottom darkest) and tints the hovered one', () => {
    const l = (r: CubeRegion) => regionColour(r, colours)[0]
    expect(l([0, 0, 1])).toBeGreaterThan(l([0, -1, 0]))
    expect(l([0, -1, 0])).toBeGreaterThan(l([1, 0, 0]))
    expect(l([1, 0, 0])).toBeGreaterThan(l([0, 0, -1]))
    expect(l([0, 0, -1])).toBeGreaterThan(0.8) // a slight step, not a dark face
    const hovered = regionColour([0, 0, 1], colours, 1)
    const rest = regionColour([0, 0, 1], colours)
    expect(hovered[0]).toBeCloseTo(rest[0] * 0.94 + (28 / 255) * 0.06, 6)
  })

  it('takes the pointer only inside its square at the top right', () => {
    const rect = { top: 100, right: 1000 }
    const right = 1000 - CUBE_MARGIN_PX
    const top = 100 + CUBE_MARGIN_PX
    expect(inCubeBox(right - 1, top + 1, rect)).toBe(true)
    expect(inCubeBox(right - CUBE_BOX_PX + 1, top + CUBE_BOX_PX - 1, rect)).toBe(true)
    expect(inCubeBox(right + 2, top + 1, rect)).toBe(false)
    expect(inCubeBox(right - CUBE_BOX_PX - 2, top + 1, rect)).toBe(false)
    expect(inCubeBox(right - 1, top + CUBE_BOX_PX + 2, rect)).toBe(false)
    // moved left beside an overlay
    expect(inCubeBox(right - 1, top + 1, rect, 300)).toBe(false)
    expect(inCubeBox(right - 301, top + 1, rect, 300)).toBe(true)
  })
})
