// The reference section of the Shape Editor (task U3): the first shown reference cut by a plane
// parallel to the edited shape's face, `sectionDepth` below it (per window; by default the middle
// of the reference there). The cut runs in the compute worker (`reference.section`, the mesh read
// once and kept there); the window keeps the latest answer and shows the previous one meanwhile.
// Doc: docs/conventions/ui.md#snap-and-measure, docs/modes/design-v0.3.md#implementation-u3
import { useEffect, useMemo, useState } from 'react'
import { Quantity } from '../../../../core/quantity/quantity'
import { lengthSource } from '../../messages/dfm'
import { useShell, useUi } from '../../shell/ShellContext'
import type { SectionView } from '../../viewport/ShapeView'
import type { DesignPart } from './model'
import type { OperationFace } from './outline'
import {
  ghostMatrix,
  middleDepth,
  referenceBox,
  referencePlacement,
  sectionMatrix,
} from './reference-view'
import { useDesignReferences } from './useDesign'

export function useReferenceSection(
  part: DesignPart | undefined,
  face: OperationFace | undefined,
): SectionView | null {
  const { bridge } = useShell()
  const references = useDesignReferences(part)
  const stored = useUi((s) => s.sectionDepth)
  const setDepth = useUi((s) => s.setSectionDepth)
  const [answer, setAnswer] = useState<{ key: string; segments: Float32Array } | null>(null)

  const request = useMemo(() => {
    if (face === undefined) return null
    const shown = references.find((r) => r.visible && r.mesh?.status === 'done')
    if (shown === undefined) return null
    const p = referencePlacement(shown.ref)
    const box = referenceBox(shown.ref)
    if (p === undefined || box === undefined) return null
    const depth = stored ?? middleDepth(box, face.frame, face.w)
    const matrix = sectionMatrix(ghostMatrix(shown.ref.asset.bounds, p), face.frame)
    const level = face.w - depth
    return {
      key: `${shown.ref.id}|${shown.ref.asset.sha256}|${matrix.join(',')}|${level}`,
      referenceId: shown.ref.id,
      matrix,
      level,
      depth,
    }
  }, [face, references, stored])

  useEffect(() => {
    if (request === null) return
    let live = true
    void bridge.reference
      .section({ referenceId: request.referenceId, matrix: request.matrix, level: request.level })
      .then((r) => {
        if (live && r.ok) setAnswer({ key: request.key, segments: r.segments })
      })
    return () => {
      live = false
    }
  }, [bridge, request])

  const units = part?.units ?? 'mm'
  const depthValue = useMemo(() => {
    if (request === null) return undefined
    const q = Quantity.parse(lengthSource(request.depth, units), {
      kind: 'length',
      defaultUnit: units === 'mm' ? 'mm' : 'in',
    })
    return q.isOk() ? q.unwrap() : undefined
  }, [request, units])

  if (request === null) return null
  return {
    // the latest answer, also while a new depth is being cut (no flicker)
    segments: answer?.segments ?? null,
    depth: depthValue,
    defaultUnit: units === 'mm' ? 'mm' : 'in',
    onDepth: (q) => setDepth(q.canonical),
  }
}
