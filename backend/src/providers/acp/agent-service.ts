// Orchestration for the agent registry: merges the official registry, PATH
// autodetection and user-registered agents into one listing, and runs the
// add / remove / probe lifecycle against the provider registry.
//
// Nothing here installs or downloads an agent binary. A registry entry is only
// described; the user adds a command explicitly, and the add triggers the probe
// that the user asked for.

import type { spawn } from 'node:child_process';
import {
  acpProviderName,
  validateAcpAgentInput,
  type AcpAgentDefinition,
  type AcpAgentInput,
  type AcpAgentSource,
} from './agent-definitions';
import {
  acpStoreRoot,
  loadAcpAgentDefinitions,
  loadAcpAgentEnv,
  loadAcpProbeVerdicts,
  removeAcpAgent,
  saveAcpAgent,
  saveAcpProbeVerdict,
  type AcpProbeVerdict,
} from './agent-store';
import { probeAcpAgent } from './probe';
import {
  autodetectAcpAgents,
  fetchAcpRegistry,
  type AcpRegistryEntry,
  type AcpRegistrySnapshot,
} from './sources';

/** The slice of the provider registry the lifecycle needs. */
export interface AcpAgentHost {
  registerAcpAgentProvider(def: AcpAgentDefinition, verdict?: AcpProbeVerdict): void;
  removeAcpAgentProvider(id: string): void;
}

export interface AcpProbeSummary {
  ok: boolean;
  checkedAt: number;
  durationMs: number;
  models: string[];
  protocolVersion?: number;
  agentName?: string;
  agentVersion?: string;
  error?: string;
}

export type AcpAgentListingStatus =
  | 'ready'
  | 'needs-probe'
  | 'probe-failed'
  | 'available'
  | 'not-added'
  | 'added';

export interface AcpAgentListing {
  id: string;
  name: string;
  source: AcpAgentSource | 'custom';
  status: AcpAgentListingStatus;
  providerName?: string;
  description?: string;
  version?: string;
  website?: string;
  repository?: string;
  license?: string;
  icon?: string;
  /** Command the agent runs as (custom: saved; autodetect/registry: suggestion only). */
  command?: string;
  args?: string[];
  envNames?: string[];
  cwdPolicy?: 'workspace' | 'private';
  permissionProfile?: 'bridge-only' | 'read-only';
  registryId?: string;
  install?: AcpRegistryEntry['install'];
  binaryPath?: string;
  argsVerified?: boolean;
  probe?: AcpProbeSummary;
}

export interface AcpRegistryListing {
  registry: {
    ok: boolean;
    url: string;
    fetchedAt: number;
    source: AcpRegistrySnapshot['source'];
    error?: string;
  };
  agents: AcpAgentListing[];
}

function summarize(verdict: AcpProbeVerdict | undefined): AcpProbeSummary | undefined {
  if (!verdict) return undefined;
  return {
    ok: verdict.ok,
    checkedAt: verdict.checkedAt,
    durationMs: verdict.durationMs,
    models: verdict.models,
    ...(verdict.protocolVersion !== undefined ? { protocolVersion: verdict.protocolVersion } : {}),
    ...(verdict.agentName ? { agentName: verdict.agentName } : {}),
    ...(verdict.agentVersion ? { agentVersion: verdict.agentVersion } : {}),
    ...(verdict.error ? { error: verdict.error } : {}),
  };
}

function customStatus(verdict: AcpProbeVerdict | undefined): AcpAgentListingStatus {
  if (!verdict) return 'needs-probe';
  return verdict.ok ? 'ready' : 'probe-failed';
}

