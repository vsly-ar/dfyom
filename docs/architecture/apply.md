# Apply: pending changes and deferred derived work

Status: accepted (user decision D13 of 2026-11-21; details confirmed with the v0.2 review, D18 of 2026-11-22) · Decision: [ADR 0020](../decisions/0020-apply-defers-derived-work.md) · Commands: [commands.md](commands.md) · Workers: [workers.md](workers.md) · Agents: [llm-api.md](llm-api.md) · UI: [ui.md](../conventions/ui.md) · Design: [design-v0.2.md](../modes/design-v0.2.md) · Plan: [plan-v0.1.md](../modes/plan-v0.1.md), [plan-v0.2.md](../modes/plan-v0.2.md) · Terms: [glossary.md](../glossary.md)

Edits commit **live** to the document, as today: one undo step per edit, the viewport follows, and the adjust popover's steps are a live [gesture](commands.md#gestures-live-edits). **Expensive or decision-making derived work waits for Apply**: the automatic tool choice, draft plans following the design and the library, toolpath regeneration, and later verification. The user applies with **Enter** in any field, with **Cmd/Ctrl+Enter**, or with the **"Apply N"** button at the top right of the main toolbar, which shows how many changes are pending. Several fields can be edited (with Tab or a click away) before one Apply. Save, export and starting a run apply first.

