/**
 * Manager tool exposure.
 *
 * Every manager tool is advertised on every turn under its real name, with a
 * short hint instead of prose, and a permissive stub instead of its full JSON
 * Schema. Names are the cheap part of a tool declaration and the only part a
 * model needs to decide that a tool is relevant, so nothing is hidden.
 *
 * The real schema is not discarded. A stubbed call is validated against the
 * authoritative schema at execution time, and a rejected call returns that
 * schema in its tool result so the model can correct itself on the next
 * attempt. Stub schemas are identical for every tool, which also keeps the
 * provider prompt-cache prefix byte-stable regardless of how tools are
 * registered.
 */

import { fromJsonSchema } from '@modelcontextprotocol/server';

export interface ExposedToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The advertised schema for every tool. Permissive on purpose: the authoritative
 * schema is enforced at execution, not advertised.
 */
export const STUB_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: true,
});

/**
 * Hints for tools whose name alone misleads. Everything else derives a param
 * hint from the tool's own `required` list, which keeps hints correct as
 * schemas change. Each entry stays short: it disambiguates, it does not
 * document.
 */
const EXPOSURE_HINTS: Readonly<Record<string, string>> = Object.freeze({
  ask_manager: 'Ask the manager agent, not the human. params: question',
  ask_user: 'Ask the human and wait for their answer. params: question, options',
  request_manager_relay: 'Relay a message to the manager on another agent behalf.',
  send_agent_message: 'Send a message to another agent. params: body',
  fetch_context: 'Pull previously pruned context back into the window. params: id, query',
  prune_context: 'Drop context out of the window to free space. params: ids',
  read_note: 'Return the text content of a note. params: title, id',
  render_note: 'Render a note into another format. params: id, mode',
  get_note_properties: 'Read one property on a note. params: noteId',
  set_note_property: 'Write one property on a note. params: noteId, key, type, value',
  'analyze-error': 'Explain one already-detected error. params: errorId',
  'detect-errors': 'Scan a source tree for errors. params: source, language, files',
  'suggest-fixes': 'Propose fixes for a detected error. params: errorId',
  delegate_to_jules: 'Delegate to a remote Google Jules cloud VM. params: task',
  delegate_to_worker: 'Delegate to a local specialist worker. params: task, domain',
  ghost_commit: 'Commit work-in-progress locally. params: label',
  commit_and_create_pr: 'Commit, push, and open a pull request. params: taskDescription',
  get_resource_budget: 'Report remaining provider credit and rate limits.',
  load_skill_detail: 'Load the full instructions for one skill. params: name',
  recall_notes: 'Semantic search across saved notes. params: query, titles, ids',
  search_notes: 'Keyword search across saved notes. params: query',
  delete_note: 'Delete a note. params: id, title',
  get_note_graph_summary: 'Summarize the link graph between notes.',
  get_note_backlinks: 'List notes linking to a note. params: title, id',
  link_notes: 'Create a link between two notes. params: fromId, toId',
  unlink_notes: 'Remove a link between two notes. params: fromId, toId',
  query_note_base: 'Read rows from a structured note base. params: baseId, baseName',
  ls: 'List directory entries. params: path, depth',
  list_workflows: 'List workflow definitions and their stages.',
  update_goal: 'Record goal evidence or report a blocker. params: status, message',
  create_goal: 'Start a durable autonomous goal. params: objective, scope',
  edit_goal_checklist:
    'Reshape a goal plan: add, rename, reorder, or delete checks. params: goalId, items',
  create_checklist: 'Create a checklist to track multi-step work. params: title',
  list_checklists: 'List checklists visible in this chat',
  read_checklist: 'Read a checklist and its items. params: id',
  add_checklist_item: 'Append items to a checklist. params: id, items',
  check_checklist_item: 'Mark a checklist item done, skipped, or pending. params: id, itemId',
  update_checklist: 'Replace a checklist title or its item plan. params: id, title, items',
  delete_checklist: 'Permanently delete a checklist. params: id',
  start_workflow: 'Run a workflow definition. params: workflowId, task',
  update_workflow: 'Advance a workflow stage with evidence. params: runId, evidence, status',
  create_workflow_draft: 'Draft a new workflow definition. params: name, description, stages',
  record_work_note: 'Log a work session. params: title, summary, status',
  manage_mcp_server: 'Add, remove, or configure an MCP server. params: action, name',
  shell_manage: 'List, kill, or read a background shell process. params: action, processId',
  batch_edit: 'Apply several file edits in one call. params: files',
});

