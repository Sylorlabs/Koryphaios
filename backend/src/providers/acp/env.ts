// Environment for a spawned ACP agent. Default-deny: a third-party agent sees only
// a minimal, allowlisted base from the backend's environment plus the secret values
// the user explicitly bound to that agent. Nothing else from the backend's
// environment (provider keys, Kory tokens, bridge grants) is inherited.

const BASE_ENV_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USERPROFILE',
  'SYSTEMROOT',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
] as const;

const BASE_ENV_PREFIXES = ['LC_'] as const;

export function buildAcpChildEnv(
  secretEnv: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const wanted = new Set<string>(BASE_ENV_NAMES);
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (wanted.has(upper) || BASE_ENV_PREFIXES.some((p) => upper.startsWith(p))) {
      out[name] = value;
    }
  }
  for (const [name, value] of Object.entries(secretEnv)) {
    out[name] = value;
  }
  return out;
}