The trade-offs are recorded in [ADR 0020](../decisions/0020-apply-defers-derived-work.md). Tasks: [plans/v0.2.md](../plans/v0.2.md#4-apply) P1–P3.

## Decisions

Settled with the user when this doc was accepted (D18, 2026-11-22: 2, 3, 4, 5, 7, 8 as recommended by D14; 1, 6, 9 as taken by D16 for Q18); the sections below specify them.

1. **Mode switches never apply.** Plan shows a pending notice on affected `draft` plans; starting a run applies first ([§ Mode switches](#mode-switches)).
2. **Apply is its own undo entry** ("Apply 3 changes"): undo reverts the automation and keeps the edits pending, the same for the button and for agents ([§ Baseline and undo](#baseline-and-undo)).
3. **The button is hidden when nothing is pending.** An always-shown, disabled "Applied" state only if discoverability suffers in testing ([§ Apply button](#apply-button)).
4. **Toolpaths on Apply:** Apply regenerates stale toolpaths only of plans whose toolpaths the user generated before ([§ Apply jobs](#apply-jobs)).
5. **Draft plans follow library edits on Apply:** a library change is pending in every affected project and applied into its Apply entry; no `system` undo steps the user did not make ([§ Apply hooks](#apply-hooks)).
6. **An agent's auto-apply applies everything** pending in the project, the user's changes included; the button shows "Applied by agent" and the history names the source ([§ Agents](#agents-mcp-and-cli)).
7. **Choice controls and fix buttons commit only;** Enter, Cmd/Ctrl+Enter or the button applies ([§ Keyboard](#keyboard)).
8. **The count counts changed fields since the last Apply, by value** ([§ What is pending](#what-is-pending)).
9. **Parameter and geometry DFM checks stay live,** except rules against an unlocked tool, which show as pending; "verification" in D13 means future expensive checks, which are deferred ([§ Instant and deferred reactions](#instant-and-deferred-reactions)).

## Decision D13

The user's intent (2026-11-21): "cement this concept of using Enter to confirm the changes to trigger some kind of automation, verification, planning or expensive operations. Changes may involve several fields. And add a button to the top-right to indicate such unapplied changes that also applies them and contains a tooltip explaining this concept."

Chosen variant (the alternatives were "edits stay local to the field until Apply" and "everything stays immediate, Enter only confirms"):

| Rule                       | Specified in                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| Edits commit live          | Unchanged: [commands.md](commands.md#dispatcher-pipeline), [gestures](commands.md#gestures-live-edits) |
| Derived work is classified | [Instant and deferred reactions](#instant-and-deferred-reactions)                                      |
| What is pending            | [Pending changes](#pending-changes)                                                                    |
| How Apply runs             | [`project.apply`](#projectapply)                                                                       |
| Agents, MCP, CLI           | [Agents, MCP and CLI](#agents-mcp-and-cli)                                                             |
| Button, keys, fields       | [UI](#ui)                                                                                              |

## Instant and deferred reactions

**Principle:** keep cheap, essential feedback live (geometry preview, field validation, warnings that are part of the preview); defer what is expensive, scales with the project, or **decides something on the user's behalf** (picks a tool, changes a plan). A deferred reaction never runs on a keystroke, a blur or a gesture step; it runs once per Apply over all pending changes.

Costs are measured on the exit-criteria project and the test part (Apple M1 Pro class; [ui.md § Quantity input](../conventions/ui.md#quantity-and-expression-input), [workers.md § Performance budgets](workers.md#performance-budgets), [geometry.md](geometry.md#performance-budgets-v01)).

| Reaction to an edit today                                                                                                         | Where                                                                                                      | Cost                                                                                                                                              | Class                                           | Why                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arg parsing, model invariants, expression and reference resolution                                                                | the command ([pipeline](commands.md#dispatcher-pipeline))                                                  | inside the ~0.4 ms command                                                                                                                        | **instant**                                     | Field validation: an invalid value never commits. Essential.                                                                                                                                                               |
| Commit, patches, replicas, action log, working-folder write (debounced ~500 ms)                                                   | dispatcher, [persistence.md](persistence.md#working-folder-writes)                                         | sub-ms; write off-queue                                                                                                                           | **instant**                                     | This _is_ the live edit; crash recovery must hold pending edits too.                                                                                                                                                       |
| Live outline of the edited operation                                                                                              | renderer ([ui.md](../conventions/ui.md#evaluation-status-pending-outdated-failed))                         | no worker                                                                                                                                         | **instant**                                     | Cheapest preview.                                                                                                                                                                                                          |
| Part evaluation: mesh ([`EvaluationScheduler`](workers.md#automatic-evaluation-after-design-edits))                               | geometry worker, 200 ms trailing debounce, aborts on a newer input                                         | 16.8 ms warm, 232 ms stress part; edit → mesh 224 ms                                                                                              | **instant** (debounced)                         | The geometry preview is the essential feedback of DFM-first design; it is already coalesced and off the UI thread, and decides nothing.                                                                                    |
| Geometry DFM checks (`dfm.loosePiece`, `dfm.retainedRemoved`, `dfm.surfaceMissing`)                                               | same evaluation run                                                                                        | included in the evaluation (no extra run)                                                                                                         | **instant** (with the mesh)                     | Free once the mesh exists; hiding results already computed would only delay feedback. Future checks above the evaluation budget are deferred ([rule](#rules-for-new-reactions)).                                           |
| Parameter and library DFM checks (`parameterChecks`: corner vs library tools, holes, slots, tabs; v0.2 `dfm.reach`, `dfm.setups`) | the command result and `design.warning.list` ([design.md](../modes/design.md#dfm-warnings-task-28-wiring)) | synchronous, part of the ~3.5 ms design step                                                                                                      | **instant**                                     | They are field-level validation ("radius below every end mill") and cheap.                                                                                                                                                 |
| v0.2 checks against the operation's **own unlocked** tool (`dfm.toolUnfit`, `dfm.toolNotInLibrary`)                               | same                                                                                                       | same                                                                                                                                              | **instant, marked pending**                     | Computed live, but Apply may swap the tool and clear them, so they show as "may change on Apply" until then ([stale display](#stale-derived-results)). Against a **locked** tool they are final and shown normally.        |
| v0.2 **automatic tool choice** ([design-v0.2.md § Auto choice](../modes/design-v0.2.md#auto-choice))                              | today: "inside the edit command" (placeholder)                                                             | library scan per operation (cheap)                                                                                                                | **deferred**                                    | Decision-making: it swaps a tool and takes a snapshot. Choosing on every keystroke or popover step churns tools through intermediate values ([design-v0.2.md decision 13](../modes/design-v0.2.md#decisions)).             |
| **Draft plan auto-rebuild** (`plan.draftAutoRebuild` [hook](commands.md#document-hooks))                                          | document hook on every `design.*` commit                                                                   | ~3 ms of the 3.5 ms design step on the exit-criteria project; grows with draft plans × operations; v0.2 adds tool resolution and setup derivation | **deferred**                                    | Decision-making (adds plan operations, suggests tools, repairs the order, re-derives setups) and the most expensive per-commit work. Plans are downstream: they follow the confirmed design, not every intermediate value. |
| **Draft library follow** (`followLibraryChanges`, source `system`)                                                                | app host, on every library change, one command per changed copy                                            | one command per copy per open project                                                                                                             | **deferred** ([decision 5](#decisions))         | Decision-making (replaces plan copies, may block), and today it adds `system` undo steps the user did not ask for. Under Apply it joins the Apply entry.                                                                   |
| Plan stale detection (`plan.stale.list`: `changedInDesign`, `libraryChanged`, …)                                                  | derived on read                                                                                            | deep compare, per query                                                                                                                           | **instant**                                     | Read-only information, decides nothing; gains a `pendingApply` flag ([below](#queries-for-pending-state)).                                                                                                                 |
| Plan statuses and explicit transitions (incl. "into `draft` rebuilds")                                                            | the status command                                                                                         | as a rebuild                                                                                                                                      | **instant** (explicit)                          | The user's own command already is the decision. It [applies first](#implicit-apply).                                                                                                                                       |
| Plan checks and feeds resolution (`plan.warning.list`, `plan.operation.list`, `plan.operation.feeds.get`)                         | derived on read                                                                                            | per query, sub-ms per operation                                                                                                                   | **instant**                                     | Cheap, read-only; they show the plan as it is (marked outdated when the plan has pending inputs).                                                                                                                          |
| **Toolpath generation** (`plan.toolpath.generate` job, [cache](workers.md#toolpath-cache))                                        | today: explicit only ("Generate toolpaths"); `plan.export` regenerates stale entries                       | 5 ms for the test part, budget 500 ms; per operation up to the 60 s timeout                                                                       | **deferred** (on Apply, for plans kept current) | A job, scales with toolpath complexity. v0.1 makes it explicit; Apply keeps toolpaths current for plans whose toolpaths the user generated ([decision 4](#decisions)).                                                     |
| Toolpath cache lookup and stale flag (`plan.toolpath.get`)                                                                        | derived on read, content-addressed                                                                         | hash per read                                                                                                                                     | **instant**                                     | Cheap; the stale flag drives the [dimmed preview](#stale-derived-results).                                                                                                                                                 |
| Geometry worker prewarm                                                                                                           | first project open                                                                                         | 44 ms spawn + WASM init                                                                                                                           | not an edit reaction                            | Unchanged.                                                                                                                                                                                                                 |
| Renderer re-reads per revision (warnings, plan data, undo names)                                                                  | renderer queries                                                                                           | latest answer kept                                                                                                                                | **instant**                                     | Cheap; they show pending markers.                                                                                                                                                                                          |

### Rules for new reactions

A new automatic reaction is classified in this table when it is designed:

- **Instant** if it decides nothing for the user (preview, validation, information) **and** fits the interactive budget: synchronous work inside the ~5 ms command step, or worker work within the evaluation budget (≤ 50 ms warm) that rides the debounced evaluation.
- **Deferred** if it changes the document on the user's behalf (chooses, rebuilds, follows, reorders) or exceeds that budget (later: thin-wall and collision checks, simulation, optimization). Deferred work is an [apply hook](#apply-hooks) (document) or an [apply job](#apply-jobs) (derived caches).
- A **document hook** ([commands.md](commands.md#document-hooks)) stays the mechanism for instant derived document state; after this change v0.2 has none.

## Pending changes

### What is pending

**Pending changes** are the changes of a project's document since its last Apply that are inputs of deferred work. They belong to the **project** (the dispatcher), not to a window or a source: the user's and agents' edits are pending together, and Apply applies all of them.

| Pending change                                                                                                    | Key (one count each)                   | Input of                                        |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------- |
| A changed field of a design operation (`on`, a parameter, a tool unlock)                                          | (part, operation, field)               | tool choice, draft plan follow, toolpaths       |
| An added or removed design operation; a moved one                                                                 | (part, operation)                      | same                                            |
| A changed part field (stock reference, general tolerance)                                                         | (part, field)                          | draft plan follow, toolpaths                    |
| A changed plan input (plan operation tool, feeds, strategy, setup, machine) of a plan [kept current](#apply-jobs) | (plan, plan operation or setup, field) | toolpaths                                       |
| A changed library item that a `draft` plan holds a copy of                                                        | (library item)                         | draft library follow ([decision 5](#decisions)) |

- **By value:** a field is pending when its value differs from the value at the last Apply, compared as the plan's stale detection compares (quantities by value and tolerance, not `source`, [plan-v0.1.md](../modes/plan-v0.1.md#implementation-task-213)). Retyping `8` as `8.0 mm` is not pending; editing a field five times counts once; editing it back to the applied value removes it.
- **Not pending:** names and other fields no deferred work reads; selection, camera, UI state; library edits that no `draft` plan copies (the [instant](#instant-and-deferred-reactions) library DFM checks re-run anyway).
- **Count:** `N` = the number of keys. The button shows it; the tooltip lists them ("Pocket 1: depth, corner radius · Drilling 2 added").
- **Cost:** tracked incrementally from each commit's patches (compare only the touched paths against the baseline); the baseline is an immutable document, so it shares structure with the current one.

### Baseline and undo

The **baseline** is the document at the last Apply. Undo and redo move it with the history:

- A successful Apply puts an **apply marker** on the top history entry: its own entry when it changed the document, otherwise the top edit entry (an Apply with no document change creates no entry, as every empty commit, [commands.md](commands.md#dispatcher-pipeline)). The marker holds the document after that entry (a frozen reference, no copy).
- The baseline is the marker of the **newest marked entry at or below the top of the undo stack**; with none, the document at open.
- **Undo of an Apply entry** reverts its derived changes (tool swaps, plan rebuilds, library follow) and the baseline falls back to the previous marker: the edits it applied are pending again and the button shows them. **Redo** re-applies its patches (hooks are never re-run, as for every redo) and restores the marker.
- **Undoing past the last Apply** therefore always goes through the Apply entry first: the history is linear. Undoing edits below the baseline makes their reverts pending (conservative: re-applying a state that needs nothing is a no-op).
- **Undoing an edit above the baseline** shrinks the pending set; undoing all of them clears it.
- A **gesture** ([commands.md](commands.md#gestures-live-edits)) merges only while nothing else was committed; an Apply in between ends the merge.
- Markers live on entries, so they leave with an entry dropped by the history cap; with no marker left, the baseline is the oldest document still reachable (pending may then include changes of dropped entries).

### Opening and recovery

- **Save applies first** ([implicit apply](#implicit-apply)), so a saved project opens with nothing pending: the baseline is the opened document.
- A project restored from the working folder ([persistence.md](persistence.md#crash-recovery)) or written by an older build may hold unapplied edits. Opening runs a cheap **consistency scan** and marks as pending: every auto (unlocked) operation tool that is absent or does not fit, every `draft` plan whose design snapshot differs from its part by value, and every library copy of a `draft` plan that is `libraryChanged`. The scan reuses the fit check and the stale detection; it runs no apply hook.

## `project.apply`

A **built-in** project-scope command (the dispatcher executes it, like `history.undo`, [commands.md](commands.md#command-definition)): it needs the history markers and starts jobs. Args `{}` (plus the reserved `expectedRevision`). Undoable through the history entry its document phase creates.

### Steps

Runs on the project queue like every command:

1. **Nothing pending and no failed apply job to retry:** `Ok` with `{ changes: 0, entrySeq: null, jobIds: [] }`; one action-log event; nothing else.
2. **Document phase:** a draft of the current document → the [apply hooks](#apply-hooks) in registry order, each given the pending set → commit as one history entry titled "Apply N changes" (`revision++`, patches published, redo stack cleared), or no entry if the hooks changed nothing. The apply marker is set ([baseline](#baseline-and-undo)); pending becomes empty.
3. **Job phase:** the [apply jobs](#apply-jobs) start (not undoable, not in the entry); their ids go into the result. A newer Apply aborts the running apply jobs it supersedes (same plan), as a newer revision aborts an evaluation.
4. **Result** `ApplyOutcome`: `{ changes, entrySeq, toolChanges[], plans[], jobIds[], warnings }` – `toolChanges` as design-v0.2's `toolChange` (`{ partId, operationId, from, to, reason }`), `plans` per affected plan (`rebuilt`, `followed`, `blocked` with the reason), `warnings` the DFM warnings of the affected parts after Apply.

### Apply hooks

`ApplyHook` (new, beside `DocumentHook` in `define.ts`; registry list `APPLY_HOOKS`): synchronous, on the Apply draft, with the pending set; same rules as a document hook (no dispatch, synchronous library reads only, an `Err` or throw fails the Apply and leaves the document unchanged). Order:

| #   | Hook                    | Does                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `design.toolAutoChoice` | [Auto choice](../modes/design-v0.2.md#auto-choice) for every unlocked operation with a pending change (v0.2).                                                                                                                                                                                                                                        |
| 2   | `plan.draftFollow`      | What `plan.draftAutoRebuild` does today, once per part with pending changes: rebuild its `draft` plans, then ([decision 5](#decisions)) update their library copies that are pending, as `plan.libraryItem.update { followOnly }` does. A plan that cannot follow is left and reported (`rebuildBlocked`, `libraryBlocked`), never an Apply failure. |

Tool choice runs first because the rebuild resolves plan tools from the design tool field ([plan-v0.2.md](../modes/plan-v0.2.md#tool-resolution-from-the-design-tool-field)). The `plan.draftAutoRebuild` document hook is removed from `APP_HOOKS`; design commands stay plan-independent as before ("a design command never fails because of a plan").

### Apply jobs

After the document phase, for every plan **kept current** – not `archived`, and it had generated toolpaths before (the cache's last-generated map knows a toolpath for one of its operations) – whose toolpaths are now stale, Apply starts `plan.toolpath.generate { planId }` with the Apply's source. The cache makes it incremental (only changed hashes run). Plans the user never generated toolpaths for stay explicit ("Generate toolpaths"). Later verification jobs join here.

### Failures

- **Apply never fails because of derived problems:** a tool that fits nowhere keeps the tool and warns (`dfm.toolUnfit`); a plan that cannot follow is blocked and reported; a failing toolpath is listed by its job as `failed`.
- An `Err` of a hook or a throw (`internal.unexpected`) fails the Apply: document, history and pending set unchanged, error in the result and on the [button](#apply-button).
- A failed apply job does not undo the document phase; its failures show where toolpath failures show today (plan rows, job list).

### Implicit apply

Commands that consume the confirmed design, or leave the project, apply first. Their definitions carry `applyFirst: true` (new flag on `CommandMeta`); the dispatcher runs `project.apply` in the same queue turn before them (its own log event and entry, source of the caller):

| Command                                                       | Why                                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `project.save`                                                | A saved file never holds unapplied edits (opens clean).                |
| `plan.export`                                                 | gCode reflects the applied design and current toolpaths.               |
| `run.job.start`                                               | The pre-flight shows the applied plan.                                 |
| `plan.create`, `plan.rebuild`, `plan.status.set` into `draft` | They copy the design into a plan; the tool choice must have run first. |

The working-folder flush and a close **without** saving do not apply: pending edits stay recoverable as they are.

### Concurrency and stale writes

- One Apply at a time per project (the queue). Edits arriving while its jobs run become pending for the next Apply.
- `project.apply` writes only derived state from the current document, so it is **exempt from the baseline rule** ([commands.md § Stale writes](commands.md#stale-writes)): an agent may apply the user's pending edits without a fresh read. A given `expectedRevision` is still checked.
- Apply is per project: projects and their windows never apply each other. A library change marks pending in every open project with an affected `draft` plan ([decision 5](#decisions)).

### Queries for pending state

| Query / field                                               | Returns                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.pending.get` (built-in query, new)                 | `{ count, changes[], applying, lastApply }`: each change `{ kind: 'design' \| 'plan' \| 'library', partId?, operationId?, planId?, field?, label, source, revision }`; `applying` the running apply jobs; `lastApply` `{ entrySeq, revision, at, source }` |
| `design.warning.list`                                       | adds `pendingApply: boolean` per warning that Apply may change (rules against an unlocked tool of an operation with pending changes)                                                                                                                       |
| `plan.stale.list`, `plan.warning.list`, `plan.toolpath.get` | add `pendingApply: true` for a plan (or toolpath) whose inputs have pending changes: a `draft` plan of a part with pending design changes, or a kept-current plan with pending plan inputs                                                                 |

### Stale derived results

What the UI shows between an edit and Apply (rules for [ui.md](../conventions/ui.md)):

| Derived result                                               | Shown as                                                                                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mesh, outline, parameter and geometry DFM warnings           | Live, as today ([evaluation status](../conventions/ui.md#evaluation-status-pending-outdated-failed)).                                                                                |
| Warnings with `pendingApply` (unlocked tool)                 | Soft tier whatever their severity, with a clock icon and "May change on Apply: the tool is chosen again." Not counted in the status bar's warning count until applied.               |
| Tool field of an unlocked operation with pending changes     | The current tool, muted, with "Chosen again on Apply."                                                                                                                               |
| `draft` plans with `pendingApply`                            | Plan header and navigator notice "Design changes not applied yet. This draft plan updates on Apply." instead of the stale notice; plan checks marked "Outdated" (muted, not hidden). |
| Toolpaths with `pendingApply` or stale (viewport, plan rows) | Drawn dimmed toward `--bg-viewport` (`MIX.outdated`), no draw-in; the row's toolpath state "outdated". After the apply job regenerates them, they draw in (`--motion-draw`).         |

## Agents, MCP and CLI

- **Auto-apply per call (default):** for agent, CLI and automation sources, a successful `document` command (and a `library.*` write, for the session's bound project) is followed by `project.apply` in the same queue turn: `dispatch(…, { apply: true })`, a new dispatcher option set by the session core. Nobody's command can land between the edit and its Apply. The UI source never auto-applies: windows call `project.apply` on Enter or the button.
- **Batching:** the reserved optional top-level key `apply` (boolean, default `true`) on every project-scope document command, stripped by the adapter like `expectedRevision` ([llm-api.md § Schemas](llm-api.md#schemas)). `apply: false` leaves the change pending; `project_apply` applies all at once. The key is not listed in the tool schemas ([size budget](llm-api.md#implementation-task-310)): the primer explains it once and says which tools take it (described "Undoable."), and `apply` on any other tool fails with `input.malformed` naming them. Tests assert no command arg is named `apply`.
- **Results:** an auto-applied call returns `{ value, revision, applied }`, `applied` being the `ApplyOutcome` (or the Apply's error: the edit stays committed and pending, the call is still `Ok`, `applied.error` says why). `revision` is the one after Apply. The command's own `warnings` stay the synchronous ones before Apply; `applied.warnings` are after it.
- **Undo:** the edit and its Apply are two history entries (one Apply entry only if it changed something). `history_undo` once reverts the automation and leaves the edit pending; twice reverts the edit. `history.list` shows both ([decision 2](#decisions)).
- **Action log and digest:** Apply is a `command` event `project.apply` (args `{ auto: true }` for auto-apply, summarized), followed by job events for its jobs; the digest counts it like any command ("design.pocket.update ×2, project.apply"). The UI history panel and undo tooltip name it "Apply 3 changes", with the source ("by agent").
- **Pending made by others:** an agent's auto-apply applies everyone's pending changes, the user's included (Apply is per project). The window shows "Applied by agent" briefly at the button ([decision 6](#decisions)).
- **CLI:** one-shot `dfyom <name> <json>` auto-applies, then saves (which applies anyway). `dfyom batch` lines take `"apply": false` beside `expectedRevision`; a `{ "name": "project.apply" }` line applies. Exit codes unchanged; an Apply error turns into the line's error only for an explicit `project.apply`.
- **Headless flows and the exit-criteria tests** ([testing.md](../conventions/testing.md#end-to-end)) keep their results: every call auto-applies, so each step sees the same derived state as v0.1's synchronous hook. Results gain `applied`; scripts that compare results ignore it or check it. The UI exit-criteria e2e commits its fields with Enter (or clicks Apply) before reading plan values or exporting; export applies anyway.

## UI

Rules for [ui.md](../conventions/ui.md) once accepted.

### Apply button

- **Place:** the main toolbar's end column ([app shell](../conventions/ui.md#app-shell)), its **first** item, left of the machine group and the panel toggles, so appearing never moves the controls to its right; the centre column keeps the mode switcher centred.
- **Look:** a primary `Button` (semibold label, amber `--accent-icon` icon, [decision 19](../conventions/ui.md#decisions)), icon Lucide `check-check`, label "Apply" with the count as a tabular-numeral badge: "Apply 3". At most one primary in the toolbar.
- **States:**

| State                          | Shown                                                                                                                                                            | Click                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Clean, nothing running         | Hidden ([decision 3](#decisions)); the slot collapses with `--motion-base`                                                                                       | –                                                     |
| Pending                        | "Apply 3"                                                                                                                                                        | `project.apply`                                       |
| Applying (jobs running)        | "Applying…" with a determinate ring from the jobs' progress, after `--delay-indicator`; pending edits made meanwhile show the count beside it ("Apply 2" + ring) | Applies the new pending changes; the job list cancels |
| Failed                         | "Apply failed" in `--danger-text` with the danger icon; tooltip has the `ErrorMessage`                                                                           | Retries                                               |
| Just applied by another source | "Applied by agent" for 2 s, then hidden                                                                                                                          | –                                                     |

- **Accessible name** "Apply 3 changes"; `aria-keyshortcuts="Meta+Enter"` (macOS) or `"Control+Enter"`. A polite live region announces "3 changes not applied" (debounced 1 s) and "Changes applied" / "Apply failed".

### Tooltip

Rich tooltip (after `--delay-tooltip`), concept first, then the list:

> **Apply changes** · ⌘↵
> 3 changes not applied yet. Your edits are already in the model: the preview, warnings and undo follow as you type. Apply runs the follow-up work: it chooses tools, updates draft plans and regenerates toolpaths. Press Enter in a field, or ⌘↵, to apply. Saving and exporting apply first.
> Pocket 1: depth, corner radius · Drilling 2 added · (and 2 more)

Windows/Linux show "Ctrl+Enter". Terms (`Term`) link "draft plans" and "toolpaths" to the wiki.

### Keyboard

- **Enter in a field** = commit + apply. **Blur, Tab or a click away** = commit only. **Escape** reverts the field text as today; it never un-applies (that is undo).
- **Cmd/Ctrl+Enter** anywhere in the window = apply; in a field it is the same as Enter. Native menu: Edit → "Apply changes" with that accelerator ([keyboard shortcuts](../conventions/ui.md#keyboard-shortcuts)); listed in the shortcut dialog under "project".
- **Invalid value + Enter:** shows the error, commits nothing and applies nothing (fix or revert first). Unchanged value + Enter: applies the other pending changes.
- Enter in the reference autocomplete inserts the reference (no commit, no apply). Dialogs with local form state (stock setup, New tool, New machine) keep their Enter rule and never apply; Cmd/Ctrl+Enter is inactive while a modal dialog is open.
- **Choice controls** (`Select`, `SegmentedControl`, switches, the lock button, the tool combobox, pick mode's surface click) and **fix buttons** ("Use 3.00") commit only ([decision 7](#decisions)).
- Fix buttons labelled "Apply …" today ([warnings](../conventions/ui.md#warnings-and-dfm): "Apply ≥ 3.2 mm") are renamed "Use …", so "Apply" means only this concept.

### Field rule

Replaces the commit bullet of [ui.md § Quantity input](../conventions/ui.md#quantity-and-expression-input) when accepted: "Enter commits a valid value as one command (one undo step) **and applies**; blur commits only; Escape reverts to the stored source." The field shows no per-field pending mark; the button is the one indicator.

### Adjust popover

- Steps stay live gesture commits (D9); they are pending like any edit.
- **Closing does not apply** (click outside, the trigger, "Use …"): it is the blur of the popover. **Escape** cancels the gesture as today; if an Apply ran meanwhile (Cmd/Ctrl+Enter inside the popover), the gesture entry is no longer on top, so Escape keeps the value and says so (the existing rule).
- Cmd/Ctrl+Enter inside the popover applies and keeps it open; Enter on a focused −/+ button presses it. After closing, focus returns to the field, where Enter applies.

### Mode switches

Switching modes **does not apply** ([decision 1](#decisions)): switching stays instant and never blocked ([mode switching](../conventions/ui.md#mode-switching)), and modes are per window. Plan mode shows the [pending notice](#stale-derived-results) on affected `draft` plans with an "Apply now" link; Run's pre-flight applies first through `run.job.start`.

### Windows and projects

One project per window, so the button applies the window's project. Agents' edits update the count live; another project's pending changes never show.

### Reduced motion

Under `prefers-reduced-motion` (or `data-motion='reduce'`): the button appears and disappears without sliding, the count changes without its roll, the progress ring shows the value without spinning, "Applied" feedback has no fade, and regenerated toolpaths appear without draw-in ([motion](../conventions/ui.md#motion)).

## Implementation (task P1)

Code: `src/core/commands/apply.ts` (pending computation, `project.apply` / `project.pending.get` definitions, `ApplyOutcome`), `dispatcher.ts` (`runApply`, `applyFirst`, `DispatchOptions.apply`), `history.ts` (markers, `executeApplyHooks`), `define.ts` (`ApplyHook`, `ApplyJob`, `applyFirst`), `registry.ts` (`APPLY_HOOKS`, `APPLY_JOBS`, both empty until P2), `agent/session.ts` (auto-apply, reserved `apply`). Choices made with the implementation:

- **Pending by structural diff.** The pending set is computed from the current document and the baseline (no patch bookkeeping): unchanged parts and operations are skipped by reference (immutable, structure-shared documents), touched ones are compared with the plan's `sameValue`; cached per (document, baseline). Field keys are dotted paths (`depth`, `shape.cornerRadius`); a shape of another kind is one field; moved operations are those outside a longest kept order. A changed stock snapshot counts as the part field `stock`.
- **P1 tracks design keys only.** Plan inputs of kept-current plans and library items join with the work that reads them (P2: toolpath apply job, draft library follow), as do the consistency scan on open and the `pendingApply` flags on `design.warning.list` and `plan.*` queries: until P2 the draft auto-rebuild still runs per commit, so those flags would be wrong.
- **Provenance:** each pending change's `source` / `revision` is the last commit (edit, undo, redo or Apply) that touched its part or its stock snapshot.
- **Markers** live on the history's entries; a marker an entry takes along when undone falls back with it (undoing an edit marked by an Apply without document changes does not make it pending). A marked entry dropped by the cap, or an Apply on an empty undo stack, leaves a floor marker that stays the baseline until a newer one.
- **Stale writes:** an Apply's commit advances the caller's baseline only if it was current, so applying someone else's pending edits never counts as reading them.
- **Implicit apply** runs after the command's revision and permission checks; an Apply error fails the command (it does not run), logged with context `apply before <command>`. Logged args: `{}` (explicit), `{ auto: true }` (auto-apply), `{ before: '<command>' }` (implicit).
- **Apply jobs** (`ApplyJob.jobs(doc, pending, ctx)`) return `{ command, args, key }`; a newer Apply aborts the running job with the same key. Their dispatch is not logged separately: the Apply event (with `jobIds`) comes first, then the jobs' lifecycle events. An Apply with nothing pending re-runs the apply jobs if one of the last Apply's jobs failed (not aborted).
- `ApplyOutcome.warnings` is `{ partId, warnings }[]` from `design.warning.list` of each part with applied changes; `toolChanges[].from/to` stay untyped until A4 defines the tool field.
- A library write by an auto-applying session applies its bound project (`applied` in the library call's result); its own pending keys come with P2.

## Testing

Per [testing.md](../conventions/testing.md), when implemented:

- Core: pending keys from patches (by value, gestures count once, edit back removes); markers through undo/redo of Apply and of edits, empty Apply, the history cap; consistency scan on open; hook order; Apply failure leaves everything unchanged; `applyFirst` commands; auto-apply in one queue turn; `apply: false` batching; baseline-rule exemption.
- Exit-criteria flows over MCP and `batch` unchanged apart from `applied` in results; UI e2e with Enter and the button.
- Components: button states, tooltip, keys, reduced motion, axe.
