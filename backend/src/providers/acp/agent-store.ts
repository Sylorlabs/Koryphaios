// Persistence for user-registered ACP agents.
//
//   <root>/koryphaios.json                    acpAgents: { <id>: AcpAgentDefinition }  (no secrets)
//   <root>/.koryphaios/acp-agent-env.json     { <id>: { NAME: value } }  0600, secret store
//   <root>/.koryphaios/acp-agent-verdicts.json { <id>: AcpProbeVerdict }  0600, local state
//
// Env values never reach koryphaios.json or a provider config. Each write is
// atomic (temp file + rename). A failed config write rolls the secret file back so
// the two halves of a registration never diverge silently.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT } from '../../runtime/paths';
import { serverLog } from '../../logger';
import type { AcpAgentDefinition } from './agent-definitions';
import { isRecord } from './protocol';

export interface AcpProbeVerdict {
  ok: boolean;
  checkedAt: number;
  durationMs: number;
  protocolVersion?: number;
  agentName?: string;
  agentVersion?: string;
  /** Model ids the agent offered in its session config options (may be empty). */
  models: string[];
  error?: string;
}

export type AcpEnvSecrets = Record<string, Record<string, string>>;

/** Root for ACP agent state. Packaged launches set KORYPHAIOS_DATA_DIR. */
export function acpStoreRoot(): string {
  return process.env.KORYPHAIOS_DATA_DIR?.trim() || PROJECT_ROOT;
}

function configPath(root: string): string {
  return join(root, 'koryphaios.json');
}
function envSecretsPath(root: string): string {
  return join(root, '.koryphaios', 'acp-agent-env.json');
}
function verdictsPath(root: string): string {
  return join(root, '.koryphaios', 'acp-agent-verdicts.json');
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (!isRecord(parsed)) throw new Error(`${path} root is not an object`);
  return parsed;
}

// ─── Definitions (koryphaios.json) ───────────────────────────────────────────

export function loadAcpAgentDefinitions(root: string = acpStoreRoot()): AcpAgentDefinition[] {
  try {
    const config = readJsonFile(configPath(root));
    const raw = config?.acpAgents;
    if (!isRecord(raw)) return [];
    const out: AcpAgentDefinition[] = [];
    for (const [id, value] of Object.entries(raw)) {
      if (!isRecord(value)) continue;
      out.push({
        id,
        label: typeof value.label === 'string' ? value.label : id,
        command: typeof value.command === 'string' ? value.command : '',
        args: Array.isArray(value.args) ? value.args.filter((a): a is string => typeof a === 'string') : [],
        envNames: Array.isArray(value.envNames)
          ? value.envNames.filter((n): n is string => typeof n === 'string')
          : [],
        cwdPolicy: value.cwdPolicy === 'private' ? 'private' : 'workspace',
        permissionProfile: value.permissionProfile === 'read-only' ? 'read-only' : 'bridge-only',
        source:
          value.source === 'registry' || value.source === 'autodetect' ? value.source : 'manual',
        ...(typeof value.registryId === 'string' ? { registryId: value.registryId } : {}),
        createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
      });
    }
    return out;
  } catch (err) {
    serverLog.warn(
      { errorType: err instanceof Error ? err.name : typeof err },
      'Failed to read ACP agent definitions from koryphaios.json',
    );
    return [];
  }
}

/** Replace the whole acpAgents map in koryphaios.json, preserving every other key. */
function writeAcpAgentDefinitions(root: string, defs: AcpAgentDefinition[]): void {
  const path = configPath(root);
  const config = (readJsonFile(path) ?? {}) as Record<string, unknown>;
  const map: Record<string, unknown> = {};
  for (const def of defs) {
    map[def.id] = {
      label: def.label,
      command: def.command,
      args: def.args,
      envNames: def.envNames,
      cwdPolicy: def.cwdPolicy,
      permissionProfile: def.permissionProfile,
      source: def.source,
      ...(def.registryId ? { registryId: def.registryId } : {}),
      createdAt: def.createdAt,
      updatedAt: def.updatedAt,
    };
  }
  config.acpAgents = map;
  config.updatedAt = Date.now();
  writeJsonAtomic(path, config);
}

