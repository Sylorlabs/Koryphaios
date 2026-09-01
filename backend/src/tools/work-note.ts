import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';
import { createNote } from '../notes/notes-service';
import { broadcastNotesNetworkUpdate } from '../notes/notes-events';
import {
  buildWorkNote,
  type WorkNoteInput,
  type WorkNoteStatus,
  type WorkNoteTestEvidence,
} from '../notes/work-note';

const VALID_STATUSES = new Set<WorkNoteStatus>(['completed', 'partial', 'blocked', 'decision']);

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

function testEvidence(value: unknown): WorkNoteTestEvidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
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
      decisions: { type: 'array', items: { type: 'string' } },
      changedFiles: { type: 'array', items: { type: 'string' } },
      commands: { type: 'array', items: { type: 'string' } },
      tests: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            outcome: { type: 'string', enum: ['pass', 'fail', 'not-run'] },
            evidence: { type: 'string' },
          },
          required: ['name', 'outcome'],
        },
      },
      evidence: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
      followUps: { type: 'array', items: { type: 'string' } },
      relatedNotes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact note titles to connect using wikilinks',
      },
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
      const built = buildWorkNote(input, {
        sessionId: ctx.sessionId,
        provider: ctx.activeProvider,
        model: ctx.activeModel,
        reasoningLevel: ctx.reasoningLevel,
        agentId: ctx.agentId,
        goalId: ctx.goalId,
        goalItemId: ctx.goalItemId,
      });
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
