# UI guidelines

Status: accepted · Principle: [principles.md §5](../principles.md#5-user-friendly-beginner-friendly-highly-graphical) · Decisions: [ADR 0012 Radix + own styles](../decisions/0012-radix-primitives-own-styles.md), [ADR 0010 react-three-fiber](../decisions/0010-react-three-fiber-viewport.md), [ADR 0017 APCA contrast](../decisions/0017-apca-contrast-for-design-tokens.md) · Terms: [glossary.md](../glossary.md) · Task: [v0.1 plan](../plans/v0.1.md) 1.11 (blocks 3.3–3.7, 3.12)

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
14. **Testing:** Vitest + Testing Library + jsdom + axe-core, plus a dev-only gallery screen screenshotted by the Playwright smoke test ([testing](#testing)).
15. **Outdated evaluation:** keep the last mesh, draw the edited operation's outline live, tint the mesh and show "Updating…" only after 300 ms ([evaluation status](#evaluation-status-pending-outdated-failed)).
16. **Reference autocomplete** in the quantity input (3.4): a simple list of valid references (earlier surfaces, tool parameters).
17. **Desktop look:** native title bar with the document name only, no logo or app name inside the window; toolbars, panels and a status bar; dense, not cramped.
18. **Accent Amber `#f5b700`, used sparingly:** on icons or parts of icons, selection, toggles and active states (switch, checkbox, segmented thumb, active mode); never a large fill. Accent icons use the saturated amber (`--accent-icon`) in both themes.
19. **No coloured primary button:** primary keeps the neutral surface and differs by a semibold label, a stronger outline and an amber icon; every primary button has an icon. Stop is the only filled control.
20. **Running is amber:** the running machine state takes the accent (play icon, a dot circling the badge edge), departing from IEC 60204-1 green on purpose; feed hold and warnings are orange; tool change is blue with an in-progress animation ([run safety](#run-mode-safety-ui)).
21. **Three severities:** soft warning (neutral, dismissible), hard warning (orange, not dismissible), error (red, impossible value, blocks Generate) ([warnings](#warnings-and-dfm)).
22. **Graphical fields:** every field has an illustration icon whose measured part is an amber line ([field](#field)).
23. **Mode switcher** is its own component, separate from tabs; its place in the window is decided with the window layout (3.3).
24. **Rich motion:** indicators slide, toolpaths draw in, selections pulse; every animation explains something and turns off with reduced motion ([motion](#motion)).
25. **Contrast by APCA:** colour contrast is checked with APCA Lc targets per role instead of WCAG 2 contrast ratios ([colour](#colour), [ADR 0017](../decisions/0017-apca-contrast-for-design-tokens.md)).

## Design system

Task 1.16, **approved by the user on 2026-11-20**. The reference is [ui-design-system.html](ui-design-system.html) (open it in a browser): principles, palette in both themes, every semantic token with its value, type, space, motion, icons, the component gallery in light and dark, and an example app shell. Nothing in the UI picks a colour, size or spacing ad hoc; every value is a token from that page, copied into `tokens.css` in task 3.3. Where this doc and the page differ on a value, the page wins; the rules stay here.

- **Base colours (from the user):** dark theme background Jet `#272d2d`, light theme background Ghost White `#f6f8ff`; neutrals lean slightly towards them.
- **Accent:** Amber `#f5b700` (option D of four). It shares a hue with feed hold and warnings, so they are separated by hue (both orange, `#c96a00` / `#f2993a` for warnings), by usage (the accent never fills a badge, a warning or a button) and by shape (triangle for warnings, pause bars for hold).
- Safety tokens stay reserved for the machine state badge, the stop control and run dialogs. Every machine state has a **label and a shape** ([run safety](#run-mode-safety-ui)), so no state depends on telling two hues apart.
- The App shell section of the page is an illustration, not a layout decision; the window layout is designed in 3.3 against [layout](#layout).
- The segmented control's selected thumb stays amber with dark text (`--text-on-accent`).

## Where things live

| Path                                        | Holds                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/renderer/src/ui/tokens.css`            | All design tokens as CSS custom properties, light and dark ([tokens](#design-tokens)).          |
| `src/renderer/src/ui/base.css`              | The only other global CSS: box sizing, body font and colours, focus ring, reduced motion.       |
| `src/renderer/src/ui/<Name>/`               | One component per folder: `<Name>.tsx`, `<Name>.module.css`, `<Name>.test.tsx`.                 |
| `src/renderer/src/ui/index.ts`              | The library's public API; screens import from `ui/`, never from Radix.                          |
| `src/renderer/src/ui/UiProvider/`           | `UiProvider` (tooltip timing), `ThemeScope` and the portal container overlays render into.      |
| `src/renderer/src/ui/icons/`                | Own icons: `tool/` (CNC tool and view icons), `field/` (field illustrations) ([icons](#icons)). |
| `src/renderer/src/ui/motion.ts`             | `useReducedMotion()`: OS preference or `data-motion='reduce'` on the root ([motion](#motion)).  |
| `src/renderer/src/gallery/`                 | Dev-only component gallery at `#gallery` ([testing](#testing)); not in production builds.       |
| `src/renderer/src/test/`                    | Component test setup and helpers (`renderUi`, `expectNoAxeViolations`, `setReducedMotion`).     |
| `src/renderer/src/shell/`                   | App shell: mode switcher, regions, status bar, global run control ([layout](#layout)).          |
| `src/renderer/src/modes/{design,plan,run}/` | Mode screens; use `ui/` components only, never Radix directly.                                  |
| `src/renderer/src/viewport/`                | The react-three-fiber canvas and scenes (task 3.5).                                             |
| `src/renderer/src/messages/`                | User-facing strings and the error/warning message catalogue ([copy](#copy-and-terminology)).    |

The renderer holds a read replica of `ProjectDoc` kept current by the patch stream and sends every change as a command over IPC ([commands.md](../architecture/commands.md#project-state)). Selection, camera, panel layout and mode are per-window UI state, never in the document or undo history.

## Design tokens

Tokens are **CSS custom properties** on `:root` in `tokens.css`, consumed by CSS Modules ([decision 4](#decisions)). Values come from the [design system](#design-system); this section fixes names and structure.

- **Semantic** tokens (below) are the only tokens components use. The design system sets them directly; Radix Colors scales ([decision 3](#decisions)) were the starting point for the neutrals and feedback hues, and primitives (`--gray-*`, …) are added to `tokens.css` only if a value is needed by several semantic tokens.
- A theme is a set of semantic values: light on `:root`, dark under `:root[data-theme='dark']` and under `prefers-color-scheme: dark` unless `data-theme='light'` is set; the setting offers Light / Dark / System, default System ([decision 1](#decisions)). Classes `.t-light` / `.t-dark` scope a theme to a subtree (the gallery).

Units: `rem` for type and spacing (so Electron zoom scales the UI), `px` only for hairlines (1 px borders). The viewport reads its colours with a `useToken('--viewport-…')` hook (`getComputedStyle`, re-read on theme change), so there is one source of truth for three.js too.

### Colour

| Token group       | Tokens                                                                                                                                                                                                                                                                          | Use                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Surfaces          | `--bg-app`, `--bg-chrome`, `--bg-viewport`, `--bg-field`, `--bg-control`, `--bg-raised`, `--bg-hover`, `--bg-active`, `--bg-overlay`                                                                                                                                            | App background, toolbars/panels/status bar, viewport, inputs, buttons, popovers, hover and pressed tints, dialog scrim. |
| Text              | `--text`, `--text-muted`, `--text-faint`, `--text-on-accent`, `--text-on-solid`, `--text-accent`                                                                                                                                                                                | Body, secondary (units, ids, hints), placeholders and disabled, on amber, on solid colours, amber-toned text.           |
| Lines             | `--border`, `--border-control`, `--focus`                                                                                                                                                                                                                                       | Separators, input and button outlines, focus ring.                                                                      |
| Accent            | `--accent`, `--accent-hover`, `--accent-border`, `--accent-subtle`, `--accent-icon`, `--accent-icon-edge`                                                                                                                                                                       | Toggles, selection, active mode; accent icon parts (the edge is a hairline filter in light only).                       |
| Feedback          | `--info`, `--success`, `--warning`, `--danger` (+ `-subtle` backgrounds)                                                                                                                                                                                                        | Hard warnings, done, errors and destructive actions ([severities](#warnings-and-dfm)). Never for machine state.         |
| Safety (reserved) | `--safety-stop`, `--safety-alarm`, `--safety-hold`, `--safety-moving` (+ `-edge`), `--safety-action`, `--safety-idle`, `--safety-offline` (+ `-fg`)                                                                                                                             | Machine state and the stop control only ([run safety](#run-mode-safety-ui)). Never reused elsewhere.                    |
| Viewport          | `--vp-grid`, `--vp-grid-major`, `--vp-stock`, `--vp-part`, `--vp-edge`, `--vp-removal`, `--vp-selected`, `--vp-selected-halo`, `--vp-feed`, `--vp-rapid`, `--vp-tool`, `--vp-axis-x/y/z`; background `--bg-viewport`; `--vp-hover`, `--vp-outdated`, `--vp-plunge` added in 3.5 | 3D scene. Axis colours follow the CAD convention X red, Y green, Z blue.                                                |

Rules:

- Contrast is measured with **APCA** (APCA-W3 0.0.98G-4g), not WCAG 2 ratios ([decision 25](#decisions), [ADR 0017](../decisions/0017-apca-contrast-for-design-tokens.md)): the lightness contrast `Lc` of a foreground on its background (order matters; negative for light on dark) must reach the target of its role, in both themes ([accessibility](#accessibility)). Targets follow the APCA Bronze levels at the sizes and weights we use; our 10–13 px text is below Bronze's font minimums, so they are floors:

  | Role  | \|Lc\| ≥ | Used for                                                                             |
  | ----- | -------- | ------------------------------------------------------------------------------------ |
  | read  | 75       | Text read for content at 11–13 px, regular (400): body, values, labels, notes, menus |
  | label | 60       | Text at 10–13 px, medium/bold (500–600): button labels, chips, badges, tooltips      |
  | spot  | 30       | Non-content text: placeholders, unit suffixes, metadata, disabled (`--text-faint`)   |
  | icon  | 45       | Outline pictograms with fine detail (1.5 px stroke, 12–16 px)                        |
  | mark  | 30       | 1–2 px control outlines, focus ring, solid indicators ≥ 5.5 px                       |

  Heading-size text (≥ 24 px bold) would take Lc 45; no token pair is used only at that size. The pairs, their roles and current misses are listed in `src/renderer/src/ui/tokens.test.ts` (`PAIRS`), which computes them from `tokens.css`.

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

Z-order follows elevation (`--z-toolbar`, `--z-popover`, `--z-dialog`, `--z-toast`); the [global stop control](#run-mode-safety-ui) sits above dialogs (`--z-safety`), so no overlay ever hides it.

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

| Component                                                                                                 | Task     | Notes                                                                                                                        |
| --------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Field`                                                                                                   | 3.3      | [Field](#field): illustration, label (+ `Term`), lock, control, support area; wires `aria-describedby`.                      |
| `QuantityInput`                                                                                           | 3.4      | [Quantity input rules](#quantity-and-expression-input).                                                                      |
| `Term`                                                                                                    | 3.3      | Glossary term with tooltip and "Learn more" link to the wiki ([copy](#copy-and-terminology)).                                |
| `StatusChip`                                                                                              | 3.3      | Plan status, stale badge, evaluation status, machine state (with safety tokens).                                             |
| `WarningList`, `WarningItem`                                                                              | 3.6, 3.7 | DFM, feeds-and-speeds and machine-check warnings ([warnings](#warnings-and-dfm)).                                            |
| `ErrorMessage`, `ErrorDetails`                                                                            | 3.3      | [AppError display](#errors).                                                                                                 |
| `JobIndicator`, `JobList`                                                                                 | 3.3      | [Jobs and progress](#jobs-and-progress).                                                                                     |
| `UndoRedo`                                                                                                | 3.3      | [Undo and redo](#undo-and-redo).                                                                                             |
| `EmptyState`                                                                                              | 3.3      | Explains the next step with one primary action.                                                                              |
| `Panel`, `PanelGroup`                                                                                     | 3.3      | Resizable, collapsible shell regions (`react-resizable-panels`, [decision 13](#decisions)).                                  |
| `OperationList`                                                                                           | 3.6      | Design order; move up/down by buttons and `Alt+↑/↓` (drag later).                                                            |
| `ParamIllustration`                                                                                       | 3.6      | Dynamic SVG per operation drawn from the entered values; highlights the focused parameter.                                   |
| `Viewport`, `ViewPresets`                                                                                 | 3.5      | One persistent canvas; the mode decides the scene ([selection](#selection-and-picking)).                                     |
| `PlanPicker`, `ToolPicker`, `FeedsSpeedsCard`, `ExportDialog`                                             | 3.7      | Tool suggestions with reasons; feeds-and-speeds derivation as formulas ([feeds-speeds.md](../architecture/feeds-speeds.md)). |
| `StopControl`, `MachineStateBadge`, `Dro`, `JogPad`, `RunProgress`, `ToolChangeDialog`, `ConnectionPanel` | 3.12     | [Run-mode safety UI](#run-mode-safety-ui).                                                                                   |

A dev-only **gallery** screen renders every `ui/` component in every variant and state in both themes, side by side as in the [design system](#design-system) page; it is the manual review surface and the target of the screenshot test ([testing](#testing)).

### Buttons

- Variants: default, primary, ghost, danger; sizes sm/md. All share the neutral surface (`--bg-control`, `--border-control`).
- **Primary** ([decision 19](#decisions)): semibold label, `--border-control` outline that warms towards amber on hover, and an icon in `--accent-icon`. At most one primary per panel or dialog.
- Danger uses `--danger` for the label and icon, never a red fill. Stop is the only filled control ([run safety](#run-mode-safety-ui)).
- Toggles (switch, checkbox, segmented thumb, pressed icon button) use the accent: amber thumb or check, or the amber part of the icon.

### Field

The `Field` component (3.3, quantity behaviour in 3.4) is a grid: label column (illustration + label), a lock column, the input, and a support area under the input.

- **Illustration** (`--icon-xl` 28 px, viewBox 20, 1 px grey drawing): draws the feature and makes the measured part itself one amber line (1.4 px, butt caps, on the same centreline as the drawing; 1.6 px while focused). No dimension arrows. Length runs end to end along the slot, width across its middle, depth the wall, stepdown the riser, corner radius the arc, chamfer the face, feed the travel line. At rest the icon is at 35 % saturation and animates to full saturation on focus. Fields without a value input (checkbox, switch, button) stay fully saturated; read-only fields are fully desaturated at reduced opacity.
- **Lock** sits between label and input, outside the input; it toggles whether the value follows the recommendation.
- **Pencil** inside the input, on a tinted round background, opens the adjust popover (step buttons .001–100 and the recommended value); amber-tinted when a fix is available.
- **Support area:** one group under the input that looks pulled out from under it (no top corners, inset from the input's rounding, a small shadow from the input, slides in with `--motion-base`). It holds the echo ([quantity input](#quantity-and-expression-input)), the highest-severity status with its fix button ("Use 3.00"), and further notes collapsed ("1 dismissed · Show"). Its background follows the severity ([warnings](#warnings-and-dfm)). Read-only fields show it dimmed with a dashed border.
- Narrow panels: the input column narrows before the label column; below 260 px the support buttons wrap under the text.

## Layout

### App shell

Starting point for the window layout, which is designed in task 3.3; the shell in the [design system](#design-system) page is an illustration only.

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
- **Left panel (navigator):** what the mode is made of. Design: part, stock, operations in design order. Plan: plan picker, plan status, setup, plan operations in machining order. Run: connection, homing, jog, work zero.
- **Viewport:** centre, always present; one react-three-fiber canvas kept alive across modes (no WebGL context churn); the mode decides the scene.
- **Inspector (right):** parameters of the selection, its warnings, the `ParamIllustration`, recommended ranges. In run mode: DRO, run progress, run controls.
- **Status bar:** [evaluation status](#evaluation-status-pending-outdated-failed), [jobs](#jobs-and-progress), warning count (opens the warning list), unit system, save state, agent connection.
- Side panels are resizable and collapsible; layout is per window, kept in app preferences, never in the project. Minimum window 1024 × 640; below 1280 px wide the inspector overlays the viewport instead of shrinking it.
- **Window chrome:** native title bar and native application menu (File, Edit, View, Help) with accelerators that dispatch the same commands as the buttons ([decision 12](#decisions)).

### Mode switching

- Modes are a three-way `ModeSwitcher` (its own component, [decision 23](#decisions)) in the main toolbar, `Ctrl/Cmd+1/2/3`. The mode is per window.
- Switching is instant and never blocked: jobs, evaluation and a run keep going. Each mode keeps its own selection and camera.
- A mode without its input shows an `EmptyState` instead of disabled controls: Plan without a part ("Design a part first", button to Design); Run without a plan ("Create a plan to run", button to Plan).
- Agents never switch the user's mode or steal focus; their edits appear in place ([undo](#undo-and-redo)).

### Panels and inspectors

- The inspector edits exactly one item: the selection. No selection → part (Design), plan (Plan), connection (Run) summary.
- Fields are grouped by what the user thinks about (Shape, Depth, Corners, Tabs), in the order of the [mode doc's](../modes/design.md#operations-v01) parameter tables; rarely changed groups start collapsed.
- Read-only states (a `finalized` plan, an `inUse` plan) show read-only fields (desaturated illustration, dimmed support area, [field](#field)) with a lock icon and the reason as a tooltip with the way out ("Finalized plans are read-only. Set the status to settled design to edit, or duplicate the plan."), not disabled grey inputs.
- Plan stale badges ([plan-v0.1.md](../modes/plan-v0.1.md#plans-are-snapshots)) appear on the affected row and in the plan header with the rebuild / library-update action next to them.

## Interaction

### Quantity and expression input

Every dimensional field is a `QuantityInput` over the [quantity model](../architecture/quantities.md) (task 3.4). The parser, units, tolerance grammar and error codes are owned there; these are the UI rules.

- **Show what was entered.** The field shows the source as typed (`1/16"`, `D/2 ±0.01`). When unfocused and the source is in another unit than the project unit system or is an expression, the computed value follows in muted text at field precision (`1/16" · 1.588 mm`).
- **Echo the interpretation while typing.** Below the field, a one-line preview states how the input is read: `= 1.588 mm`, `= 25.4 mm, upper +0.1, lower −0.05`, `= 3 mm (from pocket1.floor.z)`. This is the general answer to the ambiguous inputs in the plan's known issues (`+1/2` as a deviation pair, `D -1/2`): the echo shows the reading, and the field's hint for those rule ids offers the intended spelling.
- **Unit suffix:** the bare-number default unit is shown as a muted suffix inside the field; typing any accepted unit of the kind overrides it.
- **Validation timing:** parse on every change (debounced 150 ms) for the echo; show an error only on blur, on Enter, or after 600 ms without typing, never mid-word. The field keeps the raw text when invalid.
- **Commit:** Enter or blur commits a valid value as one command (one undo step); Escape reverts to the stored source. An invalid value never commits; the document and viewport keep the last valid value, and the field stays marked until fixed or reverted.
- **Errors in place:** `issues[].params.offset` underlines the position in the text; the message comes from the catalogue keyed by `rule` ([errors](#errors)); a `hint` param becomes a one-click fix button ("Use `1 1/2"`").
- **Steppers:** `↑`/`↓` step a plain literal by the field's step in the source's unit (`Shift` ×10, `Alt` ×0.1); disabled for expressions. No spinner buttons.
- **Tolerance:** typed in the same field. An untoleranced field shows the inherited general tolerance as muted text with its scope ("±0.1 mm from part").
- **Recommended range:** where a check or the calculator knows one, the field shows it as a hint ("recommended ≥ 3.2 mm") and a `Term`-style tooltip explains what it depends on and what it affects (principle §5); a [DFM suggestion](#warnings-and-dfm) offers "Apply".
- **References:** typing a letter offers an autocomplete list of valid references (surfaces of earlier operations, tool parameters) ([decision 16](#decisions)); a reference that becomes unknown later marks the field with `expression.reference`.
- **Precision:** display precision belongs to the field ([quantities.md](../architecture/quantities.md#value)); the decimal separator is always `.`.

Implementation (task 3.4): [`ui/QuantityInput/`](../../src/renderer/src/ui/QuantityInput/QuantityInput.tsx) renders a `Field` and reads the text only through the core (`quantityFromSource`, `parseLiteral`; pure helpers in `reading.ts`); messages and labels in [`messages/quantity.ts`](../../src/renderer/src/messages/quantity.ts). Props: kind, bare-number default unit (also the display unit), stored `Quantity`, `onCommit`, optional resolver, references, field rules (`validate`), precision, step, inherited tolerance, recommended value, pick hook. Refinements decided while building it:

- **Echo** shows only while focused and only for a reading that is not an error (a stale echo never sits next to an error). The inherited general tolerance is part of the echo ("= 1.588 mm · ±0.100 mm from part"), not shown at rest. Deviations show with their sign at field precision ("upper +0.100, lower −0.050"); a formula names its references ("(from pocket1.floor.z)").
- **Computed value at rest:** for an expression, or a literal whose written unit is not the display unit; the unit suffix hides when a unit is typed or the computed value shows.
- **Error marks** are drawn by a text overlay of the input (wavy `--danger` underline from `offset` to the next space; at the end of the text a short stub). A stored formula that no longer reads (reference gone) is marked at once, without typing.
- **Fixes** are verified with the core before they are offered, and applying one commits it. Known ambiguities get fixes: a trailing `+n/d` / `-n/d` that fails `order` ("“+1/2” reads as a tolerance (upper +1, lower +2)…", fix `10 + 1/2`, `D - 1/2`); Greek mu U+03BC (fix: micro sign); `hyphenatedMixedNumber` and `ambiguousDivision` hints (first variant).
- **Steppers** change the text only; Enter/blur commits. They replace the number between the core's nominal offsets, so unit and tolerance stay as typed (`1.50 ±0.05` → `1.60 ±0.05`; `1/16"` + 0.1 → `0.1625"`). The pencil's adjust popover (step .001–100, −/+, recommended "Use …") also edits the text; closing it commits once (one undo step per popover session).
- **References:** the list opens while typing a name, or with `Ctrl+Space` (and `↓` when the text is not steppable); `↑`/`↓` move, `Enter` inserts, `Escape` closes the list without reverting. Options show the id and the human name.
- **Pick hook:** `onPick(insert)`; the shortcut is `Alt+P` (a bare `P` would type into the field). `insert(reference)` puts the reference at the last caret/selection, refocuses the field and does not commit.

### Errors

How an `AppError` reaching the UI boundary ([boundaries.md](../conventions/error-handling/boundaries.md#entry-points-ui-agent-cli-automation)) is shown:

| Situation                                    | Display                                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `issues` with a `path` matching a field      | Inline in the field's support area (`--danger`, icon, `aria-invalid`, `aria-describedby`); focus moves to the first invalid field on submit. |
| `issues` without a matching field            | Summary at the top of the form/inspector.                                                                                                    |
| `severity` `info` (incl. `op.aborted`)       | Neutral toast or nothing; cancellation is never shown as a failure.                                                                          |
| `severity` `warn` / `error`, no field        | Inline banner in the panel that started the action, with `userMessage` and a retry button if `retryable`.                                    |
| `severity` `fatal`, `machine.*` during a run | Blocking dialog (run errors: [run safety](#run-mode-safety-ui)).                                                                             |
| `command.conflict`                           | Not shown for UI sources (never rejected); for queued agent actions see the agent indicator.                                                 |

- Message text: the catalogue in `messages/` maps `code` (and issue `rule`) to a friendly sentence with `params` formatted in the project unit system; fallback is the registry's `userMessage` ([codes.ts](../../src/shared/errors/codes.ts)). The developer-facing `message` and the frames are only in an "Details" expander with a "Copy details" button (for bug reports).
- Every message says what happened, why if known, and what to do next.

### Selection and picking

- Click in the viewport selects the operation (or plan operation) owning the clicked surface; the navigator row and inspector follow. Selecting a row selects in the viewport. Hover highlights (`--viewport-hover`) before click. `Escape` clears the selection. Multi-select is later.
- **Pick mode** for surface references (`on`, references in formulas): the field's pick button (or `Alt+P` while focused; a bare `P` types) enters pick mode – crosshair cursor, eligible surfaces (horizontal surfaces of the stock and earlier operations, [design.md](../modes/design.md#positioning-v01)) highlighted, others dimmed, a banner "Pick a surface for _On_ · Esc to cancel". Click picks and returns focus to the field. The same field always offers a dropdown of the eligible surface ids, so picking never needs the mouse.
- Picked and referenced surfaces are named by their surface id and the operation name (`pocket1.floor` · "Pocket 1 floor").
- Camera: orbit, pan, zoom to cursor; view presets Top / Front / Right / Iso and "Fit" in a floating viewport toolbar with keys `1`–`4`, `F` while the viewport has focus. Mouse mapping is a setting with presets ([decision 10](#decisions)):

  | Preset     | Orbit               | Pan                 | Zoom             |
  | ---------- | ------------------- | ------------------- | ---------------- |
  | Default    | Left-drag           | Right-drag          | Wheel, to cursor |
  | Fusion 360 | Shift + middle-drag | Middle-drag         | Wheel, to cursor |
  | Blender    | Middle-drag         | Shift + middle-drag | Wheel, to cursor |

  Left-click always selects (a click is a press and release without drag). Trackpad gestures (two-finger pan, pinch zoom) work in every preset. More presets only where they are a mapping table entry.

- The viewport is focusable (`tabindex=0`, labelled region); arrow keys orbit, `Shift`+arrows pan, `+`/`−` zoom.

### Undo and redo

- Undo/redo buttons in the main toolbar and `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` (also `Ctrl+Y` on Windows/Linux) dispatch `history.undo` / `history.redo` ([commands.md](../architecture/commands.md#undo--redo)). While focus is in a text field, the shortcuts act on the text, not the history.
- Tooltips name the step: "Undo Add pocket (Pocket 2)". The history is shared by all sources; when the top step is not the user's own, the tooltip says whose ("Undo Add pocket – by agent").
- After undo/redo the affected item is selected and briefly highlighted (`--motion-slow`, none under reduced motion) so the user sees what changed.
- Removing something shows a toast "Removed Pocket 2 · Undo" instead of a confirmation ([confirmations](#confirmations)).
- Agent edits (source `agent`) briefly highlight the changed row with an agent badge, so the user notices changes they did not make (principle §1).

### Evaluation status: pending, outdated, failed

Design evaluation is automatic with a 200 ms trailing debounce ([workers.md](../architecture/workers.md#automatic-evaluation-after-design-edits)). UI rules (task 3.6):

| `evaluation` | Viewport                                                                                                                                                                                     | Status bar / inspector                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `done`       | Current mesh.                                                                                                                                                                                | Nothing (or a quiet check mark).                                                       |
| `pending`    | Keeps the last mesh; the edited operation's shape is drawn live as an outline from the field values (cheap, no worker). After `--delay-indicator`, the mesh is tinted `--viewport-outdated`. | "Updating…" chip after `--delay-indicator`; geometry warnings marked "checks pending". |
| `failed`     | Keeps the last mesh, tinted outdated, with an error marker at the failing operation.                                                                                                         | Error chip with `userMessage`; clicking selects the operation and focuses the field.   |

- A drag or held key never flickers: nothing changes until 200 ms after the last change, and the indicator delay hides evaluations that finish in time ([decision 15](#decisions)).
- Parameter warnings come with every command result and show at once; geometry warnings appear when the evaluation is `done`.

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

  | Tier         | Meaning                                               | Look                                                     | Dismiss                                |
  | ------------ | ----------------------------------------------------- | -------------------------------------------------------- | -------------------------------------- |
  | Soft warning | Outside a recommendation; safe to ignore              | Neutral background, `--border-control` bar, "i" icon     | `×`; collapses to "1 dismissed · Show" |
  | Hard warning | Likely bad result or risk (tool can't cut the radius) | `--warning-subtle` background, `--warning` triangle icon | No                                     |
  | Error        | Impossible value; blocks Generate                     | `--danger-subtle`, `--danger`, `aria-invalid`            | No; fixed or reverted                  |

  Core `info` maps to soft, `warning` to hard (the mapping per check code lives in the message catalogue). Warnings never block; only errors do.

- **Text:** re-rendered from `code` + `params` in the project unit system through the message catalogue; the core's English `message` (mm values) is the fallback. This closes the plan's known issue on DFM messages for inch projects.
- **Suggestion:** a `suggestion` becomes a button "Apply ≥ 3.2 mm" that dispatches the update command (one undo step).
- Every warning links its terms (`Term`) and, where useful, shows a small illustration of the problem (e.g. a corner radius smaller than the tool).

### Confirmations

Policy ([decision 11](#decisions)): **undo instead of confirm** for document edits; confirm only what cannot be undone.

| Action                                                                           | Confirmation                                                                                                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document edits incl. removing operations                                         | None; undo toast.                                                                                                                                     |
| `plan.remove`, library item delete, discard recovery, close with unsaved changes | `ConfirmDialog` naming the item and the consequence; the destructive button names the action ("Remove plan"), never "OK".                             |
| `run.job.start`                                                                  | Pre-flight dialog before every run, the virtual machine included: plan, machine copy, work zero, tools in order, soft-limit check result, time scale. |
| `run.machine.unlock` (`$X`)                                                      | Confirm: "Position is not known until homed."                                                                                                         |
| Feed hold, stop, `run.machine.reset`                                             | **Never** confirmed.                                                                                                                                  |

`ConfirmDialog` focuses the safe choice (Cancel) first, except the run pre-flight, which focuses "Start run" only after the checks pass.

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
- **DRO:** work and machine coordinates per axis, mono tabular digits, units of the project; work zero shown in the viewport with the tool marker at `wpos`.
- **Progress:** lines done/total, current section label, elapsed time, the toolpath played back in the viewport with the done part dimmed.
- **Disabled controls explain why:** jog in Alarm says "Home the machine first" (from `run.state` data), rather than doing nothing.

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
  - `vitest.config.mts` has two projects: `node` (every `*.test.ts`) and `ui` (`src/renderer/**/*.test.tsx`, jsdom, setup `src/renderer/src/test/setup.ts` with jest-dom matchers and the browser APIs Radix needs). Render with `renderUi()` (inside `UiProvider`, with a `user`), check with `expectNoAxeViolations()` (contrast is off in jsdom; the token test covers it), emulate reduced motion with `setReducedMotion()`.
- **Gallery:** in a dev build, open `#gallery` (DevTools console: `location.hash = 'gallery'`). It renders every `ui/` component light and dark side by side, overlays open in place, with switches for the window theme and reduced motion.
- What to test: `QuantityInput` behaviour per rule above (echo, timing, commit/revert, hints, steppers); error mapping from `AppError` fixtures; confirmation policy; keyboard paths (mode switch, F6, feed hold); stop control visible in every mode with an open connection.
- **Viewport:** WebGL does not run in jsdom. Keep picking, highlighting and scene building in pure functions (unit-tested); the canvas is covered by the end-to-end tests.
- **Tokens:** `ui/tokens.test.ts` parses `tokens.css` and checks that both themes define every semantic token, the two dark blocks agree, type and spacing are in `rem`, reduced motion zeroes every duration, and the listed contrast pairs reach their APCA Lc target per role ([colour](#colour)); `ui/apca.ts` implements the APCA formula, checked against its published reference values. Pairs below their target are pinned with `it.fails` and listed in the [plan's known issues](../plans/v0.1.md#known-issues-and-risks) until decided.
- **Smoke test (task 0.9, done):** Playwright for Electron launches the built app, checks the window opens without console errors and runs the packaged worker chunk ([testing.md](testing.md#app-playwright-for-electron)). With the UI shell (3.3): switch the three modes and open the gallery in both themes for screenshot comparison.
- **End-to-end (task 3.11):** the exit-criteria flow driven through the UI by roles and labels, mirrored by the headless MCP flow.
