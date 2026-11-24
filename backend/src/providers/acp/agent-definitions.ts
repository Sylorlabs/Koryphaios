// User-registered ACP agent definitions: shape, validation and provider naming.
//
// An agent is spawned directly (no shell) from `command` + `args`. Its env is a
// closed allowlist: the child gets a minimal base environment plus the secret
// values named in `envNames`. Loader-injection variables are refused outright.

import { isAbsolute } from 'node:path';
import type { AcpAgentProviderConfig } from '@koryphaios/shared';
import type { AcpProbeVerdict } from './agent-store';
import {
  ACP_PERMISSION_PROFILES,
  type AcpPermissionProfile,
} from './protocol';

export type AcpAgentSource = 'manual' | 'registry' | 'autodetect';
export type AcpCwdPolicy = 'workspace' | 'private';

/** Persisted (non-secret) definition. Env values are NOT in here. */
export interface AcpAgentDefinition {
  id: string;
  label: string;
  command: string;
  args: string[];
  envNames: string[];
  cwdPolicy: AcpCwdPolicy;
  permissionProfile: AcpPermissionProfile;
  source: AcpAgentSource;
  registryId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AcpAgentInput {
  id?: string;
  label: string;
  command: string;
  args?: string[];
  /** Env values. Names are persisted in config; values go to the secret store. */
  env?: Record<string, string>;
  cwdPolicy?: AcpCwdPolicy;
  permissionProfile?: AcpPermissionProfile;
  source?: AcpAgentSource;
  registryId?: string;
}

export const ACP_PROVIDER_PREFIX = 'acp:';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 1024;
const MAX_ENV = 32;
const MAX_ENV_VALUE_LENGTH = 8192;
const MAX_COMMAND_LENGTH = 512;

/** Env names a third-party agent must never receive from the user: they change
 *  how the dynamic loader or the Node/Bun runtime executes code before the agent
 *  starts, and PATH would redirect every helper the agent resolves. */
const REFUSED_ENV_EXACT = new Set([
  'PATH',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
  'BASH_ENV',
  'ENV',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'RUBYOPT',
  'PERL5OPT',
]);
const REFUSED_ENV_PREFIXES = ['LD_', 'DYLD_', 'BUN_', 'NODE_'];

export function acpProviderName(id: string): string {
  return `${ACP_PROVIDER_PREFIX}${id}`;
}

export function isAcpProviderName(name: string): boolean {
  return name.startsWith(ACP_PROVIDER_PREFIX);
}

/** Slug an arbitrary label into a stable agent id (lowercase, dashes). */
export function slugifyAcpAgentId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'agent';
}

export function isRefusedAgentEnvName(name: string): boolean {
  if (REFUSED_ENV_EXACT.has(name)) return true;
  return REFUSED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export class AcpAgentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpAgentValidationError';
  }
}

export interface ValidatedAcpAgentInput {
  id: string;
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwdPolicy: AcpCwdPolicy;
  permissionProfile: AcpPermissionProfile;
  source: AcpAgentSource;
  registryId?: string;
}

/** Validate user input. Throws AcpAgentValidationError with a user-safe message. */
export function validateAcpAgentInput(input: AcpAgentInput): ValidatedAcpAgentInput {
  const label = (input.label ?? '').trim();
  if (!label || label.length > 80) {
    throw new AcpAgentValidationError('Agent name is required (80 characters or fewer)');
  }
  const id = (input.id?.trim() || slugifyAcpAgentId(label)).toLowerCase();
  if (!ID_RE.test(id)) {
    throw new AcpAgentValidationError(
      'Agent id must be 1-48 lowercase letters, digits or dashes, starting with a letter or digit',
    );
  }

  const command = (input.command ?? '').trim();
  if (!command || command.length > MAX_COMMAND_LENGTH || /[\0\r\n]/.test(command)) {
    throw new AcpAgentValidationError('A command is required (a program name or absolute path)');
  }
  // A bare program name is resolved on PATH; anything with a separator must be absolute.
  if (/[\\/]/.test(command) && !isAbsolute(command)) {
    throw new AcpAgentValidationError('A command with a path must use an absolute path');
  }

  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_ARGS) {
    throw new AcpAgentValidationError(`Up to ${MAX_ARGS} arguments are allowed`);
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH || arg.includes('\0')) {
      throw new AcpAgentValidationError('Each argument must be a short text value');
    }
  }

  const envInput = input.env ?? {};
  const envEntries = Object.entries(envInput);
  if (envEntries.length > MAX_ENV) {
    throw new AcpAgentValidationError(`Up to ${MAX_ENV} environment variables are allowed`);
  }
  const env: Record<string, string> = {};
  for (const [name, value] of envEntries) {
    if (!ENV_NAME_RE.test(name)) {
      throw new AcpAgentValidationError(
        `Environment variable name "${name.slice(0, 40)}" must be UPPER_SNAKE_CASE`,
      );
    }
    if (isRefusedAgentEnvName(name)) {
      throw new AcpAgentValidationError(
        `Environment variable ${name} cannot be set for an agent (it changes how code is loaded)`,
      );
    }
    if (typeof value !== 'string' || value.length > MAX_ENV_VALUE_LENGTH || value.includes('\0')) {
      throw new AcpAgentValidationError(`Environment variable ${name} has an invalid value`);
    }
    if (value.length > 0) env[name] = value;
  }

  const cwdPolicy = input.cwdPolicy ?? 'workspace';
  if (cwdPolicy !== 'workspace' && cwdPolicy !== 'private') {
    throw new AcpAgentValidationError('cwdPolicy must be "workspace" or "private"');
  }
  const permissionProfile = input.permissionProfile ?? 'bridge-only';
  if (!ACP_PERMISSION_PROFILES.includes(permissionProfile)) {
    throw new AcpAgentValidationError('permissionProfile must be "bridge-only" or "read-only"');
  }

  return {
    id,
    label,
    command,
    args,
    env,
    cwdPolicy,
    permissionProfile,
    source: input.source ?? 'manual',
    ...(input.registryId ? { registryId: input.registryId } : {}),
  };
}

/** Project a persisted definition onto the provider-config shape (no secret values). */
export function toAcpAgentProviderConfig(
  def: AcpAgentDefinition,
  probe?: AcpAgentProviderConfig['probe'],
): AcpAgentProviderConfig {
  return {
    id: def.id,
    label: def.label,
    command: def.command,
    args: [...def.args],
    envNames: [...def.envNames],
    cwdPolicy: def.cwdPolicy,
    permissionProfile: def.permissionProfile,
    source: def.source,
    ...(probe ? { probe } : {}),
  };
}

/** Project a stored probe verdict onto the provider-config probe shape. */
export function toAcpProbeConfig(verdict: AcpProbeVerdict): NonNullable<AcpAgentProviderConfig['probe']> {
  return {
    ok: verdict.ok,
    checkedAt: verdict.checkedAt,
    models: [...verdict.models],
    ...(verdict.protocolVersion !== undefined ? { protocolVersion: verdict.protocolVersion } : {}),
    ...(verdict.agentName ? { agentName: verdict.agentName } : {}),
    ...(verdict.agentVersion ? { agentVersion: verdict.agentVersion } : {}),
    ...(verdict.error ? { error: verdict.error } : {}),
  };
}
