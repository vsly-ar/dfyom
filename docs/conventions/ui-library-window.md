# Library window: machines, tools and stock from every mode

Status: accepted (backlog B24; the user confirmed the recommendations on 2026-11-22, D27; not built yet) · Data and commands: [library.md](../architecture/library.md) · UI rules: [ui.md](ui.md) · Apply: [apply.md](../architecture/apply.md) · Tool field: [design-v0.2.md § Operation tool](../modes/design-v0.2.md#operation-tool) · Terms: [glossary.md](../glossary.md)

The user's request (B24): machines, tools and stock libraries reachable from the toolbar in all modes; today tools are created through Plan's "New tool…". This doc drafts the UI; the data model, storage and commands stay as in [library.md](../architecture/library.md). Nothing here is implemented.

## Today

| Where                                                                                      | What it can do                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Design stock setup ([design.md § Design UI](../modes/design.md#design-ui-task-36))         | Pick a block from the library or add one (`library.stock.add`), only before the part exists                       |
| Plan inspector, tool picker ([ui.md § Plan mode](ui.md#plan-mode-task-37))                 | "New tool…": `NewToolDialog` adds a tool with the v0.1 fields and assigns it                                      |
| Plan navigator and plan header                                                             | "New machine…": `NewMachineDialog` adds a machine                                                                 |
| Design tool field ([ui.md § Design and plan controls](ui.md#design-and-plan-controls-v02)) | Lists fitting library tools; cannot add one (`dfm.toolNotInLibrary` says "add one to the library" with no action) |
| Nowhere                                                                                    | Browse, edit, duplicate or remove items; cutting presets; stickout, shank, coating, notes                         |

The commands exist ([library.md § Storage](../architecture/library.md#storage)): `library.{stock,tool,machine}.{add,update,remove}` and `.get`/`.list`, effect commands (written at once, **not undoable**), run by the app-scope dispatcher with or without an open project. Agents already have full access; this is a UI gap only ([principle 1](../principles.md#1-llm-first) holds).

## Decisions (assumed)

1. **L1 – One Library window per app instance.** A separate native window, not a dialog or a panel: the library is global app data shared by every project and window, it stays open beside a project in any mode (edit a tool while the plan inspector shows the effect), and it works without a project. Opening it again focuses the existing window. Its bounds are remembered like project windows ([ui.md § Remembered window state](ui.md#remembered-window-state-and-dialog-folders)); e2e launches it hidden like every window.
2. **L2 – Entry points.** A "Library" button (icon + label, Lucide `library`) in the main toolbar's end column before "Settings", in Design, Plan and Run and in a window without a project; the native menu gets Window → Library (`Ctrl/Cmd+Shift+L`). Context links open the window on the right tab with an item selected: "Edit in library" beside a plan operation's tool and the plan's machine, "Open library" from the stock setup.
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
│ ⌀ Drill 1/4        1/4"   2         │ Cutting   Presets (table per material)│
│ …                                   │ Notes                                  │
│                                     │ [Duplicate] [Remove…]  [Revert] [Save]│
├ Status: 14 tools · 1 unreadable file ┴───────────────────────────────────────┤
```

- **Tabs** (`Tabs` of `ui/`): Machines, Tools, Stock, in the user's order; workholding joins later. The last tab is remembered per instance.
- **Item list:** a sortable table per kind with search by name and notes. Tools: type icon (own [tool icons](ui.md#icons)), name, Ø, corner radius, flutes, flute length, preset count, filter by type. Machines: name, controller, travel X × Y × Z, spindle. Stock: name, shape, L × W × T, material. A row used by the opening window's project (a snapshot's `libraryItemId`) has a "Used in this project" chip; an item file that does not load is listed with its error and cannot be edited ([library.md § Storage](../architecture/library.md#storage)).
- **Item editor:** every field of [library.md](../architecture/library.md) for the kind, not only the v0.1 subset of the quick dialogs, grouped (Tool: Geometry, Cutting, Presets, Notes; Machine: Travel, Feed rates, Spindle, Controller; Stock: Size, Material). Each field has its [illustration](ui.md#field); the tool geometry group shows a tool drawing with the focused dimension (DC, LCF, OAL, RE, SIG, stickout) as the amber line ([principle 5](../principles.md#5-user-friendly-beginner-friendly-highly-graphical)). Presets are an editable table (name, material class, spindle speed, feed, plunge, stepdown, stepover) with chip load shown, derived.
- **Actions:** "New <kind>" (primary, amber icon) starts an unsaved item with the quick dialog's defaults; Duplicate adds a copy named "Flat 6 copy"; "Remove…" opens a `ConfirmDialog` ("Remove Flat 6 from the library? Projects keep their copies.", destructive button "Remove tool") and sends `confirm: true` ([ui.md § Confirmations](ui.md#confirmations)).

## Behaviour with projects

- A saved library change reaches projects through the existing paths only: the instant library DFM checks re-run, design tool candidates re-read, specific tool and stock snapshots show "library changed" with "Update from library" (`design.snapshot.update`, `plan.libraryItem.update`), and copies held by `draft` plans become [pending](../architecture/apply.md#what-is-pending) and follow on the next Apply. The window itself never changes a project.
- **Conflicts:** a save whose `revision` is stale (another app instance wrote the item) fails with `command.conflict`; the editor keeps the draft and offers "Reload" (discard and show the current item) or "Overwrite" (save again on the new revision).
- **Run safety:** while any machine connection is open, the Library window's toolbar shows the same machine group as the main toolbar (state badge and Stop, [ui.md § Run-mode safety UI](ui.md#run-mode-safety-ui)), so a window in front never hides the stop control.
- **Agents:** nothing new; the window is a client of the library commands. Library edits by agents appear in the open window at once (`Library.subscribe`); an agent's change to the item being edited marks the draft as conflicting.

## Accessibility

Window landmarks: `banner` (toolbar), `navigation` (tabs), `main` (list and editor). The list is a `grid` with row selection by arrow keys; Enter moves focus into the editor; `F6` cycles toolbar, list and editor; every action has a keyboard path and is in the [shortcut list](ui.md#keyboard-shortcuts).

## Questions for the user

Each with the recommendation this draft assumes.

1. **Separate window, modal dialog, or a panel in the project window?** Recommendation: a separate window (L1). A large modal dialog is cheaper to build but blocks the project while open; a panel competes with the navigator and inspector.
2. **Draft and Save, or live commit per field?** Recommendation: draft and Save (L3), because library writes are not undoable and are shared by every project.
3. **Keep the quick "New tool…" / "New machine…" dialogs, and add "New tool…" to the Design tool field?** Recommendation: yes to both (L4), sharing one form component with the window.
4. **Toolbar placement and shortcut:** recommendation: "Library" before "Settings" in the end column, Window → Library, `Ctrl/Cmd+Shift+L` (L2).
5. **Import in scope?** Fusion tool library JSON, FreeCAD tool bits and GRBL `$$` for machines. Recommendation: later, as separate backlog items; the window gets an "Import…" slot in its `⋯` menu when they come.
