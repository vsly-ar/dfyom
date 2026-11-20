# 0017 – APCA instead of WCAG 2 contrast ratios for the design tokens

Status: accepted · Date: 2026-11-20

## Context

Task 3.3a checked the design-token colour pairs against WCAG 2 AA ratios (4.5:1 text, 3:1 non-text). The WCAG 2 ratio is known to misjudge dark themes (it overrates light text on dark grey) and mid-tones, and it ignores font size and weight, which matter at our 11–13 px desktop sizes ([ui.md type](../conventions/ui.md#type)). APCA (Accessible Perceptual Contrast Algorithm), the candidate contrast method for WCAG 3, models polarity and spatial frequency and gives targets by use. Options: keep WCAG 2 ratios; check both; switch to APCA.

The reference implementation, the `apca-w3` npm package, is published under the "Limited W3 License", which is not GPL-compatible ([ADR 0014](0014-gpl-3-or-later-license.md)).

## Decision

The user decided: measure contrast with **APCA** (APCA-W3 0.0.98G-4g, signed Lc, foreground on background) with a **target per role** taken from the APCA Bronze readability levels at the sizes and weights the components use ([ui.md colour](../conventions/ui.md#colour)). WCAG 2 ratios are no longer checked.

The formula is implemented in our own small test helper (`src/renderer/src/ui/apca.ts`), from the published constants, and verified against APCA's published reference values; `apca-w3` is not a dependency.

## Consequences

- The UI no longer claims WCAG 2.2 AA conformance for contrast (1.4.3, 1.4.6, 1.4.11); the rest of WCAG 2.2 AA still applies ([ui.md accessibility](../conventions/ui.md#accessibility)).
- APCA is stricter than WCAG 2 for light-on-dark text and small text: re-evaluating the approved tokens fails more pairs in the dark theme (secondary text, control outlines, danger text, safety badges) and Feed hold in both themes. They are pinned with `it.fails` and tracked in the [v0.1 plan known issues](../plans/v0.1.md#known-issues-and-risks); colour values change only after the user decides.
- APCA is still a draft and may change before WCAG 3; a new constant set means updating `apca.ts` and the role targets together.
- Our text is below the font minimums Bronze attaches to its levels, so the targets are floors, not comfort levels.
