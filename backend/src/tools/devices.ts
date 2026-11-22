import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import { decideToolPermission } from './permission-policy';
import { deviceService } from '../devices/service';
import { materializeDelegatedWork } from '../devices/delegated-work';
import { getContext } from '../context';
import {
  buildDelegationAnnouncement,
  normalizeComputeDelegation,
} from '@koryphaios/shared/src/compute-delegation';

function manager(ctx: ToolContext) {
  if (
    ctx.callerRole !== 'manager' &&
    !(ctx.callerRole === undefined && ctx.agentId === 'kory-manager')
  )
    throw new Error('Only the session manager can route work to another device');
  if (!ctx.sessionId) throw new Error('Device access requires a session');
}

function failure(call: ToolCallInput, started: number, error: unknown): ToolCallOutput {
  return {
    callId: call.id,
    name: call.name,
    isError: true,
    durationMs: Date.now() - started,
    output: error instanceof Error ? error.message : 'Remote device request failed',
  };
}

export class ListLinkedDevicesTool implements Tool {
  readonly name = 'list_linked_devices';
  readonly role = 'manager' as const;
  readonly description =
    'List linked desktops that the user has explicitly enabled for agent routing. Device names and OS are shown; never guess local paths for another computer.';
  readonly inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    try {
      manager(ctx);
      await deviceService.initialize();
      return {
        callId: call.id,
        name: call.name,
        isError: false,
        durationMs: 0,
        output: JSON.stringify(
          deviceService
            .status()
            .peers.filter((p) => p.agentRouting && p.kind === 'desktop')
            .map((p) => ({ id: p.id, name: p.name, os: p.os, online: p.online })),
        ),
      };
    } catch (error) {
      return failure(call, Date.now(), error);
    }
  }
}

export class ControlLinkedDeviceTool implements Tool {
  readonly name = 'control_linked_device';
  readonly role = 'manager' as const;
  readonly description =
    'Use a user-authorized linked desktop. Discover workspaces and chats using opaque IDs, create a chat there, submit a task, inspect progress, or cancel work. `delegate` starts work on the target with an explicit placement: `stay` keeps it there, `return` brings the changes back to this machine for review. The target chat\'s manager owns that work and spawns its workers there, so the turn survives this machine disconnecting; do not mirror it with local workers. Returned work is never committed or pushed. `collect_work` exports the target checkout changes and writes them under this workspace\'s .koryphaios/incoming for review. Never send local filesystem paths. Both desktops must grant agent access. Remote tools retain the target desktop\'s permissions; this tool cannot approve prompts, pair devices, run raw shell commands, or change grants.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      deviceId: { type: 'string' },
      operation: {
        type: 'string',
        enum: [
          'workspaces',
          'folders',
          'sessions',
          'snapshot',
          'create_chat',
          'prompt',
          'cancel',
          'delegate',
          'collect_work',
        ],
      },
      input: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          sessionId: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          policy: { type: 'string', enum: ['stay', 'return'] },
          commit: { type: 'string', enum: ['none', 'local'] },
          summary: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    required: ['deviceId', 'operation'],
    additionalProperties: false,
  };
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const started = Date.now();
    try {
      manager(ctx);
      const operations = this.inputSchema.properties.operation.enum as readonly string[];
      const operation = String(call.input.operation);
      if (!operations.includes(operation)) throw new Error('Unsupported device operation');
      // A remote mutation is still a mutation: the host policy that governs
      // local writes must deny it while the user is planning, before anything
      // reaches the linked desktop.
      const host = decideToolPermission(ctx.permissionPolicy, 'control_linked_device');
      if (host.action === 'deny') throw new Error(host.reason);
      await deviceService.initialize();
      const input = (call.input.input ?? {}) as Record<string, unknown>;
      const deviceId = String(call.input.deviceId);

      if (operation === 'delegate') {
        const content = typeof input.content === 'string' ? input.content.trim() : '';
        if (!content) throw new Error('delegate requires the task in input.content');
        if (typeof input.workspaceId !== 'string' || !input.workspaceId)
          throw new Error('delegate requires a target workspaceId from the workspaces operation');
        const delegation = normalizeComputeDelegation({
          placement: input.policy === 'return' ? 'return' : 'stay',
          commit: input.commit === 'local' ? 'local' : 'none',
          sourceSessionId: ctx.sessionId,
        });
        const chat = await deviceService.rpc(
          deviceId,
          'create_chat',
          {
            workspaceId: input.workspaceId,
            title: typeof input.title === 'string' ? input.title : 'Delegated work',
            delegation,
          },
          'agent',
          ctx.signal,
        );
        try {
          const run = await deviceService.rpc(
            deviceId,
            'prompt',
            { sessionId: chat.id, content, delegation },
            'agent',
            ctx.signal,
          );
          return {
            callId: call.id,
            name: call.name,
            isError: false,
            durationMs: Date.now() - started,
            output: JSON.stringify({
              sessionId: chat.id,
              deviceId,
              deviceName: chat.deviceName,
              workspaceName: chat.workspaceName,
              accepted: run.accepted !== false,
              runId: run.runId,
              delegation,
              announcement: buildDelegationAnnouncement({
                deviceName: String(chat.deviceName ?? 'the linked computer'),
                workspaceName: String(chat.workspaceName ?? 'workspace'),
                placement: delegation.placement,
              }),
            }),
          };
        } catch (error) {
          throw new Error(
            `Remote chat ${chat.id} was created but the task was not accepted: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      if (operation === 'collect_work') {
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
        if (!sessionId) throw new Error('collect_work requires the target chat sessionId');
        const bundle = await deviceService.rpc(
          deviceId,
          'export_work',
          {
            sessionId,
            ...(typeof input.summary === 'string' ? { summary: input.summary } : {}),
          },
          'agent',
          ctx.signal,
        );
        if (bundle?.placement !== 'return')
          throw new Error(
            'This chat is set to keep its work on the target. Only a chat delegated with policy "return" may be collected.',
          );
        const origin = await getContext().sessions.getActive(ctx.sessionId!);
        if (!origin?.workingDirectory)
          throw new Error('The origin chat has no workspace to receive the returned work');
        const materialized = materializeDelegatedWork(origin.workingDirectory, bundle);
        return {
          callId: call.id,
          name: call.name,
          isError: false,
          durationMs: Date.now() - started,
          output: JSON.stringify({
            ...materialized,
            files: bundle.files.length,
            placement: bundle.placement,
            commit: bundle.commit,
            targetSessionId: sessionId,
            note: 'Nothing was applied, committed, or pushed. Review changes.patch and files/ before applying.',
          }),
        };
      }

      const result = await deviceService.rpc(deviceId, operation, input, 'agent', ctx.signal);
      return {
        callId: call.id,
        name: call.name,
        isError: false,
        durationMs: Date.now() - started,
        output: JSON.stringify(result),
      };
    } catch (error) {
      return failure(call, started, error);
    }
  }
}
