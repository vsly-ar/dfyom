# Reference model: import, place and show a 3D model for reference

Status: implemented (v0.2 closed 2026-11-22; user direction D15 of 2026-11-21; confirmed with the v0.2 review, D17 and D18; visuals approved, D25 of 2026-11-22) · Design: [design.md § Workflow](design.md#workflow) step 4 · Storage: [persistence.md § Assets and references](../architecture/persistence.md#assets-and-references-v02) · UI rules: [ui.md § Viewport](../conventions/ui.md#reference-ghost-v02) · Apply: [apply.md](../architecture/apply.md) · Plan of record: [plans/v0.2.md](../plans/v0.2.md#5-reference-model) · Terms: [glossary.md](../glossary.md)

The user's direction (D15) is the full CAM cycle **with a reference model**: import a 3D model, recreate it in Design with typical operations, Plan, Run on the virtual machine. This doc covers the first step only, for v0.2: get an STL into the project, place it on the stock and show it as a ghost. Measuring, snapping and assisted recreation come later ([§ Later](#later)).

## Decisions

Settled with the user when this doc was accepted (D17, D18, 2026-11-22: the reference-model core stays in v0.2; R-A, R-C, R-D, R-E as recommended, R-B as per-window view state); the sections below specify them.

1. **A reference belongs to a part (R-A)** and lives in the part frame: a project can hold many parts, and a reference describes one ([§ Data model](#data-model)).
2. **Visibility is per-window view state (R-B),** like the camera and the selection: not in the document, not undoable, never marks the project unsaved, not saved with the project; a new window shows every reference ([§ Display](#display)).
3. **The asset is copied into the project (R-C),** so the project opens on another machine and in the e2e tests; linking to an external file is later ([§ Storage](#storage)).
4. **Import fits to centre + top by default (R-D):** the stock usually has margin around the part and its top is faced, so the reference shows inside the stock at once ([§ Fit to stock](#fit-to-stock)).
5. **Apply ignores references in v0.2 (R-E):** their commands are instant reactions only ([§ Commands](#commands-and-queries)).

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
}
```

- Values are [quantities](../architecture/quantities.md) like every other design value, so `25.4 mm`, `1"` and expressions referencing stock surfaces (e.g. `stock.top.z`) work. A reference is **not** a reference target: other values cannot refer to it in v0.2 (that comes with measure and snap).
- Placement is stored, never re-derived: "fit to stock" writes `position` once ([below](#fit-to-stock)). Changing the stock later does not move the reference.
- `rotation` keeps the user's numbers; the 90° buttons add ±90° to one axis. The renderer composes them into one matrix. Exact 90° multiples stay exact (no drift from repeated quarter turns).

### Source unit guess

STL has no units. On import, the guess picks the unit whose placed bounding box fits the stock better: **mm** unless the mm reading's largest extent is under 1/10 of the stock's largest extent **and** the inch reading still fits within the stock. The result names the guess and why ("Read as inch: 2.0 × 1.5 × 0.5 in mm would be 20× smaller than the stock"). The user or agent can change `sourceUnit` at any time.

## Commands and queries

All are `document` commands (undoable, one gesture = one command; names per [commands.md § Naming](../architecture/commands.md#naming)). They have **no deferred work**, so they are instant reactions in [apply.md](../architecture/apply.md#instant-and-deferred-reactions) terms and never make the Apply button count up. MCP tools and CLI calls come from the command layer as usual ([llm-api.md § Names](../architecture/llm-api.md#names)).

| Command / query                 | Args                                                                                                                                                                                    | Result                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `design.reference.import`       | `{ partId, path, name?, sourceUnit?, fit? }` – `path` is an absolute local file the main process reads                                                                                  | `{ referenceId, sourceUnit, guess: { unit, reason }, warnings }`              |
| `design.reference.update`       | `{ partId, referenceId, name?, sourceUnit?, scale?, rotation?, position?, turn?, fit? }` – `turn: { axis: 'x' \| 'y' \| 'z', turns: -1 \| 1 \| 2 }`, `fit: { anchor?, z? }` (see below) | `{ warnings }`                                                                |
| `design.reference.remove`       | `{ partId, referenceId }`                                                                                                                                                               | `{}`                                                                          |
| `design.reference.list` (query) | `{ partId }`                                                                                                                                                                            | the records plus `placed` (bounding box in the part frame, mm) and `warnings` |

- `import` copies the file into the project ([§ Storage](#storage)), parses it in the compute worker ([workers.md](../architecture/workers.md#file-access)) and adds the record in one command (its [`prepare` step](../architecture/commands.md#prepared-input) does the copy and parse; undo removes only the record). It always fits (default `{ anchor: { u: 'centre', v: 'centre' }, z: 'top' }`, the usual case: the model's top at the stock top, centred); `name` defaults to the file name without extension.
- **One update command for every placement edit (task R2):** the 90° buttons and "Fit to stock" are `update` with `turn` or `fit` (titles "Rotate reference", "Fit reference to stock"), not separate `rotate90` / `fit` commands as first sketched: the same behaviour with two fewer agent tools, which keeps `tools/list` within its [budget](../architecture/llm-api.md#implementation-task-310). Order inside one call: the fields, then `turn`, then `fit` (so "scale ×3 and fit" is one step); `fit` together with `position` is refused (rule `fitWithPosition`).
- Field values are quantities as entered; `position` may use formulas on stock faces (`stock.top.z - 10`), never on operation results (a reference is placed on the stock). Scale must be > 0 (`model.invariant`, rule `positive`); tolerances are dropped.
- Errors: a relative path (rule `absolutePath`), a path that is not a readable file (`unreadableFile`), or an unparsable file is `input.malformed` (the issue names the byte offset or line); a mesh over the limits ([§ Performance](#performance)) is refused with the same code, rule `tooLarge` and the limit in its params. Nothing is recorded then. Error handling per [error-handling](../conventions/error-handling/README.md).
- Warnings (never errors; `{ code, severity, message, referenceId, params }`, values in mm): `reference.exceedsStock` (placed bounds outside the stock, with the overhang per axis, both sides added; every command and the list), `reference.unitGuessed` (after an import without `sourceUnit`, with the reason), `reference.openMesh` (the STL is not closed; display only, so `info`), `reference.manyTriangles` (over the warn limit; import only).

### Fit to stock

`fit` (of `import` or `update`) computes `position` so the reference's placed bounding box sits on the stock: `anchor` is the [9-point placement anchor](design-v0.2.md#placement-anchors) `{ u, v }` (on the top face `u` is X and `v` is Y; each `min`, `centre` or `max`, default centre; XY: the matching point of both rectangles coincide), `z` aligns the box's top, centre or bottom with the stock's (default top). It is one undoable write of `position`; nothing is kept live. Scale is never changed by a fit. The written position is a literal in the project's units, rounded to 0.0001 mm (0.00001 in).

## Storage

The original file bytes are stored with the project as a content-addressed **asset** (importing the same file twice stores it once) and the record as `references/<id>.json`. Layout, streaming, cleanup of unreferenced assets and loading of older projects: [persistence.md § Assets and references (v0.2)](../architecture/persistence.md#assets-and-references-v02) (plan task [R1](../plans/v0.2.md#5-reference-model)).

## Display

- Ghost in the Design viewport: translucent neutral material with edges, drawn after the part, never pickable in face-pick mode and never highlighted as a face target (rules: [ui.md § Reference ghost](../conventions/ui.md#reference-ghost-v02)).
- **Visibility** is per-window view state in the window's UI store ([decision 2](#decisions)): the eye toggles it without a command, an undo step or the unsaved mark; a new window or a reopened project shows the reference. Headless instances have no viewport, so agents have no visibility command.
- Navigator: a "Reference" row under the stock (its name, truncated with a tooltip, over the triangle count on one line) with the visibility eye; inspector: file name, triangles, source unit (with the guess reason), scale, rotation (90° buttons per axis and the three angle fields), position, and "Fit to stock" with the anchor picker and the Z choice.
- The renderer receives the parsed mesh once per asset and applies the placement matrix itself, so editing placement never re-sends the mesh ([§ Ghost mesh](#ghost-mesh-task-r3)).

## Performance

- Parse in the worker, never on the main or renderer thread. Binary STL target: 1 M triangles parsed in under 1 s on the reference machine.
- **Limits (measured in task R2, `STL_LIMITS` in `src/core/design/stl.ts`):** refuse over **5 M triangles** or **512 MB** (the file is refused before it is copied; ASCII is refused while counting); warn over **1 M triangles** (`reference.manyTriangles`: the viewport may get slow; the viewport side is measured in [§ Ghost mesh](#ghost-mesh-task-r3)). Decimation is later. The byte limit equals the per-asset archive guard, so a stored reference never makes a project unopenable ([persistence.md](../architecture/persistence.md#assets-and-references-v02)).
- **Measured** (`npm run perf`, `stl.perf.ts`, Apple M1 Pro, 2026-11-21; the parse itself, chunks of 1 MB as the worker reads them):

  | File                                                    | Size    | Parse    | Parser memory                                           |
  | ------------------------------------------------------- | ------- | -------- | ------------------------------------------------------- |
  | Real enclosure base (binary, 49 806 triangles, fixture) | 2.4 MB  | 13–20 ms | ~1–2 MB heap (constant state; the 1 MB chunk dominates) |
  | Binary, 1 M triangles                                   | 47.7 MB | 61 ms    | constant                                                |
  | Binary, 5 M triangles (the limit)                       | 238 MB  | 0.29 s   | constant                                                |
  | ASCII, 1 M triangles                                    | 122 MB  | 1.3 s    | constant                                                |

  The parser keeps only a summary (count, bounds, closed check), never the mesh, so memory does not grow with the file; the copy into the project streams too. ASCII is ~20× slower than binary per triangle; at the byte limit an ASCII file holds ~4 M triangles (~5 s). Import holds the project queue while it parses ([prepared input](../architecture/commands.md#prepared-input)), so these times are the command's latency.

## STL parser (task R2)

`createStlParser(size)` in `src/core/design/stl.ts` (pure, streamed: `push(chunk)` then `finish()`), run by the worker task `reference.parseStl`:

- **Detection:** binary if the size is exactly `84 + 50 × count` (count at byte 80), else ASCII if the file starts with `solid`, else refused (`stlFormat`; a binary size mismatch without `solid` is `stlTruncated`). The size test comes first because many binary files start with "solid" too; the user's enclosure file starts with "MESH-MESH-…".
- **Binary:** records split across chunks are reassembled; a NaN or infinite coordinate is `stlValue` with its byte offset; a short file is `stlTruncated`.
- **ASCII:** tokens `solid` (rest of the line is the name), `facet normal n n n` (normals ignored, some exporters write `nan`), `outer loop`, exactly three `vertex x y z`, `endloop`, `endfacet`, `endsolid`; several solids in one file are accepted; it must end after `endsolid`. Errors are `stlSyntax` with the line; a line over 4096 characters is refused (a binary file mistaken for text). Values are read as float32, like binary.
- **Empty** (no triangles or no bytes) is `emptyMesh`. All issues have path `['path']`, so they point at the import's file argument.
- **Closed check** (`reference.openMesh`): constant memory, one pass. Every directed edge a→b of a closed, consistently oriented mesh has its twin b→a, so the sum of `f(a,b) − f(b,a)` over all edges, with a non-symmetric hash `f` of the vertices' float32 bit patterns (−0 = 0), is exactly 0; two independent 32-bit sums make a false "closed" ~2⁻⁶⁴ likely. A closed mesh with flipped triangles counts as open (fine for information).

## Placement math (task R2)

`src/core/design/reference.ts`, canonical units (mm, degrees):

- The rotation matrix is `Rz · Ry · Rx` (x first, about the fixed part axes); multiples of 90° use exact 0/±1, so quarter turns never drift. `turn` adds `90° × turns` exactly (rational) and keeps the angle within ±360°.
- The **placed bounding box** is the axis-aligned box of the 8 corners of the source bounds, times `scale × (1 mm or 25.4 mm)`, rotated; its min corner is `position`. Exact for 90° steps; for free angles it is larger than the mesh's own box, because the mesh is never re-read. So `reference.fit` and `exceedsStock` are conservative for free angles; the U3 snap and measure tools use the exact mesh (the worker's section and the ghost's triangles) instead of the box. R3's renderer must use the same box to turn `position` into its matrix.
- The unit guess compares **sorted** extents ("fits within the stock" regardless of how the model lies in the file), and the reasons read "Read as inch: 2 × 1.5 × 0.5 in mm would be 50× smaller than the stock" or "Read as mm: … mm".
- `exceedsStock` ignores overhangs under 0.001 mm (fitted positions are rounded).

## Ghost mesh (task R3)

The STL parser keeps only a summary, so the ghost needs the triangles read a second time. Decision (R3): **read them in the compute worker on demand and copy them once per asset to the renderer**; the renderer never parses files (it has no file access) and never re-reads the mesh for placement.

- **Worker task `reference.meshStl`** (`src/core/workers/tasks.ts`): the same streamed parser with a triangle sink (`createStlParser(size, limits, sink)`, `StlPositions` in `stl.ts`) that keeps every triangle as 9 float32 values in source units, sized once from the record's triangle count. The positions are **transferred** from the worker to the main process (no copy).
- **Window plumbing, not an agent capability** (like the evaluation push, [overview.md § IPC](../architecture/overview.md#ipc)): `window.dfyom.reference.mesh(referenceId)` (IPC `dfyom:reference.mesh`) → `AppHost.referenceMesh(key, referenceId)` resolves the record's asset in the bound project's working folder and runs the task. Electron IPC cannot transfer buffers between processes, so the reply's `Float32Array` is **copied once** (structured clone: 36 bytes per triangle, 1.8 MB for the enclosure, 36 MB at the 1 M warn limit). Agents have no viewport and get placement from `design.reference.list`.
- **Renderer cache** (`state/reference-meshes.ts`): one entry per asset **sha256**, so two references of the same file, undo/redo of a remove, placement edits and visibility toggles never fetch again; a hidden reference is not fetched until shown; an asset no reference uses any more is dropped. A failed read shows in the inspector and the viewport summary.
- **Placement:** the renderer builds the matrix from the record (`ghostMatrix` in `modes/design/reference-view.ts`): scale `scale × unit`, rotate `Rz · Ry · Rx`, then translate so the [placed bounding box](#placement-math-task-r2) min corner lands on `position` – the same box as fit and `exceedsStock`, so the ghost sits where they say. The placed box also widens the viewport's framing bounds.
- **Measured** (R3, Apple M1 Pro, Node 24 with three 0.187, the renderer's work per mesh): face normals 8 ms for the enclosure (49 806 triangles), 20 ms at 300 K, 74 ms at 1 M; feature edges (`EdgesGeometry`, 30°) 107 ms, 0.8 s and 3.1 s. So edges were drawn up to 150 K triangles (~0.4 s once per mesh on the renderer thread). **U3 moved the edges to the worker:** `reference.meshStl` computes them with the mesh (`featureEdges`, 30°, welded at 1e-4; 46 ms for the enclosure, ~0.9 s at 1 M triangles in the geometry lane) and the renderer only builds the line geometry, so every ghost has edges and the limit is gone. Draw cost per frame is one transparent mesh (`frameloop="demand"`: nothing renders while nothing changes). Decimation stays [later](#later).

## Implementation (task R3)

UI rules: [ui.md § Reference ghost](../conventions/ui.md#reference-ghost-v02). Design mode (`src/renderer/src/modes/design/`):

- **Import:** the navigator's "Reference" group (`ReferenceRows.tsx`, between the part and the operations) has "Import reference…" (and "Import STL…" while empty). It opens the native dialog (`files.chooseReference()` → `chooseReferenceFile` in `src/main/file-dialogs.ts`, STL filter, remembered folder `reference-import`, B19) and sends `design.reference.import { partId, path }` with the absolute path, exactly as an agent does; the new reference is selected. The import's own warnings (unit guess, open mesh, many triangles) are kept per window (`referenceNotes` in the UI store) for the inspector; an import error shows under the group.
- **Row:** name and triangle count (or "hidden"); the eye is a toggle `IconButton` "Show reference" (`aria-pressed` = shown; a toggle keeps one name, its state is the pressed state), flipping `hiddenReferences` in the window's UI store: no command, no undo step, no unsaved mark; a newly bound or reopened project shows every reference. Remove is `design.reference.remove` with the navigator's undo toast.
- **Inspector** (`ReferenceInspector.tsx`, when a reference is selected): name; "STL · triangles · source size"; source unit (mm / inch segmented control, with the unit guess for the current stock as a note); scale; rotation X/Y/Z angle fields, each with "Turn −90° / +90° about X…" buttons (`update` with `turn`); position X/Y/Z (min corner; formulas on stock faces resolve); "Fit to stock" with the anchor picker (top-face point names) and Top / Centre / Bottom (`update` with `fit`). Each edit is one `design.reference.update` (one undo step), errors at their field; warnings: `exceedsStock` live from the record (core `exceedsStock` on the placed box, as the list query) plus the import's notes.
- **Viewport:** `useDesignScene` passes the visible references with a loaded mesh as `ghosts` (`viewport/ReferenceGhost.tsx`: translucent `--vp-stock` faces at 20 %, `--vp-edge` edges at 45 %, no depth write, drawn after the part, `raycast` disabled, fading in over `--motion-slow` unless motion is reduced). The viewport's text summary names each visible reference ("Reference enclosure-wood-base shown as a ghost.", or loading / could not be shown).

## Testing (tasks R2, R3)

- `stl.test.ts`: binary and ASCII (incl. every chunking), the closed check (open, flipped, −0), the real enclosure fixture (`src/core/design/__fixtures__/enclosure-wood-base.stl`), the evaluated test part written as binary and ASCII STL (closed), malformed files with offsets/lines, limits.
- `reference.test.ts`: unit guess, exact quarter turns, extents, fit, `exceedsStock`.
- `reference-commands.test.ts`: the commands through a dispatcher with an in-memory session and in-process worker (import incl. the enclosure end to end, undo/redo, update/turn/fit, remove, list, refused input leaves no record).
- `cli.test.ts`: the bundled CLI imports the enclosure STL into a saved project (real worker thread, real asset copy), and a reopen lists the record with its asset.
- R3: `stl.test.ts` also covers the triangle sink (binary, ASCII, chunking, a wrong size hint) and the `reference.meshStl` task on the enclosure; `app-host.test.ts` reads an imported reference's mesh through `AppHost.referenceMesh`; `modes/design/reference-view.test.ts` checks the ghost matrix against core's placed box (quarter turns, scale, inch, free angles); `modes/design/Reference.test.tsx` drives import (dialog cancelled, unreadable file), the row's eye (no command, no revision, mesh read once), turns, angles, scale, unit, fit, field errors, remove with undo and a failed mesh read against the fake bridge with a real dispatcher; `e2e/reference.e2e.ts` imports the enclosure fixture in the built app through the stubbed dialog, hides and shows it, turns and fits it, saves, closes the app, reopens and finds it placed as saved and drawn from the stored asset.

## Later

| Item                                      | When  | Notes                                                                                             |
| ----------------------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| STEP import                               | later | `occt-import-js` (LGPL-2.1); tessellated for display, B-rep kept for measure, snap and recreation |
| Measure and snap to the reference         | later | With v0.3 shapes; uses the anchors                                                                |
| Assisted recreation and deviation view    | later | Spike recognition on real parts first                                                             |
| Golden-path reference cycle e2e + UX pass | later | v0.2 has a first version ([plan task X2](../plans/v0.2.md#6-acceptance))                          |
