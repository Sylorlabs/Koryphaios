import type { DeviceChat } from '@koryphaios/shared/src/devices';
import { isRemoteRouteAllowed } from '@koryphaios/shared';

let chat = $state<DeviceChat | null>(null);
let generation = $state(0);
export function deviceSessionKey(value: DeviceChat): string {
  return `linked-${value.deviceId}-${value.id}`;
}
export function isDeviceSessionKey(value: string): boolean {
  return value.startsWith('linked-');
}
export const deviceRouting = {
  get chat() {
    return chat;
  },
  get generation() {
    return generation;
  },
  setChat(value: DeviceChat | null) {
    generation += 1;
    chat = value;
  },
};
export function mapDeviceSessionIds(value: unknown, target: DeviceChat, incoming: boolean): any {
  if (Array.isArray(value)) return value.map((item) => mapDeviceSessionIds(item, target, incoming));
  if (!value || typeof value !== 'object') return value;
  const source = incoming ? target.id : deviceSessionKey(target);
  const destination = incoming ? deviceSessionKey(target) : target.id;
  const agentPrefix = `linkedagent-${target.deviceId}-`;
  const agentId = (id: string) =>
    ['kory-manager', 'user'].includes(id)
      ? id
      : incoming
        ? `${agentPrefix}${id}`
        : id.startsWith(agentPrefix)
          ? id.slice(agentPrefix.length)
          : id;
  const identity = 'role' in value && 'provider' in value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      (key === 'sessionId' || key === 'id') && item === source
        ? destination
        : typeof item === 'string' &&
            (['agentId', 'sourceAgentId', 'parentAgentId'].includes(key) ||
              (key === 'id' && identity))
          ? agentId(item)
          : mapDeviceSessionIds(item, target, incoming),
    ]),
  );
}
export function deviceWorkbenchPath(path: string, target: DeviceChat): string {
  return path
    .replaceAll(encodeURIComponent(deviceSessionKey(target)), encodeURIComponent(target.id))
    .replaceAll(`linkedagent-${target.deviceId}-`, '');
}
export function isDeviceWorkbenchPath(path: string, method = 'GET'): boolean {
  return isRemoteRouteAllowed(path, method);
}
