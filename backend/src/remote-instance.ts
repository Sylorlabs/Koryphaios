/**
 * Headless remote-instance host.
 *
 * A VPS does not need to expose the Koryphaios HTTP server. When explicitly
 * enabled, the backend creates one durable base chat, hosts it through the
 * existing outbound collaboration relay, and writes the short-lived join
 * projection to a 0600 state file. The desktop client still joins through the
 * normal collaboration flow and the relay remains the only public transport.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { PROJECT_ROOT } from './runtime/paths';
import { collaborationManager, type CollaborationHostSnapshot } from './collaboration/manager';
import { getContext } from './context';
import { serverLog } from './logger';
import type { CollaborationPolicy } from '@koryphaios/shared';
import { startRemoteInstanceEvents } from './remote-instance-events';
import { setSessionAgentOverrides } from './stores/session-agent-overrides';

const log = serverLog.child({ module: 'remote-instance' });
let stopEvents: (() => Promise<void>) | null = null;

export async function stopRemoteInstanceHost(): Promise<void> {
  const stop = stopEvents;
  stopEvents = null;
  await stop?.();
}

type RemoteInstanceState = {
  version: 1;
  baseSessionId: string;
  collaborationSessionId: string | null;
  joinCode: string | null;
  hostName: string;
  sessionName: string;
  workspacePath: string;
  updatedAt: string;
};

function enabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env.KORYPHAIOS_REMOTE_CONTROL ?? '').trim().toLowerCase(),
  );
}

function statePath(): string {
  return (
    process.env.KORYPHAIOS_REMOTE_CONTROL_STATE_FILE?.trim() ||
    join(PROJECT_ROOT, '.koryphaios', 'remote-control.json')
  );
}

function setting(name: string, fallback: string, maxLength: number): string {
  const value = process.env[name]?.trim();
  return (value || fallback).slice(0, maxLength);
}

async function readState(path: string): Promise<RemoteInstanceState | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<RemoteInstanceState>;
    if (parsed.version !== 1 || typeof parsed.baseSessionId !== 'string') {
      return null;
    }
    return parsed as RemoteInstanceState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeState(path: string, state: RemoteInstanceState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    // Atomic replacement preserves owner-only mode even for an older loose file.
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function remotePolicy(
  current: CollaborationPolicy,
  hostName: string,
  sessionName: string,
  workspacePath: string,
): Partial<CollaborationPolicy> {
  return {
    hostName,
    sessionName,
    workspacePaths: [workspacePath],
    joinMode: 'auto',
    defaultTierId: 'yolo',
    // Keep the built-in tiers, but make the explicit headless mode usable:
    // there is no desktop host present to approve each guest prompt.
    accessTiers: current.accessTiers.map((tier) =>
      tier.id === 'yolo'
        ? {
            ...tier,
            allowedModels: ['*'],
            permissions: {
              ...tier.permissions,
              submitPrompts: true,
              autoExecutePrompts: true,
              useTools: true,
              fullSystemAccess: true,
              readPaths: ['**'],
              writePaths: ['**'],
              commandAllowlist: ['*'],
            },
          }
        : tier,
    ),
  };
}

/** Start the opt-in relay host used by a headless VPS installation. */
export async function startRemoteInstanceHost(): Promise<CollaborationHostSnapshot | null> {
  if (!enabled()) return null;

  if (!process.env.RELAY_URL?.trim() || !process.env.RELAY_HOST_SECRET?.trim()) {
    throw new Error(
      'KORYPHAIOS_REMOTE_CONTROL requires RELAY_URL and RELAY_HOST_SECRET; remote hosting was not started.',
    );
  }

  const hostName = setting('KORYPHAIOS_REMOTE_HOST_NAME', 'Remote Koryphaios', 80);
  const sessionName = setting('KORYPHAIOS_REMOTE_SESSION_NAME', 'Remote Koryphaios', 80);
  const workspacePath = setting(
    'KORYPHAIOS_REMOTE_WORKSPACE',
    join(PROJECT_ROOT, '.koryphaios', 'remote-workspace'),
    1024,
  );
  const path = statePath();
  const previous = await readState(path);
  const { sessions, wsManager } = getContext();
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });

  let baseSession = previous?.baseSessionId
    ? await sessions.get(previous.baseSessionId)
    : undefined;
  if (!baseSession) {
    baseSession = await sessions.create('remote-instance', sessionName, undefined, workspacePath);
  }
  if (baseSession.archivedAt !== undefined) {
    throw new Error('Restore the remote instance chat before restarting remote control.');
  }
  // The explicitly enabled headless profile needs a matching chat approval
  // preset; relay auto-execution alone does not remove local tool approvals.
  const overrides = { ...baseSession.agentOverrides, permissionMode: 'yolo' as const };
  const updated = await sessions.update(baseSession.id, { agentOverrides: overrides });
  if (!updated) throw new Error('The remote instance chat could not be configured.');
  setSessionAgentOverrides(baseSession.id, overrides);

  const executionPath = baseSession.gitWorkspace?.path ?? workspacePath;
  const state: RemoteInstanceState = {
    version: 1,
    baseSessionId: baseSession.id,
    collaborationSessionId: null,
    joinCode: null,
    hostName,
    sessionName,
    workspacePath: executionPath,
    updatedAt: new Date().toISOString(),
  };
  // Save chat identity before contacting the relay. An outage must not create
  // a new chat/checkout on every systemd retry or advertise the previous code.
  await writeState(path, state);

  const host = await collaborationManager.hostSession(
    baseSession.id,
    'remote-instance',
    [executionPath],
    hostName,
  );
  if (!host.relayEnabled || !/^[A-HJ-NP-Z2-9]{8}$/.test(host.joinCode)) {
    throw new Error('Remote instance could not establish a live collaboration relay host.');
  }
  const policy = await collaborationManager.updatePolicy(
    host.id,
    remotePolicy(host.policy, hostName, sessionName, executionPath),
  );
  await stopRemoteInstanceHost();
  stopEvents = startRemoteInstanceEvents(
    baseSession.id,
    (event) => collaborationManager.broadcastEvent(event),
    wsManager,
  );
  await writeState(path, {
    ...state,
    collaborationSessionId: host.id,
    joinCode: host.joinCode,
    updatedAt: new Date().toISOString(),
  });
  log.info(
    { statePath: path, hostName, sessionName, workspacePath: executionPath },
    'Headless remote Koryphaios instance is ready; join code written to the protected state file',
  );
  return { ...host, policy };
}
