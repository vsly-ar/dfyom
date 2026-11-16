# 0012 – Radix primitives with own styling for UI components

Status: accepted · Date: 2026-11-16

## Context

The UI is form-heavy and highly graphical, with custom quantity inputs, tooltips linking to wiki content and dynamic illustrations ([principles.md §5](../principles.md#5-user-friendly-beginner-friendly-highly-graphical)). Candidates: Radix + own styles, Mantine.

## Decision

Build components on **Radix UI primitives** (accessible, unstyled), copied into the repo in the shadcn/ui style, with **our own design tokens and styles**.

## Consequences

- Full control over the look; no fighting a stock theme.
- More upfront work for basic components.
- Styling approach and tokens: UI guidelines doc (to be written).
