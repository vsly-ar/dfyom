# LLM / agent API

Status: draft · Task: 1.6 of the [v0.1 plan](../plans/v0.1.md#1-docs-and-decisions-accepted-before-implementation) (implementation: 3.10, end-to-end: 3.11) · Principle: [principles.md §1](../principles.md#1-llm-first) · Decision: [ADR 0011](../decisions/0011-mcp-and-cli-agent-api.md) · Commands: [commands.md](commands.md)

How agents reach DFYOM: an **MCP server** (stdio for a headless instance, local HTTP for attaching to a running app) and a **CLI**, both thin adapters over the [command layer](commands.md). This doc maps commands, queries, jobs, errors and the action log onto MCP and the CLI, and defines agent sessions, project binding, coexistence with the GUI and safety. Recommendations marked **(Q n)** wait for a decision in [Open questions](#open-questions); do not implement 3.10 before they are answered.

## Requirements

- **Parity:** every user action is available to agents; the tool list is derived from the registry, never hand-written ([ADR 0005](../decisions/0005-shared-command-layer.md)).
- **Headless** operation (no window) and **multiple app instances** on one computer.
- **Multi-agent** workflows: several agents (and the user) on one project at once.
- An agent attached to a visible window **receives the user's actions**.
- Later (not v0.1): agent-authored run-mode automation scripts and live run supervision ([modes/run.md](../modes/run.md)).

## v0.1 scope

| In v0.1                                                                          | Later                                                                    |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| MCP over stdio (headless instance) and Streamable HTTP on loopback (running app) | Remote (non-loopback) access, OAuth                                      |
| One tool per registry command and query; a few session tools (below)             | MCP prompts; MCP Tasks for jobs; automation-script tools                 |
| Results and `AppError` as structured tool results                                | Streaming large results (meshes are not exposed at all)                  |
| Jobs: `job.wait` with MCP progress; polling with `job.get`                       | Push of job completion to the model without a pending call               |
| Action-log digest in tool results, `project.log.list`, subscribable log resource | Patch streams to agents (replicas only)                                  |
| Permission: the v0.1 virtual-machine rule ([Safety](#safety))                    | Real-machine grants for agents ([run.md#safety](../modes/run.md#safety)) |
| CLI: one-shot calls, JSON-lines batch, `dfyom mcp`, `dfyom tools`                | Generated per-field flags, shell completion                              |

## Processes and hosting

| Mode         | Process                                                  | Transport                           | Projects                                                           |
| ------------ | -------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| GUI          | Electron main ([overview.md](overview.md#ipc))           | IPC (renderer), local HTTP (opt.)   | Opened by the user or by an attached agent                         |
| Headless MCP | `dfyom mcp`: Node process, no Electron import (**Q 15**) | stdio                               | Opened by the agent; closed when the session ends                  |
| Bridge       | `dfyom mcp --connect [instance]`                         | stdio ↔ local HTTP of a running app | The running app's ([Coexistence](#coexistence-with-a-running-gui)) |
| CLI          | `dfyom <name> …`, `dfyom batch` (same Node entry)        | argv / stdin / stdout               | One per invocation ([CLI](#cli))                                   |

All modes run the same **app host** (`src/main/host/`, no Electron import – like `src/main/persistence/`): the [project storage](persistence.md#files), the [library](library.md#storage), the [worker pool](workers.md#hosting), the machine host ([run-v0.1.md](../modes/run-v0.1.md#processes): utility process in the app, `worker_threads` headless), the app-scope dispatcher and one project runtime per open project (dispatcher, `EvaluationScheduler`, `ToolpathCache`, `ExportFiles`, geometry prewarm – the wiring [workers.md](workers.md#implementation-task-29) leaves to "whoever opens a project"). The GUI adds windows and IPC on top; MCP and CLI add their framing. Stdout carries only protocol or CLI output ([logging.md rule 6](../conventions/logging.md#rules)).

### App scope and project scope

Today every command runs on a project dispatcher, so the library is unusable without an open project and project lifecycle is not a command (plan known issues: "app-level dispatcher", "no project opens via IPC/MCP/CLI"). Recommended **(Q 3)**:

- An **app-scope dispatcher** per instance: the same `createDispatcher` pipeline (lookup, `parseArgs`, FIFO, permission, one action-log event per call) over an empty `ProjectDoc` and an app registry. It holds `library.*`, `feedsSpeeds.*` and the project lifecycle below; these move out of `APP_COMMANDS`/`APP_QUERIES`. Names stay unique across both registries (registry test).
- **Project lifecycle commands** (all `effect`, app scope; handlers call the app host through a new `services.host` port):

| Name                       | Args                       | Result / notes                                                                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.create`           | `{ name, unitSystem }`     | `{ key, revision }`; untitled until `project.save { target }`.                                                                                                                                                                                                                                    |
| `project.open`             | `{ file }`                 | `{ key, revision, alreadyOpen }`. A file already open **in this instance** returns its key instead of `persist.locked` (the storage rule is unchanged; the host checks its open map first). Recovery case → `persist.recovery` (new code, added to `ERROR_CODES` in 3.10) with the key in `data`. |
| `project.close`            | `{ key, confirm?: true }`  | Unsaved changes need `confirm: true` (else `input.malformed`, rule `unsavedChanges`); the working folder then stays recoverable ([persistence.md](persistence.md#crash-recovery)). `run.busy` while a run job runs.                                                                               |
| `project.list`             | `{}` (query)               | Open projects: `key`, file, name, `dirty`, `revision`, bound sources.                                                                                                                                                                                                                             |
| `project.recovery.list`    | `{}` (query)               | Wraps `listRecovery` ([persistence.md](persistence.md#crash-recovery)).                                                                                                                                                                                                                           |
| `project.recovery.resolve` | `{ key, action, confirm }` | Wraps `resolveRecovery`; `restore` opens the project.                                                                                                                                                                                                                                             |

### Session tools

A few tools are not registry entries because they depend on the session, not on a dispatcher. They live in the shared session core (`src/core/agent/`), so MCP and CLI offer the same set, and they follow the [naming](commands.md#naming) rules:

| Name               | Args                                       | Result                                                                                                                     |
| ------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `project.bind`     | `{ key }`                                  | Binds the session to an open project (`project.open`/`create`/`recovery.resolve` bind automatically).                      |
| `project.log.list` | `{ afterSeq?, sources?, names?, limit? }`  | Action-log events of the bound project ([Action log](#action-log-and-user-actions)); `gap: true` if evicted.               |
| `job.wait`         | `{ jobId, timeoutSeconds?: 30 }` (max 300) | The `job.get` value once finished, or the current one on timeout (`timedOut: true`) ([Jobs](#jobs)).                       |
| `history.list`     | `{ limit? }`                               | Undo/redo stack: `seq`, `title`, `source`, revisions ([Undo](#undo-and-history)). A builtin query, `readsDocument: false`. |

## Exposure: commands and queries as MCP tools

### Which

- **Every** command and query of both registries is a tool, plus the session tools. Nothing is hidden from agents; [Safety](#safety) gates what may run. Test fixtures (`commands.fixture.ts`) are never registered. Measured on 2026-11-18: 63 registry entries (43 commands, 20 queries); about 85 with run mode (3.9) and the tools above.
- Queries are **tools**, not MCP resources: models call tools; resources are application-driven in most clients. Resources are used only for streams and catalogs ([Resources](#resources)).

### Names

- MCP name = registry name with `.` → `_`: `design.pocket.add` → `design_pocket_add`. Registry names contain no `_` (`NAME_PATTERN`), so the mapping is bijective; it is the only transport-specific renaming ([commands.md](commands.md#naming)). Underscored names fit every common client and LLM tool-name rule (`^[a-zA-Z0-9_-]{1,64}$`); the server name `dfyom` is the client's prefix.
- No tool `title` (`CommandMeta.title` needs args). `description` = `summary` plus the kind line: "Undoable." / "Not undoable; writes app data." / "Starts a job; returns { jobId }, wait with job_wait." / "Affects a machine."

### Schemas

- `inputSchema` = `toolDescriptor(def).inputSchema` from [`json-schema.ts`](../../src/core/commands/json-schema.ts) ([commands.md](commands.md#json-schema-for-agent-tools)), plus the reserved optional key `expectedRevision` (integer) on every command of project scope **(Q 12)**. The adapter removes it before `dispatch(…, { expectedRevision })`; a registry test asserts no command arg is named `expectedRevision`.
- **Output schemas are not listed** in `tools/list` **(Q 2)**: they are 80 % of the size (470 K of 585 K chars; `plan.get` alone 148 K). They are served by the `dfyom://schema/{name}` resource and `dfyom tools --json`.
- Size: input schemas of all 63 entries are about 111 K chars (~28 K tokens), dominated by `library.{tool,machine}.{add,update}` (~13 K each, repeated quantity sub-schemas). 3.10 generates with shared definitions (`$defs`/`$ref` for reused schemas) and a test enforces a budget on the serialized `tools/list` (target: under 60 K chars), so growth is noticed when a command is added. Clients with deferred tool loading handle the rest.
- **Granularity (Q 1):** recommended one tool per command/query (structural parity, client-side validation, no extra round trip). Server option `--areas design,plan,…` (MCP) restricts the list for small-context models; session tools and `history`/`job` are always listed.

### Annotations and server instructions

- MCP tool annotations are derived, never hand-set: query → `readOnlyHint: true`; `document` → `destructiveHint: false` (undoable); `effect`/`job` → `destructiveHint: true` when the args require `confirm` or the command is `machine`, else `false`; `machine: true` → `openWorldHint: true`; queries and `job.wait` → `idempotentHint: true`.
- The `initialize` result's `instructions` is a short primer generated from one source file (`src/core/agent/primer.ts`, linking here): open or create a project first; quantities are strings as entered (`"6 mm"`, `"1/4\""`, [quantities.md](quantities.md)); query before editing or pass `expectedRevision`; job tools return a `jobId`, wait with `job_wait`; `confirm: true` means the user agreed.

### Library

The adapter uses the SDK's **low-level `Server`** of `@modelcontextprotocol/sdk` (MIT, GPL-compatible) with our JSON Schemas and own Zod parsing (`parseArgs`), not `McpServer.registerTool` with Zod shapes: it avoids coupling our Zod 4 schemas to the SDK's Zod version and keeps `parseArgs`' unknown-key rule.

## Data flow

### Results

Every tool call goes through `atBoundary` with `EntryPoint { kind: 'agent', name }` ([boundaries.md](../conventions/error-handling/boundaries.md#entry-points-ui-agent-cli-automation)) and returns a `CallToolResult`:

| Outcome         | `isError` | `structuredContent`                      | `content` (text, for clients without structured output)         |
| --------------- | --------- | ---------------------------------------- | --------------------------------------------------------------- |
| Command `Ok`    | `false`   | `{ value, revision }` (`CommandOutcome`) | Same JSON, then the [digest](#action-log-and-user-actions) line |
| Query `Ok`      | `false`   | `{ value, revision }` (`QueryOutcome`)   | Same                                                            |
| Job started     | `false`   | `{ value: { jobId }, revision }`         | Same, plus "wait with job_wait"                                 |
| `Err(AppError)` | `true`    | `{ error: AppErrorData, retryable }`     | `code: message` and the issues, one per line                    |

- Errors are **tool execution errors** (`isError: true`), never JSON-RPC errors, so the model sees `code`, `issues` with `params` and frames and can self-correct ([app-error.md](../conventions/error-handling/app-error.md#serialization)). `retryable` comes from `ERROR_CODES`. JSON-RPC errors are only for protocol faults (unknown tool name, malformed request) – an unknown tool cannot be a known command, since the list equals the registry.
- `command.conflict` text says to re-query and retry ([commands.md](commands.md#stale-writes)); `permission.denied` names the command and source kind.
- Results are `ResultWire` DTOs; no truncation in v0.1 (meshes are not exposed, [workers.md](workers.md#jobs-for-agents)).

### Jobs

- A `job` command's tool returns `{ jobId }` at once, as the dispatcher does ([commands.md](commands.md#long-running-commands-jobs)). `job_get`, `job_list`, `job_pause`, `job_resume`, `job_abort` are the registry entries.
- **`job.wait` (Q 8)** blocks until the job finishes or `timeoutSeconds` passes and returns the `job.get` value. If the call carries `_meta.progressToken`, the server sends `notifications/progress` from `JobHandle.onProgress` (`progress` = `done`, `total`, `message` = `label`; already throttled by the dispatcher). Cancelling the MCP request (`notifications/cancelled`) ends the wait, **not** the job (`job_abort` does that).
- A job's completion is also an action-log `job` event, so it shows up in the [digest](#action-log-and-user-actions) of the agent's next call.
- **Follow-up document commands (Q 14):** no v0.1 job needs one (toolpaths are derived, [plan-v0.1.md](../modes/plan-v0.1.md); evaluation and runs change no document). Adapters never dispatch follow-ups; this closes the plan known issue for v0.1.

### Action log and user actions

The [action log](commands.md#action-log) is how an agent sees what the user and other agents did. Most MCP clients do not show server notifications to the model, so the primary channel is pull plus piggyback **(Q 9)**:

- **Digest:** each session keeps a cursor (last seen `seq`). Every tool result of a bound session ends with one text line (and `_meta["dfyom/actions"]`) summarizing events **by other sources** since the cursor, e.g. `Since your last call: 3 actions by ui:win-1 (design.pocket.update ×2, history.undo), revision 41 → 44.` Then the cursor advances. Patches are never included.
- **Pull:** `project.log.list { afterSeq }` returns the events (args summarized, `withPatches: false`); a `gap` means the ring buffer dropped events and the agent should re-query what it needs.
- **Push (optional):** resource `dfyom://project/{key}/log` supports `resources/subscribe`; the server sends `notifications/resources/updated` (debounced 250 ms) and the client reads the resource with `?after=<seq>`. For clients and harnesses that act on notifications.

### Resources

| URI                         | Content                                                  | Subscribable                   |
| --------------------------- | -------------------------------------------------------- | ------------------------------ |
| `dfyom://project/{key}/log` | Action-log events after `?after=`                        | yes                            |
| `dfyom://run/status`        | `RunStatus` ([run-v0.1.md](../modes/run-v0.1.md#status)) | yes, updates throttled to 1 Hz |
| `dfyom://schema/{name}`     | Full descriptor incl. `outputSchema`                     | no                             |

## Sessions and sources

- **Source:** each MCP session is one [source](commands.md#stale-writes) `{ kind: 'agent', id }`: `stdio-<n>` or `http-<n>` (per `Mcp-Session-Id`), unique per instance. The client's `clientInfo.name` is logged with it and shown in the GUI ("Claude Code · http-2"). A CLI invocation or `dfyom batch` run is `{ kind: 'cli', id: 'cli-<pid>' }`. A `--connect` bridge keeps its client's identity (the HTTP session is the source).
- **Binding (Q 4):** a session is bound to at most one project; project-scope tools run on the bound project's dispatcher and fail with `input.malformed` (rule `noProject`, hint: open, create or bind) when none is bound. App-scope tools work unbound. Several projects = several sessions (cheap over HTTP; one headless process per project over stdio).
- **Stale writes** apply per source unchanged: an agent edits after a query or with `expectedRevision`; a user's edit in between gives `command.conflict` ([commands.md](commands.md#stale-writes)).
- **Lifecycle:**
  - Headless stdio: the process is the instance. On end of stdin: abort running jobs, close every project it opened (unsaved changes stay recoverable, as on `project.close { confirm: true }`), flush logs, terminate workers, exit 0.
  - HTTP session end (DELETE, or 30 min idle): unbind; projects stay open. Its running jobs keep running (they belong to the dispatcher).
  - Agent-opened projects in the GUI instance open a window and stay open after the session ends **(Q 6)**.

### Coexistence with a running GUI

One project has exactly one owner instance: the [lock](persistence.md#lock) holder, whose dispatcher is the only authoritative `ProjectDoc` ([commands.md](commands.md#project-state)). There is no shared-file editing between instances.

| Situation                                                   | Behaviour                                                                                                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent wants the project the user has open                   | Attach to that GUI: HTTP directly, or stdio via `dfyom mcp --connect`; then `project.list` / `project.bind`. Same dispatcher, queue, history and log as the user. |
| Headless `dfyom mcp` opens a file locked by a live instance | `persist.locked` as today; `data` adds the holder's instance id and, if it serves HTTP, the hint `dfyom mcp --connect <instance>` **(Q 5)**.                      |
| GUI opens a file a headless instance holds                  | `persist.locked`; the GUI shows which agent instance holds it.                                                                                                    |
| Several GUIs / headless instances                           | Independent; each owns different projects; the library is shared ([library.md](library.md#storage), cross-instance revision check).                               |

**Discovery:** an instance serving HTTP writes `<appData>/instances/<instanceId>.json` `{ instanceId, pid, port, token, startedAt, appVersion }` (owner-only permissions: mode `0600`; Windows: user-profile ACL) and deletes it on quit; stale files (dead PID) are ignored and removed. `--connect` without an id picks the only live instance, else fails listing them. The lock's instance id names the file.

## Safety

### Permissions

- The dispatcher's `PermissionPolicy` stays the single gate ([commands.md](commands.md#dispatcher-pipeline) step 5); adapters add none. v0.1 rule: machine commands on the virtual connection are allowed for every source; any other target denies non-UI sources ([grbl.md](grbl.md#transport-and-sender), [run-v0.1.md](../modes/run-v0.1.md#safety-v01)). Only virtual exists in v0.1.
- Real machines are decided with [run.md#safety](../modes/run.md#safety) before any serial connection exists **(Q 11)**; recommended direction: an explicit grant by the user at the GUI, per agent session and connection, revoked on disconnect, never available to headless instances.
- Destructive non-machine commands already need `confirm: true` in their args (library `remove`, recovery `discard`, replacing files in `project.save`/`plan.export`, `project.close` with unsaved changes). For agents `confirm: true` asserts the user agreed; the primer says so; it is logged with the source.
- No path sandbox in v0.1: a local agent already has the user's file access. HTTP hardening (below) keeps web pages out.

### Local HTTP

Recommended **(Q 7)**:

- **Off by default.** Enabled by an app setting or `--mcp-http[=port]`; the GUI shows a visible "agents can connect" indicator and the attached sessions.
- Binds `127.0.0.1` only (never `0.0.0.0`/`::`); port random unless given. Streamable HTTP at `/mcp` (not the deprecated HTTP+SSE transport).
- **Bearer token:** 256 random bits per instance start, in the discovery file; every request needs `Authorization: Bearer <token>` (else 401). Compared in constant time; redacted in logs ([logging.md](../conventions/logging.md#redaction) already covers `authorization`, `token`).
- **DNS-rebinding guard:** reject requests whose `Host` is not `127.0.0.1:<port>`/`localhost:<port>`, and any request with an `Origin` header (browsers) – 403.
- Limits: request body 4 MB; at most 16 concurrent sessions.

### Undo and history

- Agents use `history_undo`/`history_redo` on the one linear, shared history ([commands.md](commands.md#undo--redo)) **(Q 10)**. The stale-write rule makes an agent's undo safe by default: without a fresh read it may undo only while nobody else committed, i.e. its own step; after a query it undoes the top entry, whoever made it.
- `history.list` shows whose step is on top before undoing; undo/redo events name the entry in the log and the digest.
- Library edits (`effect`) are not undoable; the tool description says so.

## CLI

The CLI reuses the session core: same names (dotted registry names), same descriptors, same `ResultWire`, same session tools. Only framing differs. Recommended **(Q 13)**:

| Form                                                 | Behaviour                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dfyom <name> [<json> \| @file.json \| -] [options]` | One call. Names contain a dot, so they never collide with subcommands. Project scope needs `--project <file>` (or `--new <name>`): open → call → if the document changed, save (default) or `--no-save` (discard) → close. A job is always waited for, since the process owns it; `--no-wait` (print the `jobId`) is allowed only with `--connect`. |
| `dfyom batch [--project <file>]`                     | One session over JSON lines: each stdin line `{ "name", "args", "expectedRevision"? }`, each stdout line a result. Undo, jobs and revisions work across lines; `job.wait` too.                                                                                                                                                                      |
| `dfyom mcp [--areas …] [--connect [instance]]`       | Stdio MCP server, or bridge to a running instance.                                                                                                                                                                                                                                                                                                  |
| `dfyom tools [--json] [<name>]`                      | Lists names and summaries, or one descriptor with input and output schema.                                                                                                                                                                                                                                                                          |

- Options: `--data-dir` ([persistence.md](persistence.md#files-and-folders)), `--log-level` ([logging.md](../conventions/logging.md#levels)), `--json` (print the `ResultWire` instead of the value), `--expected-revision`, `--connect`, `--confirm` (sets `confirm: true` only if the args schema has it).
- Output: value as pretty JSON on stdout; errors as `code: message` plus issues on stderr; logs `warn`+ on stderr only.
- **Exit codes** (the mapping [boundaries.md](../conventions/error-handling/boundaries.md#entry-points-ui-agent-cli-automation) leaves to this doc): `0` ok · `1` `internal.unexpected` · `2` usage, `command.unknown`, `input.malformed` and other input/model codes (`quantity.*`, `expression.*`, `model.invariant`) · `3` retryable conflicts (`command.conflict`, `persist.locked`) · `4` `permission.denied` · `5` `op.aborted`, `op.timeout` · `6` any other `AppError` (domain, persistence, machine). Mapping by code in `src/core/agent/exit-codes.ts`; a test covers every `ERROR_CODES` key.

## Files (planned)

| File                            | Contents                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/core/agent/session.ts`     | `AgentSession`: source, binding, log cursor, routing (app/project scope, session tools), digest     |
| `src/core/agent/tools.ts`       | Name mapping, descriptors with `expectedRevision`, annotations, `--areas` filter, size budget       |
| `src/core/agent/results.ts`     | `CallToolResult` mapping of outcomes and `AppError`                                                 |
| `src/core/agent/primer.ts`      | Server instructions text                                                                            |
| `src/core/agent/exit-codes.ts`  | CLI exit codes by error code                                                                        |
| `src/core/project/lifecycle.ts` | `project.create/open/close/list/recovery.*` app-scope commands; `HostPort`                          |
| `src/main/host/`                | App host: storage, library, workers, machine host, app dispatcher, project runtimes; discovery file |
| `src/main/mcp/server.ts`        | MCP `Server` wiring: tools, resources, progress, cancellation                                       |
| `src/main/mcp/http.ts`          | Streamable HTTP on loopback: token, Host/Origin checks, session ids                                 |
| `src/main/cli/index.ts`         | CLI entry: argument parsing, one-shot, `batch`, `mcp`, `tools`, `--connect` bridge                  |

## Testing

Per [testing.md](../conventions/testing.md); everything runs in `npm run check` without manual steps.

| Layer          | Task | What                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mapping (core) | 3.10 | Name mapping bijective for every registry name; `tools/list` equals both registries plus session tools ([commands.md](commands.md#testing): parity is structural); annotation derivation; size budget; no `expectedRevision` arg.                                                                                                                             |
| Results (core) | 3.10 | Each outcome kind and an `AppError` with issues map to the documented `CallToolResult`; exit code for every `ERROR_CODES` key.                                                                                                                                                                                                                                |
| Session (core) | 3.10 | Binding and `noProject`; digest of other sources' events and cursor advance; `gap`; `job.wait` finish, timeout and cancellation (fake clock, in-process workers); stale-write conflict between a UI and an agent source.                                                                                                                                      |
| MCP server     | 3.10 | SDK client ↔ server over the SDK's in-memory transport: list, call, errors, progress notifications, resource subscribe/updated.                                                                                                                                                                                                                               |
| HTTP           | 3.10 | Real loopback server: 401 without/with a wrong token, 403 on foreign `Host` or any `Origin`, bound address is `127.0.0.1`, two sessions = two sources, discovery file permissions and cleanup.                                                                                                                                                                |
| Coexistence    | 3.10 | Two hosts in one test with temp data dirs: second open → `persist.locked` with the connect hint; `--connect` bridge reaches the first host's dispatcher; same-instance re-open returns `alreadyOpen`.                                                                                                                                                         |
| CLI            | 3.10 | Spawn the built CLI with `--data-dir` (temp): one-shot save/`--no-save`, `batch` across lines, exit codes, stdout holds only results (no log lines).                                                                                                                                                                                                          |
| End to end     | 3.11 | The [exit criterion](../plans/v0.1.md#exit-criteria) headless: an SDK client spawns `dfyom mcp` (built output, temp data dir) and runs create → design ops → plan → export (gCode compared with the golden file) → virtual run at `max` with `job_wait` and `run_job_continue` → save → close → reopen → compare. A CLI `batch` variant runs the same script. |

## Open questions

Each starts with the recommendation. Answer before 3.10.

1. **Tool granularity.** (a) **Recommended:** one MCP tool per command/query, input schemas with `$ref` reuse, a size-budget test and an `--areas` filter – structural parity, client-side validation, one call per action; ~28 K tokens today. (b) Three generic tools (`dfyom_call`, `dfyom_query`, `dfyom_describe`) – tiny, constant list, but every action needs a schema lookup first, no client-side validation, weaker models struggle. (c) One tool per area with an `action` discriminator – ~8 tools but the same schema size in large unions that clients handle poorly. (d) Hybrid: 1:1 for queries and frequent commands, generic call for the rest – smaller, but parity is no longer uniform.
2. **Output schemas.** (a) **Recommended:** not in `tools/list`; served by `dfyom://schema/{name}` and `dfyom tools` – saves 80 % of the size; results still carry `structuredContent`. (b) Include them – clients can validate results, but +470 K chars. (c) Include only below a size threshold – inconsistent per tool.
3. **App scope.** (a) **Recommended:** an app-scope dispatcher (same pipeline, empty doc) holding `library.*`, `feedsSpeeds.*` and new `project.*` lifecycle commands – one pipeline for logging, parsing and permission; closes two known issues. (b) App-host methods outside the command layer, wrapped by adapters – less change, but no action log, no parity check, adapters gain logic. (c) Keep library on project dispatchers and require an open project – no change, but no library use without a project.
4. **Project targeting.** (a) **Recommended:** one bound project per session (`project.bind`; open/create bind) – schemas unchanged, matches per-source stale-write state. (b) A `project` key arg on every project-scope tool – multi-project sessions, but every schema grows and every call must repeat it. (c) Binding plus an optional override key – flexible, more surface.
5. **Same project in GUI and a headless agent.** (a) **Recommended:** explicit attach – the GUI serves HTTP, stdio clients use `dfyom mcp --connect`; a headless open of a locked project fails with a connect hint. (b) Automatic forwarding when the lock holder serves HTTP – convenient, but a "headless" session silently edits the user's open project. (c) Read-only open of locked projects – already "much later" in persistence.md; no edits.
6. **Projects opened by an agent in the GUI instance.** (a) **Recommended:** open a window and stay open after the session ends – the user sees what the agent works on and owns closing. (b) Hidden until the user opens them – less intrusive, but invisible edits. (c) Close when the session ends – tidy, but loses the user's view and makes recovery prompts likely.
7. **Local HTTP enablement and auth.** (a) **Recommended:** off by default (setting or `--mcp-http`), loopback only, bearer token in an owner-only discovery file, `Host`/`Origin` checks, visible indicator. (b) On by default with the same checks – zero setup, larger exposure while unused. (c) Additionally ask the user in the GUI to approve each new session – strongest, but blocks unattended attach and tests need a bypass.
8. **Waiting for jobs.** (a) **Recommended:** job tools return `{ jobId }`; `job.wait` with timeout and MCP progress; CLI waits by default. (b) Job tools block until done (progress via `progressToken`) – one call, but long runs hit client request timeouts and hold a slot. (c) Polling `job.get` only – simplest server, many wasted calls and tokens. (d) MCP Tasks (experimental in the 2025-11-25 spec) – the protocol-native answer, but little client support yet; revisit later.
9. **Delivering user actions to agents.** (a) **Recommended:** a digest line in every tool result plus `project.log.list`, with the subscribable log resource as an extra – works in every client. (b) Resource subscription only – protocol-clean, but most clients never show the update to the model. (c) Custom server notifications – richest, invisible to the model in today's clients.
10. **Agent undo.** (a) **Recommended:** the shared linear history under the stale-write rule, plus a `history.list` query – no new semantics; an agent undoes its own step unless it re-read first. (b) Per-source undo ("undo my last step") – intuitive for multi-agent work, but needs selective undo over a linear history (conflicting patches); a large change. (c) Deny `history.*` to agents while a UI is attached – safe, loses parity.
11. **Machine permissions for agents beyond virtual** (not blocking 3.10; feeds [run.md#safety](../modes/run.md#safety)). (a) **Recommended direction:** per-session, per-connection grant by the user at the GUI, revoked on disconnect, never headless. (b) Never – agents act on real machines only through user-approved automation scripts. (c) Allowed with `confirm: true` args – an agent sets it itself, so it confirms nothing.
12. **Where `expectedRevision` goes.** (a) **Recommended:** a reserved optional top-level arg merged into each project command's schema, stripped by the adapter – flat args, same JSON as the CLI. (b) Wrapper `{ args, expectedRevision }` – no reserved name, one more nesting level on every call. (c) Not exposed – agents rely on the read baseline only; no way to pin a revision.
13. **CLI shape.** (a) **Recommended:** `dfyom <name> <json>` one-shot (open → call → save on change → close), `dfyom batch` JSON lines, `dfyom mcp`, `dfyom tools` – scriptable, reuses the session core. (b) Per-field flags generated from JSON Schema (`--depth "3 mm"`) – friendlier for people, awkward for nested args; can be added later. (c) CLI only as a client of a running instance (daemon) – keeps undo across calls, needs an instance running.
14. **Job follow-up commands** (plan known issue). (a) **Recommended:** none in v0.1; adapters never dispatch follow-ups; when a job needs one, its definition declares it and the dispatcher dispatches it with `startRevision`. (b) Keep "the caller dispatches" – agents must remember it; easy to get wrong.
15. **Headless runtime.** (a) **Recommended:** the CLI/MCP entry is a separate build output with no Electron import, run by the app's own binary with `ELECTRON_RUN_AS_NODE` (packaged) or `node` (tests) – one Node, same native ABI; needs the `runAsNode` fuse left enabled. (b) A separate Node runtime shipped with the app – fuse can be disabled, larger download. (c) The Electron app started with `--headless` and no window – utility process available, but slow start and heavier for CI.
