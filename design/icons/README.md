# Icon proposals: B21 app icon, B22 icon set

Status: **approved in L3 (D33)** ([plan v0.3](../../docs/plans/v0.3.md)) with the recommendations. B21 is built: concept C is the app icon (`build/icon.*`, made by `npm run icon`, [ui.md § App name and icon](../../docs/conventions/ui.md#app-name-and-icon)). B22 is not wired into the app yet; `src/renderer/src/ui/icons/` is unchanged. The style rules are proposed in [ui.md § Icon set proposal](../../docs/conventions/ui.md#icon-set-proposal-v03-b22-draft). B22 is wired: its rules are in [ui.md § Icons](../../docs/conventions/ui.md#icons).

## Files

| Path                | What                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `b21/concept-*.svg` | Three app icon concepts, 1024 canvas; `concept-c-small.svg` is the approved C simplified for 16 and 32 px                              |
| `b22/icons.mjs`     | Adapts the single source (`src/renderer/src/ui/icons/iconSet.ts`) for the renders: `ICONS` and `iconSvg()`                             |
| `b22/sync-page.mjs` | Writes the icon sheet of `docs/conventions/ui-design-system.html` from the single source (a test checks it)                            |
| `b22/svg/*.svg`     | Standalone exports of those icons (generated; grey `#5b6462`, accent `#f5b700`)                                                        |
| `render.mjs`        | Renders everything with headless Chromium (no window): `node design/icons/render.mjs [outDir]`; `CHROMIUM_PATH` picks an installed one |
| `renders/*.png`     | B21 concepts at 1024, small-size sheet; B22 specimen and in-context mock, L1 and DF11 sheets, light and dark                           |

The specimen and the mock load the real `src/renderer/src/ui/tokens.css`, so colours follow the tokens.

## B21 app icon

All three use the macOS grid: 1024 canvas, 824 body at (100, 100), corner radius 185, a soft shadow below, light from the top left; amber `#f5b700` is the only saturated colour.

- **A · Flute:** a flat end mill (front view) cutting a slot into stock; the slot floor (the toolpath) and chips are amber. Most literal; at 32 px it is a thin vertical bar, at 16 px illegible.
- **B · Spiral pocket:** a pocket milled into light aluminium with its offset rings in amber and the end mill from above. Reads as CAM to people who know it; at 16 px an amber blob on a light square, and the light body is weak in a light Dock.
- **C · Routed D:** the monogram D milled as a groove into a graphite block, amber floor, the end mill (from above) near the end of the stroke with the rest as a dashed toolpath preview. Holds up best: a clear amber D on dark at 32 and 16 px, distinct from other apps; the tool turns into a light dot at 32 px. **Recommended.**

Small sizes (`renders/b21-small-sizes.png`): the `.icns` holds separate 16/32 px artwork, so whichever concept wins gets a simplified 16/32 variant (for C: the D alone, no tool, no dashes).

**Decision (L3, D33):** C · Routed D (B21-1 c), simplified 16 and 32 px images (B21-2 a, `b21/concept-c-small.svg`: the closed D groove, wider, no tool, dashes or texture), dark body only (B21-3 a). `scripts/app-icon.mjs` (`npm run icon`) renders the full drawing for 64 px and up and the small one for 16–32 px into `build/icon.{png,icns,ico}`.

## B22 icon set

Approved in L3 (D33, 2026-11-22) with these answers: **B22-1 b** (user override) every generic icon redrawn in the own style too, Lucide removed; **B22-2 a** 16 px grid, 1.35 px stroke, round caps and joins; **B22-3 a** amber only when active or in a primary button, field drawings keep always-amber; **B22-4 a** tool side views told apart by the amber tip, always next to the tool name, 20 px in the tool picker; **B22-5 a** groove = bent slot; **B22-6 a** V-bit drawn but shown only with the V-bit tool type (kept in the source as `reserved`); **B22-7 b** (user override) the tabs drawing refined to read alone at 16 px (still a bridge on a cut line: the stock top, the cut floor on both sides and the tab standing between them).

The rules live in [ui.md § Icons](../../docs/conventions/ui.md#icons). The single source is [`src/renderer/src/ui/icons/iconSet.ts`](../../src/renderer/src/ui/icons/iconSet.ts): the app's `<Icon>` renders it, `render.mjs` (through `b22/icons.mjs`) renders the specimen sheets and the SVG exports, `b22/sync-page.mjs` the design-system page's sheet. Groups: operations, features (v0.4: hole types, chamfer, Clones and its row kinds), tool types, drawing tools and shape kinds, modes and CNC actions, views, generic actions, status.

### Review at 16 px (after wiring)

- Flat, bull nose and ball end mill differ only in the bottom 2–3 px; they always sit next to the tool's name (tool field, tool picker at 20 px, library rows).
- Groove reads as the slot bend at 20 px and above; at 16 px it was close to a "signal" glyph. Redrawn in L1 (v0.4): 1 px wider, closed by a round cap at its visible end.
- Fillet is drawn but not shown: fillets are shape-item fields with the `corner` field illustration, not an operation.
- The pick (crosshair with a centre dot) and drilling (crosshair through the circle) were close. Redrawn in L1: a pointer touching a small face, no crosshair.
- Disconnect (the connect plug struck through) was the busiest drawing. Redrawn in L1: the prongs drawn apart from the plug, no strike-through.

### L1 (v0.4): feature icons and the B22 follow-ups

Drawn to the rules above for [ui.md § Icons (v0.4)](../../docs/conventions/ui.md#icons-v04), reviewed in L2. Contact sheet: `renders/l1-contact-{light,dark}.png` (each icon beside its label at rest and selected, then 16 / 20 / 32 px at rest and active, the replaced drawing beside each redraw); `render.mjs` writes it with the other renders.

- Hole types are front sections (plate top and bottom faces either side of the bore), told apart by the amber part: the bore walls, the counterbore step, the countersink cone. Chamfer is an edge section with its bevel amber and no bore.
- `chamfer-mill` is the former `v-bit` drawing, renamed to the name in ui.md (the `chamferMill` tool type's icon since C1).
- Clones: the source square, two dashed copies and the dotted path between them (amber).
- Row kinds (`row-grid`, `row-offset`, `row-polar`, `row-arc`, `row-point`, `row-along`): grid, arc, point and along read at 16 px; offset (three dots on a diagonal) and polar (the same with a ray from a small origin) are close at 16 px, so for L2: keep them or show the Add row menu's labels alone.

### DF11: stock size field illustrations

Dogfood DF11 ([ui.md § Stock dialog](../../docs/conventions/ui.md#stock-dialog-df11df13)): the Stock dialog showed the slot's length, width and depth drawings for the stock's Length, Width and Thickness. `stock-length`, `stock-width` and `stock-thickness` are field illustrations (viewBox 20, 1 px grey, one amber measured line) of one oblique block with its front bottom edge, receding bottom edge and front right vertical edge highlighted; the data is in [`ui/icons/field/stockSize.ts`](../../src/renderer/src/ui/icons/field/stockSize.ts), which `FieldIcon` and `render.mjs` both read. Review sheet: `renders/df11-stock-size-{light,dark}.png` (28 px beside the label at rest and focused, then 16 / 20 / 28 / 32 px, then the slot drawing replaced).

## Provenance and licence

- `b21/*` and every icon in `src/renderer/src/ui/icons/iconSet.ts` (`src`: `approved` = shapes approved with the design system or earlier, `b22` = drawn for this proposal, `redraw` = drawn for B22-1 b in place of a former Lucide glyph): own drawings for DFYOM, GPL-3.0-or-later. The `redraw` icons were drawn from scratch on the 16 px grid to the rules above, not traced or copied from Lucide or any other set.
- Lucide (`lucide-react`, ISC) is no longer a dependency, so its notice left the shipped third-party notices.
- No other sources, fonts or generated imagery were used.
