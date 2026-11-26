// The design scene of the shared viewport (task 3.6): the part's last good mesh and the stock,
// the evaluation status (outdated tint after 300 ms), the selection (synced with navigator and
// inspector), the live outline of the selected operation while pending (in its face frame), the
// error marker at the failing operation, pick mode for the inspector's fields (normal glyphs on
// every eligible face), and for the selected operation its face-frame axes (task F1) and anchor
// marker (task F2), and the visible references as ghosts (task R3); named and rotated shapes'
// outlines through the renderer's 2D port (task U1); while the Reference panel is open, Fit mode's
// preview placement and "See through stock" (dogfood DF2, DF5); a selected face (DF22): a stock
// face click or Alt+click on a floor selects it, drawn selected with its face-frame axes; a split
// source's exploded preview while its part inspector shows (split parts 4a polish).
// Doc: docs/conventions/ui.md#selection-and-picking, #evaluation-status-pending-outdated-failed,
// #design-and-plan-controls-v02, #reference-ghost-v02, #reference-panel-hardening-df2df8
import { useMemo } from 'react'
import { isDisabled } from '../../../../core/design/disabled'
import { patternFacts } from '../../../../core/design/pattern/pattern'
import { placedBox } from '../../../../core/design/reference'
import { faceFrame, toPartFrame } from '../../../../core/geometry/face'
import { unapplyPlacement } from '../../../../core/geometry/model'
import { useRegion2d, useUi } from '../../shell/ShellContext'
import { designMessages } from '../../messages/design'
import { referenceMessages } from '../../messages/reference'
import type { OutlineLoop, ViewportProps } from '../../viewport'
import { disabledOf, failingOperation, itemName, surfaceLabel } from './model'
import {
  anchorPoint,
  frameAxes,
  markerPoint,
  operationFace,
  operationOutline,
  patternGuideLoops,
  surfaceAxes,
} from './outline'
import { clickedFace, faceSelectionId, selectedFace } from './face-selection'
import { overlayView } from './reference-overlay'
import { ghostMatrix, referencePlacement, sectionMatrix, stockSizeOf } from './reference-view'
import { useTabMarkers } from './useTabMarkers'
import { useReferenceCompare } from './useReferenceCompare'
import { deviationView, worstRegion } from './reference-compare-state'
import { lengthSource } from './reference-view'
import { countsAsWarning } from './feature-view'
import { useClonesScene } from './useClonesScene'
import { useSplitScene } from './useSplitScene'
import { slotDimension } from './slot-dimension'
import { constructionOverlays } from './construction-view'
import { instanceId, instanceOfOperation } from './clones-view'
import {
  useDesignEvaluation,
  useDesignPart,
  useDesignReferences,
  useDesignSelection,
  useDesignWarnings,
} from './useDesign'

export type SceneProps = Omit<ViewportProps, 'className' | 'mousePreset'>

