import { describe, expect, it } from 'vitest'
import { contourParam, offsetContour, perimeter } from '../geometry/contour'
import type { AnalyticContour as Contour, Vec2 } from '../geometry/model'
import { slotCoversOpening } from '../geometry/operations'
import { analyticTabCentres } from '../geometry/tab-hold'
import type { ProfileOperation, ToolpathTool } from './model'
import { generateProfile } from './profile'
import { endMill, profileInput } from './testing/fixtures'
import { Heightmap, insideDistance, render, samples, steps } from './testing/oracles'
import { cuttingLevels, feedDepths, stepsWithin, violations } from './testing/rules'

const stock = { length: 60, width: 40, thickness: 6 }
const rect = (length: number, width: number, cornerRadius: number): Contour => ({
  kind: 'rectangle',
  length,
  width,
  cornerRadius,
})
const profile = (
  contour: Contour,
  side: 'outside' | 'inside',
  slotWidth: number,
  tabs = { count: 4, width: 4, thickness: 2 },
): ProfileOperation => ({
  kind: 'profile',
  id: 'profile1',
  shape: { center: [30, 20], contour },
  side,
  slotWidth,
  tabs,
})

function random(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31
    return s / 2 ** 31
  }
}

/**
 * Independent tab oracle: is `q` in the slot within a tab's stretch of the shape? The centres are
 * the count rule's, with tabs over free sides of `stock` moved (`analyticTabCentres`, tested in
 * geometry/tab-hold.test.ts).
 */
const centreCache = new WeakMap<ProfileOperation, readonly number[]>()
function centresOf(op: ProfileOperation): readonly number[] {
  let c = centreCache.get(op)
  if (c === undefined)
    centreCache.set(op, (c = analyticTabCentres(op, stock, op.tabs.count).centres))
  return c
}
function inTab(op: ProfileOperation, q: Vec2): boolean {
  const { contour } = op.shape
  const c = op.shape.center
  const d = insideDistance(contour, c, q)
  const inSlot = op.side === 'outside' ? d <= 0 && d >= -op.slotWidth : d >= 0 && d <= op.slotWidth
  if (!inSlot || op.tabs.count === 0 || slotCoversOpening(op)) return false
  const P = perimeter(contour)
  const s = contourParam(contour, [q[0] - c[0], q[1] - c[1]])
  for (const center of centresOf(op)) {
    const off = ((((s - center) % P) + P * 1.5) % P) - P / 2
    if (Math.abs(off) <= op.tabs.width / 2) return true
  }
  return false
}

function checkProfile(op: ProfileOperation, tool: ToolpathTool, over = {}) {
  const input = profileInput(stock, op, tool, over)
  const tp = generateProfile(input).unwrap()
  const R = tool.diameter / 2
  const c = op.shape.center
  const T = stock.thickness
  const bottom = -T - input.strategy.breakthrough
  const covers = slotCoversOpening(op)
  const inset = offsetContour(op.shape.contour, op.slotWidth).into()
  const contains = (p: readonly number[]) => {
    if (p[2]! > 1e-9) return true
    if (p[2]! < bottom - 1e-9) return false
    const xy: Vec2 = [p[0]!, p[1]!]
    const d = insideDistance(op.shape.contour, c, xy)
    if (op.side === 'outside') return d <= -R + 1e-9 && d >= -(op.slotWidth - R) - 1e-9
    if (d < R - 1e-9) return false
    return covers || inset === undefined || -insideDistance(inset, c, xy) >= R - 1e-9
  }
  expect(
    violations(tp, {
      feedRate: input.cutting.feedRate,
      plungeRate: input.cutting.plungeRate,
      rampAngle: input.strategy.rampAngle,
      retractZ: 2,
      clearanceZ: 10,
      targetZ: bottom,
      contains,
    }),
  ).toEqual([])
  const rough = cuttingLevels(tp, 'rough')
  expect(rough.at(-1)).toBeCloseTo(bottom, 12)
  expect(stepsWithin(rough, 0, input.cutting.stepdown)).toBe(true)

  // tabs: no cut below the tab top touches a tab (probes up to the tool radius − 1 µm)
  const tabTop = -T + op.tabs.thickness
  const probes: Vec2[] = [[0, 0]]
  for (const r of [0.5, 1])
    for (let k = 0; k < 32; k++) {
      const a = (k * Math.PI) / 16
      probes.push([(R - 0.001) * r * Math.cos(a), (R - 0.001) * r * Math.sin(a)])
    }
  const bad: string[] = []
  for (const s of steps(tp)) {
    if (s.move.kind === 'rapid') continue
    if (Math.min(s.from[2], s.move.to[2]) >= tabTop - 1e-6) continue
    for (const p of samples(s, 0.25))
      if (p[2] < tabTop - 1e-6 && probes.some(([x, y]) => inTab(op, [p[0] + x, p[1] + y])))
        bad.push(`cuts a tab at ${p.map((n) => n.toFixed(3))}`)
  }
  expect(bad.slice(0, 3)).toEqual([])
  return { input, tp }
}

