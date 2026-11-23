// The snap engine lives in core since hardening A6 (headless, shared with `design.measure`); the
// viewport keeps importing it from here. Doc: docs/conventions/ui.md#snap-and-measure
export * from '../../../core/geometry/snap'
