# Plan mode v0.2: setups from face directions, tools from design

Status: draft (follows from user decisions D10 and D11 of 2026-11-21; the details below await confirmation) · Vision: [plan.md](plan.md) · v0.1 subset: [plan-v0.1.md](plan-v0.1.md) · Design input: [design-v0.2.md](design-v0.2.md) · Apply (D13): [apply.md](../architecture/apply.md) · Terms: [glossary.md](../glossary.md)

Plan consequences of [design-v0.2.md](design-v0.2.md): several setups, one per approach direction, and tool assignment from the design's tool field; plus plan-only edits of the design snapshot in the UI (strategy editing phase 2, [roadmap.md](../roadmap.md)). Everything not mentioned here stays as in [plan-v0.1.md](plan-v0.1.md). Do not implement before the user confirms it. Tasks: [plans/v0.2.md](../plans/v0.2.md).

**Q15 (assumed by D16, 2026-11-21; the user can veto):** v0.2 multi-setup goes **without workholding and without in-process stock**. Toolpaths of later setups use the design's analytic levels, so they may air-cut where an earlier setup already removed material, like the known facing/profile air-cutting.

## Setups from face directions

- **Derivation:** `plan.create` and every rebuild group the plan operations by the [approach direction](design-v0.2.md#face) of their design operation's `on` face: **one setup per direction** in use. A part with only top operations keeps exactly one setup, as in v0.1.
- **Setup record** (extends [plan-v0.1.md § Plan record](plan-v0.1.md#plan-record)): `{ id, name, direction, workOffset, clearanceHeight, retractHeight, operations[] }`. `direction` is the part direction that points up to the spindle (machine +Z). Default name: "Top", "Bottom", "Front", "Right", "Back", "Left" (a second setup of one direction: "Top 2").
- **Orientation:** the setup's machine axes are the [face frame](design-v0.2.md#face-frame) of its direction: `u` → machine +X, `v` → machine +Y, `n` → machine +Z. For `+z` this is v0.1's fixed orientation ([plan-v0.1.md § Setup](plan-v0.1.md#setup-orientation-work-zero-safe-heights)). Rotating a setup about the spindle axis is [question K](#questions-raised-by-this-draft).
- **Work zero:** `G54` at the face frame origin (the lower-left corner of the up-facing stock face, seen from above on the machine), Z0 on that stock face. Each setup is re-zeroed by the operator after re-fixturing; each exports its own program. The stock's thickness tolerance after a flip absorbs into `breakthrough` for through cuts, as in v0.1.
- **Safe heights** per setup as in v0.1, measured from the setup's up-facing stock face and the operation's `on` face.
- **Machine checks per setup:** the stock size in the setup's orientation (extent along `u`, `v`, `n`) + `clearanceHeight` must fit the travel.

### Merge, split, reorder

| Action  | Rule                                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Split   | Move chosen plan operations of a setup into a new setup of the **same direction** (e.g. rough the top, flip, machine the bottom, flip back to finish the top).                           |
| Merge   | Join setups of the **same direction**. Merging different directions fails with `plan.setup` (new code): a 3-axis setup has one approach direction. (4th/5th axis and user planes later.) |
| Reorder | Setups in any order and plan operations across setups of the same direction, subject to the order checks below.                                                                          |

- **Default order:** `+z`, `−z`, then the sides 0–3, then repaired so every operation follows the operations its `on` references (as `repairOrder` in [plan-v0.1.md § Implementation](plan-v0.1.md#implementation-task-213)). Which side comes first by default is [question L](#questions-raised-by-this-draft).
- **Order checks across setups:** `plan.order` (error) when an operation's `on` face is made in a later setup; warning `plan.cutoutBeforeSetup` when a through profile runs in a setup before another setup (the part is held only by its tabs while re-fixtured).
- **Rebuild keeps the user's structure:** a new operation of an existing direction joins the last setup of that direction; a new direction gets a new setup at its default position; a setup left empty by a rebuild is removed. An operation whose `on` changed direction moves to a setup of its new direction.

### Toolpaths per setup

Generators stay top-down ([plan-v0.1.md § Toolpath generators](plan-v0.1.md#toolpath-generators-task-210)): the seam (`planOperationInputs`) passes each operation in its face frame (`[u, v]` positions, levels along `n` relative to the setup's Z0, the stock extent along `n` as the thickness for through cuts). Toolpaths come out in the setup's WCS directly. Export and run work per setup: [`plan.export`](../architecture/grbl.md#plan-export-command) gains `setupId` (required when the plan has more than one setup) and writes one program per setup; run mode's "next setup" prompt between programs needs a [run-v0.1.md](run-v0.1.md) amendment when this is accepted.

### Commands (setups)

| Command               | Args                                                                | Result        |
| --------------------- | ------------------------------------------------------------------- | ------------- |
| `plan.setup.split`    | `{ planId, setupId, planOperationIds, name? }` – new setup after it | `{ setupId }` |
| `plan.setup.merge`    | `{ planId, setupIds }` – same direction only; into the first        | `{ setupId }` |
| `plan.setup.move`     | `{ planId, setupId, toIndex }`                                      | `{}`          |
| `plan.operation.move` | as v0.1, plus `toSetupId?` (same direction)                         | `{}`          |
| `plan.setup.update`   | as v0.1, plus `name?`                                               | `{}`          |

`plan.create` returns `{ planId, setupIds }`. Statuses as `plan.setup.update` in v0.1 (`draft`, `settledDesign`).

## Tool resolution from the design tool field

The design's [tool field](design-v0.2.md#operation-tool) is an input to Plan's [tool assignment](plan-v0.1.md#tool-assignment-and-checks). It replaces "the design's tool requirement" as the only input to `plan.tool.suggest`; the plan check table itself is unchanged.

| Design tool         | Locked | `plan.create` / rebuild assigns                                                                                                                                                                                                                                                                |
| ------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Specific            | no     | That tool (a plan copy of the design's snapshot) if it passes the plan checks for the plan's machine; else the first `plan.tool.suggest`, with info `plan.designToolReplaced` naming the failed check.                                                                                         |
| Specific            | yes    | That tool, **always**. If it fails a plan check, it stays assigned and `plan.designToolFailed` (error, fails generation for that operation) names the check and lists the fitting alternatives. Never swapped.                                                                                 |
| Generalized         | no     | The first `plan.tool.suggest`, where library tools matching the generalized type and diameter (and RE) within 0.01 mm rank first.                                                                                                                                                              |
| Generalized         | yes    | The best matching library tool (type and diameter, and RE, within 0.01 mm) that passes the checks, ranked as `plan.tool.suggest`. None: no tool, `plan.toolUnresolved` (error) naming the generalized tool and the fitting non-matching alternatives. Never a different size or type silently. |
| None (v0.1 project) | –      | As v0.1: the first `plan.tool.suggest`.                                                                                                                                                                                                                                                        |

- **A locked tool failing in a plan warns, it never swaps.** The user resolves it explicitly: assign another tool in the plan (`plan.tool.assign`, a deliberate plan decision), change the machine, extend the stickout, or change the design. The fix list in `plan.warning.list` offers these.
- **Plan assignment wins inside the plan.** `plan.tool.assign` marks the plan operation `toolSource: 'plan'` (new optional field, no `schemaVersion` change); create and rebuild set `toolSource: 'design'`. A rebuild re-resolves the tool only for `toolSource: 'design'` operations whose design tool field changed (by value) since the snapshot; `plan` ones keep their tool and show the stale flag `designToolChanged` in `plan.stale.list`. Whether a later design lock should override a plan assignment is [question M](#questions-raised-by-this-draft).
- **Draft plans** follow the design tool field through the rebuild like any design change, on Apply ([below](#draft-plans-follow-on-apply)); a locked specific tool that fails reports `plan.designToolFailed`, never a blocked rebuild.
- `plan.tool.suggest` gains a reason per candidate for the design tool (`matchesDesign`, `designTool`), so the UI and agents see why a tool ranks first.

## Plan-only edits and the snapshot scene

Strategy editing phase 2 ([roadmap.md](../roadmap.md); phase 1 shipped the Strategy group and the feeds derivation). The core already has [plan-only edits](plan-v0.1.md#plans-are-snapshots) (`plan.design.operation.update` in `settledDesign`, the `editedInPlan` stale indicator, `discardPlanEdits` on rebuild); this section adds what the UI needs. No new data: the plan's design snapshot `{ taken, part }` already holds both versions.

- **New command `plan.design.operation.revert`** `{ planId, planOperationId }`: copies the `taken` version back into `part` for that operation (one undo step); allowed where `plan.design.operation.update` is. Agents and the CLI get it from the command layer.
- **Inspector:** in a `settledDesign` plan, a "Part (plan copy)" group under Tool shows the operation's design fields, reusing the Design inspector's per-kind field components (factored out of the Design inspector, not copied). An edited operation shows an "Edited in plan" badge and "Revert to design". In `draft` the group is read-only with the hint "Settle the design to edit it for this plan only"; in `finalized` and later it is read-only.
- **Rebuild with plan edits** asks first ([ui.md § Confirmations](../conventions/ui.md#confirmations)): "Rebuild discards 2 plan-only edits" with Rebuild and Cancel; agents still pass `discardPlanEdits: true`.
- **Snapshot scene:** the plan scene draws the **plan's** part (`design.part` of the plan), not the design's current mesh. The geometry worker evaluates a part DTO passed in (cached by the snapshot's hash, [workers.md](../architecture/workers.md)); edited operations are tinted, and the design's current part can be shown as a ghost for comparison (view toggle, off by default).
- **Open:** may a rebuild keep plan edits that do not conflict with the design change? Today it discards all; this draft keeps that ([question O](#questions-raised-by-this-draft)).

## Setup change in Run

Run mode loads **one program per setup** ([§ Toolpaths per setup](#toolpaths-per-setup)). Between programs it shows a setup-change prompt, styled like the tool-change dialog ([run-v0.1.md](run-v0.1.md)): the next setup's name and direction, a picture of the stock in its new orientation, "Set the work zero on the new top" with the WCS corner, then Start. The virtual machine needs nothing new (a setup change is a pause with a new program). The [run-v0.1.md](run-v0.1.md) amendment is part of plan task E2 ([plans/v0.2.md](../plans/v0.2.md#3-plan-and-run)).

## Draft plans follow on Apply

User decision D13 (2026-11-21), draft in [apply.md](../architecture/apply.md): the draft auto-rebuild no longer runs on every `design.*` commit. It becomes the apply hook `plan.draftFollow`, which runs once per Apply after the design's tool choice, so setups and tools are derived from the confirmed design, not from every keystroke or popover step.

- Between an edit and Apply, a `draft` plan shows "Design changes not applied yet" instead of a stale notice, its checks and toolpaths marked outdated ([apply.md § Stale derived results](../architecture/apply.md#stale-derived-results)).
- `plan.create`, `plan.rebuild` and `plan.status.set` into `draft` apply first ([implicit apply](../architecture/apply.md#implicit-apply)).
- Draft library follow moving into Apply as well is [apply.md question 5](../architecture/apply.md#open-questions); keeping stale toolpaths current on Apply is question 4.

## Questions raised by this draft

| #   | Question                                     | Options                                                                                                               | Recommendation                                                                                         |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| K   | Setup rotation about the spindle axis        | (a) fixed by the face frame in v0.2; (b) 0/90/180/270° per setup                                                      | (b) if cheap: a long side face may only fit the travel rotated; else (a) with the travel check warning |
| L   | Default setup order                          | (a) `+z`, `−z`, sides; (b) `−z` first (face the bottom as a datum), then sides, `+z` last (cutouts last)              | (b): profiles with tabs are usually on top and should run last; dependencies repair the rest           |
| M   | A design tool locked after a plan assignment | (a) plan assignment wins, stale flag shown; (b) the design lock replaces it on rebuild                                | (a): plans are snapshots and are tuned on their own                                                    |
| N   | Through features from the opposite side      | (a) one direction per operation (the design's); (b) Plan may machine a through hole or profile from the opposite face | (a) in v0.2; (b) later as "access directions", it changes setup derivation                             |
| O   | Plan-only edits on rebuild                   | (a) a rebuild discards all plan edits (as today); (b) keeps edits of operations the design change did not touch       | (a) in v0.2: predictable, and the confirmation names what is lost; (b) later if users ask              |

K–N were answered with the recommendations by decision D12 (2026-11-21, self, draft); the user confirms them with this doc.
