# Dogfood script: the v0.4 lid in the installed app

Status: draft (hardening [I1](../plans/hardening.md#2-dogfood-intake), 2026-11-23) · Part: [v0.4 exit criteria](../plans/v0.4.md#exit-criteria) · Severities: [Q54](../plans/hardening.md#questions-for-the-user) · Automated twin: `e2e/golden-path-v0.4.e2e.ts`, `e2e/run-manual.e2e.ts`

A step-by-step walk through the v0.4 lid golden path in the **installed** app (`~/Applications/DFYOM.app`), for finding what the automated tests can't: wrong numbers, dead ends, slow steps and unclear text. It takes about 45 minutes. Names in **bold** or "quotes" are what the screen shows today; if a name differs, that is a finding too.

## Before you start

- Note the version in the window title ("… — DFYOM 0.0.x"); put it in every report.
- Have the v0.3 enclosure drawing at hand ([assets/enclosure-sections.svg](assets/enclosure-sections.svg) if you don't have your own copy; a published copy of the test fixture, kept identical by a test, so black-box agents can import it too, X2 F9).
- Keep a screenshot shortcut ready (`Cmd+Shift+4`). Note the clock time when something feels slow.
- The machine library may already hold tools and a machine from earlier sessions: reuse them or add the ones below; both paths are worth a look.

## What to watch at every step

| Watch for         | Examples                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| **Wrong numbers** | A size, position, count, depth or time that disagrees with this script, the drawing or your own arithmetic   |
| **Dead ends**     | You can't find the next action, a button is disabled without saying why, Escape or Undo does the wrong thing |
| **Slow steps**    | Anything over ~2 s without a progress indicator, a field that lags while typing, a frozen 3D view            |
| **Unclear text**  | A label, hint or message you had to read twice, jargon, a message that doesn't say what to do next           |
| **Looks**         | Overlap, clipped text, jumping layout, an icon that means two things, dark-theme contrast                    |

## 1. Library: three tools

Toolbar **Library** (`Cmd+Shift+L`) → **Tools** tab → **New tool** for each; open **Details** where a field is not shown; **Add preset** → material **Sheet good**; **Save**.

| Name            | Type          | Geometry                                 | Preset (rpm / feed / plunge / stepdown / stepover) |
| --------------- | ------------- | ---------------------------------------- | -------------------------------------------------- |
| Flat 6          | Flat end mill | Ø 6, flute length 22                     | 18000 / 4800 / 800 / 3 / 3                         |
| Flat 3          | Flat end mill | Ø 3, flute length 12                     | 18000 / 3600 / 300 / 1.5 / 1.2                     |
| Chamfer 90 × 12 | Chamfer mill  | Ø 12, included angle 90°, flute length 8 | 12000 / 3800 / 600                                 |

Watch: **Stickout** (was "Overall length", DF26) and whether the **Details** accordion keeps its open state; hints right under their inputs (DF27); the row stays "Unsaved" until Save.

Optional, for Run later: **Machines** tab → a machine like yours: travel, max feed rates, **Homing corner** (back right for yours), pull-off, soft limits, rigidity **Fixed gantry, solid frame** (DF36).

## 2. New project and the Stock dialog

1. File toolbar (top left) **New project** → name "Enclosure lid" → **Create project**. The **Stock** dialog opens by itself.
2. **Part name** should read "Enclosure lid 1" (DF12). **From library**: "Not selected".
3. **Length (X)** 255, **Width (Y)** 200, **Thickness (Z)** 6; **Material name** "Birch plywood", **Material class** "Sheet good". Check the size icons highlight the right edge (DF11).
4. Optional: **Save to library**, change a size, **Save to library** again → **Save as variant** (named "<parent> · L × W × T").
5. **Create part**. The sidebar's part row reads "Stock: 255 × 200 × 6 …" above the **Operations** header (DF15).

Watch: Enter commits a field and the Apply count; the dialog's focus order; does the library dropdown fill everything you expect?

## 3. The outline

1. Toolbar **Shapes** → **Add shape** → **Import SVG…** → **Import**. The report says "Imported 2 shapes"; close it.
2. Hover the **cavity** row → **Remove cavity**; keep **outline**. **Done**.
3. Navigator **Add** → **Profile**. **Shape**: outline; **Position X** 127.498, **Position Y** 100.006 (the drawing centred on the board); **Side** Outside; **Slot width** 6; **Tab count** 6, **Tab width** 6, **Tab thickness** 2.
4. Expect the note "2 of 6 tabs moved off sides where the slot leaves no stock beyond the cut."

Watch: the Add menu's tooltips (DF18); does the outline land centred on the board; tab markers where you'd expect them.

## 4. Bolt holes, Clones and the cutout

All positions are from the board's lower-left corner on the top face (mm).

1. **Add** → **Bolt hole**. **Centre X** 39, **Centre Y** 55.7; type **Countersink**; **Size** M3. The section reads "Ø 3.4 mm through; countersink Ø 7.12 mm, 90°"; the row "Bolt hole 1, M3 countersink".
2. Right-click the row (or its … button, or `Shift+F10`) → **Make Clones…**. **Add row** → **Grid**, **Remove row 1** (the default offset row); **Columns** 2, **Rows** 2, **Column spacing (X)** 177, **Row spacing (Y)** 88.6. Readout: "1 + 3 clones = 4 instances · 0 skipped". **Make clones** → "Clones 1, ×4".
3. **Add** → **Profile**. **Shape** Circle; **Position X** 187.5, **Position Y** 100; **Diameter** 22; **Side** Inside; **Slot width** 11; **Tab count** 0.
4. Row menu of Profile 2 → **Chamfer**. **Edge** "Profile 2 · Ø 22"; **Width** 1.5 → **Depth** 1.5 and **Diameter** "Ø 25 mm" follow.
5. **Add** → **Bolt hole**. **Centre X** 205.5, **Centre Y** 100; **Counterbore**; **Size** M3.
6. Its row menu → **Make Clones…** → **Add row** → **Arc**, **Remove row 1**; **Radius** 18, **Centre angle** 180, **Sweep** 360, **Step angle** 60. Readout: "1 + 5 clones = 6 instances · 0 skipped" (a full circle doesn't repeat the source). **Make clones** → "Clones 2, ×6".

Optional (DF22): click the stock's top face; the inspector shows "Face: Stock top" with "Add … here" buttons; Add creates on that face. `Alt`+click selects a pocket floor.

Watch: which row is selected after each Add; whether the face stays selected when you expect it to; clone markers in the 3D view; the countersink and counterbore sizes against your M3 screws.

## 5. Vents

1. Toolbar **Shapes** → **Add shape** → **Obround**. **Name** "Vent slot"; **Centre X** 0, **Centre Y** 0; **Length** 30, **Width** 5. `Escape` closes the Shape Editor.
2. **Add** → **Profile**. **Shape** Vent slot; **Position X** 67.5, **Position Y** 70; **Side** Inside; **Slot width** 3; **Tab count** 0.
3. Row menu → **Make Clones…**. Row 1 is already **Offset**: **Count** 6, **Step X** 0, **Step Y** 10 → "1 + 6 clones = 7 instances · 0 skipped". **Make clones**.
4. In the 3D view click the marker of clone 4: it turns skipped, readout "… 6 instances · 1 skipped". **Apply** if the button shows (or wait: auto-apply runs after 10 s, DF28; change it in **Settings**).

## 6. Change the bolt circle to M4

1. Select "Clones 2, ×6", press `→` to open it, select **Bolt hole 2** under its source.
2. **Size** M4. The button reads **Apply 1 change**; press it. All six holes follow; the row says "M4 counterbore".
3. `Cmd+Z` → back to M3 in one step; `Cmd+Shift+Z` → M4 again.
4. Status bar: "Part up to date"; the part has 29 operations.

Watch: the Apply countdown bar; how long the re-evaluation takes; undo granularity.

## 7. Plan

1. `Cmd+2` (Plan). The **Plan the part** card sits over the view (DF29). With an empty machine library it offers **New machine…** (e.g. "Router", travel 800 × 800 × 100, max feeds 5000 / 5000 / 1000, spindle 24000). **Create plan**.
2. One setup "Top G54". Operations tool by tool: Flat 3 (holes, counterbores, vents), Flat 6 (cutout), Chamfer 90 × 12 (countersinks, chamfer), Flat 6 (outline).
3. Select Profile 1: the **Strategy** group shows **Cut depth** linked to **Breakthrough** (DF23); try entering either.
4. Try dragging an operation within its setup (U3).
5. **Generate toolpaths** → "All toolpaths up to date." → **Export gCode…** → the "gCode exported" dialog: "No machine warnings.", the line count, the tool changes.

Watch: tool choices and their "Why this tool"; feeds against what you'd run in plywood; the estimated time; the second Flat 6 tool change (U7: does it bother you?).

## 8. Run on the virtual machine

Manual control first (DF31–DF35):

1. `Cmd+3` (Run). **Plan**: "No plan (manual control)"; **Machine**: your library machine; **Time scale** 1× (to watch homing). **Connect to virtual machine**; the chip reads "Virtual machine · 1×".
2. **Stop** is hollow while nothing moves ("Nothing to stop: the machine is not moving.").
3. **Home**: the spindle moves to the home corner in the 3D view; the DRO reads −1 / −1 / −1 with a 1 mm pull-off; the travel box and home marker are drawn.
4. Jog **0.1 mm** **X+** ten times quickly → X 0.000; one more → "X would leave the travel: max 0.000 mm, …". The jog pad must not move under your pointer.
5. Jog with **100 mm** / **10 mm** steps to the stock's lower-left corner and down; **Zero X Y Z**. **Disconnect**.

Then the program:

6. **Plan**: Plan 1. **Connect to virtual machine** (pick **Max** to save time), **Home**, jog and **Zero X Y Z** again.
7. **Start run** → "Start run?" names the machine → **Start run**. At each "Tool change n" dialog read the steps, then **Continue** (three or four times).
8. Once while it runs: `Escape` (feed hold) → **Resume**.
9. Expect "Run complete: N lines in …" with N the export's line count. **Disconnect**.

Watch: does the tool marker and work zero sit where the stock is; are tool-change steps clear enough to follow at a real machine; does anything let you start motion you didn't intend?

## 9. Save, reopen, export again

1. `Cmd+S` → status "Saved". Quit the app.
2. Double-click the `.dfyom` file in Finder (U5): the project opens. Clones 3 still shows instance 4 skipped and clone 7 present.
3. Plan → **Export gCode…** again; the file should be identical to the first export (compare with `diff`).

Optional: **Help → Connect an agent…** (A4): is the `claude mcp add` line ready to paste?

## Sending findings

Send each finding over Telegram, in any form; a short line is enough. Helpful to include:

- **Step** number from this script, what you did, what you expected, what happened.
- **Severity** ([Q54](../plans/hardening.md#questions-for-the-user)): **S1** blocks the path or risks the machine or data · **S2** wrong result or confusing, with a workaround · **S3** polish.
- A **screenshot**; for wrong numbers or toolpaths also the **project file** (`.dfyom`) and the exported `.nc`.
- The app **version** from the title bar.

Each finding becomes an intake row (`DF38`, …) in [hardening.md § Intake](../plans/hardening.md#intake-user-feedback-goes-here); S1 is fixed and installed the same day, S2 in batches, S3 in one design review.
