// Provider auto-detection helpers.
//
// Connection material already present on the machine — env API keys and auth
// tokens, AWS credentials for Bedrock, running local model servers — may
// auto-connect a built-in provider, but only after the provider's real
// verification probe succeeds. ProviderRegistry.autoDetectProviders owns the
// pass; nothing here enables anything by itself.

import type { ProviderName } from '@koryphaios/shared';
import { ENV_API_KEY_MAP, ENV_AUTH_TOKEN_MAP, ENV_URL_MAP } from './constants';
import { PROVIDER_CONFIGS } from './provider-configs';

/**
 * Autodetect opt-outs. KORY_DISABLE_CLI_AUTODETECT is the historical switch
 * the test suite already sets to isolate from the host, so it gates this pass
 * too; KORY_DISABLE_PROVIDER_AUTODETECT names the feature directly.
 */
export function isProviderAutodetectDisabled(env = process.env): boolean {
  return !!(
    env.KORY_DISABLE_CLI_AUTODETECT?.trim() || env.KORY_DISABLE_PROVIDER_AUTODETECT?.trim()
  );
}

/** Every env var the login-shell hydration probe is allowed to adopt. */
export function providerEnvNamesForHydration(): Set<string> {
  const names = new Set<string>();
  for (const keys of Object.values(ENV_API_KEY_MAP)) {
    for (const key of keys) names.add(key);
  }
  for (const keys of Object.values(ENV_AUTH_TOKEN_MAP)) {
    for (const key of keys) names.add(key);
  }
  for (const key of Object.values(ENV_URL_MAP)) {
    if (key) names.add(key);
  }
  for (const key of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_PROFILE',
  ]) {
    names.add(key);
  }
  return names;
}

/**
 * The env var that supplies a provider's key/token, with the var name so the
 * UI can say where the connection came from. `env:`/`enc:` values are
 * indirections into the secret store, never raw material — same rule as the
 * registry's own env detection.
 */
export function envVarMaterial(
  name: ProviderName,
  kind: 'apiKey' | 'authToken',
): { envVar: string; value: string } | null {
  const envVars = kind === 'apiKey' ? (ENV_API_KEY_MAP[name] ?? []) : (ENV_AUTH_TOKEN_MAP[name] ?? []);
  for (const envVar of envVars) {
    const value = process.env[envVar];
    if (!value) continue;
    if (value.startsWith('env:') || value.startsWith('enc:')) return null;
    return { envVar, value };
  }
  return null;
}

/**
 * Base URL worth probing for a local model server. Ollama, LM Studio, and
 * llama.cpp are probed at their env override or their PROVIDER_CONFIGS
 * default; the generic `local` provider only has a candidate when the user
 * exported LOCAL_ENDPOINT.
 */
export function localServerCandidate(name: ProviderName): string | null {
  const envUrlKey = ENV_URL_MAP[name];
  const envUrl = envUrlKey ? process.env[envUrlKey]?.trim() : undefined;
  if (name === 'local') return envUrl || null;
  if (name !== 'ollama' && name !== 'lmstudio' && name !== 'llamacpp') return null;
  if (envUrl) return envUrl;
  return PROVIDER_CONFIGS.find((config) => config.name === name)?.baseUrl || null;
}
