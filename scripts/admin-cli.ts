import { validateDeviceRelayUrl } from '../shared/src/devices';

export const ADMIN_HELP = `Koryphaios administrative CLI

Usage: koryphaios [--port PORT | --url http://127.0.0.1:PORT] [--json] COMMAND

  status                         Backend health and linked devices
  doctor                         Health, relay, workspace, and provider status
  devices list                   Linked devices and connection status
  devices invite                 Create a ten-minute pairing code
  devices pair CODE              Enter another instance's code; print the check
  devices pending                Pending requests and verification checks
  devices approve ID --check "123 456"
                                 Approve after comparing checks on both instances
  devices decline ID             Decline a pending link
  devices cancel                 Cancel this instance's pairing invite
  devices unlink ID              Revoke a link
  devices rename NAME            Change this desktop's display name
  devices grants ID [--incoming on|off] [--outgoing on|off]
                                 Set directional agent grants explicitly
  devices workspaces ID          Discover a linked desktop's workspace IDs
  workspace status               Show this instance's workspace
  workspace open PATH            Open a workspace on this instance
  workspace select PATH          Select a project on this instance
  workspace clear                Clear this instance's workspace selection
  providers list                 List provider connection state
  providers refresh NAME         Re-probe one provider (no generation)
  config show                    Show supported non-secret settings
  config get KEY                 Read a supported setting
  config set KEY VALUE           Set a supported setting
  serve --data-dir PATH          Run the backend headlessly in the foreground
        [--runtime-dir PATH] [--port PORT] [--relay URL] [--workspace PATH]
        [--bun PATH]

Config keys: device.name, device.relay, agent.permissionMode,
agent.intentInterview, agent.planApproval, agent.criticMode, agent.criticGateEnabled,
agent.reasoningExpandedByDefault, agent.agentExecutionMode.
Use --project PATH for project-scoped agent settings.
An empty device.relay disables device linking.

The CLI manages Koryphaios; it does not accept coding prompts or run agent tools.
API targets are loopback only. Use an SSH tunnel for a remote backend.
Without an explicit target, one running backend is discovered on ports 3001/3000.
--json emits compact JSON for scripts. Pairing codes and checks are shown only
by commands that create or inspect pairing. Auth tokens/private keys are never printed.
`;