export function useDesignScene(): SceneProps {
  const part = useDesignPart()
  const evaluation = useDesignEvaluation(part)
  const { warnings } = useDesignWarnings(part)
  const [selected, select] = useDesignSelection()
  const pick = useUi((s) => s.pick)
  const rotationGuide = useUi((s) => s.rotationGuide)
  const snapOn = useUi((s) => s.snapOn)
  const setPick = useUi((s) => s.setPick)
  const status = evaluation?.status ?? 'pending'
  const references = useDesignReferences(part)
  const preview = useUi((s) => s.referencePreview)
  const panel = useUi((s) => s.referencePanel)
  const seeThroughStock = useUi((s) => s.seeThroughStock)
  // named and rotated shapes are placed through the renderer's 2D port (task U1)
  const port = useRegion2d()

  const ghosts = useMemo(
    () =>
      references.flatMap(({ ref, visible, mesh }) => {
        const p = preview?.referenceId === ref.id ? preview.placement : referencePlacement(ref)
        if (!visible || mesh?.status !== 'done' || p === undefined) return []
        const matrix = ghostMatrix(ref.asset.bounds, p)
        const box = placedBox(ref.asset.bounds, p)
        return [
          {
            id: ref.id,
            positions: mesh.positions,
            edges: mesh.edges,
            matrix,
            box: {
              min: [box.min.x, box.min.y, box.min.z] as const,
              max: [box.max.x, box.max.y, box.max.z] as const,
            },
          },
        ]
      }),
    [references, preview],
  )
  // the Reference panel's section loops, sharp corners and hovered level on the ghost (DF60)
  const overlayState = useUi((s) => s.referenceOverlay)
  const referenceOverlay = useMemo(() => {
    const stockSize = part === undefined ? undefined : stockSizeOf(part)
    if (!panel || preview !== null || overlayState === null || stockSize === undefined) return null
    const r = references.find((x) => x.ref.id === overlayState.referenceId)
    const p = r === undefined ? undefined : referencePlacement(r.ref)
    if (r === undefined || !r.visible || r.mesh?.status !== 'done' || p === undefined) return null
    const matrix = ghostMatrix(r.ref.asset.bounds, p)
    return overlayView(overlayState, stockSize, {
      positions: r.mesh.positions,
      matrix,
      faceMatrix: sectionMatrix(matrix, faceFrame(overlayState.direction, stockSize)),
    })
  }, [panel, preview, overlayState, part, references])
  const sectionSummary =
    referenceOverlay === null || overlayState?.loops == null
      ? undefined
      : referenceMessages.tools.viewportSection(
          overlayState.loops.length,
          referenceOverlay.corners.length,
        )
  const holeCount = referenceOverlay === null ? 0 : (overlayState?.holes?.length ?? 0)
  const overlaySummary =
    holeCount === 0
      ? sectionSummary
      : [sectionSummary, referenceMessages.tools.viewportHoles(holeCount)]
          .filter((x) => x !== undefined)
          .join(' ')
  // the compare overlay (DF60 P5): runs while on, drawn on the mesh it measured
  useReferenceCompare(part?.dto.id, evaluation, references)
  const compare = useUi((s) => s.referenceCompare)
  const compareResult = useUi((s) => s.compareResult)
  const compareRegion = useUi((s) => s.compareRegion)
  const viewportFocus = useUi((s) => s.viewportFocus)
  const shownPositions = evaluation?.mesh?.positions
  const deviation = useMemo(
    () =>
      compare === null
        ? null
        : deviationView(compareResult, compare.threshold, shownPositions, compareRegion),
    [compare, compareResult, shownPositions, compareRegion],
  )
  const compareSummary = useMemo(() => {
    const r = compareResult.result
    if (compare === null || r === undefined || part === undefined) return undefined
    const L = (mm: number) => lengthSource(mm, part.units)
    const worst = worstRegion(r)
    const op =
      worst === undefined
        ? undefined
        : part.dto.operations.find((o) => o.id === worst.operationIds[0])?.name
    return referenceMessages.compare.viewport(
      r.regions.length + (r.more ?? 0),
      L(r.threshold),
      worst === undefined
        ? undefined
        : { dev: L(worst.maxDev), kind: worst.kind, ...(op === undefined ? {} : { op }) },
    )
  }, [compare, compareResult, part])
  const referenceSummary = references
    .filter((r) => r.visible)
    .map((r) =>
      referenceMessages.viewport(
        r.ref.name,
        r.mesh?.status === 'done' ? 'done' : r.mesh?.status === 'failed' ? 'failed' : 'loading',
      ),
    )

  const stock = useMemo(() => {
    const s = part?.loaded?.stock
    return s === undefined
      ? null
      : {
          min: [0, 0, -s.thickness.canonical] as const,
          max: [s.length.canonical, s.width.canonical, 0] as const,
        }
  }, [part])

  const ops = part?.loaded?.part.operations
  // DF106: a disabled item is not in the 3D view: no outline, axes, tab markers or clones
  const shown =
    selected !== null && part !== undefined && isDisabled(disabledOf(part), selected)
      ? null
      : selected
  // a selected pattern shows its pocket's outline (the cells) and its area dashed (patterns P2),
  // with the cells left out at the border as dashed ghosts and a ring at the thinnest web (P5)
  const pattern = part?.dto.features?.find((f) => f.id === shown && f.kind === 'pattern')
  const selectedOp = ops?.find(
    (o) => o.id === shown || (pattern !== undefined && o.id === `${pattern.id}_pocket`),
  )
  // U9 P4: a pattern's cells (its owned pocket and chamfer) are selected by their outlines, not
  // a fill: hundreds of cells filled amber would be a block of accent
  const dto = part?.dto
  const outlineOnly = useMemo(() => {
    const patterns = new Set(
      (dto?.features ?? []).filter((f) => f.kind === 'pattern').map((f) => f.id),
    )
    return new Set(
      (dto?.operations ?? [])
        .filter((o) => o.featureId !== undefined && patterns.has(o.featureId))
        .map((o) => o.id),
    )
  }, [dto])
  const overlays = useMemo(() => {
    if (selectedOp === undefined || part?.loaded === undefined || part.table === undefined)
      return null
    const s = part.loaded.stock
    const table = part.table
    const axes = frameAxes(selectedOp, s, table)
    const face = operationFace(selectedOp, s, table)
    const outline = operationOutline(
      selectedOp,
      s,
      table,
      port === undefined ? undefined : { port, shapes: part.loaded.part.shapes },
      part.loaded.part.operations,
    )
    // the placed shape's bounding box in the face frame (what the anchor refers to, task U2)
    let guide: readonly OutlineLoop[] | null = null
    if (pattern !== undefined && port !== undefined) {
      const facts = patternFacts(pattern.id, part.dto.shapes ?? [], port)
      // the area, the ghosts left out at the border and the thinnest web's ring (P2, P5)
      if (facts !== undefined) guide = patternGuideLoops(selectedOp, s, table, facts)
    } else if (rotationGuide === selectedOp.id && outline.length > 0) {
      const top = outline[0]!.map((p) => unapplyPlacement(face.frame, p))
      const us = top.map((p) => p[0])
      const vs = top.map((p) => p[1])
      const w = top[0]![2]
      const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)]
      guide = [
        [
          [u0, v0],
          [u1, v0],
          [u1, v1],
          [u0, v1],
        ].map(([u, v]) => toPartFrame(face.frame, [u!, v!, w])),
      ]
    }
    return {
      outline,
      guide,
      frame: { ...axes, labels: designMessages.inspector.frameAxes },
      anchor: anchorPoint(selectedOp, s, table),
      describe: designMessages.selectionSummary({
        name: selectedOp.name,
        on: surfaceLabel(part.dto, selectedOp.on),
        anchor:
          selectedOp.kind === 'pocket' || selectedOp.kind === 'profile'
            ? designMessages.anchorPoint(face.direction, selectedOp.shape.anchor)
            : undefined,
      }),
    }
  }, [selectedOp, part, port, rotationGuide, pattern])
  // DF119 H3 follow-up: a selected slotted Bolt hole's centre line and travel dimension
  const hole = part?.dto.features?.find((f) => f.id === shown && f.kind === 'hole')
  const slot = useMemo(() => {
    if (hole === undefined || part?.loaded === undefined || part.table === undefined) return null
    const on = (hole as { on?: string }).on ?? 'stock.top'
    const d = slotDimension(hole.id, on, part.loaded.part.operations, part.loaded.stock, part.table)
    return d === null ? null : { ...d, label: lengthSource(d.travel, part.units) }
  }, [hole, part])
  // a selected face (DF22): its face frame axes, its name in the summary
  const face = selectedFace(part, selected)
  const faceId = face?.id
  const faceOverlay = useMemo(() => {
    if (faceId === undefined || part?.loaded === undefined || part.table === undefined) return null
    return {
      ...surfaceAxes(faceId, part.loaded.stock, part.table),
      labels: designMessages.inspector.frameAxes,
    }
  }, [faceId, part])
  const selectedDto = part?.dto.operations.find((o) => o.id === shown)
  const tabs = useTabMarkers(part, selectedDto)
  const clones = useClonesScene(part, shown, warnings)
  // the exploded split preview while the part inspector (its Split section) shows (4a polish)
  const clonesDraft = useUi((s) => s.clonesDraft)
  const splitScene = useSplitScene(
    part,
    selected === null && !panel && pick === null && compare === null && clonesDraft === null,
    warnings,
  )
  const announcement = useUi((s) => s.announcement)

  // DF118 V3: construction surfaces (construction-surfaces.md#ui) – in pick mode the eligible ones,
  // pickable; else those the selected operation refers to, as a read-out
  const patches = evaluation?.mesh?.construction
  const eligible = pick?.eligible
  // the On list's highlighted option (DF118 follow-up): its surface highlighted as on hover, a
  // construction surface by its outline (added while it is not shown already)
  const highlight = useUi((s) => s.surfaceHighlight)
  const construction = useMemo(() => {
    const size = part === undefined ? undefined : stockSizeOf(part)
    if (patches === undefined || size === undefined) return null
    if (eligible !== undefined)
      return constructionOverlays(
        patches,
        size,
        new Set(patches.map((c) => c.surface).filter((x) => eligible.has(x))),
        true,
      )
    const own = new Set(
      part?.dto.operations.filter((o) => o.id === shown || o.featureId === shown).map((o) => o.id),
    )
    const refs = patches
      .filter((c) => c.referencedBy.some((r) => own.has(r.operationId)) || c.surface === highlight)
      .map((c) => c.surface)
    return refs.length === 0 ? null : constructionOverlays(patches, size, new Set(refs), false)
  }, [patches, part, eligible, shown, highlight])
  const constructionSummary =
    construction === null || eligible !== undefined || part === undefined
      ? undefined
      : construction
          .map((o) =>
            designMessages.construction.summary(
              surfaceLabel(part.dto, o.surface),
              (patches?.find((c) => c.surface === o.surface)?.consumedBy ?? []).map((id) =>
                itemName(part.dto, id),
              ),
            ),
          )
          .join(' ')

  const marker = useMemo(() => {
    if (status !== 'failed' || ops === undefined || part?.loaded === undefined || !part.table)
      return null
    const ids = ops.map((o) => o.id)
    const at =
      (evaluation?.error && failingOperation(evaluation.error, ids)) ?? selected ?? ids.at(-1)
    const op = ops.find((o) => o.id === at)
    return op === undefined ? null : markerPoint(op, part.loaded.stock, part.table, ops)
  }, [status, ops, part, evaluation, selected])

  return {
    mesh: evaluation?.mesh ?? null,
    stock,
    status,
    selectedOperation: selected,
    outline: overlays?.outline ?? null,
    marker,
    frame: overlays?.frame ?? faceOverlay,
    selectedSurface: faceId ?? null,
    stockFaces: true,
    anchor: overlays?.anchor ?? null,
    tabs,
    split: splitScene.split,
    guide: overlays?.guide ?? clones.guide,
    construction,
    highlight,
    clonePath: clones.clonePath,
    selectedAlso: clones.selectedAlso,
    outlineOnly,
    announcement,
    ghosts,
    referenceOverlay,
    deviation,
    focus: viewportFocus,
    slotDimension: slot,
    seeThrough: panel && seeThroughStock && ghosts.length > 0,
    snap: snapOn,
    ...(part === undefined ? {} : { units: part.units }),
    ...(part === undefined
      ? {}
      : {
          summary: [
            designMessages.viewportSummary({
              operations: part.dto.operations.length,
              warnings: warnings.filter(countsAsWarning).length,
              status,
            }),
            overlays?.describe,
            slot === null ? undefined : designMessages.slotTravel(slot.label),
            constructionSummary,
            face === undefined ? undefined : designMessages.face.summary(face.label),
            clones.summary,
            splitScene.summary,
            ...referenceSummary,
            overlaySummary,
            compareSummary,
          ]
            .filter(Boolean)
            .join(' '),
        }),
    // a clone instance's surface selects the instance, a second click its Clones; an owned
    // operation's second click selects its feature (ui.md § Feature selection in the viewport)
    onSelect: (target, modifiers) => {
      if (target === null) return select(null)
      // a stock face, or Alt+click on a floor or tab top, selects the face (DF22)
      const clicked = clickedFace(part, target.surface, modifiers?.alt === true)
      if (clicked !== undefined) return select(faceSelectionId(clicked.id))
      if (target.operation === 'stock') return select(null)
      const inst = part === undefined ? undefined : instanceOfOperation(part, target.operation)
      if (inst !== undefined) {
        const id = instanceId(inst.feature.id, inst.n)
        return select(selected === id ? inst.feature.id : id)
      }
      const owner = part?.dto.operations.find((o) => o.id === target.operation)?.featureId
      select(owner !== undefined && selected === target.operation ? owner : target.operation)
    },
    pick:
      pick === null
        ? null
        : { eligible: pick.eligible, field: pick.field, noneFacing: pick.noneFacing },
    onPick: (target) => {
      pick?.onPick(target.surface)
      setPick(null)
    },
    onPickCancel: () => setPick(null),
  }
}
