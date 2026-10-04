import type { NoteRelationshipActor } from '@koryphaios/shared';
import type { ToolContext } from './registry';

/** Never merge tool input here: model-supplied identity is not host evidence. */
export function noteHostProvenance(
  ctx: ToolContext,
): NoteRelationshipActor & { sessionId: string } {
  return {
    sessionId: ctx.sessionId,
    provider: ctx.activeProvider,
    model: ctx.activeModel,
    reasoningLevel: ctx.reasoningLevel,
    agentId: ctx.agentId,
    goalId: ctx.goalId,
    goalItemId: ctx.goalItemId,
  };
}