type Options = { words: string[]; flags: Record<string, string>; json: boolean; help: boolean };
export function parseAdminArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): Options {
  const result: Options = { words: [], flags: {}, json: false, help: false };
  const flags = new Set([
    'port',
    'url',
    'project',
    'check',
    'incoming',
    'outgoing',
    'data-dir',
    'runtime-dir',
    'relay',
    'workspace',
    'bun',
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      result.words.push(...args.slice(i + 1));
      break;
    }
    if (arg === '--json') {
      result.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const [key, ...parts] = arg.slice(2).split('=');
      if (!flags.has(key!)) throw new Error(`Unknown option: --${key}`);
      if (Object.hasOwn(result.flags, key!)) throw new Error(`Repeated option: --${key}`);
      const value = parts.length ? parts.join('=') : args[++i];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`Missing value for --${key}`);
      result.flags[key!] = value;
    } else result.words.push(arg);
  }
  if (!result.flags.port && !result.flags.url) {
    if (env.KORYPHAIOS_API_URL) result.flags.url = env.KORYPHAIOS_API_URL;
    else if (env.KORYPHAIOS_PORT) result.flags.port = env.KORYPHAIOS_PORT;
  }
  if (result.flags.port && result.flags.url) throw new Error('Choose either --port or --url');
  if (
    result.flags.port &&
    (!/^\d+$/.test(result.flags.port) || +result.flags.port < 1 || +result.flags.port > 65535)
  )
    throw new Error('Port must be between 1 and 65535');
  if (result.flags.url) result.flags.url = localApiUrl(result.flags.url);
  return result;
}
function localApiUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'API URL must be a loopback HTTP origin; use an SSH tunnel for remote instances',
    );
  return url.origin;
}
type DeviceStatus = {
  local: { id: string; name: string; os: string; kind: string } | null;
  connected: boolean;
  relayUrl: string | null;
  error: string | null;
  peers: Array<{
    id: string;
    name: string;
    os: string;
    kind: string;
    online: boolean;
    allowAgents: boolean;
    agentRouting: boolean;
  }>;
  requests: Array<{
    id: string;
    identity: { name: string; os: string; kind: string };
    check: string;
    expiresAt: number;
  }>;
  pendingPairIds: string[];
};
function publicStatus(status: DeviceStatus) {
  return {
    local: status.local && { id: status.local.id, name: status.local.name, os: status.local.os },
    connected: status.connected,
    relayUrl: status.relayUrl,
    error: status.error,
    peers: status.peers.map((p) => ({
      id: p.id,
      name: p.name,
      os: p.os,
      kind: p.kind,
      online: p.online,
      allowAgents: p.allowAgents,
      agentRouting: p.agentRouting,
    })),
    pendingPairIds: status.pendingPairIds,
  };
}
const AGENT_CONFIG: Record<string, readonly string[] | 'boolean'> = {
  permissionMode: ['yolo', 'guarded', 'edits', 'ask', 'custom'],
  intentInterview: ['off', 'adaptive', 'deep'],
  planApproval: ['never', 'material', 'always'],
  criticGateEnabled: 'boolean',
  criticMode: ['auto', 'always', 'off'],
  reasoningExpandedByDefault: 'boolean',
  agentExecutionMode: ['auto', 'single', 'multi'],
};
function configKey(key: string) {
  if (key === 'device.name' || key === 'device.relay') return key;
  const name = key.replace(/^agent\./, '');
  if (!key.startsWith('agent.') || !Object.hasOwn(AGENT_CONFIG, name))
    throw new Error(`Unsupported configuration key: ${key}`);
  return name;
}
function providerRows(rows: any[]) {
  return rows.map((p) => ({
    name: p.name,
    connectionState: p.connectionState,
    configurationBlocked: p.configurationBlocked,
    modelCount: p.models?.length ?? p.availableModels?.length ?? 0,
  }));
}
function required(value: string | undefined, label: string) {
  if (!value) throw new Error(`Supply ${label}`);
  return value;
}
function deviceId(value: string | undefined) {
  const id = required(value, 'a device ID from devices list or devices pending');
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Use the full 64-character device ID');
  return id;
}
export async function runAdminCli(
  args: string[],
  options: {
    fetch?: typeof fetch;
    write?: (text: string) => void;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const { words, flags, json, help } = parseAdminArgs(args, options.env);
  const write = options.write ?? console.log;
  const fetcher = options.fetch ?? fetch;
  if (help || !words.length || words[0] === 'help') {
    write(ADMIN_HELP);
    return;
  }
  const [group, verb, a, b] = words;
  const commands: Record<string, Record<string, number>> = {
    devices: {
      list: 2,
      invite: 2,
      pair: 3,
      pending: 2,
      approve: 3,
      decline: 3,
      cancel: 2,
      unlink: 3,
      rename: 3,
      grants: 3,
      workspaces: 3,
    },
    workspace: { status: 2, open: 3, select: 3, clear: 2 },
    providers: { list: 2, refresh: 3 },
    config: { show: 2, get: 3, set: 4 },
  };
  const count = group === 'status' || group === 'doctor' ? 1 : commands[group!]?.[verb!];
  if (count === undefined || words.length !== count)
    throw new Error('Unknown command or wrong arguments. Run koryphaios --help');
  const allowed = new Set(['port', 'url', 'project']);
  if (group === 'devices' && verb === 'approve') allowed.add('check');
  if (group === 'devices' && verb === 'grants') {
    allowed.add('incoming');
    allowed.add('outgoing');
  }
  for (const key of Object.keys(flags))
    if (!allowed.has(key)) throw new Error(`--${key} is not valid for this command`);
  if (
    group === 'devices' &&
    ['approve', 'decline', 'unlink', 'grants', 'workspaces'].includes(verb!)
  )
    deviceId(a);
  if (
    group === 'devices' &&
    verb === 'pair' &&
    !/^[A-HJ-NP-Z2-9]{20}$/i.test(required(a, 'a pairing code').replace(/[\s-]/g, ''))
  )
    throw new Error('Enter the 20-character device pairing code');
  if (
    group === 'devices' &&
    verb === 'approve' &&
    !/^\d{6}$/.test((flags.check ?? '').replace(/\s/g, ''))
  )
    throw new Error('Supply --check with the six digits shown by the other instance');
  if (group === 'devices' && verb === 'grants') {
    if (!flags.incoming && !flags.outgoing)
      throw new Error('Supply --incoming on|off or --outgoing on|off');
    for (const key of ['incoming', 'outgoing'])
      if (flags[key] && !['on', 'off'].includes(flags[key]!))
        throw new Error(`--${key} must be on or off`);
  }
  let parsedValue: unknown;
  if (group === 'config' && verb !== 'show') {
    const key = configKey(a!);
    if (verb === 'set') {
      if (key === 'device.relay') parsedValue = b ? validateDeviceRelayUrl(b) : '';
      else if (key === 'device.name') {
        if (!b?.trim() || b.trim().length > 80 || /[\x00-\x1f\x7f]/.test(b))
          throw new Error('Use a device name between 1 and 80 characters');
        parsedValue = b.trim();
      } else {
        const values = AGENT_CONFIG[key]!;
        if (values === 'boolean') {
          if (!['true', 'false'].includes(b!)) throw new Error(`${a} must be true or false`);
          parsedValue = b === 'true';
        } else {
          if (!values.includes(b!)) throw new Error(`${a} must be one of: ${values.join(', ')}`);
          parsedValue = b;
        }
      }
    }
  }
  async function healthAt(base: string) {
    const r = await fetcher(base + '/api/health', {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    const result = await r.json();
    if (!r.ok || !result.ok || result.data?.id !== 'koryphaios')
      throw new Error('Target is not a healthy Koryphaios backend');
    return result.data;
  }
  let base = flags.url ?? (flags.port ? `http://127.0.0.1:${flags.port}` : '');
  let health: any;
  if (base) {
    try {
      health = await healthAt(base);
    } catch {
      throw new Error(
        `Could not reach a healthy Koryphaios backend at ${base}. Start the app/service or check --port.`,
      );
    }
  } else {
    const found = await Promise.all(
      [3001, 3000].map(async (port) => {
        const url = `http://127.0.0.1:${port}`;
        try {
          return { url, health: await healthAt(url) };
        } catch {
          return null;
        }
      }),
    );
    const available = found.filter((p) => p !== null);
    if (!available.length)
      throw new Error(
        'No Koryphaios backend found. Start the app or use koryphaios serve / --port',
      );
    if (available.length > 1)
      throw new Error('Multiple Koryphaios backends found; choose one with --port');
    base = available[0]!.url;
    health = available[0]!.health;
  }
  let bearer = '';
  async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await fetcher(base + path, {
      method,
      headers: {
        ...(bearer ? { authorization: bearer } : {}),
        ...(flags.project ? { 'X-Koryphaios-Project': flags.project } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
      redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok || !result.ok)
      throw new Error(
        `${result.error ?? 'Koryphaios request failed'}${result.correlationId ? ` (reference ${result.correlationId})` : ''}`,
      );
    return result.data ?? result;
  }
  const status = (): Promise<DeviceStatus> => api('/api/devices');
  const emit = (result: unknown) => write(JSON.stringify(result, null, json ? undefined : 2));
  try {
    bearer = (await api('/api/auth/session', 'POST')).bearerToken;
    if (typeof bearer !== 'string' || !bearer.startsWith('Bearer '))
      throw new Error('Local authentication failed');
    if (group === 'status') {
      emit({ apiUrl: base, health, devices: publicStatus(await status()) });
      return;
    }
    if (group === 'doctor') {
      const [devices, workspace, providers] = await Promise.all([
        status(),
        api('/api/workspace/state'),
        api('/api/providers/status'),
      ]);
      emit({
        apiUrl: base,
        health,
        devices: publicStatus(devices),
        workspace,
        providers: providerRows(providers),
      });
      return;
    }
    if (group === 'devices') {
      if (verb === 'list') emit(publicStatus(await status()));
      else if (verb === 'pending') {
        const s = await status();
        emit({
          requests: s.requests.map((r) => ({
            id: r.id,
            name: r.identity.name,
            os: r.identity.os,
            kind: r.identity.kind,
            check: r.check,
            expiresAt: r.expiresAt,
          })),
          pendingPairIds: s.pendingPairIds,
        });
      } else if (verb === 'invite') {
        const invite = await api('/api/devices/pairing', 'POST');
        emit({
          code: invite.code,
          expiresAt: new Date(invite.expiresAt).toISOString(),
          qrUrl: invite.qrUrl,
        });
      } else if (verb === 'pair') {
        const pair = await api('/api/devices/pair', 'POST', { code: a });
        emit({
          deviceId: pair.identity.id,
          name: pair.identity.name,
          os: pair.identity.os,
          check: pair.check,
          awaitingHostApproval: true,
        });
      } else if (verb === 'approve' || verb === 'decline') {
        if (verb === 'approve') {
          const pending = (await status()).requests.find((r) => r.id === a);
          if (
            !pending ||
            pending.expiresAt <= Date.now() ||
            pending.check.replace(/\s/g, '') !== flags.check!.replace(/\s/g, '')
          )
            throw new Error('Verification check does not match the current pending request');
        }
        const result = await api('/api/devices/decision', 'POST', {
          id: a,
          approved: verb === 'approve',
        });
        emit({
          ...(verb === 'approve' ? { linked: true } : { declined: true }),
          devices: publicStatus(result),
        });
      } else if (verb === 'cancel') {
        await api('/api/devices/pairing', 'DELETE');
        emit({ cancelled: true });
      } else if (verb === 'unlink') {
        await api(`/api/devices/${a}`, 'DELETE');
        emit({ unlinked: a });
      } else if (verb === 'rename')
        emit(publicStatus(await api('/api/devices/name', 'PATCH', { name: a })));
      else if (verb === 'grants') {
        const peer = (await status()).peers.find((p) => p.id === a);
        if (!peer) throw new Error('Device is not linked');
        emit(
          publicStatus(
            await api(`/api/devices/${a}/grants`, 'PATCH', {
              allowAgents: flags.incoming ? flags.incoming === 'on' : peer.allowAgents,
              agentRouting: flags.outgoing ? flags.outgoing === 'on' : peer.agentRouting,
            }),
          ),
        );
      } else if (verb === 'workspaces')
        emit(await api(`/api/devices/${a}/rpc`, 'POST', { operation: 'workspaces', input: {} }));
      return;
    }
    if (group === 'workspace') {
      if (verb === 'status') emit(await api('/api/workspace/state'));
      else if (verb === 'clear') emit(await api('/api/workspace/state', 'DELETE'));
      else
        emit(
          await api(`/api/workspace/${verb}`, 'POST', verb === 'open' ? { root: a } : { path: a }),
        );
      return;
    }
    if (group === 'providers') {
      if (verb === 'list') emit(providerRows(await api('/api/providers/status')));
      else {
        const result = await api(`/api/providers/${encodeURIComponent(a!)}/refresh`, 'POST', {
          runtimeCheck: false,
        });
        emit({
          refreshed: a,
          skipped: result.skipped,
          verified: result.verification?.success,
          connectionState: result.connectionState ?? result.status?.connectionState,
        });
      }
      return;
    }
    if (verb === 'set') {
      if (a === 'device.name')
        emit(publicStatus(await api('/api/devices/name', 'PATCH', { name: parsedValue })));
      else if (a === 'device.relay')
        emit(publicStatus(await api('/api/devices/relay', 'PATCH', { url: parsedValue })));
      else {
        const key = configKey(a!);
        const result = await api('/api/agent/settings', 'PUT', { [key]: parsedValue });
        emit({ [a!]: result[key] });
      }
      return;
    }
    const agent =
      verb === 'show' || a!.startsWith('agent.') ? await api('/api/agent/settings') : null;
    const device = verb === 'show' || a!.startsWith('device.') ? await status() : null;
    const config: Record<string, unknown> = {};
    if (device) {
      config['device.name'] = device.local?.name;
      config['device.relay'] = device.relayUrl;
    }
    if (agent) for (const key of Object.keys(AGENT_CONFIG)) config[`agent.${key}`] = agent[key];
    emit(verb === 'show' ? config : { [a!]: config[a!] });
  } finally {
    if (bearer) await api('/api/auth/session', 'DELETE').catch(() => undefined);
  }
}
