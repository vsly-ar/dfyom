/**
 * Split parts 4c: a piece's blank. The library stocks a piece may be cut from, the automatic
 * choice (smallest volume of the source's material class that holds the piece's need, turned 0°
 * or 90° about Z) and the resolution of the user's choice (kept by the piece's number; a chosen
 * stock that no longer holds the piece falls back to the own block). Pure.
 * Doc: docs/modes/split-parts.md#implementation-4c
 */
import type { Library } from '../../library/library'
import type { MaterialClass } from '../../library/item'
import { Stock } from '../../library/stock'
import type { StockValuesDTO } from '../../library/stock.dto'
import type { PieceBlankDTO } from '../part.dto'

/** Lengths within this (mm) fit. */
const FIT_EPS = 1e-6

/** Length, width, thickness (mm). */
export type Size3 = readonly [number, number, number]

/** A library block stock as a blank option. */
export interface StockOption {
  readonly id: string
  readonly name: string
  readonly size: Size3
  readonly material: { readonly name: string; readonly class: MaterialClass }
  readonly values: StockValuesDTO
}

/** Every readable block stock of the library (none without a library). */
export function libraryStockOptions(library: Library | undefined): StockOption[] {
  if (library === undefined) return []
  return library.list('stock').items.flatMap((i) =>
    i.values instanceof Stock && i.values.shape === 'block'
      ? [
          {
            id: i.id,
            name: i.values.name,
            size: [
              i.values.length.canonical,
              i.values.width.canonical,
              i.values.thickness.canonical,
            ] as const,
            material: { name: i.values.material.name, class: i.values.material.class },
            values: i.values.toDTO(),
          },
        ]
      : [],
  )
}

/** How a box holds a need: 0 (as is), 90 (turned about Z) or undefined (it does not). */
export function holds(need: Size3, box: Size3): 0 | 90 | undefined {
  if (need[2] > box[2] + FIT_EPS) return undefined
  if (need[0] <= box[0] + FIT_EPS && need[1] <= box[1] + FIT_EPS) return 0
  if (need[0] <= box[1] + FIT_EPS && need[1] <= box[0] + FIT_EPS) return 90
  return undefined
}

/** How far a need is from fitting a box (0 = fits), turned 0° or 90°. */
export function shortOf(need: Size3, box: Size3): number {
  const t = Math.max(0, need[2] - box[2])
  const a = Math.max(need[0] - box[0], need[1] - box[1], 0)
  const b = Math.max(need[0] - box[1], need[1] - box[0], 0)
  return Math.max(t, Math.min(a, b))
}

const volume = (s: Size3) => s[0] * s[1] * s[2]

/**
 * The automatic choice: the library stocks of the material's class that hold the need, smallest
 * volume first, then the same material name, then by name; undefined = none.
 */
export function autoStock(
  need: Size3,
  options: readonly StockOption[],
  material: { readonly name: string; readonly class: MaterialClass },
): StockOption | undefined {
  const same = (o: StockOption) =>
    o.material.name.trim().toLowerCase() === material.name.trim().toLowerCase() ? 0 : 1
  return options
    .filter((o) => o.material.class === material.class && holds(need, o.size) !== undefined)
    .sort(
      (a, b) =>
        volume(a.size) - volume(b.size) ||
        same(a) - same(b) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )[0]
}

/** A piece's blank as resolved for a regeneration. */
export interface ResolvedBlank {
  /** The blank's sizes in the piece frame (turned when `rotation` is 90). */
  readonly size: Size3
  /** The library stock it is cut from; undefined = the own block (the need). */
  readonly stock: StockOption | undefined
  readonly rotation: 0 | 90
  /** The user's choice could not be kept: the chosen stock, and why. */
  readonly fallback?: {
    readonly libraryItemId: string
    readonly name: string | undefined
    readonly reason: 'missing' | 'short'
    readonly short: number
  }
  /** The record stored on the piece. */
  readonly record: PieceBlankDTO | undefined
}

/** A stock's sizes in the piece frame. */
const turned = (s: Size3, rotation: 0 | 90): Size3 => (rotation === 90 ? [s[1], s[0], s[2]] : s)

/**
 * The blank of a piece of `need`: the user's choice (kept), else with `useStocks` the automatic
 * choice, else the own block. A chosen stock missing or too small falls back to the own block.
 */
export function resolveBlank(
  need: Size3,
  choice: PieceBlankDTO['choice'],
  useStocks: boolean,
  options: readonly StockOption[],
  material: { readonly name: string; readonly class: MaterialClass },
): ResolvedBlank {
  const own = (extra: Partial<ResolvedBlank> = {}): ResolvedBlank => ({
    size: need,
    stock: undefined,
    rotation: 0,
    record: choice === undefined ? undefined : { choice },
    ...extra,
  })
  const on = (stock: StockOption): ResolvedBlank => {
    const rotation = holds(need, stock.size)!
    return {
      size: turned(stock.size, rotation),
      stock,
      rotation,
      record: {
        libraryItemId: stock.id,
        ...(rotation === 90 ? { rotation: 90 as const } : {}),
        ...(choice === undefined ? {} : { choice }),
      },
    }
  }
  if (choice?.kind === 'own') return own()
  if (choice?.kind === 'library') {
    const stock = options.find((o) => o.id === choice.libraryItemId)
    if (stock === undefined)
      return own({
        fallback: {
          libraryItemId: choice.libraryItemId,
          name: undefined,
          reason: 'missing',
          short: 0,
        },
      })
    if (holds(need, stock.size) === undefined)
      return own({
        fallback: {
          libraryItemId: stock.id,
          name: stock.name,
          reason: 'short',
          short: shortOf(need, stock.size),
        },
      })
    return on(stock)
  }
  if (!useStocks) return own()
  const auto = autoStock(need, options, material)
  return auto === undefined ? own() : on(auto)
}

/** The library stock's values as a blank's, its length and width swapped when turned. */
export function blankValues(stock: StockOption, rotation: 0 | 90): StockValuesDTO {
  const v = stock.values
  return rotation === 90 ? { ...v, length: v.width, width: v.length } : v
}
