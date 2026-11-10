import { expect, test } from 'vitest';
import {
  deviceSessionKey,
  deviceWorkbenchPath,
  isDeviceWorkbenchPath,
  mapDeviceSessionIds,
} from './device-routing.svelte';
const chat = {
  id: 'chat',
  deviceId: 'linux',
  deviceName: 'VPS',
  title: 'Remote',
  workspaceName: 'work',
};
test('chat and worker identities stay distinct from the local instance', () => {
  const payload = {
    sessionId: 'chat',
    agent: { id: 'worker', role: 'worker', provider: 'antigravity' },
    content: 'chat',
  };
  const mapped = mapDeviceSessionIds(payload, chat, true);
  expect(mapped.sessionId).toBe(deviceSessionKey(chat));
  expect(mapped.agent.id).toBe('linkedagent-linux-worker');
  expect(mapped.content).toBe('chat');
  expect(mapDeviceSessionIds(mapped, chat, false)).toEqual(payload);
  expect(
    deviceWorkbenchPath(`/api/agent/${mapped.agent.id}/thread?sessionId=${mapped.sessionId}`, chat),
  ).toBe('/api/agent/worker/thread?sessionId=chat');
});
test('instance authentication, provider configuration and linking stay on the local administration path', () => {
  for (const path of ['/api/providers', '/api/auth/local/session', '/api/devices', '/api/sessions'])
    expect(isDeviceWorkbenchPath(path)).toBe(false);
  expect(isDeviceWorkbenchPath('/api/messages')).toBe(true);
  expect(isDeviceWorkbenchPath('/api/notes/note-1')).toBe(true);
  expect(isDeviceWorkbenchPath('/api/providers/models')).toBe(false);
  expect(isDeviceWorkbenchPath('/api/appearance', 'GET')).toBe(true);
  expect(isDeviceWorkbenchPath('/api/appearance', 'OPTIONS')).toBe(false);
  expect(isDeviceWorkbenchPath('/api/sessions', 'GET')).toBe(false);
  expect(isDeviceWorkbenchPath(`/api/sessions/${deviceSessionKey(chat)}/cancel`)).toBe(true);
});
