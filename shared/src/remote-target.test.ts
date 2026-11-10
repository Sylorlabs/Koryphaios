import { describe, expect, test } from 'bun:test';
import {
  capabilityIsAvailable,
  isExecutionTarget,
  isLocalExecutionTarget,
  remoteRouteDescriptor,
} from './remote-target';

describe('remote target contract', () => {
  test('accepts target identity without treating presentation ids as paths or credentials', () => {
    expect(
      isExecutionTarget({ kind: 'linked-device', deviceId: 'device-1', sessionId: 'chat-1' }),
    ).toBe(true);
    expect(
      isExecutionTarget({ kind: 'remote-instance', instanceId: 'vps-1', sessionId: 'chat-1' }),
    ).toBe(true);
    expect(isExecutionTarget({ kind: 'remote-instance', instanceId: 'vps-1' })).toBe(false);
    expect(isExecutionTarget({ kind: 'local', backendId: '' })).toBe(false);
  });

  test('availability is explicit and not inferred from a capability name', () => {
    expect(capabilityIsAvailable({ name: 'approvals', state: 'available' })).toBe(true);
    expect(capabilityIsAvailable({ name: 'approvals', state: 'approval_required' })).toBe(false);
    expect(capabilityIsAvailable(undefined)).toBe(false);
  });

  test('MCP bridge targets are local and backend-specific', () => {
    expect(isLocalExecutionTarget({ kind: 'local', backendId: 'desktop-1' }, 'desktop-1')).toBe(true);
    expect(isLocalExecutionTarget({ kind: 'local', backendId: 'desktop-2' }, 'desktop-1')).toBe(false);
    expect(
      isLocalExecutionTarget(
        { kind: 'linked-device', deviceId: 'phone-1', sessionId: 'chat-1' },
        'desktop-1',
      ),
    ).toBe(false);
    expect(isLocalExecutionTarget(undefined, 'desktop-1')).toBe(false);
  });

  test('route descriptors identify supported methods without becoming an auth bypass', () => {
    expect(remoteRouteDescriptor('/api/messages', 'POST')?.id).toBe('messages');
    expect(remoteRouteDescriptor('/api/notes/note-1', 'GET')?.capability).toBe('notes');
    expect(remoteRouteDescriptor('/api/providers', 'GET')).toBeUndefined();
    expect(remoteRouteDescriptor('/api/messages', 'DELETE')).toBeUndefined();
  });

  test('the shared registry covers target workbench routes and excludes collections', () => {
    expect(remoteRouteDescriptor('/api/appearance', 'GET')?.id).toBe('appearance');
    expect(remoteRouteDescriptor('/api/sessions/chat-1', 'PATCH')?.id).toBe('sessions');
    expect(remoteRouteDescriptor('/api/sessions', 'GET')).toBeUndefined();
    expect(remoteRouteDescriptor('/api/sessions/', 'GET')).toBeUndefined();
    expect(remoteRouteDescriptor('/api/mode', 'POST')?.id).toBe('mode');
    expect(remoteRouteDescriptor('/api/v1/agent-messages/one', 'GET')?.id).toBe('agent-messages');
    expect(remoteRouteDescriptor('/api/spend-caps', 'DELETE')?.id).toBe('spend-caps');
    expect(remoteRouteDescriptor('/api/health', 'POST')).toBeUndefined();
  });
});
