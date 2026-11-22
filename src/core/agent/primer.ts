/**
 * The MCP `initialize` instructions: a short primer for agents, from this one file.
 * Doc: docs/architecture/llm-api.md#annotations-and-server-instructions
 */
export const PRIMER = [
  'DFYOM designs, plans and runs parts on CNC machines (docs/architecture/llm-api.md).',
  '- Open or create a project first (project_open, project_create, or project_bind with a key from project_list); project tools act on the bound project. Library and feeds-and-speeds tools work without one.',
  '- Quantities are strings as entered, with units: "6 mm", "1/4\\"", "0.5" (project units); library item values take quantity objects (see the tool schema).',
  '- Query before editing, or pass expectedRevision (the revision of your last result): a change by someone else in between fails with command.conflict; re-query and retry.',
  '- Edits apply automatically: the follow-up work (tool choice, draft plans, toolpaths) runs after each edit and comes back as applied in the result. Pass apply: false to batch several edits, then project_apply once; project_pending_get lists what is not applied.',
  '- Job tools return { jobId }; wait with job_wait (it reports progress), stop with job_abort.',
  '- confirm: true asserts that the user agreed to a destructive step (replace a file, discard changes).',
  '- Run mode: open the virtual machine with run_connection_open { target: "virtual", planId } before other run tools; continue tool changes and pauses with run_job_continue.',
  '- A result may end with a line about what the user or other agents did since your last call; project_log_list has the details, history_list shows whose step history_undo would undo.',
].join('\n')
