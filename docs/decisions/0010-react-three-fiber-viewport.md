# 0010 – react-three-fiber for 3D viewports

Status: accepted · Date: 2026-11-16

## Context

Design previews, setups and simulation need 3D views inside the React UI ([ADR 0001](0001-electron-typescript-react.md)). Candidates: react-three-fiber, plain three.js, Babylon.js.

## Decision

Use **three.js through react-three-fiber** (plus drei helpers). Geometry comes from the layers in [geometry.md](../architecture/geometry.md) as meshes and lines; the viewport never computes geometry itself.

## Consequences

- Declarative scenes driven by React state; large ecosystem (controls, gizmos, loaders for STL/OBJ/3MF/SVG).
- Performance-critical views (simulation) may drop to imperative three.js inside a component.
