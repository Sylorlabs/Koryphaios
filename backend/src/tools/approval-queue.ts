import type { PermissionRequest, WSMessage } from '@koryphaios/shared';
import { wsBroker } from '../pubsub';
import { redactSecretsInText } from '../security';
import type { ToolCallInput, ToolContext } from './registry';

/** Live approvals belong to suspended tool invocations, not the chat's single
 * durable question slot. Restarted invocations must request fresh approval. */
export class ToolApprovalQueue {
  private pending = new Map<
    string,
    { request: PermissionRequest; settle: (answer: string) => void }
  >();

  constructor(private emit: (message: WSMessage) => void) {}

  list(sessionId?: string): PermissionRequest[] {
    return [...this.pending.values()]
      .map((entry) => entry.request)
      .filter((request) => !sessionId || request.sessionId === sessionId);
  }

  respond(sessionId: string, id: string, selection: string): boolean {
    const entry = this.pending.get(id);
    if (
      !entry ||
      entry.request.sessionId !== sessionId ||
      !entry.request.options?.includes(selection)
    )
      return false;
    entry.settle(selection);
    return true;
  }

  cancelSession(sessionId: string): void {
    for (const entry of this.pending.values()) {
      if (entry.request.sessionId === sessionId) entry.settle('__cancelled__');
    }
  }

  request(
    ctx: ToolContext,
    call: ToolCallInput,
    question: string,
    options: string[],
    signal = ctx.signal,
  ): Promise<string> {
    if (signal?.aborted) return Promise.resolve('__cancelled__');
    const request: PermissionRequest = {
      id: crypto.randomUUID(),
      sessionId: ctx.sessionId,
      toolName: call.name as PermissionRequest['toolName'],
      agentId: ctx.agentId,
      agentName:
        ctx.agentName ??
        ctx.callerDomain ??
        (ctx.callerRole === 'manager' ? 'Kory' : (ctx.callerRole ?? 'Agent')),
      action: 'execute',
      description: redactSecretsInText(question, 12_000),
      command:
        typeof call.input.command === 'string'
          ? redactSecretsInText(call.input.command, 12_000)
          : undefined,
      path: typeof call.input.path === 'string' ? call.input.path : undefined,
      options: [...options],
      createdAt: Date.now(),
    };
    return new Promise((resolve) => {
      const abort = () => settle('__cancelled__');
      const settle = (answer: string) => {
        if (!this.pending.delete(request.id)) return;
        signal?.removeEventListener('abort', abort);
        this.emit({
          type: 'permission.response',
          sessionId: ctx.sessionId,
          payload: { id: request.id, response: answer },
          timestamp: Date.now(),
        });
        resolve(answer);
      };
      this.pending.set(request.id, { request, settle });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        settle('__cancelled__');
        return;
      }
      this.emit({
        type: 'permission.request',
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        payload: request,
        timestamp: Date.now(),
      });
    });
  }
}

export const toolApprovalQueue = new ToolApprovalQueue((message) =>
  wsBroker.publish('custom', message),
);
export const waitForToolApproval: NonNullable<ToolContext['waitForToolApproval']> = (
  ctx,
  call,
  question,
  options,
  signal,
) => toolApprovalQueue.request(ctx, call, question, options, signal);
