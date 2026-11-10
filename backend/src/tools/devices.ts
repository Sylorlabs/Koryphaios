import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import { decideToolPermission } from './permission-policy';
import { deviceService } from '../devices/service';

function manager(ctx: ToolContext) {
  if (
    ctx.callerRole !== 'manager' &&
    !(ctx.callerRole === undefined && ctx.agentId === 'kory-manager')
  )
    throw new Error('Only the session manager can route work to another device');
  if (!ctx.sessionId) throw new Error('Device access requires a session');
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
      return {
        callId: call.id,
        name: call.name,
        isError: true,
        durationMs: 0,
        output: error instanceof Error ? error.message : 'Device discovery failed',
      };
    }
  }
}
export class ControlLinkedDeviceTool implements Tool {
  readonly name = 'control_linked_device';
  readonly role = 'manager' as const;
  readonly description =
    'Use a user-authorized linked desktop. Discover its workspaces and chats using opaque IDs, create a chat there, submit a task to its Kory manager, inspect progress, or cancel work. Never send local filesystem paths. Both desktops must grant agent access. Remote tools retain the target desktop’s permissions; this tool cannot approve prompts, pair devices, run raw shell commands, or change grants.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      deviceId: { type: 'string' },
      operation: {
        type: 'string',
        enum: ['workspaces', 'folders', 'sessions', 'snapshot', 'create_chat', 'prompt', 'cancel'],
      },
      input: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          sessionId: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
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
      const operations = [
        'workspaces',
        'folders',
        'sessions',
        'snapshot',
        'create_chat',
        'prompt',
        'cancel',
      ];
      const operation = String(call.input.operation);
      if (!operations.includes(operation)) throw new Error('Unsupported device operation');
      // A remote mutation is still a mutation: the host policy that governs
      // local writes must deny it while the user is planning, before anything
      // reaches the linked desktop.
      const host = decideToolPermission(ctx.permissionPolicy, 'control_linked_device');
      if (host.action === 'deny') throw new Error(host.reason);
      await deviceService.initialize();
      const result = await deviceService.rpc(
        String(call.input.deviceId),
        operation,
        (call.input.input ?? {}) as Record<string, unknown>,
        'agent',
        ctx.signal,
      );
      return {
        callId: call.id,
        name: call.name,
        isError: false,
        durationMs: Date.now() - started,
        output: JSON.stringify(result),
      };
    } catch (error) {
      return {
        callId: call.id,
        name: call.name,
        isError: true,
        durationMs: Date.now() - started,
        output: error instanceof Error ? error.message : 'Remote device request failed',
      };
    }
  }
}
