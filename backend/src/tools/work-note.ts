import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';
import { createNote } from '../notes/notes-service';
import { noteHostProvenance } from './note-host-provenance';
import { broadcastNotesNetworkUpdate } from '../notes/notes-events';
import {
  buildWorkNote,
  type WorkNoteInput,
  type WorkNoteStatus,
  type WorkNoteTestEvidence,
} from '../notes/work-note';

const VALID_STATUSES = new Set<WorkNoteStatus>(['completed', 'partial', 'blocked', 'decision']);

/**
 * The manager advertises this tool with a stub schema, so a model is guessing at
 * the shape of the list fields. It reliably guesses "one string" or "a
 * newline-delimited block" instead of an array. Accept both rather than burning
 * a turn on a schema rejection and a dumped schema in the transcript.
 */
const LIST_SCHEMA = Object.freeze({
  anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
});

function listSchema(description: string): Record<string, unknown> {
  return { ...LIST_SCHEMA, description };
}

const TEST_OBJECT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    name: { type: 'string' },
    outcome: { type: 'string', enum: ['pass', 'fail', 'not-run'] },
    evidence: { type: 'string' },
  },
  required: ['name', 'outcome'],
});

const LIST_BULLET = /^[-*•]\s+/;

/** Accept an array, or a bare string / newline-delimited block as one. */
function stringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return undefined;
  return value
    .split('\n')
    .map((line) => line.replace(LIST_BULLET, '').trim())
    .filter(Boolean);
}

const OUTCOME_PATTERNS: ReadonlyArray<readonly [RegExp, WorkNoteTestEvidence['outcome']]> = [
  [/\b(?:not[\s_-]?run|skipped|pending|todo)\b/i, 'not-run'],
  [/\bpass(?:ed|es|ing)?\b/i, 'pass'],
  [/\bfail(?:ed|s|ing|ure)?\b/i, 'fail'],
];

/** Parse "bun test (pass)" into { name: 'bun test', outcome: 'pass' }. */
function parseTestString(value: string): WorkNoteTestEvidence {
  const text = value.replace(LIST_BULLET, '').trim();
  const match = OUTCOME_PATTERNS.find(([pattern]) => pattern.test(text));
  const name = (match ? text.replace(match[0], '') : text)
    .replace(/^[\s:(\[-]+/, '')
    .replace(/[\s:)\]-]+$/, '')
    .trim();
  return { name: name || text, outcome: match?.[1] ?? 'not-run' };
}

function testEvidence(value: unknown): WorkNoteTestEvidence[] | undefined {
  if (value === undefined || value === null) return undefined;
  const rows = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split('\n')
      : [value];
  return rows.map((entry) => {
    if (typeof entry === 'string') return parseTestString(entry);
    const row = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const outcome =
      row.outcome === 'pass' || row.outcome === 'fail' || row.outcome === 'not-run'
        ? row.outcome
        : 'not-run';
    return {
      name: String(row.name ?? ''),
      outcome,
      evidence: row.evidence === undefined ? undefined : String(row.evidence),
    };
  });
}

/**
 * Record a structured work result with provenance supplied by the Koryphaios
 * host, not by the agent. This turns implementation output into durable,
 * searchable evidence without trusting a model to identify its own run.
 */
export const recordWorkNoteTool: Tool = {
  name: 'record_work_note',
  description:
    'Record an evidence-backed work note. Koryphaios binds the note to the authenticated session and all provider, model, agent, and goal provenance available to the host. Use after meaningful implementation, verification, a decision, or a blocker.',
  role: 'worker',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Specific result or decision title' },
      summary: { type: 'string', description: 'Concise outcome grounded in the supplied evidence' },
      status: {
        type: 'string',
        enum: ['completed', 'partial', 'blocked', 'decision'],
      },
      objective: { type: 'string' },
      decisions: listSchema('Decisions made, as a list or a newline-delimited block'),
      changedFiles: listSchema('Files changed, as a list or a newline-delimited block'),
      commands: listSchema('Commands run, as a list or a newline-delimited block'),
      tests: {
        description:
          'Verification evidence as {name, outcome, evidence} objects, or plain strings such as "bun test (pass)"',
        anyOf: [
          { type: 'array', items: TEST_OBJECT_SCHEMA },
          { type: 'array', items: { type: 'string' } },
          { type: 'string' },
        ],
      },
      evidence: listSchema('Supporting evidence, as a list or a newline-delimited block'),
      risks: listSchema('Known risks, as a list or a newline-delimited block'),
      followUps: listSchema('Follow-up work, as a list or a newline-delimited block'),
      relatedNotes: listSchema('Exact note titles to connect using wikilinks'),
      includeInContext: {
        type: 'boolean',
        description: 'Pin this work note into future agent context (default false)',
      },
    },
    required: ['title', 'summary', 'status'],
  },
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    try {
      const raw = call.input as Record<string, unknown>;
      const status = String(raw.status ?? '') as WorkNoteStatus;
      if (!VALID_STATUSES.has(status)) throw new Error(`Invalid work note status: ${status}`);

      const input: WorkNoteInput = {
        title: String(raw.title ?? ''),
        summary: String(raw.summary ?? ''),
        status,
        objective: raw.objective === undefined ? undefined : String(raw.objective),
        decisions: stringArray(raw.decisions),
        changedFiles: stringArray(raw.changedFiles),
        commands: stringArray(raw.commands),
        tests: testEvidence(raw.tests),
        evidence: stringArray(raw.evidence),
        risks: stringArray(raw.risks),
        followUps: stringArray(raw.followUps),
        relatedNotes: stringArray(raw.relatedNotes),
        includeInContext: Boolean(raw.includeInContext),
      };
      const built = buildWorkNote(input, noteHostProvenance(ctx));
      const note = await createNote(built, ctx.workingDirectory);
      broadcastNotesNetworkUpdate('create', note.id, ctx.sessionId);
      return {
        callId: call.id,
        name: call.name,
        output: JSON.stringify({
          id: note.id,
          title: note.title,
          folderPath: note.folderPath,
          status,
          sessionId: ctx.sessionId,
        }),
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        callId: call.id,
        name: call.name,
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  },
};
