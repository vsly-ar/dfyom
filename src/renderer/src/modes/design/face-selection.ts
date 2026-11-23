// Face selection in design mode (dogfood DF22): a click on a stock face, or Alt+click on a floor or
// tab top, selects that face; Add then creates the operation on it. The face lives in the design
// selection as `face:<surface id>` (one selection per mode). Pure.
// Doc: docs/conventions/ui.md#selection-and-picking, docs/modes/design.md#design-ui-task-36,
// docs/modes/design-v0.2.md#face-targets-generalised-on
import type { OperationKind } from '../../../../core/design/part.dto'
import { STOCK_FACES } from '../../../../core/design/surfaces'
import {
  DIRECTION,
  STOCK_FACE,
  localStock,
  type Direction,
  type StockSize,
} from '../../../../core/geometry/face'
import type { Vec3 } from '../../../../core/geometry/model'
import { surfaceLabel, type DesignPart } from './model'

export const FACE_PREFIX = 'face:'

/** The design selection id of a face. */
export const faceSelectionId = (surface: string): string => `${FACE_PREFIX}${surface}`

/** The surface id of a selected face, if the selection is one. */
export function faceSurfaceOf(selected: string | null): string | undefined {
  return selected?.startsWith(FACE_PREFIX) === true ? selected.slice(FACE_PREFIX.length) : undefined
}

export interface SelectedFace {
  readonly id: string
  /** "Stock top", "Pocket 1 floor". */
  readonly label: string
  readonly direction: Direction
  /** Nominal level below the stock face of its direction (0 on the stock face, −depth below). */
  readonly faceZ: number
  readonly stockFace: boolean
}

/** The face a surface id names when it may carry operations (a face target), else undefined. */
export function faceOf(part: DesignPart, surface: string): SelectedFace | undefined {
  const entry = part.table?.get(surface)
  if (entry === undefined || entry.isNone()) return undefined
  const e = entry.unwrap()
  if (!e.onTarget) return undefined
  return {
    id: e.id,
    label: surfaceLabel(part.dto, e.id),
    direction: e.direction,
    faceZ: e.faceZ.toNumber(),
    stockFace: STOCK_FACES.includes(e.id),
  }
}

/** The selected face, if the design selection is a face that still exists. */
export function selectedFace(
  part: DesignPart | undefined,
  selected: string | null,
): SelectedFace | undefined {
  const surface = faceSurfaceOf(selected)
  return part === undefined || surface === undefined ? undefined : faceOf(part, surface)
}

/**
 * What a viewport click selects (ui.md § Selection and picking): a stock face selects that face;
 * Alt+click selects any face target (a floor, a tab top); otherwise undefined (the operation).
 */
export function clickedFace(
  part: DesignPart | undefined,
  surface: string,
  alt: boolean,
): SelectedFace | undefined {
  if (part === undefined) return undefined
  const face = faceOf(part, surface)
  return face !== undefined && (face.stockFace || alt) ? face : undefined
}

/** Where Add puts an operation of `kind` with `face` selected: its `on` and the room it has there. */
export interface AddTarget {
  readonly on: string
  /** The face rectangle (`length` along `u`, `width` along `v`) and the material below the face. */
  readonly room: StockSize
}

/**
 * A pocket, drilling (and hole) start on the face itself; a facing or profile, which take stock
 * faces only, on the stock face of the same direction (design-v0.2.md § Face targets).
 */
export function addTarget(
  face: SelectedFace,
  kind: OperationKind | 'hole',
  stock: StockSize,
): AddTarget {
  const local = localStock(face.direction, stock)
  if (kind === 'facing' || kind === 'profile')
    return { on: STOCK_FACE[face.direction], room: local }
  return {
    on: face.id,
    room: { ...local, thickness: Math.max(0, local.thickness + face.faceZ) },
  }
}

/** A part-frame unit axis as text ("+X", "−Z"). */
export function axisText(v: Vec3): string {
  const i = v.findIndex((c) => c !== 0)
  return `${v[i]! > 0 ? '+' : '−'}${'XYZ'[i]}`
}

/** The face frame's `u` and `v` of a direction in part-frame terms. */
export function faceAxesText(direction: Direction): { u: string; v: string } {
  const d = DIRECTION[direction]
  return { u: axisText(d.u), v: axisText(d.v) }
}
