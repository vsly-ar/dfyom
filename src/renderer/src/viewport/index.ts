// The 3D viewport (task 3.5). Doc: docs/conventions/ui.md#selection-and-picking
export { Viewport, DELAY_INDICATOR_MS, type PickRequest, type ViewportProps } from './Viewport'
export { MOUSE_PRESETS, VIEW_PRESETS, type MousePreset, type ViewPreset } from './camera'
export {
  surfaceOwner,
  type Box,
  type SurfaceTarget,
  type OutlineLoop,
  type Vec3,
  type ViewportMesh,
} from './mesh'
export { useToken, useTokens } from './useTokens'
export type { AnchorOverlay, FrameOverlay } from './Overlays'
export type { TabDragPhase, TabMarkerView, TabOverlay } from './TabMarkers'
export type { ReferenceGhostView } from './ReferenceGhost'
export type { ZRefDragPhase, ZRefOverlay, ZRefPolygon } from './ZRefLayer'
export type { AlignmentMarker, AlignmentTarget, FlipAxisLine } from './AlignmentLayer'
export type { AidDragPhase, AidHandle, AidOverlay } from './AidHandles'
export type { WorkholdingOverlay } from './WorkholdingLayer'
export { RunLayer, boxEdges, segmentColours, type RunEnvelope, type RunScene } from './RunLayer'
export {
  advancePlayback,
  linesBounds,
  SEGMENT,
  toolpathLines,
  type ToolpathLines,
} from './toolpath-lines'
