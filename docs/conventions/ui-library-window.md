# Library window: machines, tools and stock from every mode

Status: implemented (backlog B24, task L1; the user confirmed the recommendations on 2026-11-22, D27; look approved as built in L3, D33) · Data and commands: [library.md](../architecture/library.md) · UI rules: [ui.md](ui.md) · Apply: [apply.md](../architecture/apply.md) · Tool field: [design-v0.2.md § Operation tool](../modes/design-v0.2.md#operation-tool) · Terms: [glossary.md](../glossary.md)

The user's request (B24): machines, tools and stock libraries reachable from the toolbar in all modes; today tools are created through Plan's "New tool…". This doc specifies the UI; the data model, storage and commands stay as in [library.md](../architecture/library.md). What is built, and where it differs from the sketch, is in [Implementation](#implementation-task-l1).

## Before L1

| Where                                                                                      | What it can do                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Design stock setup ([design.md § Design UI](../modes/design.md#design-ui-task-36))         | Pick a block from the library or add one (`library.stock.add`), only before the part exists                       |
| Plan inspector, tool picker ([ui.md § Plan mode](ui.md#plan-mode-task-37))                 | "New tool…": `NewToolDialog` adds a tool with the v0.1 fields and assigns it                                      |
| Plan navigator and plan header                                                             | "New machine…": `NewMachineDialog` adds a machine                                                                 |
| Design tool field ([ui.md § Design and plan controls](ui.md#design-and-plan-controls-v02)) | Lists fitting library tools; cannot add one (`dfm.toolNotInLibrary` says "add one to the library" with no action) |
| Nowhere                                                                                    | Browse, edit, duplicate or remove items; cutting presets; stickout, shank, coating, notes                         |

The commands exist ([library.md § Storage](../architecture/library.md#storage)): `library.{stock,tool,machine}.{add,update,remove}` and `.get`/`.list`, effect commands (written at once, **not undoable**), run by the app-scope dispatcher with or without an open project. Agents already have full access; this is a UI gap only ([principle 1](../principles.md#1-llm-first) holds).

## Decisions

1. **L1 – One Library window per app instance.** A separate native window, not a dialog or a panel: the library is global app data shared by every project and window, it stays open beside a project in any mode (edit a tool while the plan inspector shows the effect), and it works without a project. Opening it again focuses the existing window. Its bounds are remembered like project windows ([ui.md § Remembered window state](ui.md#remembered-window-state-and-dialog-folders)); e2e launches it hidden like every window.
2. **L2 – Entry points.** A "Library" button (icon + label, the `library` icon of the [own set](ui.md#icons)) in the main toolbar's end column before "Settings", in Design, Plan and Run and in a window without a project; the native menu gets Window → Library (`Ctrl/Cmd+Shift+L`). Context links open the window on the right tab with an item selected: "Edit in library" beside a plan operation's tool and the plan's machine, "Open library" from the stock setup.
3. **L3 – Draft and Save per item.** Library edits are not undoable, so the editor holds a local draft of the selected item: fields validate as they are typed (the [quantity input](ui.md#quantity-and-expression-input) rules), the item row shows "Unsaved", and **Save** (primary, `Ctrl/Cmd+S` or `Ctrl/Cmd+Enter` in this window) sends one `library.<kind>.update` with the read `revision`; **Revert** drops the draft. Switching items or closing the window with a draft asks "Save changes to Flat 6?" (Save / Discard / Cancel). This differs on purpose from project fields, which commit live with undo ([ui.md § Undo and redo](ui.md#undo-and-redo)).
4. **L4 – Quick add stays where the need is.** Plan's "New tool…" and "New machine…" dialogs stay (they add and assign in one step and are covered by the exit-criteria e2e) but reuse the library window's form component. The Design tool field gains "New tool…" at the end of its list, prefilled with the generalized tool it shows (type, diameter, corner radius), and `dfm.toolNotInLibrary` gains the fix "Add to library" opening the same dialog; adding locks the new tool on the operation (`design.operation.tool.set`).
5. **L5 – Units.** Forms show quantities in the unit system of the window that opened the library (its project), else the last used one (a [setting](ui.md#settings)); a mm / inch segmented control in the window toolbar switches it. Stored values keep their `source`, so an item entered in inches still reads `1/4"`.

## Layout

```text
┌ Native title bar: "Library — DFYOM 0.0.70" ──────────────────────────────────┐
├ Toolbar: [Machines | Tools | Stock]   Search…   mm|in   [+ New tool]  ⋯     │
├ Item list ──────────────────────────┬ Item editor ───────────────────────────┤
│ Type ▾  Name        Ø      Flutes   │ Flat 6                  Unsaved       │
│ ⌀ Flat 6           6 mm   2   ●used │ Geometry  (tool drawing: DC LCF OAL)  │
│ ⌀ Drill 1/4        1/4"   2         │ Presets (one block per preset)        │
│ …                                   │ ▸ Details · Carbide (material, notes) │
│                                     │ [Duplicate] [Remove…]  [Revert] [Save]│
├ Status: 14 tools · 1 unreadable file ┴───────────────────────────────────────┤
```

- **Tabs** (`Tabs` of `ui/`): Machines, Tools, Stock, in the user's order; workholding joins later. The last tab is remembered per instance.
- **Item list:** a sortable table per kind with search by name and notes. Tools: type icon (own [tool icons](ui.md#icons)), name, Ø, corner radius, flutes, flute length, preset count, filter by type. Machines: name, controller, travel X × Y × Z, spindle. Stock: name, shape, L × W × T, material. A row used by the opening window's project (a snapshot's `libraryItemId`) has a "Used in this project" chip (in the grid the short "Used" with that tooltip; the editor heading shows it in full); an item file that does not load is listed with its error and cannot be edited ([library.md § Storage](../architecture/library.md#storage)).
- **Item editor:** every field of [library.md](../architecture/library.md) for the kind, not only the v0.1 subset of the quick dialogs, grouped (Tool: Geometry, Presets, and Details collapsed, [§ Tool details](#tool-details-df1); Machine: Travel, Feed rates, Spindle, Controller; Stock: Size, Material). Each field has its [illustration](ui.md#field); the tool geometry group shows a tool drawing with the focused dimension (DC, LCF, OAL, RE, SIG, stickout) as the amber line and, since DF48, a legend under it naming each ISO 13399 symbol it shows ("DC Diameter", "LCF Flute length"); the tool grid's columns fit their headers ("Flute length"; "Corner R" with the tooltip "Corner radius (RE)"), and a new tool's draft row shows its type icon ([principle 5](../principles.md#5-user-friendly-beginner-friendly-highly-graphical)). Presets are an editable list, one stacked block per preset so every value fits the editor at the default window size without sideways scrolling: name, material class and the derived chip load (with remove) above spindle speed, feed, plunge, stepdown and stepover, labelled compactly (Speed, Feed, Plunge; the full name is the tooltip and accessible name) with units inside the inputs. A narrow editor reflows the values into two columns. Without a selection the editor says "Select an item to edit it.", except when the tab's list is empty: the list's empty state already points to "New …", and the editor stays blank.
- **Actions:** "New <kind>" (primary, amber icon) starts an unsaved item with the quick dialog's defaults; Duplicate adds a copy named "Flat 6 copy"; "Remove…" opens a `ConfirmDialog` ("Remove Flat 6 from the library? Projects keep their copies.", destructive button "Remove tool") and sends `confirm: true` ([ui.md § Confirmations](ui.md#confirmations)).
- **Names (DF47, UX audit #13):** a suggested name never repeats one of the kind's other items: the new item's default (a tool's "Flat 6" that follows type and diameter, "My machine", "Block 100 × 60 × 20") and Duplicate's "Flat 6 copy" get the first free " (2)", " (3)" … suffix ("Flat 6 (2)"); the quick "New tool…" dialog reads the library's tools for this too. Names compare trimmed and case-insensitively. Duplicate names stay allowed – items are told apart by id, and two "Flat 6" of different flute count are real – but a typed name that repeats another item's shows a soft warning at Name, "Another tool is already named Flat 6: a different name tells them apart in lists.", and Save still saves.

## Recommended presets

The user approved a "Recommended" flag on presets (D30 item 14); the data rules are in [library.md § Recommended presets](../architecture/library.md#recommended-presets).

- **Checkbox** "Recommended" on its own line at the end of each preset block, followed by a muted note (the checkbox's accessible description): "Follows the calculator for this tool and material, for no particular machine. Editing a value unticks it." While the preset cannot follow, the checkbox is disabled and the note gives the reason: no material class ("Choose a material to follow the calculator."), tool values that do not load ("Fix the tool's values to follow the calculator.") or no calculator data (the calculator's reason, e.g. tool material not set). A `noRecommendation` issue colours the note as an error.
- **Ticked:** the four followed values (speed, feed, plunge, stepdown) change at once to the recommendation in the draft, and follow every later change to the tool's fields; Save stores them (the command recomputes them, so they agree). Typing a different value into one of them unticks the flag and keeps the values (cnc-code made them read-only instead; unticking by editing is the approved "until edited"). Stepover stays editable and unaffected.
- **Look:** the standard `Checkbox` and the muted hint text style; nothing else is accented. The plan inspector's "Cutting preset" list shows "Follows the calculator" as the option's second line (`Select` `description`) under recommended presets, in the tool's order.

## Tool details (DF1)

The user's finding ([hardening.md](../plans/hardening.md) intake DF1): the tool form shows everything at once, so the cutting geometry drowns among rarely changed fields. The full tool form (Library window) keeps the essentials open and moves the secondary fields into one collapsed group:

- **Open:** Name; **Geometry** with the tool drawing (type, diameter, corner radius, angle and tip diameter, flute length, stickout, shank diameter, flute count, point angle); **Presets**.
- **Details** (collapsed): overall length (DF26, with the note "The whole tool, shank included: the stickout must be shorter."), tool material, coating, notes. The library has no manufacturer field; one would go here. Tool material feeds the calculator, so while collapsed the heading shows the filled values in muted text ("Details · Carbide · TiAlN") and a preset's "Recommended" note still names a missing material.
- **Disclosure:** the group heading is a button with a chevron and `aria-expanded`, the pattern of the hole inspector's Defaults group ([ui.md § Features](ui.md#features-v04)). Open or closed is remembered per Library window (its store; not saved between runs) across items and tabs. A field inside with an issue opens the group, so Save's focus on the first invalid field and the issue text are never hidden.
- Tests: `LibraryWindow.test.tsx` (closed with its summary, open with axe, kept across items and tabs); `e2e/library.e2e.ts` opens it (renders `design/features/renders/df1-tool-details-{light,dark}.png`, and `u4-chamfer-mill` regenerated, with `DFYOM_RENDERS=1`).
- The quick "New tool…" dialog is unchanged (its few fields include the tool material, which recommended presets need).
- **Stickout, not overall length** (DF26, user's dogfood finding: "Overall length" read as the length set up in the machine): the length people set is the stickout, so Geometry shows "Stickout" (optional; since DF48 placeholder "Default: 20 mm" with the tool's flute length and note "Length below the collet; empty uses the flute length. Plans may override it."; until then placeholder "Flute length", which read like a value) where the overall length was, and the overall length, which only bounds the stickout, moves into Details. Both are distinct library fields ([library.md](../architecture/library.md#tool)); the data keys (`stickout`, `overallLength`) are unchanged. The quick dialog shows Stickout instead of Overall length ([ui.md § Plan mode](ui.md#plan-mode-task-37), New tool).

## Stock variants (DF13)

Stock items may have variants, one level deep ([library.md § Stock variants](../architecture/library.md#stock-variants-df13)).

- **List:** a variant row follows its parent, its name indented by `--space-4` with a thin branch line, in the parent's position of any sort (the variants of one parent sort among themselves by the same column); a search hit on a variant shows its parent too. The row's accessible name ends with ", variant of Aluminium plate 10".
- **Editor:** a variant's heading has the muted line "Variant of Aluminium plate 10" (a link button that selects the parent). A saved stock's action bar has **New variant** (`add` icon): an unsaved draft with the stock's values, named "Aluminium plate 10 variant", whose parent is the stock (or the variant's parent, so a variant of a variant is a sibling). Duplicate of a variant keeps its parent.
- **Remove:** a stock with variants keeps "Remove…" disabled with the reason "Remove its variants first." as tooltip; the command refuses it as well (`hasVariants`).
- Variants are written by the design Stock dialog's "Save to library" too ([ui.md § Stock dialog](ui.md#stock-dialog-df11df13)); the window shows them at once (`Library.subscribe`).

## Behaviour with projects

- A saved library change reaches projects through the existing paths only: the instant library DFM checks re-run, design tool candidates re-read, specific tool and stock snapshots show "library changed" with "Update from library" (`design.snapshot.update`, `plan.libraryItem.update`), and copies held by `draft` plans become [pending](../architecture/apply.md#what-is-pending) and follow on the next Apply. The window itself never changes a project.
- **Conflicts:** a save whose `revision` is stale (another app instance wrote the item) fails with `command.conflict`; the editor keeps the draft and offers "Reload" (discard and show the current item) or "Overwrite" (save again on the new revision).
- **Run safety:** while any machine connection is open, the Library window's toolbar shows the same machine group as the main toolbar (state badge and Stop, [ui.md § Run-mode safety UI](ui.md#run-mode-safety-ui)), so a window in front never hides the stop control.
- **Agents:** nothing new; the window is a client of the library commands. Library edits by agents appear in the open window at once (`Library.subscribe`); an agent's change to the item being edited marks the draft as conflicting.

## Accessibility

Window landmarks: `banner` (toolbar), `navigation` (tabs), `main` (list and editor). The list is a `grid` with row selection by arrow keys; Enter moves focus into the editor; `F6` cycles toolbar, list and editor; every action has a keyboard path and is in the [shortcut list](ui.md#keyboard-shortcuts).

## Questions for the user (answered)

The user confirmed each recommendation (D27).

1. **Separate window, modal dialog, or a panel in the project window?** Recommendation: a separate window (L1). A large modal dialog is cheaper to build but blocks the project while open; a panel competes with the navigator and inspector.
2. **Draft and Save, or live commit per field?** Recommendation: draft and Save (L3), because library writes are not undoable and are shared by every project.
3. **Keep the quick "New tool…" / "New machine…" dialogs, and add "New tool…" to the Design tool field?** Recommendation: yes to both (L4), sharing one form component with the window.
4. **Toolbar placement and shortcut:** recommendation: "Library" before "Settings" in the end column, Window → Library, `Ctrl/Cmd+Shift+L` (L2).
5. **Import in scope?** Fusion tool library JSON, FreeCAD tool bits and GRBL `$$` for machines. Recommendation: later, as separate backlog items; the window gets an "Import…" slot in its `⋯` menu when they come. GRBL `$$` was approved on 2026-11-22 (D30) and is built as "Import $$…" in the machine editor (see [Implementation](#implementation-task-l1)).

## Implementation (task L1)

- **Window:** the same renderer bundle with `--dfyom-window=library` (`App.tsx` routes on `bridge.windowKind`), made and tracked by `src/main/library-window.ts`; an unbound session (no project), so it calls only the app-scope `library.*` commands. Its bounds are remembered as `libraryWindow` in `app-state.json` ([ui.md § Remembered window state](ui.md#remembered-window-state-and-dialog-folders)); it never cascades a project window. Hidden test runs never show it (`DFYOM_HIDE_WINDOWS=1`, like every window).
- **Context:** main gives the window the context of the window that opened it: project name (only in the "Used in this project" chip's tooltip; the window shows no project name, D45: the library is app-wide), unit system, used item ids (`src/core/library/used.ts`: every snapshot's `libraryItemId`, the design's and each plan's), followed live; the target of a context link selects the tab and item. The last tab is kept for the app instance (not between runs).
- **Units (L5):** the window's mm / in control overrides the project's unit system until the window is opened again from another window; with no project the `libraryUnits` [setting](ui.md#settings) applies, and switching writes it. Saved values keep their `source`; a stored item keeps its own unit system for bare numbers (`itemUnitSystem`), so a value in the other system is shown with its unit written out.
- **Draft (L3):** one draft at a time (the selected item or a new one). Model issues show live under their fields; Save with issues moves focus to the first invalid field. Duplicate starts an unsaved new draft named "<name> copy". A library change from elsewhere refreshes a clean draft and marks a dirty one as conflicting ("changed elsewhere": Reload / Overwrite; "removed": Discard changes / Overwrite, which saves it as a new item). Closing the window or quitting with a draft asks the window first ("Save changes to X?").
- **Toolbar button:** icon-only with its tooltip and shortcut, like Settings beside it (the end column holds icon buttons only), not icon + label as in L2.
- **Tabs:** a custom tablist (left/right arrows) in the `navigation` landmark rather than `ui/Tabs`, so the banner / navigation / main split of [Accessibility](#accessibility) holds. `Ctrl/Cmd+Shift+L` is the native menu accelerator only.
- **Look (2026-11-22 review):** a long item name in the grid ellipsizes with the full name as its tooltip; the "Unsaved" and "Used" chips keep their size, and the name column's minimum width (220 px tools, 180 px machines and stock) leaves the name room beside both. The editor's label column is 156 px (`--field-label-width`, the inspector keeps 124 px) so labels such as "Max spindle speed" stay on one line; acceleration takes its unit in the group heading ("Acceleration (mm/s²)", fields "Acceleration X/Y/Z"). The heading (name and chips) keeps one height with or without chips, the fields scroll below it with a hairline once scrolled, and a focused field stops `--space-4` clear of the heading and the action bar (`scroll-padding`).
- **Tool drawing:** `ToolDrawing.tsx` (flat, ball, bull nose, drill); the dimension of the focused field is amber and named in the image label ("Tool drawing: LCF highlighted"). Presets show the derived chip load (feed ÷ (speed × flutes)) per row.
- **Quick dialogs (L4):** `NewToolDialog` / `NewMachineDialog` use the window's field components (`variant="quick"`); the design tool field's "New tool…" and the `dfm.toolNotInLibrary` fix "Add to library" open `NewToolDialog` prefilled from the generalized tool, and the added tool is locked with `design.operation.tool.set`.
- **Run safety:** the window shows the run mode's `MachineToolbar` (state badge, Stop); its Stop (`job.abort`) is sent to the window's own session, and when that has no run, main aborts the run of the window whose project runs it (`abortElsewhere` in `src/main/ipc.ts`).
- **Import $$… (D30):** the machine editor's action bar has "Import $$…" (`paste` icon), enabled for a saved machine without unsaved changes (else its tooltip says to save first). The dialog has two steps: a monospace text area for the pasted `$$` output and "Compare" (`library.machine.settings.preview`); then the diff: one checkbox row per change ("Max feed rate X · $110 · 3000 mm/min → 5000 mm/min", all ticked), rows of a `together` group tick together, followed by what was skipped with the reason, the unchanged count and the ignored settings. "Apply N changes" sends `library.machine.settings.import` with the ticked settings and shows the stored machine; "Back" returns to the text. It never writes to GRBL ([library.md § GRBL `$$` import](../architecture/library.md#grbl--import)).
- **Motion and drive fields:** the full machine form adds the group "Motion planning" (junction deviation `$11`, arc tolerance `$12`) and "Steps per mm" (X/Y/Z, all three or none, like acceleration).
- **Not built:** the toolbar's `⋯` menu (it would hold the other imports, later backlog items).

| File                                                                    | Contents                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/main/library-window.ts`                                            | The one window: open/focus, context, close and quit with a draft         |
| `src/main/library-context.ts`                                           | Pure parts: project context, open targets, the renderer's reported state |
| `src/core/library/used.ts`                                              | Library item ids a project uses                                          |
| `src/renderer/src/library/library-store.ts`                             | Window state: tabs, listings, the draft, save, conflicts, prompts        |
| `src/renderer/src/library/LibraryWindow.tsx`                            | Layout, keys (F6, Save), the save prompts                                |
| `src/renderer/src/library/ItemTable.tsx`                                | The item grid: sort, search, type filter, chips, keys                    |
| `src/renderer/src/library/ItemEditor.tsx`                               | Editor: forms, conflict alert, actions, Remove confirmation              |
| `src/renderer/src/library/{Tool,Machine,Stock}Fields.tsx`, `fields.tsx` | The forms shared by the window and the quick dialogs                     |
| `src/renderer/src/library/form.ts`                                      | Defaults, names, clean-up and command input of drafts                    |
| `src/renderer/src/library/ToolDrawing.tsx`, `PresetTable.tsx`           | Tool drawing; presets list with chip load and the Recommended checkbox   |
| `src/renderer/src/library/GrblImportDialog.tsx`                         | "Import $$…": paste, diff with checkboxes, apply                         |
| `src/renderer/src/library/LibraryLink.tsx`                              | "Edit in library" / "Open library" context links                         |
