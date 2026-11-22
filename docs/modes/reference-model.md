# Reference model: import, place and show a 3D model for reference

Status: draft (proposal from user direction D15 of 2026-11-21; nothing here is confirmed) · Design: [design.md § Workflow](design.md#workflow) step 4 · Storage: [persistence.md](../architecture/persistence.md#working-folder-layout) · Apply: [apply.md](../architecture/apply.md) · Plan of record: [plans/v0.2.md](../plans/v0.2.md#5-reference-model) · Terms: [glossary.md](../glossary.md)

The user's direction (D15) is the full CAM cycle **with a reference model**: import a 3D model, recreate it in Design with typical operations, Plan, Run on the virtual machine. This doc covers the first step only, for v0.2: get an STL into the project, place it on the stock and show it as a ghost. Measuring, snapping and assisted recreation come later ([§ Later](#later)).

Do not implement this doc before the user confirms it ([README.md](../README.md#status-values)).

## Rule: reference only

A reference model **never** changes the part, the toolpaths or any check. It is not an input to geometry evaluation, DFM, plans, toolpaths, export or run. Plans do not copy it into their design snapshot. Removing it changes nothing but the picture. This keeps design result-first ([principles.md](../principles.md)): the part is what the operations remove, not what a mesh suggests.

## Scope (v0.2)

| In v0.2                                                                                     | Later                                                                       |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| STL import (binary and ASCII), from the UI, MCP and CLI                                     | STEP import (e.g. `occt-import-js`, LGPL-2.1, licence compatible)           |
| Stored with the project as an asset (works on another machine)                              | Linking to an external file that updates                                    |
| Placement: position, rotation (90° steps and free angles), uniform scale, source unit guess | Non-uniform scale, mirroring                                                |
| Fit to stock: 9-point anchor in XY plus top / centre / bottom in Z                          | Drop onto a picked reference face (align a reference plane to a stock face) |
| Ghost display in Design (translucent, never pickable as a face target); visibility toggle   | Ghost in Plan and Run; section view at a level                              |
| Warnings when the placed reference sticks out of the stock                                  | Measure and snap, assisted recreation and deviation view                    |

## Data model

A reference belongs to one **part** and lives in the part frame ([design.md § Part and stock](design.md#part-and-stock-v01)). A part has zero or more references; the v0.2 UI focuses on the first one but the model does not limit it.

```
Reference {
  id, partId, name               // name defaults to the file name without extension
  asset: { path, sha256, format: 'stl', triangles, bounds }   // bounds in source units
  sourceUnit: 'mm' | 'inch'      // what one STL unit means; from the unit guess, user can change
  scale                          // uniform factor on top of sourceUnit, default 1 (a scalar quantity)
  rotation: { x, y, z }          // angle quantities, applied in the order x, then y, then z, about the part axes
  position: { x, y, z }          // length quantities: where the reference's bounding-box min corner lands, after rotation and scale
  visible                        // shown in the viewport
}
```

- Values are [quantities](../architecture/quantities.md) like every other design value, so `25.4 mm`, `1"` and expressions referencing stock surfaces (e.g. `stock.top.z`) work. A reference is **not** a reference target: other values cannot refer to it in v0.2 (that comes with measure and snap).
- Placement is stored, never re-derived: "fit to stock" writes `position` once ([below](#fit-to-stock)). Changing the stock later does not move the reference.
- `rotation` keeps the user's numbers; the 90° buttons add ±90° to one axis. The renderer composes them into one matrix. Exact 90° multiples stay exact (no drift from repeated quarter turns).

### Source unit guess

STL has no units. On import, the guess picks the unit whose placed bounding box fits the stock better: **mm** unless the mm reading's largest extent is under 1/10 of the stock's largest extent **and** the inch reading still fits within the stock. The result names the guess and why ("Read as inch: 2.0 × 1.5 × 0.5 in mm would be 20× smaller than the stock"). The user or agent can change `sourceUnit` at any time.

## Commands and queries

All are `document` commands (undoable, one gesture = one command; names per [commands.md § Naming](../architecture/commands.md#naming)). They have **no deferred work**, so they are instant reactions in [apply.md](../architecture/apply.md#instant-and-deferred-reactions) terms and never make the Apply button count up. MCP tools and CLI calls come from the command layer as usual ([llm-api.md § Names](../architecture/llm-api.md#names)).

| Command / query                 | Args                                                                                         | Result                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `design.reference.import`       | `{ partId, path, name?, sourceUnit?, fit? }` – `path` is a local file the main process reads | `{ referenceId, sourceUnit, guess, warnings }` |
| `design.reference.update`       | `{ partId, referenceId, name?, sourceUnit?, scale?, rotation?, position?, visible? }`        | `{ warnings }`                                 |
| `design.reference.rotate90`     | `{ partId, referenceId, axis: 'x' \| 'y' \| 'z', turns: -1 \| 1 \| 2 }`                      | `{ warnings }`                                 |
| `design.reference.fit`          | `{ partId, referenceId, anchor, z: 'top' \| 'centre' \| 'bottom' }` – see below              | `{ warnings }`                                 |
| `design.reference.remove`       | `{ partId, referenceId }`                                                                    | `{}`                                           |
| `design.reference.list` (query) | `{ partId }`                                                                                 | references with placed bounds in part units    |

- `import` parses in the compute worker ([workers.md](../architecture/workers.md)), stores the asset ([§ Storage](#storage)) and adds the record in one command. With `fit` it also fits (default `{ anchor: 'centre', z: 'top' }`, the usual case: the model's top at the stock top, centred).
- Errors: an unreadable or unparsable file is `input.malformed` (issue names the byte offset or line); a mesh over the limits ([§ Performance](#performance)) is refused with the same code and the limit in its params. Error handling per [error-handling](../conventions/error-handling/README.md).
- Warnings (never errors): `reference.exceedsStock` (placed bounds outside the stock, with the overhang per axis), `reference.unitGuessed` (once, after import), `reference.openMesh` (the STL is not watertight; display only, so this is information).

### Fit to stock

`design.reference.fit` computes `position` so the reference's placed bounding box sits on the stock: `anchor` is the [9-point placement anchor](design-v0.2.md#placement-anchors) (XY: the matching point of both rectangles coincide), `z` aligns the box's top, centre or bottom with the stock's. It is one undoable write of `position`; nothing is kept live. Scale is never changed by a fit.

## Storage

The asset is a new kind of project file. The [persistence](../architecture/persistence.md) changes it needs (draft, part of [plan task R1](../plans/v0.2.md#5-reference-model)):

- **Layout:** the original file bytes at `work/assets/<sha256>.stl` (content-addressed, so importing the same file twice stores it once) and the record at `references/<id>.json`, a new record collection in `layout.ts`. Assets are listed in `manifest.json` like every file (path, size, sha256) and deflated in the archive.
- **Streaming:** v0.1 builds archives in memory; assets need streamed zip writing and reading so a large STL does not hold the archive twice in memory ([known issue](../plans/v0.1.md#known-issues-and-risks) "Archives are built and read in memory").
- **Unreferenced assets:** undoing an import removes the record, not the file, so redo works. Save writes only assets referenced by a record **or** by the session's undo history; on open, unreferenced files in `work/assets/` are deleted.
- **No `schemaVersion` bump** (pre-alpha, [CLAUDE.md](../../CLAUDE.md)): a project without references has no `references/` and no `assets/`, so older projects open unchanged. Any other file in `assets/` stays `input.malformed`.

## Display

- Ghost in the Design viewport: translucent neutral material with edges, drawn after the part, never pickable in face-pick mode and never highlighted as a face target ([ui.md § Selection and picking](../conventions/ui.md#selection-and-picking)). Styling goes to [ui.md](../conventions/ui.md) when this doc is accepted.
- Navigator: a "Reference" row under the stock with the visibility eye; inspector: file name, triangles, source unit (with the guess reason), scale, rotation (90° buttons per axis and the three angle fields), position, and "Fit to stock" with the anchor picker and the Z choice.
- The renderer receives the parsed mesh once per asset (transferable buffer) and applies the placement matrix itself, so editing placement never re-sends the mesh.

## Performance

- Parse in the worker, never on the main or renderer thread. Binary STL target: 1 M triangles parsed in under 1 s on the reference machine.
- Limits (first guess, to measure in task R2): refuse over 5 M triangles or 512 MB; warn over 1 M triangles (the viewport may get slow). Decimation is later.

## Later

| Item                                      | When  | Notes                                                                                             |
| ----------------------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| STEP import                               | later | `occt-import-js` (LGPL-2.1); tessellated for display, B-rep kept for measure, snap and recreation |
| Measure and snap to the reference         | later | With v0.3 shapes; uses the anchors                                                                |
| Assisted recreation and deviation view    | later | Spike recognition on real parts first                                                             |
| Golden-path reference cycle e2e + UX pass | later | v0.2 has a first version ([plan task X2](../plans/v0.2.md#6-acceptance))                          |

## Open questions

| #   | Question                               | Options                                                                            | Recommendation                                                                                                      |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| R-A | Where the reference belongs            | (a) to a part (part frame); (b) to the project (stock frame)                       | (a): a project can hold many parts, and a reference describes one part                                              |
| R-B | Is visibility undoable document state? | (a) yes, a document field (saved, agents read it back); (b) per-window view state  | (a): simple and saved with the project; (b) if toggling clutters the undo history in testing                        |
| R-C | Where the asset lives                  | (a) copied into the project (`work/assets/`); (b) linked by path                   | (a): the project opens on another machine and in the e2e tests; linking is later                                    |
| R-D | Default fit on import                  | (a) centre + top; (b) front-left + bottom; (c) none, placed at the STL origin      | (a): the stock usually has margin around and the top is faced; the user sees the reference inside the stock at once |
| R-E | Does Apply care about references?      | (a) no, instant reactions only; (b) later reactions (snapping hints) go into Apply | (a) for v0.2                                                                                                        |
