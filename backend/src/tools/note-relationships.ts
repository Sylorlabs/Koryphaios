import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import {
  proposeNoteRelationship,
  reviewNoteRelationship,
  type ProposeNoteRelationshipInput,
} from '../notes/notes-service';
import { checkNoteToolPermission } from '../notes/notes-settings';
import { broadcastNotesNetworkUpdate } from '../notes/notes-events';
import { noteHostProvenance } from './note-host-provenance';
import {
  proposeNoteRelationshipSchema,
  reviewNoteRelationshipSchema,
} from './note-relationship-schema';

async function run(
  ctx: ToolContext,
  call: ToolCallInput,
  review: boolean,
): Promise<ToolCallOutput> {
  const start = Date.now();
  try {
    const root = ctx.settingsRoot ?? ctx.workingDirectory;
    const name = review ? 'review_note_relationship' : 'propose_note_relationship';
    const permission = checkNoteToolPermission(name, root, { mode: ctx.permissionPolicy?.mode });
    if (!permission.allowed) throw new Error(permission.reason);
    // Explicit Ask requires an invocation-bound receipt in every mode.
    if (permission.requiresApproval && !ctx.approvedToolCallIds?.has(call.id))
      throw new Error('This relationship action requires approval');
    if (ctx.signal?.aborted) throw new Error('Relationship action cancelled');
    const host = { provenance: 'agent' as const, actor: noteHostProvenance(ctx) };
    const input = call.input;
    const result = review
      ? await reviewNoteRelationship(
          input.fromId as string,
          input.toId as string,
          input as unknown as { status: 'accepted' | 'rejected'; expectedRevision: number },
          root,
          host,
        )
      : await proposeNoteRelationship(input as unknown as ProposeNoteRelationshipInput, root, host);
    broadcastNotesNetworkUpdate('update', result.fromId, ctx.sessionId);
    return {
      callId: call.id,
      name: call.name,
      output: JSON.stringify(result),
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
  } finally {
    // A receipt is for this invocation, not a capability reusable by another call.
    ctx.approvedToolCallIds?.delete(call.id);
  }
}
export const proposeNoteRelationshipTool: Tool = {
  name: 'propose_note_relationship',
  role: 'worker',
  description:
    'Propose one typed, revision-bound evidence relationship. Does not accept it as fact. Read both endpoints first; never infer support or contradiction from similarity alone.',
  inputSchema: proposeNoteRelationshipSchema,
  run: (ctx, call) => run(ctx, call, false),
};
export const reviewNoteRelationshipTool: Tool = {
  name: 'review_note_relationship',
  role: 'worker',
  description:
    'Accept or reject one proposed relationship at its expected revision according to the dedicated review permission; stale evidence cannot be accepted.',
  inputSchema: reviewNoteRelationshipSchema,
  run: (ctx, call) => run(ctx, call, true),
};
