# View cube

Status: implemented (backlog B25; the user confirmed the recommendations on 2026-11-22, D27; built in v0.3 task L2, [§ As built](#as-built-task-l2); look approved in L3, D33, with a gap added below the cube) · Viewport: [ui.md § Viewport](ui.md#viewport-task-35), [§ Selection and picking](ui.md#selection-and-picking) · Face frames: [design-v0.2.md § Face frame](../modes/design-v0.2.md#face-frame) · Setups: [plan-v0.2.md](../modes/plan-v0.2.md#setups-from-face-directions) · Terms: [glossary.md](../glossary.md)

The user's request (B25): a chamfered 3D cube with named clickable faces that rotates the view to that face, replacing the Top / Front / Right view icons of the viewport toolbar, keeping the view hotkeys.

Before L2 the floating viewport toolbar held Top, Front, Right, Iso and Fit (keys `1`–`4`, `F`); the cube replaces the four view buttons.

## Decisions (confirmed, D27)

1. **C1 – The cube replaces Top, Front, Right and Iso.** It sits at the viewport's top right, where the toolbar is now. Below it a small floating toolbar keeps **Fit** (`F`) and adds a **Views** menu button (the keyboard and screen-reader equivalent, [Accessibility](#accessibility)).
2. **C2 – 26 clickable regions.** 6 faces, 12 edge chamfers and 8 corner chamfers, as in common CAD view cubes. A face looks straight at it; an edge looks from the bisector of its two faces (45°); a corner looks from its three faces (isometric). The front-right-top corner is today's Iso (`[1, −1, 1]`).
3. **C3 – Each face view shows that face in its face frame.** Looking at a face puts its [face frame](../modes/design-v0.2.md#face-frame) `u` to the right and `v` up on screen, so `[u, v]` positions and the face-frame axes read directly: sides with Z up, Top with Y up (as today), **Bottom with −Y up** (the part rolled over the X axis, design-v0.2 decision 7). Today's Top tilt away from the pole (`1e-3`) applies to Bottom too.
4. **C4 – Fit as today.** A click looks from the region's direction and fits the part, like the presets (`fitPose`); clicking the face already in view does nothing.
5. **C5 – Drag on the cube orbits** like the default left-drag in the viewport, whatever the mouse preset; a click is a press and release within 4 px, as in the viewport.
6. **C6 – Hotkeys kept and extended.** `1` Top, `2` Front, `3` Right, `4` Iso, `F` Fit stay. New: `Shift+1` Bottom, `Shift+2` Back, `Shift+3` Left (the opposite faces), matched on `KeyboardEvent.code` (`Digit1`…) because `Shift+1` types `!` on many layouts. They act while the viewport region or its toolbars have focus, never while typing in a field.
7. **C7 – Part frame in every mode.** Face names are the part's (Top = `+z`, Front = `−y`, … as the `on` dropdown and setup names say: Top, Bottom, Front, Right, Back, Left). In Plan and Run the up face of the window's setup carries a small spindle glyph, and clicking it looks down the spindle axis with the setup's rotation applied, so the screen matches the operator's view of the machine table (WCS X right) ([Q3](#questions-for-the-user)).

## Look

Neutral chrome, sparse accent ([ui.md decision 18](ui.md#decisions)); every colour is a token read with `useTokens`, so both themes and theme changes need no extra code.

| Element                   | Token / value                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Size                      | 5.5 rem (88 px at 100 %); chamfer 18 % of the edge, so edge strips and corner triangles stay visible                                                      |
| Faces                     | `--bg-raised`, opaque, flat shading with a slight lightness step per face orientation so the cube reads as 3D                                             |
| Edges and chamfer borders | `--border-control` hairlines (mark target on `--bg-raised` and `--bg-viewport`)                                                                           |
| Face labels               | "Top", "Front", … (title case, as elsewhere), `--text`, `--weight-medium`, sized to fit the face; turned away faces hidden                                |
| Hover                     | `--bg-hover` on the hovered region, label unchanged; a tooltip with its name and shortcut ("Front · 2", "Top front right corner") after `--delay-tooltip` |
| Current view              | When the camera looks exactly along a region's direction, that region gets an amber hairline outline (`--accent`): the active state, never a fill         |
| Axis triad                | Short X, Y, Z arrows at the cube's front-left-top corner (part zero), `--vp-axis-x/y/z`, with letter labels                                               |
| Setup glyph (Plan, Run)   | `--text-muted` spindle arrow on the setup's up face                                                                                                       |

## Motion

- The cube turns with the camera in lockstep (it renders the camera's rotation), during orbit and during view changes alike.
- A click animates the camera over `--motion-slow` (280 ms) with `--ease-standard`, as presets do now; hover tints over `--motion-fast`.
- Reduced motion (OS or [setting](ui.md#settings)): the camera cuts to the view, the cube follows at once, hover changes instantly ([ui.md § Motion](ui.md#motion)).

## Rendering

In the one viewport canvas ([ADR 0010](../decisions/0010-react-three-fiber-viewport.md): no second WebGL context), as a HUD layer with its own orthographic camera in the corner (drei's `GizmoHelper` pattern), with our own chamfered geometry and label textures drawn from tokens. It renders with the demand frame loop (only when the camera or a token changes) and takes pointer events only inside its own square, so clicks next to it still select in the scene.

- In narrow windows the inspector overlay covers the viewport's right edge ([ui.md § App shell](ui.md#app-shell)); while it is open the cube and its toolbar move left beside it (`--motion-base`).
- The pick-mode banner stays top centre; the cube keeps working in pick mode (looking at a face to pick it).

## Accessibility

- The canvas cube is a pointer convenience and is `aria-hidden`; every view it offers is in the **Views** menu (the `Menu` component of `ui/`): Top `1`, Front `2`, Right `3`, Iso `4`, Bottom `Shift+1`, Back `Shift+2`, Left `Shift+3`, and in Plan and Run "Setup view" for the window's setup. The menu and Fit are in the viewport toolbar's roving focus; the hotkeys work as today.
- The edge and corner regions are smaller than 24 × 24 px; WCAG 2.2 target size allows this because each has an equivalent control (the menu or a hotkey) that meets it.
- The viewport's text summary ends with the current view ("View: Front", "View: custom") and announces a change politely, so screen readers know where the camera looks.
- The shortcut list ([ui.md § Keyboard shortcuts](ui.md#keyboard-shortcuts)) gains the `Shift+1/2/3` views.

## Testing

Pure parts unit-tested like `camera.ts` today: region → direction and screen-up per face (the face-frame rule C3 for all six faces), hotkeys by `code`, hit-testing of the 26 regions; `Viewport.test.tsx` checks the Views menu and its names with axe; the gallery shows the cube in both themes.

## As built (task L2)

- **Code:** `viewport/view-cube.ts` (pure: the 26 regions, `regionView` with the face-frame up of C3, `setupView`, `cameraDirection` with the pole tilt, `shownView` / `regionAlong`, `regionPolygon`, `regionColour`, `inCubeBox`), `viewport/ViewCube.tsx` (the HUD: drei `Hud` with an orthographic camera in px, one mesh per region, label and letter textures drawn on a 2D canvas from tokens, `--border-control` hairlines, the amber outline, the triad), `Viewport.tsx` (Fit and Views toolbar, tooltip, clicks, hotkeys, summary), `viewportKey` in `camera.ts` (`Shift+Digit1/2/3` by `code`). Names are in `messages/viewport.ts`.
- **Size:** the square is `CUBE_BOX_PX` 88 px; the cube's half edge is 28 px (edge 56 px, faces 36 px), so the chamfered silhouette (radius ≈ 1.35 × the half edge) stays inside it. Labels share one font size, the largest at which "Bottom" fits. The flat shading is a mix towards black of up to 20 % by the angle to a light from the front-right-top, so the top is lightest and the bottom darkest.
- **Current view:** the amber outline marks the region the camera looks along within 0.5° (roll ignored, so a turned Top view still marks Top). The summary names a view only when the roll matches too (within 1°): "View: Front", "View: Top front right corner", "View: Setup view" (a setup view equal to a region's view, an unrotated top setup, is named by the region), else "View: custom". A second `aria-live="polite"` paragraph carries the same text, so only view changes are announced. A click on a region whose view is already shown does nothing (C4).
- **Setup (C7):** the window's setup is `run.frame` (Plan and Run pass it, [ui.md § Viewport](ui.md#viewport-task-35)). Its up face shows the spindle pictogram (spindle nose, tool, the face line) under the label; a click there, or "Setup view" in the menu, looks down `frame.n` with `frame.u` right and `frame.v` up. Top and bottom setups get every rotation through the pole tilt (camera up stays +Z); a side setup turned 90/180/270° needs a horizontal screen up, so its setup view sets the camera's up to `frame.v` (camera-controls `updateCameraUp`), and orbiting then turns about that axis until the next view command, which restores +Z. The tooltip there reads "Setup view · Top up to the spindle", without a shortcut.
- **Pointer:** a press inside the square (`inCubeBox`) sets the default left-drag orbit for that press whatever the mouse preset (C5); an invisible plane fills the square, so clicks in its corners never reach the scene. Hover tints the region with `--bg-hover` over `--motion-fast` (frame-driven, instant under reduced motion); the tooltip (`Tooltip`, controlled, anchored to the square, opening to its left) follows after `--delay-tooltip` and hides while a button is held.
- **Motion:** a click goes through the same camera command as the keys (camera-controls' damped transition, as the presets had; a cut under reduced motion). The cube renders the inverse of the camera's rotation every frame. Next to the narrow-window inspector overlay (`insetRight`, measured by `AppShell` with a `ResizeObserver`) the square slides left over `--motion-base` and the toolbar follows with a CSS transition.
- **Toolbar gap (L3-22, D33):** Fit, Views and Measure sit `--space-3` below the cube's square (was `--space-1`, where they touched the cube's lower edge in some views).
- **Triad:** X, Y, Z arrows from the front-left-top corner with letter sprites; hidden while that corner faces away from the camera (from below it would stick out behind the cube).
- **Tests:** `view-cube.test.ts` (regions and names, region → direction and screen up, the face-frame table for all six faces, the setup view for every direction and rotation, the shown view, polygons and ray hit-testing of all 26 regions with three's `Raycaster`, shading, the square), `camera.test.ts` (`Shift+1/2/3` by `code` on several layouts), `Viewport.test.tsx` (toolbar, the Views menu with axe, menu and keys sending the camera, the setup view of a turned side setup), `e2e/view-cube.e2e.ts` (keys, a click on an edge strip, the menu, a click on the face in view, a drag, read from the text summary).

## Questions for the user

Answered on 2026-11-22 (D27): every recommendation below was confirmed and built.

Each with the recommendation this draft assumes.

1. **Iso as a button too, or only the front-right-top corner?** Recommendation: the corner only (plus `4` and the Views menu); the toolbar keeps Fit and Views.
2. **Edges and corners clickable?** Recommendation: yes (C2); 45° and isometric views are the common reason to reach for a cube.
3. **Setup orientation in Plan and Run:** keep the cube in the part frame and mark the setup's up face with "look down the spindle" on click (C7), or turn the whole cube into the setup's frame (machine Top = setup up face)? Recommendation: part frame (C7), so names match faces, `on` targets and setup names everywhere.
4. **Bottom view orientation:** −Y up on screen, matching the bottom face frame (C3)? Recommendation: yes, so positions on the bottom read like the setup sheet.
5. **Step arrows** (small triangles around the cube in a face view to step to the next face, and 90° roll arrows in Top and Bottom)? Recommendation: not in the first version; drag and the 26 regions cover it.
6. **New hotkeys `Shift+1/2/3` for Bottom, Back, Left?** Recommendation: yes (C6).
