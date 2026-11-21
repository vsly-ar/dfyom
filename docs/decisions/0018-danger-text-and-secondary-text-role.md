# 0018 – Separate red text token and a secondary text role

Status: accepted · Date: 2026-11-21 · Amends: [ADR 0017](0017-apca-contrast-for-design-tokens.md) (role targets and the 2026-11-21 token values)

## Context

After [ADR 0017](0017-apca-contrast-for-design-tokens.md) the token values were adjusted in lightness so every APCA pair met its role target. Two dark-theme colours paid for it:

- `--danger` served both red text (danger button and menu item, danger chip, field error text: Lc 75 read / 60 label) and non-text marks (invalid field outline, viewport error marker, error icons: Lc 30 / 45). Meeting the text targets on dark grey pushed it to a pale pink (`#ef6366` → `#ffcecb`, OKLCH chroma 0.173 → 0.056) that no longer reads as an error colour in outlines and icons.
- `--text-muted` was held to the body-text target (Lc 75), so in dark it rose to `#d1dcda`, nearly as bright as `--text` (`#e9edf3`); the primary/secondary hierarchy disappeared. Muted text is secondary text (labels, hints, notes, ids, descriptions under a title), not body copy.

Options: accept the pale values; lower the danger text targets; split the token; give muted text its own target.

## Decision

The user decided: **split tokens**.

- **`--danger-text`** is the colour for red text and meets the text targets (read 75, label 60); in dark it may stay pale. **`--danger`** is a saturated red again, close to the approved values, for outlines, the viewport error marker, the danger button's hover border, and icons; its pairs take the mark (30) and icon (45) targets. Components use `--danger-text` wherever red is a text colour (including icons that inherit the text colour inside the same element).
- A **secondary** text role at **Lc 60** covers `--text-muted` (11–13 px secondary text). Body copy that people must read uses `--text` (read, Lc 75). `--text-muted` comes back close to its approved values so the hierarchy shows again.

Values and Lc per pair: [ui.md design system](../conventions/ui.md#design-system) and the design page changelog; the pairs are in `src/renderer/src/ui/tokens.test.ts`.

## Consequences

- One more semantic colour token; the red text of a component is a separate decision from its marks, checked by its own pairs.
- Secondary text at Lc 60 is below the Bronze level for regular body text at our sizes; it is acceptable only because it is not body copy. Short descriptions under a title (dialog body, empty state, error details) and read-only field values count as secondary; longer explanatory copy should use `--text`.
- Dark `--danger` is lightened slightly from the approved `#ef6366` (to `#ff7475`) because error icons need Lc 45 on `--bg-chrome`, `--bg-app` and `--danger-subtle`.