describe('generateProfile', () => {
  it('golden: outside rectangle, ramp entry, two tabs, finishing', async () => {
    const op = profile(rect(20, 10, 2), 'outside', 4, { count: 2, width: 3, thickness: 1.5 })
    const input = profileInput(
      { length: 40, width: 30, thickness: 3 },
      { ...op, shape: { ...op.shape, center: [20, 15] } },
      endMill(3),
      {
        cutting: {
          spindleSpeed: 18000,
          feedRate: 1200,
          plungeRate: 300,
          stepdown: 1.5,
          stepover: 1.2,
        },
      },
    )
    await expect(render(generateProfile(input).unwrap())).toMatchFileSnapshot(
      '__golden__/profile-outside-tabs.txt',
    )
  })

  it('golden: inside circle, plunge entry, no tabs', async () => {
    const op = profile({ kind: 'circle', radius: 8 }, 'inside', 3, {
      count: 0,
      width: 4,
      thickness: 2,
    })
    const input = profileInput({ length: 40, width: 30, thickness: 3 }, op, endMill(3), {
      strategy: {
        entry: 'plunge',
        rampAngle: 3,
        breakthrough: 0.5,
        finishAllowance: 0,
        direction: 'climb',
      },
      cutting: {
        spindleSpeed: 18000,
        feedRate: 1200,
        plungeRate: 300,
        stepdown: 1.5,
        stepover: 1.2,
      },
    })
    await expect(render(generateProfile(input).unwrap())).toMatchFileSnapshot(
      '__golden__/profile-inside-circle.txt',
    )
  })

  // profiles checked on a heightmap: ~1 s alone, several times that
  // under a loaded parallel `npm test` (docs/conventions/testing.md#commands)
  it('cuts outside and inside slots with tabs left at their height', { timeout: 60_000 }, () => {
    checkProfile(profile(rect(30, 20, 3), 'outside', 6), endMill(6))
    checkProfile(profile(rect(30, 20, 3), 'outside', 10), endMill(4))
    // 4 mm from the stock front: the front tab moves off the free side (TB1), the cut lifts there
    const nearFront = profile(rect(30, 20, 3), 'outside', 6)
    const moved = { ...nearFront, shape: { ...nearFront.shape, center: [30, 14] as Vec2 } }
    expect(centresOf(moved)[0]).not.toBeCloseTo(12, 3)
    checkProfile(moved, endMill(6))
    checkProfile(profile(rect(30, 24, 4), 'inside', 6), endMill(6))
    checkProfile(profile(rect(30, 24, 1), 'inside', 7), endMill(4)) // corners smaller than the slot
    checkProfile(
      profile({ kind: 'circle', radius: 12 }, 'inside', 5, { count: 3, width: 5, thickness: 1 }),
      endMill(3),
    )
    checkProfile(profile({ kind: 'circle', radius: 6 }, 'inside', 6), endMill(4)) // slot covers the opening
    // tabs on corners
    checkProfile(
      profile(rect(30, 20, 5), 'outside', 6, { count: 5, width: 6, thickness: 2 }),
      endMill(6),
    )
  })

  it('material by sampling: the slot through, tabs at their top, the part untouched', () => {
    const op = profile(rect(36, 20, 4), 'outside', 6, { count: 4, width: 5, thickness: 2 })
    const tool = endMill(6)
    const { tp } = checkProfile(op, tool)
    const map = new Heightmap(stock.length, stock.width, 0.25)
    map.sweep(tool, tp)
    const problems: string[] = []
    let tabCells = 0
    for (let i = 0; i < map.nx; i++)
      for (let j = 0; j < map.ny; j++) {
        const p = map.center(i, j)
        const h = Math.max(map.z[j * map.nx + i]!, -6)
        const d = insideDistance(op.shape.contour, op.shape.center, p)
        const tab = inTab(op, p)
        if (d > 0.02 || d < -6.02) {
          if (h !== 0) problems.push(`touched at ${p}: ${h}`)
        } else if (tab) {
          tabCells++
          if (h < -4 - 1e-6) problems.push(`tab cut at ${p}: ${h}`)
          if (d < -0.3 && d > -5.7 && h > -4 + 1e-6)
            problems.push(`tab top not at its height at ${p}: ${h}`)
        } else if (d < -0.02 && d > -5.98) {
          // the slot is cut through, except where the tool lifts within its radius of a tab
          const nearTab = [0, 1, 2, 3, 4, 5, 6, 7].some((k) => {
            const a = (k * Math.PI) / 4
            return inTab(op, [p[0] + 3.05 * Math.cos(a), p[1] + 3.05 * Math.sin(a)])
          })
          if (!nearTab && h > -6 + 1e-6) problems.push(`slot left at ${p}: ${h}`)
        }
      }
    expect(problems.slice(0, 5)).toEqual([])
    expect(tabCells).toBeGreaterThan(100)
  })

  it('40 seeded random profiles keep every property', { timeout: 60_000 }, () => {
    const rnd = random(11)
    let checked = 0
    for (let n = 0; n < 40; n++) {
      const D = [2, 3, 4, 6][Math.floor(rnd() * 4)]!
      const side = rnd() < 0.5 ? 'outside' : 'inside'
      const sw = D + (rnd() < 0.5 ? 0 : rnd() * 2 * D)
      const size = side === 'inside' ? 2 * sw + 4 + rnd() * 20 : 4 + rnd() * 25
      const contour: Contour =
        rnd() < 0.3
          ? { kind: 'circle', radius: size / 2 }
          : rect(
              size + rnd() * 10,
              size,
              Math.min(size / 2, (side === 'inside' ? D / 2 : 0) + rnd() * 5),
            )
      const tabs = {
        count: Math.floor(rnd() * 6),
        width: 1 + rnd() * 6,
        thickness: 0.5 + rnd() * 4,
      }
      const op = profile(contour, side, sw, tabs)
      if (tabs.count * tabs.width >= perimeter(contour)) continue
      checked++
      const base = profileInput(stock, op, endMill(D))
      checkProfile(op, endMill(D), {
        strategy: {
          ...base.strategy,
          entry: n % 2 === 0 ? 'ramp' : 'plunge',
          rampAngle: 1 + rnd() * 20,
          finishAllowance: rnd() < 0.5 ? 0 : 0.3,
          direction: rnd() < 0.5 ? 'climb' : 'conventional',
        },
        cutting: { ...base.cutting, stepover: (0.3 + rnd() * 0.7) * D, stepdown: 0.5 + rnd() * 3 },
      })
    }
    expect(checked).toBeGreaterThan(30)
  })

  it('climb runs clockwise outside and counter-clockwise inside', () => {
    const turn = (side: 'outside' | 'inside', direction: 'climb' | 'conventional') => {
      const op = profile({ kind: 'circle', radius: 10 }, side, 4, {
        count: 0,
        width: 1,
        thickness: 1,
      })
      const base = profileInput(stock, op, endMill(4))
      const tp = generateProfile({ ...base, strategy: { ...base.strategy, direction } }).unwrap()
      const arc = steps(tp).find((s) => s.move.kind === 'arc')!.move
      return arc.kind === 'arc' && arc.cw ? 'cw' : 'ccw'
    }
    expect(turn('outside', 'climb')).toBe('cw')
    expect(turn('inside', 'climb')).toBe('ccw')
    expect(turn('outside', 'conventional')).toBe('ccw')
  })

  it('golden: outside rectangle, 4 tabs, two slot passes', async () => {
    const op = profile(rect(30, 20, 3), 'outside', 8, { count: 4, width: 4, thickness: 1.5 })
    const input = profileInput({ length: 60, width: 40, thickness: 3 }, op, endMill(6), {
      cutting: { spindleSpeed: 18000, feedRate: 1200, plungeRate: 300, stepdown: 1.5, stepover: 2 },
    })
    await expect(render(generateProfile(input).unwrap())).toMatchFileSnapshot(
      '__golden__/profile-outside-4-tabs.txt',
    )
  })

  // docs/modes/plan-v0.1.md#finishing-defaults-hardening-df75-df76 and
  // docs/architecture/feeds-speeds.md#finishing-pass-feed-hardening-df74
  it('finishes in levels of finishStepdown at the finishing feed (DF74, DF76)', () => {
    const op = profile(rect(30, 20, 3), 'outside', 8, { count: 0, width: 4, thickness: 1.5 })
    const base = profileInput(stock, op, endMill(6))
    const finishOf = (over: object) => {
      const tp = generateProfile({ ...base, ...over }).unwrap()
      const finish = tp.passes.filter((p) => p.kind === 'finish').flatMap((p) => p.moves)
      const cuts = finish.flatMap((m) =>
        (m.kind === 'line' || m.kind === 'arc') && m.feed !== base.cutting.plungeRate ? [m] : [],
      )
      return {
        levels: [...new Set(cuts.map((m) => Math.round(m.to[2] * 1e6) / 1e6))],
        feeds: [...new Set(cuts.map((m) => m.feed))],
      }
    }
    // absent: one level at the full depth (6 + 0.5 breakthrough), at the feed rate
    expect(finishOf({})).toEqual({ levels: [-6.5], feeds: [base.cutting.feedRate] })
    // 2.5 mm: three equal levels of 6.5 / 3, at the finishing feed
    const levels = finishOf({
      strategy: { ...base.strategy, finishStepdown: 2.5 },
      cutting: { ...base.cutting, finishFeedRate: 2345 },
    })
    expect(levels.feeds).toEqual([2345])
    expect(levels.levels.map((z) => Math.round(z * 1000) / 1000)).toEqual([-2.167, -4.333, -6.5])
    // the roughing passes keep the feed rate
    const tp = generateProfile({
      ...base,
      cutting: { ...base.cutting, finishFeedRate: 2345 },
    }).unwrap()
    for (const p of tp.passes.filter((x) => x.kind === 'rough'))
      for (const m of p.moves) if (m.kind !== 'rapid') expect(m.feed).not.toBe(2345)
  })

  /** Radii (from the shape center) of the arcs at the last level, in cutting order. */
  const lastLevelRadii = (op: ProfileOperation, tool: ToolpathTool) => {
    const tp = generateProfile(profileInput(stock, op, tool)).unwrap()
    const rough = tp.passes.filter((p) => p.kind === 'rough').at(-1)!
    const radii: number[] = []
    for (const m of rough.moves)
      if (m.kind === 'arc' && m.to[2] === -6.5) {
        const r = Math.hypot(m.to[0] - 30, m.to[1] - 20)
        if (radii.length === 0 || Math.abs(radii.at(-1)! - r) > 1e-6) radii.push(r)
      }
    return radii
  }

  it('an inside slot that covers the opening is cleared from the center outwards', () => {
    const op = profile({ kind: 'circle', radius: 10 }, 'inside', 10, {
      count: 0,
      width: 1,
      thickness: 1,
    })
    const radii = lastLevelRadii(op, endMill(6))
    expect(radii.length).toBeGreaterThan(2)
    for (let i = 1; i < radii.length; i++) expect(radii[i]!).toBeGreaterThan(radii[i - 1]!)
    checkProfile(op, endMill(6))
  })

  it('multi-pass slots cut the offcut side first and the part side last', () => {
    const outside = lastLevelRadii(
      profile({ kind: 'circle', radius: 8 }, 'outside', 10),
      endMill(4),
    )
    expect(outside.length).toBeGreaterThan(1)
    for (let i = 1; i < outside.length; i++) expect(outside[i]!).toBeLessThan(outside[i - 1]!)
    const inside = lastLevelRadii(profile({ kind: 'circle', radius: 15 }, 'inside', 10), endMill(4))
    expect(inside.length).toBeGreaterThan(1)
    for (let i = 1; i < inside.length; i++) expect(inside[i]!).toBeGreaterThan(inside[i - 1]!)
  })

  it('a hole the size of the tool is plunged level by level to full depth', () => {
    for (const [radius, finishAllowance] of [
      [3, 0.2],
      [3, 0],
      [2.995, 0],
    ] as const)
      for (const entry of ['ramp', 'plunge'] as const) {
        const op = profile({ kind: 'circle', radius }, 'inside', 6, {
          count: 0,
          width: 1,
          thickness: 1,
        })
        const base = profileInput(stock, op, endMill(6))
        const tp = generateProfile({
          ...base,
          strategy: { ...base.strategy, entry, finishAllowance },
        }).unwrap()
        expect(
          violations(tp, {
            feedRate: 1200,
            plungeRate: 300,
            retractZ: 2,
            clearanceZ: 10,
            targetZ: -6.5,
            contains: (p) =>
              p[2] > 1e-9 || (p[2] >= -6.5 - 1e-9 && Math.hypot(p[0] - 30, p[1] - 20) <= 1e-9),
          }),
        ).toEqual([])
        expect(stepsWithin(feedDepths(tp), 0, base.cutting.stepdown)).toBe(true)
      }
  })

  it('rejects a tool wider than the slot', () => {
    const r = generateProfile(
      profileInput(stock, profile(rect(20, 10, 2), 'outside', 4), endMill(6)),
    )
    expect(r.unwrapErr().code).toBe('plan.check')
  })
})