/** Merged listing: custom agents, PATH candidates and the official registry. */
export async function listAcpAgents(
  opts: { refresh?: boolean; registryFetch?: typeof fetchAcpRegistry; root?: string } = {},
): Promise<AcpRegistryListing> {
  const root = opts.root ?? acpStoreRoot();
  const verdicts = loadAcpProbeVerdicts(root);
  const customs = loadAcpAgentDefinitions(root);
  const agents: AcpAgentListing[] = [];

  for (const def of customs) {
    const verdict = verdicts[def.id];
    agents.push({
      id: def.id,
      name: def.label,
      source: 'custom',
      status: customStatus(verdict),
      providerName: acpProviderName(def.id),
      command: def.command,
      args: [...def.args],
      envNames: [...def.envNames],
      cwdPolicy: def.cwdPolicy,
      permissionProfile: def.permissionProfile,
      ...(def.registryId ? { registryId: def.registryId } : {}),
      probe: summarize(verdict),
    });
  }

  const customIds = new Set(customs.map((d) => d.id));
  for (const found of autodetectAcpAgents()) {
    if (customIds.has(found.id)) continue;
    agents.push({
      id: found.id,
      name: found.label,
      source: 'autodetect',
      status: 'available',
      binaryPath: found.binaryPath,
      command: found.binaryPath,
      args: [...found.args],
      argsVerified: false,
    });
  }

  const registry = await (opts.registryFetch ?? fetchAcpRegistry)({ force: opts.refresh === true });
  const addedRegistryIds = new Map(
    customs.filter((d) => d.registryId).map((d) => [d.registryId as string, d.id]),
  );
  for (const entry of registry.entries) {
    const addedAs = addedRegistryIds.get(entry.id);
    agents.push({
      id: entry.id,
      name: entry.name,
      source: 'registry',
      status: addedAs ? 'added' : 'not-added',
      ...(addedAs ? { providerName: acpProviderName(addedAs) } : {}),
      description: entry.description,
      version: entry.version,
      website: entry.website,
      repository: entry.repository,
      license: entry.license,
      icon: entry.icon,
      registryId: entry.id,
      install: entry.install,
      // Suggestion only: the user reviews and confirms it through the add call.
      ...(entry.install.command
        ? { command: entry.install.command, args: [...(entry.install.args ?? [])] }
        : {}),
    });
  }

  return {
    registry: {
      ok: registry.ok,
      url: registry.url,
      fetchedAt: registry.fetchedAt,
      source: registry.source,
      ...(registry.error ? { error: registry.error } : {}),
    },
    agents,
  };
}

export interface AddAcpAgentResult {
  id: string;
  providerName: string;
  status: AcpAgentListingStatus;
  probe?: AcpProbeSummary;
}

/**
 * Register a user agent: definition and env secrets are saved, then the
 * capability probe runs (unless disabled) and its verdict is stored. A failed
 * probe still keeps the agent so the user can fix its environment and re-probe.
 */
export async function addCustomAcpAgent(
  host: AcpAgentHost,
  input: AcpAgentInput & { probe?: boolean },
  opts: { root?: string; spawnChild?: typeof spawn } = {},
): Promise<AddAcpAgentResult> {
  const root = opts.root ?? acpStoreRoot();
  const validated = validateAcpAgentInput(input);
  if (loadAcpAgentDefinitions(root).some((d) => d.id === validated.id)) {
    throw new AcpAgentConflictError(`An agent with id "${validated.id}" already exists`);
  }
  const now = Date.now();
  const def: AcpAgentDefinition = {
    id: validated.id,
    label: validated.label,
    command: validated.command,
    args: validated.args,
    envNames: Object.keys(validated.env),
    cwdPolicy: validated.cwdPolicy,
    permissionProfile: validated.permissionProfile,
    source: validated.source,
    ...(validated.registryId ? { registryId: validated.registryId } : {}),
    createdAt: now,
    updatedAt: now,
  };

  let verdict: AcpProbeVerdict | undefined;
  if (input.probe !== false) {
    verdict = await probeAcpAgent(
      { id: def.id, label: def.label, command: def.command, args: def.args },
      { secretEnv: validated.env, spawnChild: opts.spawnChild },
    );
  }

  saveAcpAgent(def, validated.env, root);
  if (verdict) saveAcpProbeVerdict(def.id, verdict, root);
  host.registerAcpAgentProvider(def, verdict);

  return {
    id: def.id,
    providerName: acpProviderName(def.id),
    status: verdict ? customStatus(verdict) : 'needs-probe',
    ...(verdict ? { probe: summarize(verdict) } : {}),
  };
}

export class AcpAgentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpAgentConflictError';
  }
}

export function removeCustomAcpAgent(
  host: AcpAgentHost,
  id: string,
  root: string = acpStoreRoot(),
): boolean {
  if (!loadAcpAgentDefinitions(root).some((d) => d.id === id)) return false;
  removeAcpAgent(id, root);
  host.removeAcpAgentProvider(id);
  return true;
}

/** Re-run the probe for a registered agent, store the verdict and refresh its provider. */
export async function probeCustomAcpAgent(
  host: AcpAgentHost,
  id: string,
  opts: { root?: string; spawnChild?: typeof spawn } = {},
): Promise<AcpProbeVerdict | null> {
  const root = opts.root ?? acpStoreRoot();
  const def = loadAcpAgentDefinitions(root).find((d) => d.id === id);
  if (!def) return null;
  const verdict = await probeAcpAgent(
    { id: def.id, label: def.label, command: def.command, args: def.args },
    { secretEnv: loadAcpAgentEnv(id, root), spawnChild: opts.spawnChild },
  );
  saveAcpProbeVerdict(id, verdict, root);
  host.registerAcpAgentProvider(def, verdict);
  return verdict;
}
