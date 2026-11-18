# UI guidelines

Status: draft · Principle: [principles.md §5](../principles.md#5-user-friendly-beginner-friendly-highly-graphical) · Decisions: [ADR 0012 Radix + own styles](../decisions/0012-radix-primitives-own-styles.md), [ADR 0010 react-three-fiber](../decisions/0010-react-three-fiber-viewport.md) · Terms: [glossary.md](../glossary.md) · Task: [v0.1 plan](../plans/v0.1.md) 1.11 (blocks 3.3–3.7, 3.12)

How the renderer looks and behaves: design tokens, components, layout, interaction, run-mode safety, accessibility, copy, testing. Rules are imperative. The user's answers to the open questions are recorded as [decisions](#decisions); concrete token values and the palette come from the [design system](#design-system) step (task 1.16), approved by the user before task 3.3.

## Decisions

Settled with the user (task 1.11); the sections below specify them. The doc stays `draft` until the [design system](#design-system) is approved.

1. **Theme:** follow the OS, with a Light / Dark / System setting ([tokens](#design-tokens)).
2. **Design system first:** tokens, palette and a components preview are defined in a separate step and approved by the user before any UI is built (task 1.16, [design system](#design-system)). Look: modern, friendly, approachable, with a consistent palette.
3. **Colour scales:** Radix Colors (MIT) 12-step scales, adapted to the chosen palette.
4. **CSS:** CSS Modules + CSS custom properties.
5. **Icons:** Lucide (ISC) + own CNC icons ([icons](#icons)).
6. **Renderer state:** Zustand (MIT) for per-window UI state (selection, mode, panels, pick mode); `useSyncExternalStore` over the document replica.
7. **i18n:** English only in v0.1, strings centralised in `messages/`, errors and warnings rendered from code + params, no library ([internationalization](#internationalization)).
8. **Typography:** system fonts at 14 px base with tabular numerals ([type](#type)).
9. **Control sizes:** 44 px in run mode, 32 px elsewhere ([sizes](#spacing-radii-sizes)).
10. **Viewport mouse:** selectable presets as a setting; default left-drag orbit, right-drag pan, wheel zoom to cursor; a Fusion 360-style preset and others where cheap ([selection and picking](#selection-and-picking)).
11. **Confirmations and run safety:** undo instead of confirm for document edits; a pre-flight dialog before every run, the virtual machine included; hold, stop and reset are never confirmed; `Escape` = feed hold while streaming; no single-key resume ([confirmations](#confirmations), [run safety](#run-mode-safety-ui)).
12. **Window chrome:** native title bar and native application menu.
13. **Panels:** `react-resizable-panels` (MIT).
14. **Testing:** Vitest + Testing Library + jsdom + axe-core, plus a dev-only gallery screen screenshotted by the Playwright smoke test ([testing](#testing)).
15. **Outdated evaluation:** keep the last mesh, draw the edited operation's outline live, tint the mesh and show "Updating…" only after 300 ms ([evaluation status](#evaluation-status-pending-outdated-failed)).
16. **Reference autocomplete** in the quantity input (3.4): a simple list of valid references (earlier surfaces, tool parameters).

## Design system

Task 1.16 of the [v0.1 plan](../plans/v0.1.md): a well-organised, systematic design system – token values for every group below, the palette in both themes, and a components preview (the gallery) – **approved by the user before task 3.3**. Nothing in the UI picks a colour, size or spacing ad hoc; every value is a token from this step.

**Base colours (from the user):**

| Role                   | Value                 |
| ---------------------- | --------------------- |
| Dark theme background  | Jet `#272d2d`         |
| Light theme background | Ghost White `#f6f8ff` |

**Accent: pending** (the user chooses from four palette options):

| Option | Accent                | Clash to resolve                                                   |
| ------ | --------------------- | ------------------------------------------------------------------ |
| A      | Vivid green `#23ce6b` | Same hue as the green "running" machine state (`--safety-moving`). |
| B      | Sage green `#4eba7a`  | Same hue family as `--safety-moving`.                              |
| C      | Orange-red            | Close to the Stop / alarm red (`--safety-stop`, `--safety-alarm`). |
| D      | Amber / yellowish     | Close to feed hold (`--safety-hold`) and `--color-warning`.        |

**Clash rules** (apply whichever accent is chosen):

- The accent never fills a machine-state badge or the stop control; safety tokens stay reserved ([colour](#colour)).
- Where the accent shares a hue with a safety colour, the design system separates them by lightness/saturation and by usage: the accent appears on interactive controls (buttons, selection, focus), safety colours only in the machine state badge, the stop control and run dialogs.
- Every machine state also has a **label and a shape** ([run safety](#run-mode-safety-ui)), so no state depends on telling two hues apart.
- With an amber accent, `--color-warning` and `--safety-hold` must remain distinguishable from primary buttons (e.g. warnings always with the triangle icon and a subtle background, never a filled accent-like surface).
- The design system's contrast test covers the accent on both backgrounds (text on accent, accent on background).

## Where things live

| Path (planned)                              | Holds                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/renderer/src/ui/tokens.css`            | All design tokens as CSS custom properties, light and dark ([tokens](#design-tokens)).       |
| `src/renderer/src/ui/<Name>/`               | One component per folder: `<Name>.tsx`, `<Name>.module.css`, `<Name>.test.tsx`.              |
| `src/renderer/src/ui/icons/`                | Own CNC icons as React components ([icons](#icons)).                                         |
| `src/renderer/src/shell/`                   | App shell: mode switcher, regions, status bar, global run control ([layout](#layout)).       |
| `src/renderer/src/modes/{design,plan,run}/` | Mode screens; use `ui/` components only, never Radix directly.                               |
| `src/renderer/src/viewport/`                | The react-three-fiber canvas and scenes (task 3.5).                                          |
| `src/renderer/src/messages/`                | User-facing strings and the error/warning message catalogue ([copy](#copy-and-terminology)). |

The renderer holds a read replica of `ProjectDoc` kept current by the patch stream and sends every change as a command over IPC ([commands.md](../architecture/commands.md#project-state)). Selection, camera, panel layout and mode are per-window UI state, never in the document or undo history.

## Design tokens

Tokens are **CSS custom properties** on `:root` in `tokens.css`, consumed by CSS Modules ([decision 4](#decisions)). Values come from the [design system](#design-system); this section fixes names and structure. Two tiers:

- **Primitive** scales (`--gray-1` … `--gray-12`, `--blue-*`, `--amber-*`, `--red-*`, `--green-*`): 12-step light/dark scales from Radix Colors, adapted to the chosen palette ([decision 3](#decisions)). Only `tokens.css` uses primitives.
- **Semantic** tokens (below): the only tokens components use. A theme is a set of semantic values: `:root[data-theme='light']` and `:root[data-theme='dark']`; `system` maps to one of them from `prefers-color-scheme`; the setting offers Light / Dark / System, default System ([decision 1](#decisions)).

Units: `rem` for type and spacing (so Electron zoom scales the UI), `px` only for hairlines (1 px borders). The viewport reads its colours with a `useToken('--viewport-…')` hook (`getComputedStyle`, re-read on theme change), so there is one source of truth for three.js too.

### Colour

| Token group       | Tokens                                                                                                                                                                                                                                                                    | Use                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Surfaces          | `--color-bg`, `--color-surface`, `--color-surface-raised`, `--color-overlay`                                                                                                                                                                                              | App background, panels, popovers/menus, dialog scrim.                                                |
| Text              | `--color-text`, `--color-text-muted`, `--color-text-disabled`, `--color-text-on-accent`                                                                                                                                                                                   | Body, secondary (units, ids, hints), disabled, text on filled buttons.                               |
| Lines             | `--color-border`, `--color-border-strong`, `--color-focus`                                                                                                                                                                                                                | Separators, input outlines, focus ring.                                                              |
| Accent            | `--color-accent`, `--color-accent-hover`, `--color-accent-subtle`                                                                                                                                                                                                         | Primary action, selected mode, selection in lists.                                                   |
| Feedback          | `--color-info`, `--color-success`, `--color-warning`, `--color-danger` (+ `-subtle` backgrounds)                                                                                                                                                                          | DFM `info`/`warning`, done, invalid field, destructive actions. Never for machine state.             |
| Safety (reserved) | `--safety-stop`, `--safety-alarm`, `--safety-hold`, `--safety-moving`, `--safety-action`, `--safety-idle`, `--safety-offline` (+ `-fg`)                                                                                                                                   | Machine state and the stop control only ([run safety](#run-mode-safety-ui)). Never reused elsewhere. |
| Viewport          | `--viewport-bg`, `--viewport-grid`, `--viewport-stock`, `--viewport-part`, `--viewport-removal`, `--viewport-hover`, `--viewport-selected`, `--viewport-outdated`, `--viewport-rapid`, `--viewport-feed`, `--viewport-plunge`, `--viewport-tool`, `--viewport-axis-x/y/z` | 3D scene. Axis colours follow the CAD convention X red, Y green, Z blue.                             |

Rules:

- Text contrast ≥ 4.5:1, large text and UI component boundaries (inputs, focus ring, icons that carry meaning) ≥ 3:1, in both themes ([accessibility](#accessibility)). Each theme's token values are checked by a unit test that computes the contrast pairs.
- Colour never carries meaning alone: every status also has a label or icon (and shape for machine states).
- Safety colours follow the IEC 60204-1 indicator meanings: red = emergency/alarm, amber = abnormal/attention, blue = action required from the user, green = normal operation, grey = neutral/off.

### Type

System font stacks with `font-variant-numeric: tabular-nums` on every numeric display ([decision 8](#decisions)): `--font-ui` (system-ui), `--font-mono` (ui-monospace) for gCode, ids in formulas and the [DRO](../glossary.md).

| Token              | Size / line height     | Use                                   |
| ------------------ | ---------------------- | ------------------------------------- |
| `--text-xs`        | 0.75 rem / 1rem        | Badges, unit suffixes, status bar     |
| `--text-sm`        | 0.8125 rem / 1.125 rem | Hints, inline messages, tooltips      |
| `--text-md` (base) | 0.875 rem / 1.25 rem   | Body, inputs, buttons (14 px at 100%) |
| `--text-lg`        | 1 rem / 1.5 rem        | Panel and dialog titles               |
| `--text-xl`        | 1.25 rem / 1.75 rem    | Empty-state titles, run progress      |
| `--text-dro`       | 1.75 rem / 2 rem, mono | DRO axis values                       |

Weights: `--weight-regular` 400, `--weight-medium` 500 (labels, buttons), `--weight-bold` 600 (titles). No italics for emphasis in messages.

### Spacing, radii, sizes

- Spacing on a 4 px grid: `--space-1` 0.25 rem, `-2` 0.5, `-3` 0.75, `-4` 1, `-6` 1.5, `-8` 2 rem. Component padding uses `-2`/`-3`; between panel sections `-4`.
- Radii: `--radius-sm` 4 px (inputs, buttons), `--radius-md` 6 px (popovers, cards), `--radius-lg` 10 px (dialogs), `--radius-full` (pills, status chips).
- Control heights: `--control-sm` 1.5 rem (dense tables), `--control-md` 2 rem (default), `--control-lg` 2.75 rem (run-mode controls). Default controls are 32 px high (`--control-md` 2 rem); pointer targets are ≥ 24 × 24 px everywhere (WCAG 2.2 target size) and ≥ 44 × 44 px in run mode ([decision 9](#decisions)), which may be used on a shop touchscreen.

### Elevation

| Token           | Use                                | Light                | Dark                                               |
| --------------- | ---------------------------------- | -------------------- | -------------------------------------------------- |
| `--elevation-0` | Panels (flat, bordered)            | none                 | none                                               |
| `--elevation-1` | Floating viewport toolbars, toasts | small shadow         | lighter surface + border                           |
| `--elevation-2` | Popovers, menus, tooltips          | medium shadow        | `--color-surface-raised` + `--color-border-strong` |
| `--elevation-3` | Dialogs                            | large shadow + scrim | raised surface + scrim                             |

Z-order follows elevation (`--z-toolbar`, `--z-popover`, `--z-dialog`, `--z-toast`); the [global stop control](#run-mode-safety-ui) sits above dialogs (`--z-safety`), so no overlay ever hides it.

### Motion

- Durations `--motion-fast` 100 ms (hover, press), `--motion-base` 150 ms (popovers, panels), `--motion-slow` 250 ms (dialogs, camera view changes); easing `--ease-standard` `cubic-bezier(0.2, 0, 0, 1)`.
- `--delay-indicator` 300 ms: spinners, "Updating…" chips and progress for short work appear only after this delay, so fast work never flickers.
- Motion explains a change (where a panel came from, what moved); nothing loops except progress and the "machine moving" indicator.
- `prefers-reduced-motion: reduce` (and the matching app setting) sets every duration to 0 and replaces camera animations with cuts; progress bars and the moving indicator stay, without animation of their own beyond the value change.

## Components

### Radix wrapping pattern

Per [ADR 0012](../decisions/0012-radix-primitives-own-styles.md): Radix primitives, copied-in wrappers in the shadcn/ui style (we own the code; no shadcn dependency), our tokens.

- Only `src/renderer/src/ui/` imports Radix (`radix-ui` package); an ESLint `no-restricted-imports` rule enforces it like the other [layer boundaries](../decisions/0015-eslint-with-typescript6-api.md). Mode screens use `ui/` components.
- Each wrapper exposes a **small, typed API**: our variants (`variant: 'primary' | 'secondary' | 'ghost' | 'danger'`, `size: 'sm' | 'md' | 'lg'`) as props, rendered as `data-variant` / `data-size` attributes and styled in the CSS module. No `className` overrides from screens except layout (margin, grid placement) through a `className` prop that the wrapper appends.
- Style interaction states with Radix's data attributes (`[data-state='open']`, `[data-highlighted]`, `[data-disabled]`) and `:focus-visible`, never with JS-computed classes.
- Keep Radix's accessibility behaviour (focus trap, roving focus, `aria-*`); never re-implement it. Keep `asChild` where composition needs it (e.g. a `Tooltip` around an `IconButton`).
- Portals render into the app root element so they inherit the theme attribute.
- Every icon-only control has an accessible name (`aria-label`) and a tooltip with the same text plus its shortcut.
- Header comment of every wrapper links back to this doc.

### Inventory (v0.1)

**Primitives** (Radix-based, task 3.3):

| Component                                                       | Radix primitive                   | Used for                                                 |
| --------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------- |
| `Button`, `IconButton`                                          | – (`Slot`)                        | All actions                                              |
| `SegmentedControl`                                              | `ToggleGroup`                     | Mode switcher, view presets, unit-system toggle          |
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
| `Field`                                                                                                   | 3.3      | Label (+ `Term`), control, hint, recommended range, inline message; wires `aria-describedby`.                                |
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

A dev-only **gallery** screen renders every `ui/` component in every variant and state in both themes; it is the manual review surface and the target of the screenshot test ([testing](#testing)).

## Layout

### App shell

```text
┌ Top bar ─────────────────────────────────────────────────────────────────────┐
│ Project name ● │ [Design | Plan | Run] │ Undo Redo │ … │ Machine state  [STOP] │
├ Left panel ──────┬ Viewport ──────────────────────────────┬ Inspector ────────┤
│ Mode navigator   │ 3D scene, view presets, overlays       │ Selected item:    │
│ (operations,     │                                        │ fields, warnings, │
│  plan order,     │                                        │ illustration,     │
│  machine)        │                                        │ recommended values│
├ Status bar ──────┴────────────────────────────────────────┴───────────────────┤
│ Evaluation · Jobs · Warnings n · Unit system · Saved/unsaved · Agent connected│
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Top bar:** project name with an unsaved-changes dot, mode switcher, undo/redo, and – whenever a machine connection is open – the machine state badge and the [stop control](#run-mode-safety-ui), in every mode.
- **Left panel (navigator):** what the mode is made of. Design: part, stock, operations in design order. Plan: plan picker, plan status, setup, plan operations in machining order. Run: connection, homing, jog, work zero.
- **Viewport:** centre, always present; one react-three-fiber canvas kept alive across modes (no WebGL context churn); the mode decides the scene.
- **Inspector (right):** parameters of the selection, its warnings, the `ParamIllustration`, recommended ranges. In run mode: DRO, run progress, run controls.
- **Status bar:** [evaluation status](#evaluation-status-pending-outdated-failed), [jobs](#jobs-and-progress), warning count (opens the warning list), unit system, save state, agent connection.
- Side panels are resizable and collapsible; layout is per window, kept in app preferences, never in the project. Minimum window 1024 × 640; below 1280 px wide the inspector overlays the viewport instead of shrinking it.
- **Window chrome:** native title bar and native application menu (File, Edit, View, Help) with accelerators that dispatch the same commands as the buttons ([decision 12](#decisions)).

### Mode switching

- Modes are a three-way `SegmentedControl` in the top bar, `Ctrl/Cmd+1/2/3`. The mode is per window.
- Switching is instant and never blocked: jobs, evaluation and a run keep going. Each mode keeps its own selection and camera.
- A mode without its input shows an `EmptyState` instead of disabled controls: Plan without a part ("Design a part first", button to Design); Run without a plan ("Create a plan to run", button to Plan).
- Agents never switch the user's mode or steal focus; their edits appear in place ([undo](#undo-and-redo)).

### Panels and inspectors

- The inspector edits exactly one item: the selection. No selection → part (Design), plan (Plan), connection (Run) summary.
- Fields are grouped by what the user thinks about (Shape, Depth, Corners, Tabs), in the order of the [mode doc's](../modes/design.md#operations-v01) parameter tables; rarely changed groups start collapsed.
- Read-only states (a `finalized` plan, an `inUse` plan) show values as text with a lock icon and the reason as a tooltip with the way out ("Finalized plans are read-only. Set the status to settled design to edit, or duplicate the plan."), not disabled grey inputs.
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

### Errors

How an `AppError` reaching the UI boundary ([boundaries.md](../conventions/error-handling/boundaries.md#entry-points-ui-agent-cli-automation)) is shown:

| Situation                                    | Display                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `issues` with a `path` matching a field      | Inline under that field (`--color-danger`, icon, `aria-invalid`, `aria-describedby`); focus moves to the first invalid field on submit. |
| `issues` without a matching field            | Summary at the top of the form/inspector.                                                                                               |
| `severity` `info` (incl. `op.aborted`)       | Neutral toast or nothing; cancellation is never shown as a failure.                                                                     |
| `severity` `warn` / `error`, no field        | Inline banner in the panel that started the action, with `userMessage` and a retry button if `retryable`.                               |
| `severity` `fatal`, `machine.*` during a run | Blocking dialog (run errors: [run safety](#run-mode-safety-ui)).                                                                        |
| `command.conflict`                           | Not shown for UI sources (never rejected); for queued agent actions see the agent indicator.                                            |

- Message text: the catalogue in `messages/` maps `code` (and issue `rule`) to a friendly sentence with `params` formatted in the project unit system; fallback is the registry's `userMessage` ([codes.ts](../../src/shared/errors/codes.ts)). The developer-facing `message` and the frames are only in an "Details" expander with a "Copy details" button (for bug reports).
- Every message says what happened, why if known, and what to do next.

### Selection and picking

- Click in the viewport selects the operation (or plan operation) owning the clicked surface; the navigator row and inspector follow. Selecting a row selects in the viewport. Hover highlights (`--viewport-hover`) before click. `Escape` clears the selection. Multi-select is later.
- **Pick mode** for surface references (`on`, references in formulas): the field's pick button (or `P` while focused) enters pick mode – crosshair cursor, eligible surfaces (horizontal surfaces of the stock and earlier operations, [design.md](../modes/design.md#positioning-v01)) highlighted, others dimmed, a banner "Pick a surface for _On_ · Esc to cancel". Click picks and returns focus to the field. The same field always offers a dropdown of the eligible surface ids, so picking never needs the mouse.
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

- Undo/redo buttons in the top bar and `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` (also `Ctrl+Y` on Windows/Linux) dispatch `history.undo` / `history.redo` ([commands.md](../architecture/commands.md#undo--redo)). While focus is in a text field, the shortcuts act on the text, not the history.
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
- The run job is shown in run mode and in the top bar, not only in the job list ([run safety](#run-mode-safety-ui)).

### Warnings and DFM

Warnings never block ([design.md](../modes/design.md#dfm-checks), [plan-v0.1.md](../modes/plan-v0.1.md#plan-record), [feeds-speeds.md](../architecture/feeds-speeds.md)).

- **Where:** next to the blamed parameter in the inspector (`parameter`), as a badge on the navigator row (`operation`), as a marker at the operation in the viewport, and in the warning list (status bar count).
- **Severity:** `warning` uses `--color-warning` and a triangle icon; `info` uses `--color-info` and an "i" icon. Never `--color-danger` (that means invalid).
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

- **Always-visible stop:** while a connection is open, the top bar shows the `MachineStateBadge` and a `StopControl` in every mode, above every overlay (`--z-safety`), never inside a scroll area or collapsible panel. Stop = `job.abort` (controlled stop: hold, then reset, [run-v0.1.md](../modes/run-v0.1.md#stop-errors-and-alarms)); colour `--safety-stop`, label "Stop", ≥ 44 px, keyboard reachable, no confirmation. While streaming, a "Feed hold" button sits next to it; "Resume" appears only while held. The immediate `run.machine.reset` lives in run mode's controls as "Reset (immediate)".
- **Shortcuts** ([decision 11](#decisions)): `Escape` triggers feed hold whenever a job is streaming, wherever the focus is (it also closes the top overlay); resume and continue are never bound to a single key.
- **Machine state colours and shapes** (GRBL states, [grbl.md](../architecture/grbl.md#state-machine), and run phases):

| State / phase                                          | Token              | Badge                                                  |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------------ |
| Disconnected                                           | `--safety-offline` | Grey, hollow circle, "Not connected"                   |
| Idle (homed)                                           | `--safety-idle`    | Neutral, filled circle, "Idle"                         |
| Run, Jog, Home (`streaming`)                           | `--safety-moving`  | Green, animated ring, "Running" / "Jogging" / "Homing" |
| Hold, Door, `programPause`                             | `--safety-hold`    | Amber, pause bars, "Feed hold" / "Paused (M0)"         |
| `toolChange`                                           | `--safety-action`  | Blue, hand icon, "Tool change: action needed"          |
| Alarm, `failed` (`machine.alarm`/`error`/`connection`) | `--safety-alarm`   | Red, octagon, "Alarm 2: soft limit"                    |

- **Virtual machine label:** a persistent "Virtual machine · 10×" chip next to the badge, so nobody mistakes a simulation for a real machine or vice versa.
- **Errors during a run** open a blocking dialog with GRBL's message, the line number, what DFYOM did (held and reset), and what to do next (home again, check work zero); also announced assertively to screen readers.
- **Tool change** (`ToolChangeDialog`): step list (raise, change to _tool 2: 6 mm end mill_, set Z zero, continue), jog and work-zero controls inside the dialog, "Continue" as the only primary action; it can be dismissed to the inspector without continuing.
- **DRO:** work and machine coordinates per axis, mono tabular digits, units of the project; work zero shown in the viewport with the tool marker at `wpos`.
- **Progress:** lines done/total, current section label, elapsed time, the toolpath played back in the viewport with the done part dimmed.
- **Disabled controls explain why:** jog in Alarm says "Home the machine first" (from `run.state` data), rather than doing nothing.

## Accessibility

Target: **WCAG 2.2 AA** for all non-3D UI; the 3D viewport has a non-visual equivalent for every task.

- **Keyboard:** every action is reachable by keyboard; tab order follows the visual order; `F6`/`Shift+F6` cycle shell regions (top bar, navigator, viewport, inspector, status bar); `?` opens the shortcut list. Shortcuts never fire while typing in a field, except feed hold.
- **Focus:** visible `:focus-visible` ring (2 px `--color-focus`, 2 px offset, ≥ 3:1 against both neighbours); focus returns to the trigger when a popover or dialog closes; never `outline: none` without a replacement.
- **Contrast:** as in [colour](#colour); checked by the token unit test and axe in component tests.
- **Reduced motion:** as in [motion](#motion); also an app setting independent of the OS.
- **Screen readers:**
  - Landmarks: `banner` (top bar), `navigation` (mode switcher, navigator), `main` (viewport region with an `aria-label` and a text summary: "Part with 4 operations, 2 warnings"), `complementary` (inspector), `contentinfo` (status bar).
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
- Own icons for CNC concepts the set lacks (facing, pocket, drilling, profile, tabs, tool types, machine states, work zero) in `ui/icons/`, drawn on the same 24 px grid and stroke width.
- Sizes `--icon-sm` 16 px (inline, status bar), `--icon-md` 20 px (buttons), `--icon-lg` 24 px (run controls). Icons inherit `currentColor`.
- An icon never stands alone without an accessible name; icon-only buttons have a tooltip.

## Testing

Extends [testing.md](testing.md) (component and end-to-end rows).

- **Component tests** ([decision 14](#decisions)): Vitest + Testing Library (`@testing-library/react`, `user-event`) in jsdom, colocated `*.test.tsx`. Query by role and accessible name (this doubles as an accessibility check); `data-testid` only for the canvas. Each `ui/` component and app component gets an axe check (`axe-core`, MPL-2.0).
- What to test: `QuantityInput` behaviour per rule above (echo, timing, commit/revert, hints, steppers); error mapping from `AppError` fixtures; confirmation policy; keyboard paths (mode switch, F6, feed hold); stop control visible in every mode with an open connection.
- **Viewport:** WebGL does not run in jsdom. Keep picking, highlighting and scene building in pure functions (unit-tested); the canvas is covered by the end-to-end tests.
- **Tokens:** a unit test parses `tokens.css` and checks that both themes define every semantic token and that the listed contrast pairs meet AA.
- **Smoke test (task 0.9):** Playwright for Electron launches the built app, checks the window opens without console errors, switches the three modes, opens the gallery in both themes for screenshot comparison, and loads the packaged worker chunk ([v0.1 plan known issue](../plans/v0.1.md#known-issues-and-risks)).
- **End-to-end (task 3.11):** the exit-criteria flow driven through the UI by roles and labels, mirrored by the headless MCP flow.
