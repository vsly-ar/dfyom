# Icon proposals: B21 app icon, B22 icon set

Status: **approved in L3 (D33)** ([plan v0.3](../../docs/plans/v0.3.md)) with the recommendations. B21 is built: concept C is the app icon (`build/icon.*`, made by `npm run icon`, [ui.md § App name and icon](../../docs/conventions/ui.md#app-name-and-icon)). B22 is not wired into the app yet; `src/renderer/src/ui/icons/` is unchanged. The style rules are proposed in [ui.md § Icon set proposal](../../docs/conventions/ui.md#icon-set-proposal-v03-b22-draft).

## Files

| Path                | What                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `b21/concept-*.svg` | Three app icon concepts, 1024 canvas; `concept-c-small.svg` is the approved C simplified for 16 and 32 px                              |
| `b22/icons.mjs`     | The one source of the 24 specimen icons (paths, accent part, provenance) and `iconSvg()`                                               |
| `b22/svg/*.svg`     | Standalone exports of those icons (generated; grey `#5b6462`, accent `#f5b700`)                                                        |
| `render.mjs`        | Renders everything with headless Chromium (no window): `node design/icons/render.mjs [outDir]`; `CHROMIUM_PATH` picks an installed one |
| `renders/*.png`     | B21 concepts at 1024, small-size sheet; B22 specimen and in-context mock, light and dark                                               |

The specimen and the mock load the real `src/renderer/src/ui/tokens.css`, so colours follow the tokens.

## B21 app icon

All three use the macOS grid: 1024 canvas, 824 body at (100, 100), corner radius 185, a soft shadow below, light from the top left; amber `#f5b700` is the only saturated colour.

- **A · Flute:** a flat end mill (front view) cutting a slot into stock; the slot floor (the toolpath) and chips are amber. Most literal; at 32 px it is a thin vertical bar, at 16 px illegible.
- **B · Spiral pocket:** a pocket milled into light aluminium with its offset rings in amber and the end mill from above. Reads as CAM to people who know it; at 16 px an amber blob on a light square, and the light body is weak in a light Dock.
- **C · Routed D:** the monogram D milled as a groove into a graphite block, amber floor, the end mill (from above) near the end of the stroke with the rest as a dashed toolpath preview. Holds up best: a clear amber D on dark at 32 and 16 px, distinct from other apps; the tool turns into a light dot at 32 px. **Recommended.**

Small sizes (`renders/b21-small-sizes.png`): the `.icns` holds separate 16/32 px artwork, so whichever concept wins gets a simplified 16/32 variant (for C: the D alone, no tool, no dashes).

**Decision (L3, D33):** C · Routed D (B21-1 c), simplified 16 and 32 px images (B21-2 a, `b21/concept-c-small.svg`: the closed D groove, wider, no tool, dashes or texture), dark body only (B21-3 a). `scripts/app-icon.mjs` (`npm run icon`) renders the full drawing for 64 px and up and the small one for 16–32 px into `build/icon.{png,icns,ico}`.

## B22 icon set

### Inventory (before this proposal)

- **Own, approved** (`ui/icons/tool/ToolIcon.tsx`, 16 grid, 1.35 px): select, rect, circle, polyline, measure, facing, profile, pocket, drill(ing), tabs, end mill, simulate, jog, work zero, probe, fit, iso, top/front/right, grid. Mode icons in `ModeSwitcher`, direction icons in `plan/DirectionIcon`, inline glyphs in `Field`, `StopControl`, `ApplyButton`, `MachineStateBadge`.
- **Field illustrations** (`ui/icons/field/FieldIcon.tsx`, 20 grid, 1 px grey + 1.4 px amber): length, width, depth, stepdown, corner, chamfer, tool, feed, tabs.
- **Lucide** (`lucide-react` 1.77, ISC), about 60 glyphs: Plus, CircleAlert, TriangleAlert, Trash2, Play, Undo2/Redo2, Check, X, Settings, Library, Download, FileInput/FileUp, Box, Crosshair, Wrench, the shape kinds (RectangleHorizontal, Circle, Pill, Hexagon, Spline), …
- **Gaps (text or generic icons today):** operation kinds beyond the four (groove / profile "on", fillet, shape import use text or Lucide), tool types (no icon: flat, bull nose, ball, drill are text only; V-bit is not a tool type yet), reference model (Lucide `Box`), snap, setups (only the per-setup direction icon), export gCode (Lucide `Download`), run.

### Style rules (proposed)

1. **Grid and stroke:** own icons on a 16 px grid, 1.35 px stroke (`--icon-stroke`), round caps and joins, no fills except dots ≤ 1.8 px. Lucide icons keep their 24 grid; at 16 px their stroke is 1.33 px, so both sit together. (ui.md said "24 px grid" for own icons; the code and this set use 16, to be corrected on approval.)
2. **Corners:** rectangles `rx` 0.5–1.5 (1 by default); outlines touch the 1.5 px margin, never the edge.
3. **One accent part per icon:** the part that tells the concept apart (a tool's cutting end, the pass lines of facing, the floor of the setup's up face, the G of gCode). Lucide icons have none.
4. **Where amber shows:** toolbar and navigator icons are grey at rest; the accent part turns amber when the control is active (pressed toggle, selected row, current mode) and always in a primary button. Field illustrations keep their own rule (D-entry: amber focused and unfocused; the line thickens on focus). Disabled and read-only: the whole icon grey at 45 % opacity, accent desaturated.
5. **Sizes:** 16 (default), 20 (run controls, tool picker), 14 inline; never scaled below 14. Tools are side views, operations and UI front/top views.
6. **Colour:** grey is `currentColor` (`--text-muted` in rows, `--text` in buttons); amber is `--accent-icon` with `--accent-icon-edge` (a hairline in light theme).

### Critical review at 16 px

- Flat, bull nose and ball end mill differ only in the bottom 2–3 px; at 16 px they need the tool name beside them (always the case in the tool field and library). Bodies were widened to 6 px for this.
- Groove (on) reads as the slot bend at 20 px and above; at 16 px it is close to a "signal" glyph. Alternative if rejected: the profile square with the amber line on its edge.
- Tabs (approved shape) is a small bump at 16 px, fine in a row with its label, too small alone in a toolbar.
- Fillet's dashed sharp corner disappears at 16 px; the arc alone still reads.
- Export gCode's G is 5 px; legible at 16 px on both themes, crisp at 20.

## Provenance and licence

- `b21/*`, and the icons marked `new` and `approved` in `b22/icons.mjs`: own drawings for DFYOM, GPL-3.0-or-later (the `approved` ones are copies of shapes already in `src/renderer/src/ui/icons/`).
- Icons marked `lucide` (settings, undo-2, redo-2, library): path data copied unchanged from `lucide-react` 1.77.0, ISC licence (GPL-compatible, [ADR 0014](../../docs/decisions/0014-gpl-3-or-later-license.md)); the app already ships them.
- No other sources, fonts or generated imagery were used.