// ─── Env secrets ─────────────────────────────────────────────────────────────

export function loadAcpAgentEnvSecrets(root: string = acpStoreRoot()): AcpEnvSecrets {
  try {
    const parsed = readJsonFile(envSecretsPath(root));
    if (!parsed) return {};
    const out: AcpEnvSecrets = {};
    for (const [id, env] of Object.entries(parsed)) {
      if (!isRecord(env)) continue;
      out[id] = Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    }
    return out;
  } catch (err) {
    serverLog.warn(
      { errorType: err instanceof Error ? err.name : typeof err },
      'Failed to read ACP agent env secret store',
    );
    return {};
  }
}

export function loadAcpAgentEnv(id: string, root: string = acpStoreRoot()): Record<string, string> {
  return { ...(loadAcpAgentEnvSecrets(root)[id] ?? {}) };
}

function saveAcpAgentEnvSecrets(root: string, secrets: AcpEnvSecrets): void {
  writeJsonAtomic(envSecretsPath(root), secrets);
}

// ─── Verdicts ────────────────────────────────────────────────────────────────

export function loadAcpProbeVerdicts(root: string = acpStoreRoot()): Record<string, AcpProbeVerdict> {
  try {
    const parsed = readJsonFile(verdictsPath(root));
    return (parsed ?? {}) as Record<string, AcpProbeVerdict>;
  } catch {
    return {};
  }
}

export function saveAcpProbeVerdict(
  id: string,
  verdict: AcpProbeVerdict,
  root: string = acpStoreRoot(),
): void {
  const all = loadAcpProbeVerdicts(root);
  all[id] = verdict;
  writeJsonAtomic(verdictsPath(root), all);
}

function removeAcpProbeVerdict(id: string, root: string): void {
  const all = loadAcpProbeVerdicts(root);
  if (!(id in all)) return;
  delete all[id];
  writeJsonAtomic(verdictsPath(root), all);
}

// ─── Combined registration ───────────────────────────────────────────────────

/**
 * Upsert one agent: definition into koryphaios.json and its env values into the
 * secret store. If the config write fails, the secret file is restored to its
 * previous content before the error propagates.
 */
export function saveAcpAgent(
  def: AcpAgentDefinition,
  env: Record<string, string>,
  root: string = acpStoreRoot(),
): void {
  const previousSecrets = loadAcpAgentEnvSecrets(root);
  const previousDefs = loadAcpAgentDefinitions(root);
  const nextSecrets: AcpEnvSecrets = { ...previousSecrets };
  if (Object.keys(env).length > 0) nextSecrets[def.id] = { ...env };
  else delete nextSecrets[def.id];
  const nextDefs = [...previousDefs.filter((d) => d.id !== def.id), def];
  saveAcpAgentEnvSecrets(root, nextSecrets);
  try {
    writeAcpAgentDefinitions(root, nextDefs);
  } catch (err) {
    try {
      saveAcpAgentEnvSecrets(root, previousSecrets);
    } catch {
      /* the next registration reconciles the secret file */
    }
    throw err;
  }
}

/** Remove one agent: config entry first, then its secrets and verdict. */
export function removeAcpAgent(id: string, root: string = acpStoreRoot()): void {
  const defs = loadAcpAgentDefinitions(root);
  if (defs.some((d) => d.id === id)) {
    writeAcpAgentDefinitions(
      root,
      defs.filter((d) => d.id !== id),
    );
  }
  const secrets = loadAcpAgentEnvSecrets(root);
  if (id in secrets) {
    delete secrets[id];
    saveAcpAgentEnvSecrets(root, secrets);
  }
  removeAcpProbeVerdict(id, root);
}