/** Param names worth naming in a hint. Past this the list stops being a hint. */
const MAX_HINTED_PARAMS = 4;

function deriveParamHint(schema: Record<string, unknown>): string | undefined {
  const required = schema.required;
  if (!Array.isArray(required)) return undefined;
  const names = required.filter((name): name is string => typeof name === 'string');
  if (names.length === 0 || names.length > MAX_HINTED_PARAMS) return undefined;
  return `params: ${names.join(', ')}`;
}

/** The one-line hint advertised for a tool, or undefined when its name suffices. */
export function toolExposureHint(
  name: string,
  schema: Record<string, unknown>,
): string | undefined {
  return EXPOSURE_HINTS[name] ?? deriveParamHint(schema);
}

function byName(a: ExposedToolDefinition, b: ExposedToolDefinition): number {
  return a.name.localeCompare(b.name);
}

/**
 * Build the manager's advertised toolset: every tool, named, hinted, stubbed.
 * Output is sorted so plugin load order cannot perturb the prompt-cache prefix.
 */
export function buildExposedToolset(
  tools: readonly ExposedToolDefinition[],
): ExposedToolDefinition[] {
  return tools
    .map((tool) => {
      // A tool whose name is self-describing gets an empty description: the
      // name is the whole signal, and providers require the field to be present.
      const hint = toolExposureHint(tool.name, tool.inputSchema);
      return {
        name: tool.name,
        description: hint ?? '',
        inputSchema: STUB_INPUT_SCHEMA as Record<string, unknown>,
      };
    })
    .sort(byName);
}

export type ToolInputValidation =
  { valid: true; value: Record<string, unknown> } | { valid: false; error: string };

/** Validate a call against a tool's authoritative JSON Schema. */
export async function validateToolInputAgainstSchema(
  schema: Record<string, unknown>,
  input: unknown,
): Promise<ToolInputValidation> {
  try {
    const wrapped = fromJsonSchema(schema) as unknown as {
      '~standard': {
        validate: (
          value: unknown,
        ) =>
          | { value?: unknown; issues?: Array<{ message?: string }> }
          | Promise<{ value?: unknown; issues?: Array<{ message?: string }> }>;
      };
    };
    const result = await wrapped['~standard'].validate(input);
    if (result.issues?.length) {
      return {
        valid: false,
        error:
          result.issues
            .map((issue) => issue.message?.trim())
            .filter((message): message is string => Boolean(message))
            .slice(0, 3)
            .join('; ') || 'Input does not match the tool schema.',
      };
    }
    if (!result.value || typeof result.value !== 'object' || Array.isArray(result.value)) {
      return { valid: false, error: 'Tool input must be an object.' };
    }
    return { valid: true, value: result.value as Record<string, unknown> };
  } catch {
    return { valid: false, error: 'Tool input schema could not be validated.' };
  }
}

/**
 * The tool result a stubbed call receives when it does not match the real
 * schema. Carrying the authoritative schema is what lets the model recover
 * without a separate discovery call.
 */
export function toolSchemaGuidance(
  name: string,
  schema: Record<string, unknown>,
  problem: string,
): string {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const requiredLine = required.length > 0 ? `\nRequired keys: ${required.join(', ')}` : '';
  return [
    `${name} rejected this call: ${problem}`,
    `The advertised schema is a stub. Use this exact input schema instead:${requiredLine}`,
    JSON.stringify(schema, null, 2),
    `Call ${name} again with input matching that schema.`,
  ].join('\n');
}
