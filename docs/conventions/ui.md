# UI guidelines

Status: accepted · Principle: [principles.md §5](../principles.md#5-user-friendly-beginner-friendly-highly-graphical) · Decisions: [ADR 0012 Radix + own styles](../decisions/0012-radix-primitives-own-styles.md), [ADR 0010 react-three-fiber](../decisions/0010-react-three-fiber-viewport.md), [ADR 0017 APCA contrast](../decisions/0017-apca-contrast-for-design-tokens.md), [ADR 0018 red text token, secondary text](../decisions/0018-danger-text-and-secondary-text-role.md) · Terms: [glossary.md](../glossary.md) · Task: [v0.1 plan](../plans/v0.1.md) 1.11 (blocks 3.3–3.7, 3.12); v0.2 amendments: [plans/v0.2.md](../plans/v0.2.md) 1.5

How the renderer looks and behaves: design tokens, components, layout, interaction, run-mode safety, accessibility, copy, testing. Rules are imperative. The user's answers to the open questions are recorded as [decisions](#decisions); concrete token values, the palette and the component looks come from the approved [design system](#design-system) (task 1.16).

## Decisions

Settled with the user (tasks 1.11 and 1.16); the sections below specify them.

1. **Theme:** follow the OS, with a Light / Dark / System setting ([tokens](#design-tokens)).
2. **Design system first:** tokens, palette and a components preview were defined in a separate step and approved by the user before any UI is built (task 1.16, [design system](#design-system)). Look: a strict, serious desktop CAD-style tool, not a web page ([decision 17](#decisions)).
3. **Colour scales:** Radix Colors (MIT) 12-step scales, adapted to the chosen palette.
4. **CSS:** CSS Modules + CSS custom properties.
5. **Icons:** Lucide (ISC) + own CNC icons ([icons](#icons)).
6. **Renderer state:** Zustand (MIT) for per-window UI state (selection, mode, panels, pick mode); `useSyncExternalStore` over the document replica.
7. **i18n:** English only in v0.1, strings centralised in `messages/`, errors and warnings rendered from code + params, no library ([internationalization](#internationalization)).
8. **Typography:** system fonts at 13 px base with tabular numerals ([type](#type); 14 px before the design system).
9. **Control sizes:** 44 px in run mode, 28 px elsewhere ([sizes](#spacing-radii-sizes); 32 px before the design system).
10. **Viewport mouse:** selectable presets as a setting; default left-drag orbit, right-drag pan, wheel zoom to cursor; a Fusion 360-style preset and others where cheap ([selection and picking](#selection-and-picking)).
11. **Confirmations and run safety:** undo instead of confirm for document edits; a pre-flight dialog before every run, the virtual machine included; hold, stop and reset are never confirmed; `Escape` = feed hold while streaming; no single-key resume ([confirmations](#confirmations), [run safety](#run-mode-safety-ui)).
12. **Window chrome:** native title bar and native application menu.
13. **Panels:** `react-resizable-panels` (MIT).
14. **Testing:** Vitest + Testing Library + jsdom + axe-core for components, plus a dev-only gallery screen for manual review; the Playwright end-to-end tests cover the real app screens, not the gallery (decided 2026-11-21, [testing](#testing)).
15. **Outdated evaluation:** keep the last mesh, draw the edited operation's outline live, tint the mesh and show "Updating…" only after 300 ms ([evaluation status](#evaluation-status-pending-outdated-failed)).
16. **Reference autocomplete** in the quantity input (3.4): a simple list of valid references (earlier surfaces, tool parameters).
17. **Desktop look:** native title bar with the document name only, no logo or app name inside the window; toolbars, panels and a status bar; dense, not cramped.
18. **Accent Amber `#f5b700`, used sparingly:** on icons or parts of icons, selection, toggles and active states (switch, checkbox, segmented thumb, active mode); never a large fill. Accent icons use the saturated amber (`--accent-icon`) in both themes.
19. **No coloured primary button:** primary keeps the neutral surface and differs by a semibold label, a stronger outline and an amber icon; every primary button has an icon. Stop is the only filled control.
20. **Running is amber:** the running machine state takes the accent (play icon, a dot circling the badge edge), departing from IEC 60204-1 green on purpose; feed hold and warnings are orange; tool change is blue with an in-progress animation ([run safety](#run-mode-safety-ui)).
21. **Three severities:** soft warning (neutral, dismissible), hard warning (orange, not dismissible), error (red, impossible value, blocks Generate) ([warnings](#warnings-and-dfm)).
22. **Graphical fields:** every field has an illustration icon whose measured part is an amber line ([field](#field)).
23. **Mode switcher** is its own component, separate from tabs; it sits in the centre of the main toolbar (3.3b, [app shell](#app-shell)).
24. **Rich motion:** indicators slide, toolpaths draw in, selections pulse; every animation explains something and turns off with reduced motion ([motion](#motion)).
25. **Contrast by APCA:** colour contrast is checked with APCA Lc targets per role instead of WCAG 2 contrast ratios ([colour](#colour), [ADR 0017](../decisions/0017-apca-contrast-for-design-tokens.md)); red text has its own token and muted text a secondary role ([ADR 0018](../decisions/0018-danger-text-and-secondary-text-role.md)).

## Design system

Task 1.16, **approved by the user on 2026-11-20**. The reference is [ui-design-system.html](ui-design-system.html) (open it in a browser): principles, palette in both themes, every semantic token with its value, type, space, motion, icons, the component gallery in light and dark, and an example app shell. Nothing in the UI picks a colour, size or spacing ad hoc; every value is a token from that page, copied into `tokens.css` in task 3.3. Where this doc and the page differ on a value, the page wins; the rules stay here. Changes since approval are badged on the page and listed in its changelog:

- **APCA adjustments (2026-11-21):** ten colour values changed in OKLCH lightness only (hue kept, chroma as close as sRGB allows) so every contrast pair meets its role target ([colour](#colour)). Light: `--text-muted` `#5b6462` → `#515957`, `--danger` `#c9363a` → `#a6051d`, `--safety-hold` `#e8741c` → `#ff9a5c`. Dark: `--text-muted` `#a2acaa` → `#d1dcda`, `--border-control` `#6d7878` → `#7a8686`, `--danger` `#ef6366` → `#ffcecb`, `--info` `#6aa9ea` → `#85c1ff`, `--safety-hold` `#f28b3c` → `#ff9a50`, `--safety-action` `#5ea2e6` → `#74b8fe`, `--safety-offline` `#7a8482` → `#939e9c`. Same-valued tokens (`--safety-idle`, `--vp-feed`, `--text-faint`, `--vp-stock`, `--vp-rapid`) keep their approved values. `--text-muted` and `--danger` were revised again by the split below.
- **After the APCA pass: split tokens (2026-11-21, [ADR 0018](../decisions/0018-danger-text-and-secondary-text-role.md)):** red text moved to the new `--danger-text` (light `#a6051d`, dark `#ffcecb`, the APCA-pass values), so `--danger` is a saturated red again for outlines, the error marker and icons: light `#a6051d` → `#c9363a` (approved value), dark `#ffcecb` → `#ff7475` (approved `#ef6366`, lightened for the icon target). `--text-muted` takes the secondary role (Lc 60): light `#515957` → `#5b6462` (approved value), dark `#d1dcda` → `#b9c4c1` (approved `#a2acaa`).
- **New since approval (2026-11-21, deviation from the original design):** `--vp-hover` (light `#f8edcc`, dark `#3f4136`), `--vp-outdated` (light `#d6dae3`, dark `#232828`) and the viewport selection tint (25 % `--vp-selected` + amber outline), all from task 3.5 ([viewport](#viewport-task-35)); `--vp-plunge` (light `#835bae`, dark `#a886cf`, muted violet) for plunges in the toolpath preview (task 3.7); `--danger-text` (above).
- **Accepted (2026-11-21):** the user reviewed the colours after the APCA pass (split tokens, secondary text, `--vp-plunge`) and accepted them as is ([ADR 0018](../decisions/0018-danger-text-and-secondary-text-role.md)).

- **Base colours (from the user):** dark theme background Jet `#272d2d`, light theme background Ghost White `#f6f8ff`; neutrals lean slightly towards them.
- **Accent:** Amber `#f5b700` (option D of four). It shares a hue with feed hold and warnings, so they are separated by hue (both orange, `#c96a00` / `#f2993a` for warnings), by usage (the accent never fills a badge, a warning or a button) and by shape (triangle for warnings, pause bars for hold).
- Safety tokens stay reserved for the machine state badge, the stop control and run dialogs. Every machine state has a **label and a shape** ([run safety](#run-mode-safety-ui)), so no state depends on telling two hues apart.
- The App shell section of the page is an illustration, not a layout decision; the window layout is designed in 3.3 against [layout](#layout).
- The segmented control's selected thumb stays amber with dark text (`--text-on-accent`).

## Where things live

| Path                                        | Holds                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/renderer/src/ui/tokens.css`            | All design tokens as CSS custom properties, light and dark ([tokens](#design-tokens)).                                                                                                                                         |
| `src/renderer/src/ui/base.css`              | The only other global CSS: box sizing, body font and colours, focus ring, reduced motion.                                                                                                                                      |
| `src/renderer/src/ui/<Name>/`               | One component per folder: `<Name>.tsx`, `<Name>.module.css`, `<Name>.test.tsx`.                                                                                                                                                |
| `src/renderer/src/ui/index.ts`              | The library's public API; screens import from `ui/`, never from Radix.                                                                                                                                                         |
| `src/renderer/src/ui/UiProvider/`           | `UiProvider` (tooltip timing), `ThemeScope` and the portal container overlays render into.                                                                                                                                     |
| `src/renderer/src/ui/icons/`                | Own icons: `tool/` (CNC tool and view icons), `field/` (field illustrations) ([icons](#icons)).                                                                                                                                |
| `src/renderer/src/ui/motion.ts`             | `useReducedMotion()`: OS preference or `data-motion='reduce'` on the root ([motion](#motion)).                                                                                                                                 |
| `src/renderer/src/gallery/`                 | Dev-only component gallery at `#gallery` ([testing](#testing)); not in production builds.                                                                                                                                      |
| `src/renderer/src/test/`                    | Test setup and helpers (`renderUi`, `expectNoAxeViolations`, `setReducedMotion`, fake bridge).                                                                                                                                 |
| `src/renderer/src/shell/`                   | App shell: regions, toolbar, status bar, dialogs, shortcuts, `ShellViewport` ([layout](#layout)), `project/` ([project files](#project-files))                                                                                 |
| `src/renderer/src/state/`                   | Per-window state: [replica](#document-replica), [settings](#settings) mirror, Zustand UI store (mode, selection per mode, pick mode), part evaluations (`evaluations.ts`).                                                     |
| `src/renderer/src/modes/{design,plan,run}/` | Mode screens; `ui/` components only. `ModePanels.tsx` routes navigator, inspector, status-bar part and viewport scene per mode; design (3.6), run (3.12, [run safety](#run-mode-safety-ui)); plan is built in 3.7 (see below). |
| `src/renderer/src/viewport/`                | The react-three-fiber canvas and scenes (task 3.5).                                                                                                                                                                            |
| `src/renderer/src/messages/`                | User-facing strings and the error/warning message catalogue ([copy](#copy-and-terminology)).                                                                                                                                   |

The renderer holds a read replica of `ProjectDoc` kept current by the patch stream and sends every change as a command over IPC ([commands.md](../architecture/commands.md#project-state)). Selection, camera, panel layout and mode are per-window UI state, never in the document or undo history.

## Design tokens

Tokens are **CSS custom properties** on `:root` in `tokens.css`, consumed by CSS Modules ([decision 4](#decisions)). Values come from the [design system](#design-system); this section fixes names and structure.

- **Semantic** tokens (below) are the only tokens components use. The design system sets them directly; Radix Colors scales ([decision 3](#decisions)) were the starting point for the neutrals and feedback hues, and primitives (`--gray-*`, …) are added to `tokens.css` only if a value is needed by several semantic tokens.
- A theme is a set of semantic values: light on `:root`, dark under `:root[data-theme='dark']` and under `prefers-color-scheme: dark` unless `data-theme='light'` is set; the setting offers Light / Dark / System, default System ([decision 1](#decisions)). Classes `.t-light` / `.t-dark` scope a theme to a subtree (the gallery).

Units: `rem` for type and spacing (so Electron zoom scales the UI), `px` only for hairlines (1 px borders). The viewport reads its colours with the `useTokens(ref, names)` / `useToken(ref, name)` hooks (`viewport/useTokens.ts`: `getComputedStyle` on the viewport element, so theme scopes apply; re-read on theme change), so there is one source of truth for three.js too.

### Colour

| Token group       | Tokens                                                                                                                                                                                                                                                                                  | Use                                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces          | `--bg-app`, `--bg-chrome`, `--bg-viewport`, `--bg-field`, `--bg-control`, `--bg-raised`, `--bg-hover`, `--bg-active`, `--bg-overlay`                                                                                                                                                    | App background, toolbars/panels/status bar, viewport, inputs, buttons, popovers, hover and pressed tints, dialog scrim.                                                                       |
| Text              | `--text`, `--text-muted`, `--text-faint`, `--text-on-accent`, `--text-on-solid`, `--text-accent`                                                                                                                                                                                        | Body, secondary (labels, units, ids, hints; never body copy), placeholders and disabled, on amber, on solid colours, amber-toned text.                                                        |
| Lines             | `--border`, `--border-control`, `--focus`                                                                                                                                                                                                                                               | Separators, input and button outlines, focus ring.                                                                                                                                            |
| Accent            | `--accent`, `--accent-hover`, `--accent-border`, `--accent-subtle`, `--accent-icon`, `--accent-icon-edge`                                                                                                                                                                               | Toggles, selection, active mode; accent icon parts (the edge is a hairline filter in light only).                                                                                             |
| Feedback          | `--info`, `--success`, `--warning`, `--danger` (+ `-subtle` backgrounds), `--danger-text`                                                                                                                                                                                               | Hard warnings, done, errors and destructive actions ([severities](#warnings-and-dfm)). Never for machine state. Red text uses `--danger-text`; `--danger` is for outlines, markers and icons. |
| Safety (reserved) | `--safety-stop`, `--safety-alarm`, `--safety-hold`, `--safety-moving` (+ `-edge`), `--safety-action`, `--safety-idle`, `--safety-offline` (+ `-fg`)                                                                                                                                     | Machine state and the stop control only ([run safety](#run-mode-safety-ui)). Never reused elsewhere.                                                                                          |
| Viewport          | `--vp-grid`, `--vp-grid-major`, `--vp-stock`, `--vp-part`, `--vp-edge`, `--vp-removal`, `--vp-selected`, `--vp-selected-halo`, `--vp-feed`, `--vp-rapid`, `--vp-tool`, `--vp-axis-x/y/z`, `--vp-plunge`, `--vp-hover`, `--vp-outdated` (new since approval); background `--bg-viewport` | 3D scene. Axis colours follow the CAD convention X red, Y green, Z blue.                                                                                                                      |

Rules:

- Contrast is measured with **APCA** (APCA-W3 0.0.98G-4g), not WCAG 2 ratios ([decision 25](#decisions), [ADR 0017](../decisions/0017-apca-contrast-for-design-tokens.md)): the lightness contrast `Lc` of a foreground on its background (order matters; negative for light on dark) must reach the target of its role, in both themes ([accessibility](#accessibility)). Targets follow the APCA Bronze levels at the sizes and weights we use; our 10–13 px text is below Bronze's font minimums, so they are floors:

  | Role      | \|Lc\| ≥ | Used for                                                                                                                              |
  | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
  | read      | 75       | Text read for content at 11–13 px, regular (400): body, values, menus, error text                                                     |
  | secondary | 60       | Secondary text at 11–13 px (`--text-muted`): labels, hints, notes, ids, descriptions under a title, read-only values; never body copy |
  | label     | 60       | Text at 10–13 px, medium/bold (500–600): button labels, chips, badges, tooltips                                                       |
  | spot      | 30       | Non-content text: placeholders, unit suffixes, metadata, disabled (`--text-faint`)                                                    |
  | icon      | 45       | Outline pictograms with fine detail (1.5 px stroke, 12–16 px)                                                                         |
  | mark      | 30       | 1–2 px control outlines, focus ring, solid indicators ≥ 5.5 px                                                                        |

  Heading-size text (≥ 24 px bold) would take Lc 45; no token pair is used only at that size. The pairs and their roles are listed in `src/renderer/src/ui/tokens.test.ts` (`PAIRS`), which computes them from `tokens.css`; every pair meets its target in both themes (values adjusted 2026-11-21, [design system](#design-system)). Text people must read as body copy uses `--text`, not `--text-muted`. Red text uses `--danger-text` (read / label); `--danger` pairs are marks and icons. Viewport lines (feature edges on part, hover and outdated surfaces; stock, toolpaths (feed, rapid, plunge), tool, axes and the error marker on `--bg-viewport`) take the mark target; the grid and surface tints are quiet area fills with no target.

- Colour never carries meaning alone: every status also has a label or icon (and shape for machine states).
- Safety colours follow the IEC 60204-1 indicator meanings (red = emergency/alarm, orange/amber = abnormal/attention, blue = action required, grey = neutral/off) with one deliberate exception: running uses the amber accent instead of green ([decision 20](#decisions)).
- The accent appears as a line, an icon part, a thumb or a check, never as a large fill; `--accent-calm*` from the page is for proposal callouts in docs only.

### Type

System font stacks with `font-variant-numeric: tabular-nums` on every numeric display ([decision 8](#decisions)): `--font-ui` (system-ui), `--font-mono` (ui-monospace) for gCode, ids in formulas and the [DRO](../glossary.md).

| Token (+ `--lh-*`) | Size / line height | Use                               |
| ------------------ | ------------------ | --------------------------------- |
| `--text-xs`        | 11 / 14 px         | Badges, unit suffixes, status bar |
| `--text-sm`        | 12 / 16 px         | Hints, inline messages, tooltips  |
| `--text-md` (base) | 13 / 18 px         | Body, inputs, buttons             |
| `--text-lg`        | 15 / 20 px         | Panel and dialog titles           |
| `--text-xl`        | 20 / 26 px         | Empty-state titles, run progress  |
| `--text-dro`       | 24 / 28 px, mono   | DRO axis values                   |

Sizes are written in `rem` in `tokens.css`; the table shows them at 100 % zoom.

Weights: `--weight-regular` 400, `--weight-medium` 500 (labels, buttons), `--weight-bold` 600 (titles). No italics for emphasis in messages.

### Spacing, radii, sizes

- Spacing on a 4 px grid: `--space-0-5` 0.125 rem, `--space-1` 0.25 rem, `-2` 0.5, `-3` 0.75, `-4` 1, `-5` 1.25, `-6` 1.5, `-8` 2 rem. Component padding uses `-2`/`-3`; between panel sections `-4`.
- Radii: `--radius-xs` 3 px (chips inside controls), `--radius-sm` 5 px (inputs, buttons), `--radius-md` 7 px (popovers, cards), `--radius-lg` 10 px (dialogs), `--radius-full` (pills, status chips).
- Control heights: `--control-sm` 1.5 rem (dense tables), `--control-md` 1.75 rem (default, 28 px), `--control-lg` 2.75 rem (run-mode controls). Pointer targets are ≥ 24 × 24 px everywhere (WCAG 2.2 target size) and ≥ 44 × 44 px in run mode ([decision 9](#decisions)), which may be used on a shop touchscreen.

### Elevation

| Token        | Use                                       | Light        | Dark                        |
| ------------ | ----------------------------------------- | ------------ | --------------------------- |
| (none)       | Panels and toolbars (flat, bordered)      | none         | none                        |
| `--shadow-1` | Floating viewport toolbars, toasts        | small shadow | small shadow + `--border`   |
| `--shadow-2` | Popovers, menus, tooltips (`--bg-raised`) | medium       | medium + `--border-control` |
| `--shadow-3` | Dialogs, over `--bg-overlay`              | large        | large                       |

Z-order follows elevation (`--z-toolbar`, `--z-dialog`, `--z-popover`, `--z-toast`); popovers, menus, tooltips and `Select` lists sit above dialogs because they can open inside one (the "New tool" form's selects), and a modal dialog makes everything outside it inert, so no outside popover is open with it. The [global stop control](#run-mode-safety-ui) sits above dialogs (`--z-safety`), so no overlay ever hides it.

### Motion

- Durations `--motion-instant` 80 ms (press), `--motion-fast` 120 ms (hover, colour), `--motion-base` 180 ms (popovers, panels, the field support area pulling out), `--motion-slow` 280 ms (dialogs, segmented thumb, camera view changes), `--motion-emphasis` 450 ms (selection pulse), `--motion-draw` 900 ms (toolpaths drawing in). Easing `--ease-standard` `cubic-bezier(0.2, 0, 0, 1)`, `--ease-emphasized` `cubic-bezier(0.2, 0.8, 0.2, 1)` for things that arrive, `--ease-exit` `cubic-bezier(0.4, 0, 1, 1)` for things that leave.
- `--delay-tooltip` 450 ms. `--delay-indicator` 300 ms: spinners, "Updating…" chips and progress for short work appear only after this delay, so fast work never flickers.
- Motion explains a change (where a panel came from, what moved, what is selected). Only ongoing processes loop: progress, the running badge's circling dot and the tool-change badge's swap icon and light sweep.
- `prefers-reduced-motion: reduce` (and the matching app setting, `data-motion='reduce'` on the root) sets every duration to 0 and replaces camera animations with cuts; progress bars and the moving indicator stay, without animation of their own beyond the value change. Looping indicators render a static fallback via `useReducedMotion()` (the running badge drops its circling dot, the tool-change badge its sweep).

## Components

### Radix wrapping pattern

Per [ADR 0012](../decisions/0012-radix-primitives-own-styles.md): Radix primitives, copied-in wrappers in the shadcn/ui style (we own the code; no shadcn dependency), our tokens.

- Only `src/renderer/src/ui/` imports Radix (`radix-ui` package); an ESLint `no-restricted-imports` rule enforces it like the other [layer boundaries](../decisions/0015-eslint-with-typescript6-api.md). Mode screens use `ui/` components.
- Each wrapper exposes a **small, typed API**: our variants (`variant: 'default' | 'primary' | 'ghost' | 'danger'`, `size: 'sm' | 'md' | 'lg'`) as props, rendered as `data-variant` / `data-size` attributes and styled in the CSS module. No `className` overrides from screens except layout (margin, grid placement) through a `className` prop that the wrapper appends.
- Style interaction states with Radix's data attributes (`[data-state='open']`, `[data-highlighted]`, `[data-disabled]`) and `:focus-visible`, never with JS-computed classes.
- Keep Radix's accessibility behaviour (focus trap, roving focus, `aria-*`); never re-implement it. Keep `asChild` where composition needs it (e.g. a `Tooltip` around an `IconButton`).
- Portals render into `document.body` by default, which inherits the root's `data-theme`; inside a `ThemeScope` (`.t-light` / `.t-dark`) they render into the scope, so they keep its theme.
- CSS module classes are read with brackets (`styles['button']`): the renderer keeps `noPropertyAccessFromIndexSignature`.
- Every icon-only control has an accessible name (`aria-label`) and a tooltip with the same text plus its shortcut.
- Header comment of every wrapper links back to this doc.

### Inventory (v0.1)

**Primitives** (Radix-based, task 3.3):

| Component                                                       | Radix primitive                   | Used for                                                 |
| --------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------- |
| `Button`, `IconButton`                                          | – (`Slot`)                        | All actions                                              |
| `SegmentedControl`                                              | `ToggleGroup`                     | Inspector sections, strategy choices, unit-system toggle |
| `ModeSwitcher`                                                  | `ToggleGroup`                     | Design / Plan / Run ([decision 23](#decisions))          |
| `Tabs`                                                          | `Tabs`                            | Inspector sections where needed                          |
| `Dialog`, `ConfirmDialog`                                       | `Dialog`, `AlertDialog`           | Tool change, export, [confirmations](#confirmations)     |
| `Popover`, `Tooltip`, `HoverCard`                               | `Popover`, `Tooltip`, `HoverCard` | Pickers, short help, [term](#copy-and-terminology) cards |
| `Menu`, `ContextMenu`                                           | `DropdownMenu`, `ContextMenu`     | Row and viewport actions                                 |
| `Select`, `Checkbox`, `Switch`, `RadioGroup`                    | same                              | Strategy, options                                        |
| `Slider`                                                        | `Slider`                          | Time scale; never the only way to enter a quantity       |
| `Progress`                                                      | `Progress`                        | Jobs and run progress                                    |
| `Toast`                                                         | `Toast`                           | Undo offers, neutral notices                             |
| `Collapsible`, `Accordion`                                      | same                              | Inspector groups, error details                          |
| `ScrollArea`, `Separator`, `Label`, `VisuallyHidden`, `Toolbar` | same                              | Layout and a11y helpers                                  |

**App components** (own, on top of primitives):

| Component                                                                                                 | Task     | Notes                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Field`                                                                                                   | 3.3      | [Field](#field): illustration, label (+ `Term`), lock (optional, may be disabled with a reason), control, support area; wires `aria-describedby`.                                                                                                                            |
| `QuantityInput`                                                                                           | 3.4      | [Quantity input rules](#quantity-and-expression-input).                                                                                                                                                                                                                      |
| `Term`                                                                                                    | 3.3      | Glossary term with tooltip and "Learn more" (with the wiki panel) ([copy](#copy-and-terminology)).                                                                                                                                                                           |
| `StatusChip`                                                                                              | 3.3      | Plan status, stale badge, evaluation status, machine state (with safety tokens).                                                                                                                                                                                             |
| `WarningList`, `WarningItem`                                                                              | 3.6, 3.7 | DFM, feeds-and-speeds and machine-check warnings ([warnings](#warnings-and-dfm)).                                                                                                                                                                                            |
| `ErrorMessage`, `ErrorDetails`                                                                            | 3.3      | [AppError display](#errors); details: the "Details" expander with "Copy details".                                                                                                                                                                                            |
| `JobIndicator`, `JobList`                                                                                 | 3.3      | [Jobs and progress](#jobs-and-progress); `JobList` opens in the indicator's popover.                                                                                                                                                                                         |
| `UndoRedo`                                                                                                | 3.3      | [Undo and redo](#undo-and-redo).                                                                                                                                                                                                                                             |
| `EmptyState`                                                                                              | 3.3      | Explains the next step with one primary action.                                                                                                                                                                                                                              |
| `Panel`, `PanelGroup`                                                                                     | 3.3      | Resizable, collapsible shell regions (`react-resizable-panels`, [decision 13](#decisions)).                                                                                                                                                                                  |
| `OperationList`                                                                                           | 3.6      | Design order; move up/down by buttons and `Alt+↑/↓` (drag later).                                                                                                                                                                                                            |
| `ParamIllustration`                                                                                       | 3.6      | Dynamic SVG per operation drawn from the entered values; highlights the focused parameter.                                                                                                                                                                                   |
| `Viewport`, `ViewPresets`                                                                                 | 3.5      | One persistent canvas; the mode decides the scene ([selection](#selection-and-picking)).                                                                                                                                                                                     |
| `PlanPicker`, `ToolPicker`, `FeedsSpeedsCard`, `ExportDialog`                                             | 3.7      | Tool suggestions with reasons; feeds-and-speeds derivation as formulas ([feeds-speeds.md](../architecture/feeds-speeds.md)).                                                                                                                                                 |
| `StopControl`, `MachineStateBadge`, `Dro`, `JogPad`, `RunProgress`, `ToolChangeDialog`, `ConnectionPanel` | 3.12     | [Run-mode safety UI](#run-mode-safety-ui). `StopControl` and `MachineStateBadge` in `ui/`; the rest in `modes/run/` (they read run state): `Dro`, `JogPad`, `RunProgressView` (in `RunInspector`), the tool-change dialog in `RunDialogs`, the connection in `RunNavigator`. |

**v0.2 components** (accepted, not built; tasks in [plans/v0.2.md](../plans/v0.2.md); rules in [Design and plan controls (v0.2)](#design-and-plan-controls-v02)):

| Component                        | Task | Notes                                                                                 |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `FaceGlyph`, `FaceFrameAxes`     | F1   | Viewport overlays in pick mode and on the selected operation's face.                  |
| `AnchorPicker`                   | F2   | 3 × 3 `RadioGroup`; the viewport's anchor marker.                                     |
| `ToolField`                      | F5   | Combobox of `design.tool.candidates` in a `Field` with the tool lock.                 |
| `ApplyButton`                    | P3   | Main toolbar ([app shell](#app-shell), [apply.md § UI](../architecture/apply.md#ui)). |
| `SetupList`                      | F6   | Plan navigator: setups with their plan operations.                                    |
| `SetupChangeDialog`              | E2   | Run dialog between setups ([run-mode safety](#run-mode-safety-ui)).                   |
| `ReferenceGhost`, `ReferenceRow` | R3   | Viewport ghost and navigator row ([reference ghost](#reference-ghost-v02)).           |

A dev-only **gallery** screen renders every `ui/` component in every variant and state in both themes, side by side as in the [design system](#design-system) page; it is the manual review surface ([testing](#testing)).

### Buttons

- Variants: default, primary, ghost, danger; sizes sm/md. All share the neutral surface (`--bg-control`, `--border-control`).
- **Primary** ([decision 19](#decisions)): semibold label, `--border-control` outline that warms towards amber on hover, and an icon in `--accent-icon`. At most one primary per panel or dialog.
- Danger uses `--danger-text` for the label and icon, never a red fill; the hover border mixes in `--danger`. Stop is the only filled control ([run safety](#run-mode-safety-ui)).
- Toggles (switch, checkbox, segmented thumb, pressed icon button) use the accent: amber thumb or check, or the amber part of the icon.

### Field

The `Field` component (3.3, quantity behaviour in 3.4) is a grid: label column (illustration + label), a lock column, the input, and a support area under the input.

- **Illustration** (`--icon-xl` 28 px, viewBox 20, 1 px grey drawing): draws the feature and makes the measured part itself one amber line (1.4 px, butt caps, on the same centreline as the drawing; 1.6 px while focused). No dimension arrows. Length runs end to end along the slot, width across its middle, depth the wall, stepdown the riser, corner radius the arc, chamfer the face, feed the travel line. The icon keeps full colour (`--text-muted` drawing, `--accent-icon` line) and saturation whether the field is focused or not (decided by the user 2026-11-21, was 35 % at rest); focus only thickens the amber line. Read-only and disabled fields stay fully desaturated at reduced opacity. The drawing meets the APCA icon target on `--bg-app` and `--bg-chrome` (`tokens.test.ts`).
- **Lock** sits between label and input, outside the input; pressed, the other recommendations follow this value.
- **Lock rule** (the user's; accepted 2026-11-21, implemented in task 3.14): a lock appears only on a field that has a recommendation (auto) mode, while that mode is on; it means "use this value as a starting point, the other recommendations adjust to it". Without a recommendation, or with it off, the lock is **hidden** (not disabled): `Field` renders it only when the `lock` prop is given. It is **disabled** when its value is invalid, contradicts a limit, or makes the calculation impossible: `lock.disabledReason` makes it `aria-disabled` (stays focusable, a click does nothing), with the reason as its tooltip and as visible text in the support area (a lock-icon note), linked by `aria-describedby`. A toggle button with `aria-pressed` and a constant name ("Lock Spindle speed"; `lock.name`, default "Lock <label>"). Typing a value never presses the lock. Only plan mode's feeds fields have a recommendation mode ([plan-v0.1.md § Locks and auto mode](../modes/plan-v0.1.md#locks-and-auto-mode)); stickout (a tool default, not a recommendation), read-only fields and design fields (DFM suggests fixes, nothing recommends one value from others) have no lock, also on the [design system](ui-design-system.html) page.
- **Pencil** inside the input, on a tinted round background, opens the adjust popover (step buttons .001–100 and the recommended value); amber-tinted when a fix is available.
- **Support area:** one group under the input that looks pulled out from under it (no top corners, inset from the input's rounding, a small shadow from the input, slides in with `--motion-base`). It holds the echo ([quantity input](#quantity-and-expression-input)), the highest-severity status with its fix button ("Use 3.00"), and further notes collapsed ("1 dismissed · Show"). Its background follows the severity ([warnings](#warnings-and-dfm)). Read-only fields show it dimmed with a dashed border.
- **Support area collapse** (decided by the user 2026-11-21): when the echo goes away on blur and a pointer is pressed (the click that moved focus), the echo stays until the pointer is released and its click has been dispatched (`Field/pointerRelease.ts`), so the click lands on what was under the pointer at pointerdown. Then the echo, or the whole support area if it held only the echo, collapses in height with `--motion-base` and `--ease-standard` (Web Animations); with reduced motion it goes at once. Leaving with the keyboard collapses it right away (animated).
- Narrow panels: the input column narrows before the label column; below 260 px the support buttons wrap under the text. Field lists in a container (`container-type: inline-size`) narrower than 20 rem put the label above the input, the lock and input on the next row (decided in 3.6: in the 16 rem navigator and the 20 rem inspector the 124 px label column left the input no room; approved by the user 2026-11-21, on the [design system](ui-design-system.html) page).

## Layout

### App shell

The window layout (task 3.3b, `shell/AppShell.tsx`): the sketch was the starting point, the bullets after it are what is built. The shell in the [design system](#design-system) page is an illustration only.

```text
┌ Native title bar: project name, unsaved state ───────────────────────────────┐
├ Main toolbar ─────────────────────────────────────────────────────────────────┤
│ Undo Redo │ mode tools │ Mode switcher (place: 3.3) │ Machine state  [STOP]  │
├ Left panel ──────┬ Viewport ──────────────────────────────┬ Inspector ────────┤
│ Mode navigator   │ 3D scene, view presets, overlays       │ Selected item:    │
│ (operations,     │                                        │ fields, warnings, │
│  plan order,     │                                        │ illustration,     │
│  machine)        │                                        │ recommended values│
├ Status bar ──────┴────────────────────────────────────────┴───────────────────┤
│ Evaluation · Jobs · Warnings n · Unit system · Saved/unsaved · Agent connected│
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Title bar:** native, the project name and unsaved state only; no logo or app name ([decision 17](#decisions)).
- **Main toolbar:** undo/redo, the mode's tools, the [mode switcher](#mode-switching), and – whenever a machine connection is open – the machine state badge and the [stop control](#run-mode-safety-ui), in every mode.
- **Apply button** (v0.2, D13; task P3): "Apply N" as the first item of the toolbar's end column while changes are pending, with a tooltip explaining Apply; states, keys and copy in [apply.md § UI](../architecture/apply.md#ui).
- **Left panel (navigator):** what the mode is made of. Design: part, stock, operations in design order. Plan: plan picker, plan status, setup, plan operations in machining order. Run: connection, homing, jog, work zero.
- **Viewport:** centre, always present; one react-three-fiber canvas kept alive across modes (no WebGL context churn); the mode decides the scene.
- **Inspector (right):** parameters of the selection, its warnings, the `ParamIllustration`, recommended ranges. In run mode: DRO, run progress, run controls.
- **Status bar:** [evaluation status](#evaluation-status-pending-outdated-failed), [jobs](#jobs-and-progress), warning count (opens the warning list), unit system, save state, agent connection.
- One project per window; New / Open with a project open go to a new window ([project files](#project-files)). Side panels are resizable and collapsible; layout is per window, kept in app preferences, never in the project. Minimum window 1024 × 640; below 1280 px wide the inspector overlays the viewport instead of shrinking it.
- **Window chrome:** native title bar and native application menu (File, Edit, View, Help) with accelerators that dispatch the same commands as the buttons ([decision 12](#decisions); built in 3.6, [keyboard shortcuts](#keyboard-shortcuts)).

As built (3.3b):

- **Main toolbar** (`banner`): a three-column grid. Start: `UndoRedo` (then the mode's tools, from 3.6). Centre: the `ModeSwitcher` in a `navigation` landmark named "Modes". End: while a machine connection is open, the machine group (3.12, `modes/run/MachineToolbar.tsx`, a `group` named "Machine": state badge in a polite live region, "Virtual machine · 10×" chip, "Feed hold" while streaming, "Resume" while held, Stop), then panel toggles "Navigator" and "Inspector" (pressed while shown) and "Settings". The machine group also mounts the run dialogs, so waits and failures show in every mode.
- **Panels** (`Panel`, `PanelGroup` on react-resizable-panels): navigator 16 rem (min 12 rem, max 40 %), viewport (min 20 rem), inspector 20 rem (min 15 rem, max 45 %). Side panels keep their pixel size when the window resizes, collapse when dragged below their minimum or by their toggle, and resize by keyboard on the focused hairline separator. One panel group for every width, so the viewport is never remounted.
- **Layout persistence:** after the user resizes or toggles, the group's layout is saved (debounced 400 ms) in the [settings](#settings) under `layouts['shell-wide']` or `layouts['shell-narrow']`; a new window starts from it. The layout at mount is not written back.
- **Narrow windows** (below 1280 px, `WIDE_QUERY`): the inspector is not a panel but an overlay at the viewport's right edge (`--shadow-2`, slides in), closed until its toggle opens it.
- **Viewport:** `shell/ShellViewport.tsx` renders the one `Viewport` in the `main` landmark (named "Viewport"); `useModeScene(mode)` (`modes/ModePanels.tsx`) gives the scene props, so the canvas stays mounted across modes (3.6; it replaced the 3.3b `ViewportSlot`). Run adds its scene (`run={useRunScene(mode)}`: toolpath playback, tool marker, work zero); plan passes its toolpaths on the same prop (`usePlanScene`, [plan mode](#plan-mode-task-37)).
- **Title bar:** the document title is the project name, with " — Edited" while there are unsaved changes; "DFYOM" without a project.
- **Status bar** (`contentinfo`): save state ("No project", "Not saved yet" for an untitled project, "Unsaved changes", "Saved"), the mode's part (design, 3.6: the [evaluation status](#evaluation-status-pending-outdated-failed) in a polite live region and the warning count, which opens the warning list), the `JobIndicator`, the unit system, the agent indicator.
- **Agent indicator:** while agent sessions are attached, "Agent connected" / "n agents connected" in the status bar (in a polite live region); its popover names each session (client name or "Unknown client", source id, bound project) and links to the settings ([llm-api.md](../architecture/llm-api.md#local-http)).
- **Closing a project with its last window:** closing a window bound to a project that no other window shows closes the project first (`project.close` through the window's session; agents bound to it lose it). Main asks the window when the close is refused: unsaved changes → `ConfirmDialog` "Close “name” with unsaved changes?" with "Close without saving" (the changes stay recoverable); any other refusal (a run is going) → a dialog with the `ErrorMessage`. Quitting asks once for all projects ([confirmations](#confirmations)); after that, windows close without asking and `host.shutdown` closes every project. Decision logic: `src/main/window-close.ts`.

### Mode switching

- Modes are a three-way `ModeSwitcher` (its own component, [decision 23](#decisions)) in the centre of the main toolbar, `Ctrl/Cmd+1/2/3`. The mode is per window (Zustand UI store).
- Switching is instant and never blocked: jobs, evaluation and a run keep going. Each mode keeps its own selection and camera.
- A mode without its input shows an `EmptyState` instead of disabled controls: Plan without a part ("Design a part first", button to Design); Run without a plan ("Create a plan to run", button to Plan).
- Agents never switch the user's mode or steal focus; their edits appear in place ([undo](#undo-and-redo)).

### Panels and inspectors

- The inspector edits exactly one item: the selection. No selection → part (Design), plan (Plan), connection (Run) summary.
- Fields are grouped by what the user thinks about (Shape, Depth, Corners, Tabs), in the order of the [mode doc's](../modes/design.md#operations-v01) parameter tables; rarely changed groups start collapsed.
- Read-only states (a `finalized` plan, an `inUse` plan) show read-only fields (desaturated illustration, dimmed support area, [field](#field)) with a lock icon and the reason as a tooltip with the way out ("Finalized plans are read-only. Set the status to settled design to edit, or duplicate the plan."), not disabled grey inputs.
- Plan stale badges ([plan-v0.1.md](../modes/plan-v0.1.md#plans-are-snapshots)) appear on the affected row and in the plan header with the rebuild / library-update action next to them.

### Project files

New / Open / Save in the window (task 3.6; `shell/project/`, shared by every mode). The window calls the app-scope commands agents call (`project.create`, `project.open`, `project.save`, `project.recovery.*`); only the native file dialogs (`window.dfyom.files`; also the gCode export's `chooseExport`, [plan mode](#plan-mode-task-37)) and the window choice (`window.dfyom.window.openProject`, below) are window plumbing.

- **Without a project** the navigator shows the start panel in every mode: "New project" (dialog: name, unit system), "Open project", and the projects with unsaved changes from an earlier session ([persistence.md](../architecture/persistence.md#crash-recovery)), each with Restore and Discard (confirmed).
- **New / Open go to a new window when the window has a project** (decided by the user 2026-11-21, replacing the 3.6 "replace the window's project"): an empty window (no project) is reused; a window with a project keeps it, so nothing is closed and nothing asks about unsaved changes. The window runs every opening command (`project.create`, `project.open`, `project.recovery.resolve` with `restore`) through `window.dfyom.window.openProject`, window plumbing in main (`src/main/ipc.ts`, decision logic `src/main/window-open.ts`) that picks the window, runs the command through that window's session (the same command and result as `call`) and adds `window: 'this' | 'other' | 'new'` to the reply's value:
  - a file already open in a window (this one or another) is not opened twice: that window comes to the front (`other`; `this` when it is the asking window) – the [lock](../architecture/persistence.md#lock) would refuse a second open in this instance anyway, and `project.open` answers an open file with its key (`alreadyOpen`);
  - otherwise the asking window when it has no project (`this`), else a new window (`new`). The new window is created hidden, bound to the project by the command, and shown only once the command succeeded; a refused command (recovery, lock, error) closes it unseen and the asking window shows the answer as before (recovery prompt, foreign lock, error dialog), so "Restore" and "Try again" route the same way. Discarding recovered changes binds no project and runs in the asking window.
  - The new window opens in front, cascaded 22 px right and down from the asking window with its size, back to the work area's top-left corner when it would leave the display (`cascadeBounds`; the first window and windows without a source window use the default size, centred). Window state is per window: mode, selection, camera, plan choice and dialogs start fresh (design mode); panel layout comes from the [settings](#settings) like any new window.
  - **No window open** (macOS, after closing the last one): File → New project… / Open project… open an empty window (its start panel offers both); the other menu items need a window and do nothing. The Dock icon opens an empty window too (`activate`).
  - Agents address projects, not windows: an agent's `project.open` / `project.create` / `project.recovery.resolve` that starts a project runtime gets a new window bound to it (cascaded the same way; an empty window is not reused, so an agent never takes over the window the user is in); a project already open (`alreadyOpen`) gets no second window. The CLI's headless entry has no windows ([llm-api.md](../architecture/llm-api.md#processes-and-hosting)).
  - Opening from Finder (file associations, macOS `open-file`, a second app instance's arguments) is not built: the app declares no file association yet, and several instances may run side by side on purpose (the project [lock](../architecture/persistence.md#lock) keeps a file in one of them), so there is no single-instance lock or `second-instance` forwarding ([plan known issues](../plans/v0.1.md#known-issues-and-risks)).
- **Save** writes to the project file; an untitled project goes to **Save as**: the native save dialog (default name from the project, `.dfyom` added), then `project.save { target, confirm: true }` – the OS dialog already asked before replacing a file. The replica takes the new file from the save's outcome (`filePath`).
- **Recovery prompt:** `project.open` answering `persist.recovery` opens "Restore unsaved changes?" with "Restore changes" (primary) and "Discard changes" (danger, confirmed): `project.recovery.resolve`.
- **Foreign lock:** `persist.locked` opens "The project is open elsewhere" with the error, "Try again", and "Retry in 2 min" (a countdown, then it opens again by itself): a lock of a stopped instance on another computer can be taken over after 2 minutes ([persistence.md](../architecture/persistence.md#lock)).
- Other failures show the `ErrorMessage` in a dialog ("The project could not be opened / saved / created").

### Keyboard shortcuts

- The native menu (`src/main/menu.ts`): File (New project… `Ctrl/Cmd+N`, Open project… `Ctrl/Cmd+O`, Save `Ctrl/Cmd+S`, Save as… `Ctrl/Cmd+Shift+S`, Close window or Quit), Edit (Undo, Redo, cut, copy, paste, select all), View (Design / Plan / Run `Ctrl/Cmd+1/2/3`, Navigator, Inspector, zoom, full screen; reload and developer tools in development), Window, Help (Keyboard shortcuts). Items are sent to the focused window (`menu.onAction`), which runs the same handler as the button or key (`shell/useAppCommands.ts`).
- The window handles the same keys itself (so they work whichever sees a key first); a menu action within 300 ms of the same key handled by the window is its accelerator echo and is skipped (`shell/key-echo.ts`). Menu Undo/Redo in a text field edit the text (`document.execCommand`), elsewhere the history.
- `?` (not in a text field) and Help → Keyboard shortcuts open the shortcut list (`ShortcutsDialog`), grouped as project, edit, modes and panels, viewport, design navigator, fields.

## Shell state

### Document replica

`state/replica.ts`, the read side of [commands.md project state](../architecture/commands.md#project-state):

- At start and whenever main pushes `project.bound` (the window's bound runtime changed: bound, closed, reopened), the window takes a snapshot (`window.dfyom.project.snapshot()`: key, document, revision, the action-log `seq` it includes, file, unsaved flag), then applies the `project.onEvent` patch stream in `seq` order. Events that arrive while a snapshot is on its way wait and are applied after it (those it already includes are skipped).
- A gap in `seq` or a patch that does not apply starts a new snapshot (resync). Main subscribes to the log before it pushes `bound`, so a snapshot taken after the push misses nothing.
- Unsaved changes: revision ≠ the revision of the last successful `project.save` event (the snapshot's `dirty` flag seeds it). Undo and redo are commits, so they count as changes, as in the host.
- The UI reads it with `useSyncExternalStore` (`useReplica()`), never edits it, and sends every change as a command (`window.dfyom.call`). Undo/redo names come from `history.list` after each revision; jobs from `job.list` on job events, polled every 500 ms while one runs (progress ticks are not in the action log). Run mode follows the run job with `job.get` every 250 ms while it runs; the machine status itself is pushed (`window.dfyom.run.onStatus`).

### Settings

App settings (`src/shared/settings.ts`): GUI preferences of the app instance, owned by main (`src/main/settings/store.ts`), persisted in `<appData>/settings.json`, mirrored by every window (`state/settings.ts`). Not part of any project, and not reachable by agents ("Allow local agents to connect" guards their own access).

| Setting                       | Values                        | Effect                                                                                                                                                                |
| ----------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Theme                         | System (default), Light, Dark | `data-theme` on the root; none for System, so `prefers-color-scheme` applies ([tokens](#design-tokens)).                                                              |
| Reduce motion                 | off (default), on             | `data-motion='reduce'` on the root; the OS preference applies as well ([motion](#motion)).                                                                            |
| Allow local agents to connect | on (default), off             | Starts or stops the local HTTP server at once ([llm-api.md](../architecture/llm-api.md#local-http)); `--mcp-http=off` or `=<port>` overrides it at start for one run. |
| Panel layouts                 | per panel group id            | Last layout of the shell's panels ([app shell](#app-shell)).                                                                                                          |
| Default anchor (v0.2)         | Centre (default), any of nine | [Placement anchor](../modes/design-v0.2.md#placement-anchors) of new positioned operations made in the UI; agents pass `anchor` or get the centre.                    |

- The settings dialog (toolbar "Settings", or "Agent settings" in the agent indicator) applies changes at once and optimistically; main validates the patch (unknown fields and wrong values are refused, the window then returns to main's settings), writes the file atomically and pushes the new settings to every window.
- A window gets the settings at creation as a window argument (`--dfyom-settings`), so theme and motion are applied before the first render (no flash).
- A missing field takes its default; an unreadable or invalid file gives the defaults with a warning in the log and is replaced on the next change. Settings are preferences, not user data, so this needs no confirmation and no migration.

## Interaction

### Quantity and expression input

Every dimensional field is a `QuantityInput` over the [quantity model](../architecture/quantities.md) (task 3.4). The parser, units, tolerance grammar and error codes are owned there; these are the UI rules.

- **Show what was entered.** The field shows the source as typed (`1/16"`, `D/2 ±0.01`). When unfocused and the source is in another unit than the project unit system or is an expression, the computed value follows in muted text at field precision (`1/16" · 1.588 mm`).
- **Echo the interpretation while typing,** when it adds something to the text. Below the field, a one-line preview states how the input is read: `= 1.588 mm`, `= 25.4 mm, upper +0.1, lower −0.05`, `= 3 mm (from pocket1.floor.z)`. This is the general answer to the ambiguous inputs in the plan's known issues (`+1/2` as a deviation pair, `D -1/2`): the echo shows the reading, and the field's hint for those rule ids offers the intended spelling.
- **Unit suffix:** the bare-number default unit is shown as a muted suffix inside the field; typing any accepted unit of the kind overrides it.
- **Validation timing:** parse on every change (debounced 150 ms) for the echo; show an error only on blur, on Enter, or after 600 ms without typing, never mid-word. The field keeps the raw text when invalid.
- **Commit:** Enter or blur commits a valid value as one command (one undo step); Escape reverts to the stored source. An invalid value never commits; the document and viewport keep the last valid value, and the field stays marked until fixed or reverted.
- **v0.2 (D13, [apply.md § Field rule](../architecture/apply.md#field-rule)):** Enter = commit **and apply** (the deferred work of all pending changes: tool choice, draft plans, toolpaths); blur and Tab = commit only. Replaces the bullet above when task P3 lands.
- **Optional fields (empty = unset):** a field whose value may be absent (min spindle speed, spindle power) is `optional`: emptying it (blank or only spaces) and committing commits _unset_ instead of an error, and an empty optional field is never marked. A required field (the default) treats empty text as invalid ("Enter a value."). The field says it is optional in a note under it ("Optional: …"), not in the input.
- **Errors in place:** `issues[].params.offset` underlines the position in the text; the message comes from the catalogue keyed by `rule` ([errors](#errors)); a `hint` param becomes a one-click fix button ("Use `1 1/2"`").
- **Steppers:** `↑`/`↓` step a plain literal by the field's step in the source's unit (`Shift` ×10, `Alt` ×0.1); disabled for expressions. No spinner buttons.
- **Tolerance:** typed in the same field. An untoleranced field shows the inherited general tolerance as muted text with its scope ("±0.1 mm from part").
- **Recommended range:** where a check or the calculator knows one, the field shows it as a hint ("recommended ≥ 3.2 mm") and a `Term`-style tooltip explains what it depends on and what it affects (principle §5); a [DFM suggestion](#warnings-and-dfm) offers "Apply".
- **References:** typing a letter offers an autocomplete list of valid references (surfaces of earlier operations, tool parameters) ([decision 16](#decisions)); a reference that becomes unknown later marks the field with `expression.reference`.
- **Precision:** display precision belongs to the field ([quantities.md](../architecture/quantities.md#value)); the decimal separator is always `.`.

Implementation (task 3.4): [`ui/QuantityInput/`](../../src/renderer/src/ui/QuantityInput/QuantityInput.tsx) renders a `Field` and reads the text only through the core (`quantityFromSource`, `parseLiteral`; pure helpers in `reading.ts`); messages and labels in [`messages/quantity.ts`](../../src/renderer/src/messages/quantity.ts). Props: kind, bare-number default unit (also the display unit), stored `Quantity`, `onCommit` (with `optional`, `onCommit(undefined)` for unset; the pair is the `QuantityCommitProps` union; a second argument `gesture` for adjust-popover steps), `onCancelGesture` (Escape in the popover), optional resolver, references, field rules (`validate`), precision, step, inherited tolerance, recommended value, pick hook. Refinements decided while building it:

- **Echo** shows only while focused and only for a reading that is not an error (a stale echo never sits next to an error). It shows only when it adds information (`echoAddsInformation` in `QuantityInput/reading.ts`, decided by the user 2026-11-21: "I enter 15 mm, why would I need to see '15.000 mm'?"): for an expression or reference, a fraction or mixed number, a unit other than the display unit, an asymmetric tolerance, or any text that is not a plain decimal. A plain decimal with no unit or the display unit's own spelling (`15`, `15 mm`, `15mm` in an mm field, `0.5 in` or `0.5"` in an inch field), also with a symmetric decimal tolerance (`10 ±0.05`), shows no echo; with an inherited tolerance it shows only that ("±0.100 mm from part"). Errors, their verified fixes and the other support items are unaffected. The inherited general tolerance is part of the echo ("= 1.588 mm · ±0.100 mm from part"), not shown at rest. Deviations show with their sign at field precision ("upper +0.100, lower −0.050"); a formula names its references ("(from pocket1.floor.z)").
- **Computed value at rest:** for an expression, or a literal whose written unit is not the display unit; the unit suffix hides when a unit is typed or the computed value shows.
- **Error marks** are drawn by a text overlay of the input (wavy `--danger` underline from `offset` to the next space; at the end of the text a short stub). A stored formula that no longer reads (reference gone) is marked at once, without typing.
- **Fixes** are verified with the core before they are offered, and applying one commits it. Known ambiguities get fixes: a trailing `+n/d` / `-n/d` that fails `order` ("“+1/2” reads as a tolerance (upper +1, lower +2)…", fix `10 + 1/2`, `D - 1/2`); Greek mu U+03BC (fix: micro sign); `hyphenatedMixedNumber` and `ambiguousDivision` hints (first variant).
- **Steppers** (`↑`/`↓` in the field) change the text only; Enter/blur commits. They replace the number between the core's nominal offsets, so unit and tolerance stay as typed (`1.50 ±0.05` → `1.60 ±0.05`; `1/16"` + 0.1 → `0.1625"`).
- **Adjust popover = live gesture** (decided 2026-11-21, D9; replaced "closing commits once"): the pencil's popover (step .001–100, −/+, recommended "Use …") updates the whole app live – model, viewport, live outline, warnings and plan values follow every step – and the session is still **one undo step**. Opening it starts a [gesture](../architecture/commands.md#gestures-live-edits) with a unique id (`newGestureId`); each −/+ and "Use …" commits at once with that id (`onCommit(value, gesture)`; the caller passes it as `call(name, args, { gesture })`), and the dispatcher merges the steps into one history entry. Closing by a click outside (or the trigger, or "Use …") keeps the value; nothing else is sent. **Escape** cancels: without a step it only closes; otherwise the field shows the opening value at once and calls `onCancelGesture(gesture)`, which command callers implement with `useCancelGesture` (`history.undo { gesture }`: reverts and discards the entry, so it cannot be redone). If the entry is no longer on top (someone committed after it), nothing is forced: the field keeps the value and notes "Kept the adjusted value: the project changed after it, so Escape could not revert it." If no step landed (every step's command was rejected, so the stored value never moved), the field just shows the opening value again, without that note. A field without `onCancelGesture` (local form state: stock setup, library dialogs) commits the opening value again instead. Typing in the field stays commit-on-Enter/blur. The popover's title hint names only what acts there ("Esc reverts"); `↑`/`↓` (`Shift` ×10, `Alt` ×0.1) step in the field, not in the popover, where arrows move within the step-size control (decided 2026-11-21). While steps are still landing (one IPC round trip each) the field shows the latest step and does not flick back to an older stored value.
- **Adjust popover and Apply** (v0.2, D13): steps stay live and pending; closing the popover does not apply, Cmd/Ctrl+Enter inside it does ([apply.md § Adjust popover](../architecture/apply.md#adjust-popover)).
- **Cost of a step** (measured on the exit-criteria project, 2026-11-21): a `design.pocket.update` step with the `plan.draftAutoRebuild` hook takes ~3.5 ms in the dispatcher and a `plan.operation.update` step ~0.4 ms, far below click intervals, so steps are not throttled. The heavy work is already coalesced: part evaluation has its 200 ms trailing debounce and aborts on a newer input ([workers.md](../architecture/workers.md#automatic-evaluation-after-design-edits)), and the renderer's per-revision re-reads (warnings, plan data, undo names) keep only the latest answer.
- **References:** the list opens while typing a name, or with `Ctrl+Space` (and `↓` when the text is not steppable); `↑`/`↓` move, `Enter` inserts, `Escape` closes the list without reverting. Options show the id and the human name.
- **Pick hook:** `onPick(insert)`; the shortcut is `Alt+P` (a bare `P` would type into the field). `insert(reference)` puts the reference at the last caret/selection, refocuses the field and does not commit.

### Errors

How an `AppError` reaching the UI boundary ([boundaries.md](../conventions/error-handling/boundaries.md#entry-points-ui-agent-cli-automation)) is shown:

| Situation                                    | Display                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issues` with a `path` matching a field      | Inline in the field's support area (`--danger-text`, icon, `aria-invalid`, `aria-describedby`); focus moves to the first invalid field on submit. |
| `issues` without a matching field            | Summary at the top of the form/inspector.                                                                                                         |
| `severity` `info` (incl. `op.aborted`)       | Neutral toast or nothing; cancellation is never shown as a failure.                                                                               |
| `severity` `warn` / `error`, no field        | Inline banner in the panel that started the action, with `userMessage` and a retry button if `retryable`.                                         |
| `severity` `fatal`, `machine.*` during a run | Blocking dialog (run errors: [run safety](#run-mode-safety-ui)).                                                                                  |
| `command.conflict`                           | Not shown for UI sources (never rejected); for queued agent actions see the agent indicator.                                                      |

- Message text: the catalogue in `messages/` maps `code` (and issue `rule`) to a friendly sentence with `params` formatted in the project unit system; fallback is the registry's `userMessage` ([codes.ts](../../src/shared/errors/codes.ts)). The developer-facing `message` and the frames are only in an "Details" expander with a "Copy details" button (for bug reports).
- Every message says what happened, why if known, and what to do next.

### Selection and picking

- Click in the viewport selects the operation (or plan operation) owning the clicked surface; the navigator row and inspector follow. Selecting a row selects in the viewport. Hover highlights (`--vp-hover`) before click. `Escape` clears the selection. Multi-select is later.
- **Pick mode** for surface references (`on`, references in formulas): the field's pick button (or `Alt+P` while focused; a bare `P` types) enters pick mode – crosshair cursor, eligible surfaces (horizontal surfaces of the stock and earlier operations, [design.md](../modes/design.md#positioning-v01)) highlighted, others dimmed, a banner "Pick a surface for _On_ · Esc to cancel". Click picks and returns focus to the field. The same field always offers a dropdown of the eligible surface ids, so picking never needs the mouse. v0.2: eligible faces of every direction for `on` ([face picking](#design-and-plan-controls-v02)).
- Picked and referenced surfaces are named by their surface id and the operation name (`pocket1.floor` · "Pocket 1 floor").
- Camera: orbit, pan, zoom to cursor; view presets Top / Front / Right / Iso and "Fit" in a floating viewport toolbar with keys `1`–`4`, `F` while the viewport has focus. Mouse mapping is a setting with presets ([decision 10](#decisions)):

  | Preset     | Orbit               | Pan                 | Zoom             |
  | ---------- | ------------------- | ------------------- | ---------------- |
  | Default    | Left-drag           | Right-drag          | Wheel, to cursor |
  | Fusion 360 | Shift + middle-drag | Middle-drag         | Wheel, to cursor |
  | Blender    | Middle-drag         | Shift + middle-drag | Wheel, to cursor |

  Left-click always selects (a click is a press and release without drag). Trackpad gestures (two-finger pan, pinch zoom) work in every preset. More presets only where they are a mapping table entry.

- The viewport is focusable (`tabindex=0`, labelled region); arrow keys orbit, `Shift`+arrows pan, `+`/`−` zoom.

### Design mode (task 3.6)

`src/renderer/src/modes/design/` ([design.md](../modes/design.md#design-ui-task-36)):

- **Navigator** (`DesignNavigator`): stock setup without a part; otherwise the part (a button that clears the selection), its stock, and the operations (the `OperationList` inline: an ordered list of rows, each a toggle button – icon, name, id, warning badge, failed marker – with move up / move down / remove icon buttons that overlay the row's end while it is hovered, focused or selected). `Alt+↑/↓` on a row moves it, `↑/↓` move the focus. Removing shows the toast "Removed Pocket 2 · Undo".
- **Inspector** (`DesignInspector`): no selection → the part (name, stock, general tolerance, evaluation status, all warnings with "Apply" and a link to their operation); a selected operation → name, then its groups. A command error's issues show at their field (`aria-invalid`), the rest as an `ErrorMessage` at the top ("The change was not applied."); the field keeps the rejected text until fixed or reverted.
- **Selection** is per mode in the UI store; a navigator row, a viewport click (the owning operation; stock surfaces clear it) and a warning's link all set it; the inspector follows. `Escape` in the viewport clears it.
- **Pick mode:** the `on` field's crosshair button and `QuantityInput.onPick` (`Alt+P`) put a pick request in the UI store (owner field, banner label, eligible surfaces: `on` targets, or every horizontal surface before the operation for formulas); the viewport shows it and a click calls back (`on` commits the surface; a formula gets `<surface>.z` inserted). `Escape` cancels.
- **Scene** (`useDesignScene`): last good mesh, stock box, status, selection; while `pending`, the selected operation's shape as dashed amber loops at its top and floor (`outline.ts`, from the document's values, which are the committed field values); when `failed`, a `--danger` ring above the failing operation (named by the error's issue paths or frame data, else the selection, else the last operation); the summary "Part with 4 operations, 2 warnings, updating."
- **Selection pulse:** a new selection's tint starts at `MIX.pulse` (0.6) and eases to `MIX.selected` over `--motion-emphasis`; none under reduced motion.
- **Warnings** come from `design.warning.list`, re-read once per revision and evaluation change and shared by navigator, inspector, status bar and viewport; text from the DFM catalogue (`messages/dfm.ts`).

### Plan mode (task 3.7)

`src/renderer/src/modes/plan/` ([plan-v0.1.md](../modes/plan-v0.1.md#plan-mode-ui-task-37)); strings in `messages/plan.ts`:

- **Navigator** (`PlanNavigator`): without a plan an `EmptyState` with "Create plan" (`plan.create` with the first library machine, if any); with an empty machine library, "The machine library is empty. Add a machine to export gCode." and "New machine…" under it. With plans: the plan `Select` (archived ones last, marked) and "Plan actions" (New plan, Duplicate plan, Remove plan… with its `ConfirmDialog`); the status `Select` (current status and its transitions; "Restore from archive" for an archived plan); the read-only reason in finalized, in-use and archived plans; the stale notices from `plan.stale.list` ("The design changed since this plan was made." with "Rebuild plan"; each changed library copy with "Update from library"; a blocked rebuild or update with its reason). Then Machine (a `Select` of the library's machines, `plan.machine.set`, and "New machine…"), Setup (work zero G54 as text, clearance and retract height as `QuantityInput`s, `plan.setup.update`), the plan operations in machining order (rows as in design: kind icon, name of the design operations, tool, a stale badge, the toolpath state – ready, outdated, none, failed – and error and warning counts; move up / move down and `Alt+↑/↓`, `plan.operation.move`), and Toolpaths ("n of m toolpaths up to date.", "Generate toolpaths", "Export gCode…" as the panel's primary action). Disabled actions say why ("Fix the errors before generating toolpaths.", "Choose a machine to export gCode.").
- **Inspector** (`PlanInspector`): no selection → the plan (name, status, machine, all checks from `plan.warning.list` with a link to their operation); a plan operation → Tool group: the tool picker (a `Select` of `plan.tool.suggest`'s ranked tools, "Flat 6 · Ø 6 mm", plus the current tool if it is not among them; "New tool…"; the chosen tool's reasons under it as "Why this tool"), stickout, cutting preset ("Default (Alu finish)" – "Default (auto)" without a preset –, "Auto (calculator)", or a named preset; Auto is disabled when the calculator has no data, with "Auto (calculator) is unavailable. No feeds-and-speeds data: …" under the control); Feeds and speeds: a `QuantityInput` per field of the kind (drilling: spindle speed, feed rate, plunge rate) showing the resolved value from `plan.operation.list` in the project units and its source as a note ("From preset “Alu finish”.", "Recommended by the calculator.", "Strategy default.", "Entered by you.", "Entered by you. Recommended 18000 rpm.", "Locked: the other values follow it."); the chip load under them. A field without a value says "No value: enter one, or add a cutting preset to the tool."
- **Entered values and locks** (task 3.14, [plan-v0.1.md § Locks and auto mode](../modes/plan-v0.1.md#locks-and-auto-mode); replaced the 3.7 rule where the lock showed an override and unlocking removed it): typing a value commits it as entered (`plan.operation.update { overrides }`, one undo step) and never locks. In auto mode the fields `plan.operation.list` offers a lock for (`lock.state` not `hidden`) show it: pressing it sends `locks: { field: true }` (pins the shown value), releasing it `locks: { field: false }` (the value stays entered). An entered value's note offers "Use <recommendation>" in auto mode and "Reset" outside it (`overrides: { field: null }`); when a warning about the field (chip load, power) is on top, that warning carries the fix. `lock.state: unavailable` shows the lock disabled with the reason, unless it is pressed (a pressed lock can always be released; an inactive one also has "Unlock" on its `feeds.lockInactive` warning). Stickout has no lock; a typed stickout is entered ("Entered by you." with "Use tool default", `stickout: null`).
- **Strategy** (v0.2, [plan-v0.1.md § Pass strategies](../modes/plan-v0.1.md#pass-strategies-v01)): a "Strategy" group between Tool and Feeds and speeds with the kind's strategy parameters; each edit is one `plan.operation.update { strategy: { <key>: … } }` (one undo step). Values shown are the resolved ones of `plan.operation.list` (`strategy`, mm and °), entered ones as typed.
  - **Choices** as `SegmentedControl`s with a caption (as design mode's profile side): cut direction Climb / Conventional (facing, pocket, profile), pattern Zigzag / One way and rows along X / Y (facing), entry Helix / Ramp / Plunge (pocket) or Ramp / Plunge (profile). Choosing stores the value; any value is a valid choice, so a choice has no reset.
  - **Drilling cycle** as a `Select` in a `Field`: a drill offers Simple, Peck and Chip break, an end mill Helical boring. A stored cycle that no longer fits the tool (another tool was assigned) stays in the list, marked "(doesn't fit the tool)", with its `plan.check` error at the field and the fix "Use default" (`cycle: null`).
  - **Lengths and angles** as `QuantityInput`s in the project units (angles in °), without locks (no recommendation mode): an unset parameter shows its default with the note "Default."; an entered one "Entered by you." with "Use default" (`null`).
  - **Only parameters that apply are shown:** helix diameter with helix entry; ramp angle with helix or ramp entry (pocket) or ramp entry (profile); finish stepdown with a finishing allowance above 0; drilling peck depth with Peck or Chip break, chip-break retract with Chip break, helix pitch and ramp angle with Helical boring, breakthrough for through holes. A hidden parameter keeps its stored value.
  - Findings with field `strategy.<key>` show at their field; those of hidden parameters and of choices join the list under the fields.
- **Calculation** (v0.2): under the feeds fields a disclosure button "Show calculation" (`aria-expanded`, starts collapsed, as a rarely used group) opens the calculator's explanation from `plan.operation.feeds.get`, read once per revision while open: **Inputs** (material class, tool material, diameter, flutes, corner radius, engagement, machine rigidity, spindle power or "not set"); per feeds field its value and source, and for calculator values the derivation steps (formula in `--font-mono`, its inputs, the result); **At the values used** (entered values included): surface speed, chip load after chip thinning with the factor, material removal rate, cutting power and spindle load. Numbers are in the calculator's canonical metric units (m/min, mm, mm/min, mm³/min, kW), like its messages ([roadmap § Later](../roadmap.md#later-unordered)). Without calculator data it shows the reason instead of the values at use.
- **New tool / New machine** (decided 2026-11-21; a library editor comes later): `NewToolDialog` and `NewMachineDialog` (a `Dialog` per item, the button is its trigger; not offered in read-only plans). Fields as in [library.md](../architecture/library.md#tool), only what v0.1 needs, `QuantityInput` in the project units (bare numbers: mm or in, mm/min or in/min, rpm, W, °):
  - **Tool:** name (suggested from type and diameter, "Flat 6", "Drill 1/4", until one is typed), type (the four v0.1 types; a drilling suggests a drill, everything else a flat end mill), diameter, corner radius (bull nose only), flute length, overall length, flutes, point angle (drill only, 118°), tool material (carbide). Defaults: Ø 6 mm / ¼", flute 20 / ¾" (drill 30 / 1"), overall 50 / 2" (drill 66 / 2½"), 2 flutes, corner radius 1 mm / 1/32". Not in the form: stickout (the plan's stickout field covers it), shank diameter, coating, notes and cutting presets (feeds come from the calculator or the inspector's overrides). "Add tool" runs `library.tool.add`, then `plan.tool.assign`.
  - **Machine:** name ("My machine"), travel X/Y/Z (400 / 400 / 100 mm, 16 / 16 / 4"), max feed rate X/Y/Z (3000 / 3000 / 1000 mm/min, 120 / 120 / 40 in/min), spindle control (manual dial or by gCode; manual), max spindle speed (30000 rpm), min spindle speed and spindle power (optional, empty; [`optional`](#quantity-and-expression-input) `QuantityInput`s, so emptying one again leaves it out of `library.machine.add`), rigidity (the five presets, "Aluminium extrusion" = the core's default), gCode units (the project's). Controller GRBL and manual tool change are fixed (the only v0.1 values); acceleration is not in the form (optional, estimates only). "Add machine" runs `library.machine.add`, then `plan.machine.set` (in the empty state it only refreshes the list; "Create plan" then takes the new machine).
  - The core validates. Issues below `values` show at their field (`aria-invalid`, focus moves to the first invalid field), others above the fields with "The item was not added to the library."; the dialog stays open. Not a `<form>`: Enter commits a field, the primary button adds (as the stock setup). If the add succeeds but assigning fails, the item stays in the library and the dialog shows the assign error.
- **Checks** show where they belong: a finding with `field` at that field (error, hard or soft by severity), the rest in a `WarningList` under the fields; the status bar shows "n errors, m warnings" opening the full list. Errors block "Generate toolpaths" and the export. Text is the core's message, sentence-cased (values in mm; [known issue](../plans/v0.1.md#known-issues-and-risks)).
- **Toolpaths:** "Generate toolpaths" runs `plan.toolpath.generate`, followed by `job.get` every 250 ms (progress bar "Toolpath progress" in the navigator, "Generating toolpaths…" in the status bar after `--delay-indicator`); afterwards each operation's state comes from `plan.toolpath.get` (stale flag), re-read once per revision, generation and export. A failed operation shows its state on the row; a failed job its `ErrorMessage`.
- **Export:** "Export gCode…" opens the native save dialog (`window.dfyom.files.chooseExport(planName)`: a `.nc` file unless another gCode extension is typed), then `plan.export { target, confirm: true }` (the OS dialog already asked before replacing, as Save as). The outcome dialog "gCode exported" lists the file, lines, estimated time, tool changes, whether soft limits were checked (only with a connected machine's work zero) and the export's machine warnings ("Export warnings"); a failure shows "The gCode could not be exported" with the `ErrorMessage`.
- **Scene** (`usePlanScene`): the design part, and the plan's toolpaths (current and outdated) through the viewport's `run` prop with nothing done and no tool marker: feeds `--vp-feed`, rapids `--vp-rapid`, plunges (feeds straight down, `SEGMENT.plunge`) `--vp-plunge`, and the work zero ring.
- **Plan choice:** per window (`plan-store.ts`); choosing or creating a plan here also makes it run mode's plan, unless a run is going.
- **Read-only** plans keep their fields visible (`readOnly`, desaturated) with the reason and the way out; move buttons and pickers are not offered.

### Design and plan controls (v0.2)

Accepted with the v0.2 docs (D18, 2026-11-22); not built yet. Behaviour is specified in [design-v0.2.md](../modes/design-v0.2.md), [plan-v0.2.md](../modes/plan-v0.2.md) and [apply.md](../architecture/apply.md); these are the UI rules. Visual specimens go to the [design system](#design-system) page for approval with their task, using existing tokens only.

- **Face picking** (F1, [face targets](../modes/design-v0.2.md#face-targets-generalised-on)): pick mode for `on` highlights every face target of the operation kind in every direction, sides and bottom included, with a normal glyph (a short arrow along the outward normal; amber on the hovered face). A face turned away from the camera stays reachable through the dropdown; picking never requires orbiting. The `on` dropdown groups targets by direction in the order Top, Bottom, Front, Right, Back, Left. The selected operation's face shows its [face frame](../modes/design-v0.2.md#face-frame) axes (`u`, `v`, labelled) at the origin, so `[u, v]` positions read directly.
- **Anchor picker** (F2, [placement anchors](../modes/design-v0.2.md#placement-anchors)): a 3 × 3 `RadioGroup` beside the position fields (arrow keys move, each point named in the face frame seen from outside: "Front left", "Centre", …; the chosen point amber). The viewport marks the selected feature's anchor point. Drillings show no picker. While the position is an expression the picker is disabled with its reason as visible text ("Remove the formula to change the anchor."). The default anchor is a [setting](#settings).
- **Tool field** (F5, [operation tool](../modes/design-v0.2.md#operation-tool)): the first group after `on`. A combobox lists the generalized tool, then the fitting library tools in auto-choice order with their reasons. Its lock is the only lock on a design field and is always shown: released = auto ("Chosen automatically."), pressed = "Chosen by you."; picking a tool presses it. This is the one exception to the [lock rule](#field), because releasing the lock is how auto mode comes back. After an automatic swap the note says why ("Chosen automatically: the 6 mm end mill didn't fit the 2 mm corner."). Checks against an unlocked tool with pending changes show "May change on Apply" in the support area (soft tier) until Apply; against a locked tool they show normally.
- **Apply button** (P3): see [app shell](#app-shell); states, tooltip, keys and the field rule are owned by [apply.md § UI](../architecture/apply.md#ui).
- **Plan copy** (E3b, [plan-only edits](../modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene)): the "Part (plan copy)" group reuses the Design inspector's field components (never copies); "Edited in plan" is a `StatusChip`; "Revert to design" is a plain button; the rebuild that discards plan edits is a `ConfirmDialog` naming the count ([confirmations](#confirmations)). Built in E3b (`PlanCopyGroup`, `OperationFields`); the plan scene tints edited operations lightly with `--info` (never the accent or warning colours), under selection and hover.
- **Setup panel** (F6, [setups](../modes/plan-v0.2.md#setups-from-face-directions)): the plan navigator's Setup group becomes a list of setups in machining order, each row with name, direction (an icon of the stock with its up face shaded, plus the word), WCS corner and rotation as text; plan operations nest under their setup. Reorder with move up / move down and `Alt+↑/↓` as the operation list (drag later). Split from a plan operation row's menu ("Move to new setup"), merge from a setup row's menu; setups of another direction are not offered. With several setups, export and preview are per setup: the panel's primary action exports the selected setup, and the toolpath preview shows the selected setup only, in its own orientation.

### Reference ghost (v0.2)

[reference-model.md § Display](../modes/reference-model.md#display) (task R3):

- Draw the ghost after the part, translucent and neutral (`--vp-stock` at low opacity with `--vp-edge` feature edges), never in the accent, the selection or the warning colours.
- The ghost is never a pick target, never hovered or highlighted as a face; a click passes through it to the part. The reference is selected only through its navigator row.
- Visibility is per window: the row's eye is an `IconButton` toggle ("Hide reference" / "Show reference", `aria-pressed`) that sends no command, adds no undo step and never marks the project unsaved. A hidden reference keeps its row, muted.
- v0.2 shows the ghost in Design only.

### Viewport (task 3.5)

`src/renderer/src/viewport/` exports `Viewport`, the one react-three-fiber canvas ([ADR 0010](../decisions/0010-react-three-fiber-viewport.md)); the shell (3.3b) mounts it in its viewport slot and keeps it alive across modes. Dependencies, exact versions: `three` 0.187.0, `@react-three/fiber` 9.8.2, `@react-three/drei` 10.7.9 (camera controls: `camera-controls`), all MIT; drei's transitive dependencies are MIT, ISC, BSD-3-Clause and Apache-2.0, all GPL-3.0-compatible ([ADR 0014](../decisions/0014-gpl-3-or-later-license.md)).

- **Props-driven, no document access.** In: `mesh` (`PartEvaluation` or any `{ positions, indices, triangleSurface, surfaces }`; `null` before the first evaluation), `stock` box, `status`, `selectedOperation`, `pick` (`{ eligible, field }`), `mousePreset`, optional `summary`. Out: `onSelect(target | null)`, `onHover`, `onPick(target)`, `onPickCancel()`, where a target is `{ surface, operation }` and the operation is the surface id's prefix (`stock` for stock surfaces). Which surfaces are eligible is the caller's business.
- **Scene:** the part mesh (one geometry per evaluation, [geometry.md](../architecture/geometry.md#worker-and-renderer)) with `--vp-edge` feature edges, the stock as a dashed `--vp-stock` outline, a grid under it (10 mm, major 50 mm), axes at the part origin. Perspective camera, 30° vertical field of view, Z up; the first mesh or stock is framed from Iso, later evaluations keep the user's camera. `frameloop="demand"`: nothing renders while nothing changes.
- **Colours:** base `--vp-part`; selected operation 25 % `--vp-selected` plus an amber outline (the accent is never a large fill); hover shows `--vp-hover` on every surface of the hovered surface's operation (what a click would select); pick mode tints eligible surfaces 12 %, the hovered eligible one 40 %, with the outline, and dims the rest 60 % towards `--bg-viewport`; `pending` (after 300 ms) and `failed` replace the base with `--vp-outdated`. Mixing ratios live in `colours.ts` (`MIX`).
- **Input:** mouse presets map onto camera-controls' button actions per press (so Shift selects the Fusion 360 / Blender action). Wheel events, in every preset: a mouse wheel dollies to the cursor, a two-finger trackpad scroll pans (content follows the fingers, like a drag), a pinch (macOS sends it as a wheel event with `ctrlKey`, as is Ctrl + wheel) dollies to the cursor. `classifyWheel` (`viewport/wheel.ts`) tells them apart per event, first match wins: `ctrlKey` → zoom; line or page `deltaMode` → zoom; within 120 ms of a pan → pan (rest of the gesture and its momentum); non-zero `deltaX` or fractional `deltaY` → pan (so Shift + wheel pans sideways); Chromium's `wheelDeltaY` equal to −3 × `deltaY` and not a multiple of 120 → pan; otherwise zoom. `Viewport` classifies in a capture-phase listener and sets camera-controls' `mouseButtons.wheel` (`TRUCK` or `DOLLY`) before its own listener runs; camera-controls would turn a `ctrlKey` wheel into a field-of-view zoom, so a pinch is re-sent without `ctrlKey` and dollies like the wheel. No setting: the mapping is the same in every preset. A click is a press and release within 4 px; a click on empty space clears the selection. Keys act while the region (or its toolbar) has focus; arrows only on the region itself, since the toolbar uses them for roving focus. In pick mode `Escape` is caught on the document, so it cancels while focus stays in the field. Camera moves animate unless motion is reduced.
- **Accessibility:** a `region` named "3D viewport", `tabindex=0`, described by a hidden text summary (default "Part with 3 operations.", the shell may pass a richer one) and the key list. The view toolbar is the `Toolbar` from `ui/` with the own view icons `top`, `front`, `right`, `iso`, `fit`.
- **Run scene (task 3.12):** optional prop `run: { lines, done, tool } | null` (`RunScene`; `null` outside run mode). `lines` are the plan's toolpaths flattened to segments (`toolpathLines`: arcs in 3° chords, drill cycles down at feed and up as a rapid), drawn feeds `--vp-feed` and rapids `--vp-rapid`; segments before `done` fade 70 % towards `--bg-viewport` (`DONE_DIM`). `tool` (the status' `wpos`) places the tool marker (`--vp-tool` cone with its tip at the tool tip); the work zero is a ring at the origin, since the setup WCS is the part frame ([plan-v0.1.md](../modes/plan-v0.1.md)). Toolpaths widen the framing bounds. `useRunScene(mode)` (`modes/run/`) fetches the chosen plan's toolpaths (`plan.toolpath.get` per plan operation, again when a run starts) and computes `done` by following `wpos` forward along the segments (`advancePlayback`, 0.1 mm tolerance, never backwards).
- **Testing:** `mesh.ts` (face → surface, normals), `colours.ts`, `camera.ts` (presets, fit, mouse table, keys), `wheel.ts` (trackpad / wheel / pinch classifier), `toolpath-lines.ts` (segments, playback, done colours) and `useTokens` are unit-tested; `Viewport.test.tsx` stubs the canvas. The gallery shows the viewport on a hand-built sample part (`viewport/sample-mesh.ts`, real surface ids) in both themes, with status, mouse preset and pick controls.

### Undo and redo

- Undo/redo buttons in the main toolbar and `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` (also `Ctrl+Y` on Windows/Linux) dispatch `history.undo` / `history.redo` ([commands.md](../architecture/commands.md#undo--redo)). While focus is in a text field, the shortcuts act on the text, not the history.
- A field's adjust-popover session is one undo step, however many steps it committed live ([Quantity input](#quantity-and-expression-input)).
- v0.2 (D13): an Apply is its own undo step; undoing it reverts the automatic changes and leaves the edits pending ([apply.md](../architecture/apply.md#baseline-and-undo)).
- Tooltips name the step: "Undo Add pocket (Pocket 2)". The history is shared by all sources; when the top step is not the user's own, the tooltip says whose ("Undo Add pocket – by agent").
- After undo/redo the affected item is selected and briefly highlighted (`--motion-slow`, none under reduced motion) so the user sees what changed.
- Removing something shows a toast "Removed Pocket 2 · Undo" instead of a confirmation ([confirmations](#confirmations)).
- Agent edits (source `agent`) briefly highlight the changed row with an agent badge, so the user notices changes they did not make (principle §1).

### Evaluation status: pending, outdated, failed

Design evaluation is automatic with a 200 ms trailing debounce ([workers.md](../architecture/workers.md#automatic-evaluation-after-design-edits)). UI rules (task 3.6):

| `evaluation` | Viewport                                                                                                                                                                                     | Status bar / inspector                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `done`       | Current mesh.                                                                                                                                                                                | Nothing (or a quiet check mark).                                                       |
| `pending`    | Keeps the last mesh; the edited operation's shape is drawn live as an outline from the field values (cheap, no worker). After `--delay-indicator`, the whole mesh is tinted `--vp-outdated`. | "Updating…" chip after `--delay-indicator`; geometry warnings marked "checks pending". |
| `failed`     | Keeps the last mesh, tinted outdated, with an error marker at the failing operation.                                                                                                         | Error chip with `userMessage`; clicking selects the operation and focuses the field.   |

- A drag or held key never flickers: nothing changes until 200 ms after the last change, and the indicator delay hides evaluations that finish in time ([decision 15](#decisions)).
- Parameter warnings come with every command result and show at once; geometry warnings appear when the evaluation is `done`.
- As built (3.6): the window gets each part's status and mesh from main's evaluation push ([workers.md](../architecture/workers.md#evaluation-status)); the status bar shows "Updating…" after `--delay-indicator`, and "Evaluation failed at Pocket 1" as a danger chip that selects the operation; while pending, the warning lists note "Geometry checks pending."; the live outline is drawn for the selected operation.

### Jobs and progress

- Jobs ([commands.md](../architecture/commands.md#long-running-commands-jobs)) appear in the status bar `JobIndicator`: count plus the newest job's label and progress; it opens `JobList` with each job's label, progress, pause/resume and cancel.
- Progress is determinate when `total` is known, indeterminate otherwise; both appear only after `--delay-indicator`.
- Work tied to an item shows progress at the item too (toolpath generation on the plan operation row).
- Cancel is always available and immediate in the UI; the outcome `op.aborted` is shown neutrally ("Cancelled").
- The run job is shown in run mode and in the main toolbar, not only in the job list ([run safety](#run-mode-safety-ui)).

### Warnings and DFM

Warnings never block ([design.md](../modes/design.md#dfm-checks), [plan-v0.1.md](../modes/plan-v0.1.md#plan-record), [feeds-speeds.md](../architecture/feeds-speeds.md)).

- **Where:** next to the blamed parameter in the inspector (`parameter`), as a badge on the navigator row (`operation`), as a marker at the operation in the viewport, and in the warning list (status bar count).
- **Severity** ([decision 21](#decisions)):

  | Tier         | Meaning                                               | Look                                                                     | Dismiss                                |
  | ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- |
  | Soft warning | Outside a recommendation; safe to ignore              | Neutral background, `--border-control` bar, "i" icon                     | `×`; collapses to "1 dismissed · Show" |
  | Hard warning | Likely bad result or risk (tool can't cut the radius) | `--warning-subtle` background, `--warning` triangle icon                 | No                                     |
  | Error        | Impossible value; blocks Generate                     | `--danger-subtle`, `--danger` icon, `--danger-text` text, `aria-invalid` | No; fixed or reverted                  |

  Core `info` maps to soft, `warning` to hard (the mapping per check code lives in the message catalogue). Warnings never block; only errors do.

- **Plan errors** (3.7) use the error tier in lists too: `WarningList` items with tier `error` (`--danger-subtle`, circle icon, not dismissible).
- **Text:** re-rendered from `code` + `params` in the project unit system through the message catalogue; the core's English `message` (mm values) is the fallback. This closes the plan's known issue on DFM messages for inch projects. As built (3.6): `messages/dfm.ts`, lengths at 2 decimals in mm and 3 in inches; a suggestion's value is rounded so it still satisfies the check (≥ up, ≤ down); suggestions on a whole shape or center show without "Apply". `ui/WarningList` renders the lists (soft: "i", dismissible, "n dismissed · Show"; hard: triangle).
- **Suggestion:** a `suggestion` becomes a button "Apply ≥ 3.2 mm" that dispatches the update command (one undo step). v0.2 (D13): renamed "Use ≥ 3.2 mm", so "Apply" names only [project Apply](../architecture/apply.md#keyboard).
- Every warning links its terms (`Term`) and, where useful, shows a small illustration of the problem (e.g. a corner radius smaller than the tool).

### Confirmations

Policy ([decision 11](#decisions)): **undo instead of confirm** for document edits; confirm only what cannot be undone.

| Action                                                                           | Confirmation                                                                                                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document edits incl. removing operations                                         | None; undo toast.                                                                                                                                     |
| `plan.remove`, library item delete, discard recovery, close with unsaved changes | `ConfirmDialog` naming the item and the consequence; the destructive button names the action ("Remove plan"), never "OK".                             |
| `run.job.start`                                                                  | Pre-flight dialog before every run, the virtual machine included: plan, machine copy, work zero, tools in order, soft-limit check result, time scale. |
| `run.machine.unlock` (`$X`)                                                      | Confirm: "Position is not known until homed."                                                                                                         |
| Quit with unsaved changes or during a run                                        | Native message boxes in main, in order (see below).                                                                                                   |
| Feed hold, stop, `run.machine.reset`                                             | **Never** confirmed.                                                                                                                                  |

`ConfirmDialog` focuses the safe choice (Cancel) first, except the run pre-flight, which focuses "Start run" only after the checks pass.

**Quit** (menu, `Cmd+Q`, closing the last window on Windows/Linux; decided 2026-11-21): main asks in `before-quit`, before any window closes, with native message boxes (the question spans every window), each only if still needed when its turn comes. Logic and wording: `src/main/quit.ts`.

1. During a run: "A run is in progress" with Cancel / "Stop run and quit" ([run-v0.1.md](../modes/run-v0.1.md#implementation-task-312-run-mode-ui)).
2. Any open project with unsaved changes: one message box naming them ("Quit with unsaved changes in “Bracket”?", or "in 2 projects?" with the names listed), buttons "Save all" / "Quit without saving" / Cancel, Cancel focused and on `Escape`. "Save all" saves each project to its file through a main-process session; an untitled project gets the native save dialog on its window (default name from the project). A cancelled save dialog cancels the quit; a failed save shows "“name” could not be saved" with the error and cancels the quit. "Quit without saving" keeps the changes recoverable ([persistence.md](../architecture/persistence.md#crash-recovery)).

Cancel at any step leaves the app as it was (closing a window still asks for its project). Paths that skip `before-quit` never ask: `app.exit` after a failed start or a crash; the headless CLI/MCP entry has no windows and keeps closing projects recoverably.

## Run-mode safety UI

The v0.1 rules in [run-v0.1.md](../modes/run-v0.1.md#safety-v01) cover the virtual machine; the real-machine safety spec ([run.md](../modes/run.md#safety)) will extend this section before any serial connection exists.

- **Always-visible stop:** while a connection is open, the main toolbar shows the `MachineStateBadge` and a `StopControl` in every mode, above every overlay (`--z-safety`), never inside a scroll area or collapsible panel. Stop = `job.abort` (controlled stop: hold, then reset, [run-v0.1.md](../modes/run-v0.1.md#stop-errors-and-alarms)); colour `--safety-stop`, label "Stop", ≥ 44 px, keyboard reachable, no confirmation. While streaming, a "Feed hold" button sits next to it; "Resume" appears only while held. The immediate `run.machine.reset` lives in run mode's controls as "Reset (immediate)".
- **Shortcuts** ([decision 11](#decisions)): `Escape` triggers feed hold whenever a job is streaming, wherever the focus is (it also closes the top overlay); resume and continue are never bound to a single key.
- **Machine state colours and shapes** (GRBL states, [grbl.md](../architecture/grbl.md#state-machine), and run phases):

| State / phase                                          | Token              | Badge                                                                                                                   |
| ------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Disconnected                                           | `--safety-offline` | Grey, hollow circle, "Not connected"                                                                                    |
| Idle (homed)                                           | `--safety-idle`    | Neutral, filled circle, "Idle"                                                                                          |
| Run, Jog, Home (`streaming`)                           | `--safety-moving`  | Amber, play icon, a dot circling the badge edge (static outline under reduced motion), "Running" / "Jogging" / "Homing" |
| Hold, Door, `programPause`                             | `--safety-hold`    | Orange, striped pause bars, "Feed hold" / "Paused (M0)"                                                                 |
| `toolChange`                                           | `--safety-action`  | Blue, rotating swap icon and a light band sweeping across (static under reduced motion), "Tool change"                  |
| Alarm, `failed` (`machine.alarm`/`error`/`connection`) | `--safety-alarm`   | Red, octagon, "Alarm 2: soft limit"                                                                                     |

- **Virtual machine label:** a persistent "Virtual machine · 10×" chip next to the badge, so nobody mistakes a simulation for a real machine or vice versa.
- **Errors during a run** open a blocking dialog with GRBL's message, the line number, what DFYOM did (held and reset), and what to do next (home again, check work zero); also announced assertively to screen readers.
- **Tool change** (`ToolChangeDialog`): step list (raise, change to _tool 2: 6 mm end mill_, set Z zero, continue), jog and work-zero controls inside the dialog, "Continue" as the only primary action; it can be dismissed to the inspector without continuing.
- **Setup change** (`SetupChangeDialog`, v0.2 task E2, [plan-v0.2.md § Setup change in Run](../modes/plan-v0.2.md#setup-change-in-run)): built like the tool-change dialog: the next setup's name and direction, a picture of the stock in its new orientation, steps (turn the stock, clamp, set the work zero at the named WCS corner, start), jog and work-zero controls inside, "Start setup n" as the only primary action, the run dialogs' Stop. The badge shows "Setup change" with the tool-change token and shape. It never continues by itself.
- **DRO:** work and machine coordinates per axis, mono tabular digits, units of the project; work zero shown in the viewport with the tool marker at `wpos`.
- **Progress:** lines done/total, current section label, elapsed time, the toolpath played back in the viewport with the done part dimmed.
- **Disabled controls explain why:** jog in Alarm says "Home the machine first" (from `run.state` data), rather than doing nothing.

As built (3.12, [run-v0.1.md](../modes/run-v0.1.md#implementation-task-312-run-mode-ui)):

- **Navigator:** plan (`Select`), connection (time scale 1× / 10× / 100× / Max, "Connect to virtual machine" or "Disconnect"), homing ("Home", "Unlock" with its confirmation, a Homed / Not homed chip), jog (`JogPad`: step as a segmented control, X/Y pad and Z column at 44 px, "Stop jog"), work zero ("Zero X/Y/Z", "Zero X Y Z", the live G54). The reason a control is disabled is visible text under it and its `aria-describedby`.
- **Inspector:** the DRO (a table named "Position": work coordinates at `--text-dro` with the unit, machine coordinates muted; feed and spindle), the run section (progress bar "Run progress" with "Line n / N", elapsed `mm:ss`, the section label; "Start run" opening the pre-flight; the wait the run is at with "Show instructions"; how the last run ended) and "Reset (immediate)" with its consequence.
- **Stop control** (`ui/StopControl`): `position: relative; z-index: --z-safety; pointer-events: auto`, so the toolbar Stop stays clickable while a modal dialog makes the rest of the window inert to the pointer. A modal hides it from the keyboard and screen readers, so every run dialog carries its own Stop (below). Without a run job Stop cancels a jog or resets a homing cycle, otherwise sends nothing (decided by the user, 2026-11-21; [run-v0.1.md](../modes/run-v0.1.md#implementation-task-312-run-mode-ui)).
- **Stop in run dialogs** (decided by the user, 2026-11-21): the pre-flight, tool-change, program-pause and failure dialogs show the same Stop (`modes/run/RunStop.tsx`, the toolbar's control and handler, look `.btn.stop` at 44 px, accessible name "Stop") first in the footer, at its start edge, apart from the dialog's actions at the end edge; it is in the dialog's tab order (Tab wraps to it inside the focus trap). Stop is never a dialog's initial focus: pre-flight focuses "Start run" (or "Cancel" while a check fails), program pause "Later", the failure dialog "Close", the tool change its first jog control. No new shortcut: Stop is not bound to a key, inside dialogs or out; `Escape` stays feed hold while streaming. The unlock confirmation has no Stop: unlock is offered only in Alarm, where nothing moves. Stop does not close a dialog itself; a wait dialog closes when the stopped run ends.
- **`Escape`** is caught on the document in the capture phase while the job streams (`job.pause`), without `preventDefault`.
- **Dialogs:** pre-flight ("Start run?", "Start run" focused only when the checks pass); "Tool change n" (steps, `JogPad`, "Set Z zero here", "Later", "Continue"); "Program pause n" (the `M0` message); the failure dialog ("Machine alarm n" or "The run stopped with an error": GRBL's text, the `ErrorMessage`, the line, what DFYOM did, what to do next) in a `role="alert"`. Waits and alarms are also announced in an assertive live region.

## Accessibility

Target: **WCAG 2.2 AA** for all non-3D UI, except that colour contrast (1.4.3, 1.4.6, 1.4.11) is measured with APCA ([colour](#colour)); the 3D viewport has a non-visual equivalent for every task.

- **Keyboard:** every action is reachable by keyboard; tab order follows the visual order; `F6`/`Shift+F6` cycle shell regions (main toolbar, navigator, viewport, inspector, status bar); `?` opens the shortcut list. Shortcuts never fire while typing in a field, except feed hold.
- **Focus:** visible `:focus-visible` ring (2 px `--focus`, 2 px offset, Lc ≥ 30 against both neighbours); focus returns to the trigger when a popover or dialog closes; never `outline: none` without a replacement.
- **Contrast:** as in [colour](#colour); checked by the token unit test and axe in component tests.
- **Reduced motion:** as in [motion](#motion); also an app setting independent of the OS.
- **Screen readers:**
  - Landmarks: `banner` (main toolbar), `navigation` (mode switcher, navigator), `main` (viewport region with an `aria-label` and a text summary: "Part with 4 operations, 2 warnings"), `complementary` (inspector), `contentinfo` (status bar).
  - The navigator list is the accessible way to select; picking always has the dropdown alternative.
  - Live regions: polite for evaluation status, job completion and toasts; assertive for alarms, run failures and tool-change waits.
  - Fields: label, unit, hint, recommended range and error wired with `aria-describedby`; `aria-invalid` when invalid.
  - Status chips and machine states expose their text, not just colour.
- **Zoom:** UI is in `rem`, so Electron zoom (`Ctrl/Cmd +/−`) scales it to 200 % without loss; panels scroll rather than clip.

## Copy and terminology

- Use [glossary](../glossary.md) terms exactly, never simplified replacements ("Feed hold", "Work zero", "Stepdown", not "Pause machine", "Origin", "Layer depth") (principle §5). New terms go to the glossary in the same change.
- Wrap terms in `Term`: dotted underline, tooltip with the one-line definition (seeded from the glossary) using real values where possible ("Stepdown: 1.5 mm per pass for this pocket"), and "Learn more" opening the wiki panel (wiki content: later; v0.1 shows the glossary entry).
- Sentence case everywhere; buttons are verbs with an object ("Add pocket", "Export gCode", "Start run"); no "OK" / "Yes".
- Messages: what happened, why, what to do; no blame, no exclamation marks, no codes in the main text (codes go to Details).
- Values always with units in the project unit system; operations by name with the id secondary (`Pocket 2` · `pocket2`).
- Empty states teach the next step in one sentence plus one action.

## Internationalization

Decided for v0.1 ([decision 7](#decisions)): **English only, i18n-ready structure, no i18n library.**

- All user-facing strings live in `messages/` modules (per feature), never inline in JSX; sentences are whole template functions with typed params, never concatenated fragments.
- Error and warning text is derived from `code` + `rule` + `params` ([error handling decision 4](error-handling/README.md#decisions)), so a later locale needs only a new catalogue.
- Number formatting is locale-independent in v0.1 (`.` decimal, as the [parser](../architecture/quantities.md#literal-grammar-task-21)); `lang="en"` on the document.
- Layouts allow 30 % longer text (no fixed-width labels).

## Icons

- Set: **Lucide** (`lucide-react`, ISC licence, GPL-3.0-compatible per [ADR 0014](../decisions/0014-gpl-3-or-later-license.md)) for generic icons ([decision 5](#decisions)).
- Own icons for CNC concepts the set lacks (facing, pocket, drilling, profile, tabs, tool types, machine states, work zero) in `ui/icons/`, drawn on the same 24 px grid, `--icon-stroke` 1.35 px at 16 px. Each own tool icon has one accent detail (corner handles, a profile's dashed offset, the drill's crosshair) that turns amber only while the tool is active; generic Lucide icons stay monochrome.
- Field illustrations are their own set ([field](#field)).
- Sizes `--icon-sm` 14 px (inline, status bar), `--icon-md` 16 px (buttons, toolbars), `--icon-lg` 20 px (run controls), `--icon-xl` 28 px (field illustrations, empty states). Icons inherit `currentColor`; accent parts use `--accent-icon` with `--accent-icon-edge`.
- An icon never stands alone without an accessible name; icon-only buttons have a tooltip.

## Testing

Extends [testing.md](testing.md) (component and end-to-end rows).

- **Component tests** ([decision 14](#decisions)): Vitest + Testing Library (`@testing-library/react`, `user-event`) in jsdom, colocated `*.test.tsx`. Query by role and accessible name (this doubles as an accessibility check); `data-testid` only for the canvas. Each `ui/` component and app component gets an axe check (`axe-core`, MPL-2.0).
  - `vitest.config.mts` has two projects: `node` (every `*.test.ts`) and `ui` (`src/renderer/**/*.test.tsx`, jsdom, setup `src/renderer/src/test/setup.ts` with jest-dom matchers and the browser APIs Radix needs). Render with `renderUi()` (inside `UiProvider`, with a `user`), check with `expectNoAxeViolations()` (contrast is off in jsdom; the token test covers it), emulate reduced motion with `setReducedMotion()`. Click a toast's action through `findToastAction(name)`: Radix lifts the toast viewport's `pointer-events: none` one render after the toast appears, so a click right after its text shows up can fail under load.
- **Gallery:** in a dev build, open `#gallery` (DevTools console: `location.hash = 'gallery'`). It renders every `ui/` component light and dark side by side, overlays open in place, with switches for the window theme and reduced motion.
- What to test: `QuantityInput` behaviour per rule above (echo, timing, commit/revert, hints, steppers); error mapping from `AppError` fixtures; confirmation policy; keyboard paths (mode switch, F6, feed hold); stop control visible in every mode with an open connection.
- **Viewport:** WebGL does not run in jsdom. Keep picking, highlighting and scene building in pure functions (unit-tested); the canvas is covered by the end-to-end tests.
- **Tokens:** `ui/tokens.test.ts` parses `tokens.css` and checks that both themes define every semantic token, the two dark blocks agree, type and spacing are in `rem`, reduced motion zeroes every duration, and the listed contrast pairs reach their APCA Lc target per role ([colour](#colour)); `ui/apca.ts` implements the APCA formula, checked against its published reference values. A pair below its target fails the test.
- **Shell tests:** `shell/AppShell.test.tsx` renders `App` against the fake bridge (`test/bridge.ts`), which can bind a real core dispatcher on the fixture commands, so the replica, undo/redo and `history.list` run against the command layer; `state/replica.test.ts` covers snapshot, buffering, gaps and the save state.
- **Smoke test (task 0.9, extended in 3.3b):** Playwright for Electron launches the built app, checks the window opens without console errors and runs the packaged worker chunk ([testing.md](testing.md#app-playwright-for-electron)); switches the three modes (click and `Ctrl/Cmd+3/1`), sets the theme to Dark and Light and checks `data-theme`, the body colour and `settings.json`; and closes an edited project's last window (Cancel, then "Close without saving"); quits with an edited project (Cancel keeps it running, "Quit without saving" quits, "Save all" saves an untitled project through the stubbed save dialog). Native message boxes are stubbed in every e2e launch (`e2e/app.fixture.ts`). Components are covered by their component tests and axe checks; the end-to-end tests cover the real app screens (the production build) and do not screenshot the gallery (decided 2026-11-21).
- **End-to-end (task 3.11):** the exit-criteria flow driven through the UI by roles and labels from an empty library (`e2e/exit-criteria.e2e.ts`: design, plan with "New machine…" and "New tool…", export, run, save, close, reopen), mirrored by the headless MCP flow ([testing.md](testing.md#end-to-end)).
- **Run mode (3.12):** `modes/run/RunMode.test.tsx` renders the shell against the fake bridge with a scripted machine (`emitRunStatus` pushes statuses).
- **New tool / New machine:** `modes/plan/NewLibraryItem.test.tsx` (same fake bridge and fixture: add a machine from an empty library and create the plan with it; a new machine set on the plan; a new drill for a drilling, assigned; the core's issues at their field with focus; axe with the dialogs open); `library-form.test.ts` (defaults valid in both unit systems, per-type fields, issue mapping).
- **Plan mode (3.7):** `modes/plan/Plan.test.tsx` renders the shell against the fake bridge bound to the core plan fixture (test part, four tools, a machine); toolpath generation, `plan.toolpath.get` and `plan.export` are scripted with `handle` (the fixture runtime has no toolpath cache or file port), the save dialog with `setFileChoice({ export })`. Strategy controls and the calculation: `modes/plan/Strategy.test.tsx` (same setup: choices, the cycle per tool type, entered lengths with "Use default", which parameters show, read-only, the calculation's inputs, derivation and values at use; axe).
