// The design scene's Clones layer (v0.4 task U3): the clone path while a Clones feature is
// selected (its stored path, click-to-skip markers, skipped positions as dashed footprint ghosts)
// or the Make Clones… draft is open (the last preview's positions, every clone a solid ghost), the
// focused row's segment amber; a Clones selection also draws its source selected; a selected
// instance draws the source's outline thin and dashed. The viewport summary names the state.
// DF126 M2: each mirror row's line dashed across the whole face, labelled "Mirror · stock centre".
// Doc: docs/conventions/ui.md#clone-path-in-the-viewport, #feature-selection-in-the-viewport;
// docs/modes/clones-mirror.md#ui
import { useMemo } from 'react'
import { faceSizeOf } from '../../../../core/design/clones/mirror'
import { toPartFrame } from '../../../../core/geometry/face'
import { designMessages } from '../../messages/design'
import { useRegion2d, useUi } from '../../shell/ShellContext'
import {
  clonePathOverlay,
  type ClonePathData,
  type ClonePathOverlay,
} from '../../viewport/clone-path'
import type { OutlineLoop, Vec3 } from '../../viewport/mesh'
import {
  clonesSourceOf,
  draftSource,
  featurePathData,
  mirrorRefs,
  mirrorRefText,
  parseInstanceId,
  readoutOf,
  rowArgsOf,
  sourceModels,
} from './clones-view'
import { positionText, useSkipToggle } from './ClonesInspector'
import type { DesignPart } from './model'
import { operationFace, operationOutline } from './outline'
import type { DesignWarnings } from './useDesign'

const c = designMessages.features.clones

export interface ClonesScene {
  readonly clonePath: ClonePathOverlay | null
  /** Operations drawn selected with the selection (a Clones' source). */
  readonly selectedAlso: ReadonlySet<string> | null
  /** The source's outline, thin and dashed, while one of its instances is selected. */
  readonly guide: readonly OutlineLoop[] | null
  readonly summary: string | undefined
}

const NONE: ClonesScene = { clonePath: null, selectedAlso: null, guide: null, summary: undefined }

export function useClonesScene(
  part: DesignPart | undefined,
  selected: string | null,
  warnings: DesignWarnings['warnings'],
): ClonesScene {
  const draft = useUi((s) => s.clonesDraft)
  const focus = useUi((s) => s.clonesRow)
  const toggle = useSkipToggle(part)
  const port = useRegion2d()

  return useMemo(() => {
    const l = part?.loaded
    if (part === undefined || l === undefined || part.table === undefined) return NONE
    const table = part.table
    const units = part.units
    const ops = l.part.operations
    const ctx = port === undefined ? undefined : { port, shapes: l.part.shapes }
    const feature = part.dto.features?.find((f) => f.id === selected && f.kind === 'clones')
    const instance = parseInstanceId(part, selected)
    const live = draft !== null && draft.partId === part.dto.id && draft.openedFor === selected

    const source = live
      ? draftSource(draft.options, draft.unchecked, draft.feature)
      : feature !== undefined
        ? clonesSourceOf(feature)
        : instance !== undefined
          ? clonesSourceOf(instance.feature)
          : undefined
    if (source === undefined) return NONE
    const src = sourceModels(part, source)
    const first = src[0]
    if (first === undefined) return NONE
    const outline = (opsOf: typeof src): Vec3[][] =>
      opsOf.flatMap((op) => {
        const loops = operationOutline(op, l.stock, table, ctx, ops)
        return loops[0] === undefined ? [] : [loops[0].map((p): Vec3 => [p[0], p[1], p[2]])]
      })

    if (instance !== undefined && !live) {
      const data = featurePathData(part, instance.feature.id, port)
      const r = data === undefined ? undefined : readoutOf(data)
      return {
        clonePath: null,
        selectedAlso: null,
        guide: outline(src),
        summary: [
          r === undefined ? undefined : c.summary(instance.feature.name, r.instances, r.skipped),
          c.selectedInstance(
            instance.n,
            'featureId' in source
              ? (part.dto.features?.find((f) => f.id === source.featureId)?.name ?? first.name)
              : first.name,
          ),
        ]
          .filter(Boolean)
          .join(' '),
      }
    }

    const data: ClonePathData | undefined = live
      ? (draft.preview ?? undefined)
      : featurePathData(part, feature!.id, port)
    if (data === undefined) return NONE
    const rowArgs = live ? draft.rows : rowArgsOf(feature!)
    const refs = data.rows.some((r) => r.mirror !== undefined)
      ? mirrorRefs(part, first.on, live ? undefined : feature!.id).refs
      : []
    const face = operationFace(first, l.stock, table)
    const placement = {
      at: (u: number, v: number) => toPartFrame(face.frame, [u, v, face.w]),
      shift: (du: number, dv: number): Vec3 => [
        face.frame.u[0] * du + face.frame.v[0] * dv,
        face.frame.u[1] * du + face.frame.v[1] * dv,
        face.frame.u[2] * du + face.frame.v[2] * dv,
      ],
    }
    const outsideWarning = live
      ? undefined
      : warnings.find((w) => w.code === 'dfm.cloneOutsideStock' && w.operation === feature!.id)
    const outside = new Set((outsideWarning?.params['numbers'] as number[] | undefined) ?? [])
    const owner = live ? 'draft' : feature!.id
    const where = (at: readonly [number, number]) =>
      c.at(positionText(at[0], units), positionText(at[1], units))
    const overlay = clonePathOverlay(data, placement, {
      focusedRow: focus?.owner === owner ? focus.row : live ? 0 : null,
      footprint: outline(src),
      draft: live,
      interactive: !live,
      outside,
      label: (n, at, skipped) => c.markerLabel(n, where(at), skipped),
      hint: (n, skipped) => (skipped ? c.hintRestore : c.hintSkip(n)),
      sourceHint: c.sourceHint,
      faceSize: faceSizeOf(l.stock, first.on, ops),
      mirrorLabel: (i) => {
        const row = rowArgs[i]
        return c.mirror.viewport(
          row === undefined
            ? c.mirror.stock
            : mirrorRefText(row, refs, {
                stock: c.mirror.stock,
                at: c.mirror.atText,
                unknown: c.mirror.unknown,
              }),
        )
      },
      onToggle: (n) => {
        if (feature !== undefined) toggle(feature, n)
      },
    })
    const r = readoutOf(data)
    return {
      clonePath: overlay,
      selectedAlso: live ? null : new Set(src.map((o) => o.id)),
      guide: null,
      summary: live
        ? c.draftSummary(r.instances)
        : c.summary(feature!.name, r.instances, r.skipped),
    }
  }, [part, selected, draft, focus, toggle, port, warnings])
}
