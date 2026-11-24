// Capability probe for a registered ACP agent: a dry run that proves the agent
// speaks ACP protocol 1 and can open a session. It sends no prompt, attaches no
// Kory bridge and runs in a private empty directory that is removed afterward.
// The verdict is what makes an agent selectable.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawn } from 'node:child_process';
import { AcpClient } from './client';
import { buildAcpChildEnv } from './env';
import type { AcpConfigOption, AcpInitializeResult } from './protocol';
import type { AcpProbeVerdict } from './agent-store';

export const ACP_PROBE_TIMEOUT_MS = 20_000;
const SUPPORTED_PROTOCOL_VERSION = 1;

export interface ProbeTarget {
  id: string;
  label: string;
  command: string;
  args: string[];
}

export interface ProbeOptions {
  timeoutMs?: number;
  spawnChild?: typeof spawn;
  now?: () => number;
  /** Extra env (secret values). Merged over the minimal base environment. */
  secretEnv?: Record<string, string>;
  /** Base environment source (tests may pin it). */
  baseEnv?: NodeJS.ProcessEnv;
}

/** Pull model ids out of session config options (category "model" or id "model"). */
export function modelIdsFromConfigOptions(options: AcpConfigOption[] | undefined): string[] {
  const out: string[] = [];
  for (const option of options ?? []) {
    const isModel = option.id === 'model' || option.category === 'model';
    if (!isModel || !Array.isArray(option.options)) continue;
    for (const entry of option.options) {
      if (typeof entry?.value === 'string' && entry.value.trim()) out.push(entry.value.trim());
    }
  }
  return [...new Set(out)];
}

export async function probeAcpAgent(
  target: ProbeTarget,
  opts: ProbeOptions = {},
): Promise<AcpProbeVerdict> {
  const now = opts.now ?? Date.now;
  const started = now();
  const timeoutMs = opts.timeoutMs ?? ACP_PROBE_TIMEOUT_MS;
  const workdir = mkdtempSync(join(tmpdir(), 'kory-acp-probe-'));
  const client = new AcpClient({
    command: target.command,
    args: target.args,
    cwd: workdir,
    env: buildAcpChildEnv(opts.secretEnv ?? {}, opts.baseEnv ?? process.env),
    spawnChild: opts.spawnChild,
    providerName: `acp:${target.id}`,
    label: target.label,
    permissionProfile: 'read-only',
    requestTimeoutMs: timeoutMs,
  });

  const run = async (): Promise<Omit<AcpProbeVerdict, 'checkedAt' | 'durationMs'>> => {
    const init: AcpInitializeResult = await client.connect();
    if (init.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      return {
        ok: false,
        protocolVersion: init.protocolVersion,
        models: [],
        error: `Agent speaks ACP protocol ${init.protocolVersion}; Kory supports ${SUPPORTED_PROTOCOL_VERSION}`,
      };
    }
    const session = await client.newSession({ cwd: workdir, mcpServers: [] });
    const info = (init as AcpInitializeResult & { agentInfo?: { name?: string; version?: string } })
      .agentInfo;
    return {
      ok: true,
      protocolVersion: init.protocolVersion,
      agentName: info?.name,
      agentVersion: info?.version,
      models: modelIdsFromConfigOptions(session.configOptions),
    };
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });

  let result: Omit<AcpProbeVerdict, 'checkedAt' | 'durationMs'>;
  try {
    result = await Promise.race([run(), timeout]);
  } catch (err) {
    result = {
      ok: false,
      models: [],
      error: sanitizeProbeError(err instanceof Error ? err.message : String(err)),
    };
  } finally {
    if (timer) clearTimeout(timer);
    await client.disconnect().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }

  return { ...result, checkedAt: now(), durationMs: now() - started };
}

/** Keep probe errors short and free of paths or secret-looking tokens. */
export function sanitizeProbeError(message: string): string {
  const cleaned = message
    .replace(/(sk|rk|pk|ak)[-_][A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 300) || 'probe failed';
}
