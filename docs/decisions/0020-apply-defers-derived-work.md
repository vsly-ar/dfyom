# 0020 – Apply defers decision-making and expensive derived work

Status: accepted · Date: 2026-11-22 · Spec: [apply.md](../architecture/apply.md) · Decisions: D13 (concept), D14 and D16 (details), D18 (accepted with the v0.2 review)

## Context

In v0.1 every edit commits at once and everything derived from it follows inside the same command or right after it: the mesh (debounced), parameter DFM checks, and the draft plan auto-rebuild as a [document hook](../architecture/commands.md#document-hooks). v0.2 adds an automatic tool choice per operation ([design-v0.2.md](../modes/design-v0.2.md#auto-choice)) and setup derivation in plans ([plan-v0.2.md](../modes/plan-v0.2.md)). Running these on every keystroke or adjust-popover step churns tools and plans through intermediate values, adds undo steps the user did not make (library follow as `system` commands), and makes the most expensive work per commit grow with the project.

The user asked (D13) for Enter to confirm changes, possibly over several fields, and trigger automation, verification, planning and expensive work, with a button at the top right that shows unapplied changes, applies them and explains the concept.

Options considered:

1. **Edits stay local to the field until Apply.** Nothing reaches the document before Enter; undo, agents and the viewport see only applied values.
2. **Everything stays immediate; Enter only confirms the field.** No pending state; the tool choice and plan rebuild run per commit.
3. **Edits commit live; derived work that decides something or is expensive waits for Apply.**

## Decision

Option 3, as specified in [apply.md](../architecture/apply.md):

- Edits commit live (one undo step each; preview, field validation and live DFM follow). Reactions are classified **instant** (decides nothing, within the interactive budget) or **deferred** (changes the document on the user's behalf, or exceeds the budget). Deferred work runs once per Apply as apply hooks (document) and apply jobs (caches).
- Apply is its own undo entry; pending changes are changed fields since the last Apply, by value, measured against an apply marker in the history.
- Save, export, run start and plan creation apply implicitly; mode switches do not.
- Agents auto-apply per call by default (`apply: false` batches), so most agent calls behave as in v0.1.
- The nine detail choices are recorded as [apply.md § Decisions](../architecture/apply.md#decisions).

## Consequences

- The tool choice and draft plans follow the confirmed design, not every intermediate value; undoing an Apply rejects an automatic tool swap or plan update without losing the typed values.
- The preview stays live, so DFM-first feedback is unchanged; only checks against an unlocked tool are marked "may change on Apply".
- A new concept for users (pending changes, the "Apply N" button and its tooltip) and for code: a pending set, apply markers on history entries, `ApplyHook`, `applyFirst` on commands and `pendingApply` flags on queries.
- The draft plan auto-rebuild hook is removed. Headless tests and agents that relied on an instant rebuild change behaviour where they batch with `apply: false` (task P2 updates them).
- Every new automatic reaction must be classified in apply.md's table when it is designed.
- Option 1 was rejected because undo, agents and the viewport would see two versions of the document; option 2 because it keeps the churn and the unasked undo steps D13 set out to remove.
