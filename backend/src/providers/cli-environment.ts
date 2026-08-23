/**
 * Environment boundary for native provider CLIs.
 *
 * Native children must not inherit the backend's full process.env: it can
 * contain unrelated provider keys, deployment credentials, shell agents, and
 * user-specific configuration. This module is deliberately default-deny. A
 * child receives only minimal process plumbing plus the selected provider's
 * documented authentication/configuration variables.
 */

export type NativeCliProvider =
  'claude' | 'codex' | 'cline' | 'cursor' | 'devin' | 'antigravity' | 'grok';

const PROCESS_ENV_KEYS = [
  // Executable discovery and Windows process startup.
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  // Locale and terminal behavior.
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  // Private temp overrides may be supplied by the caller/soft jail.
  'TMPDIR',
  'TMP',
  'TEMP',
  // Explicit network proxy and trust configuration.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const;

// These paths are accepted only as explicit caller overrides. Copying the
// backend's real HOME/XDG roots by default would re-expose interactive CLI
// state (and any credentials stored below it) to a native child.
const EXPLICIT_PRIVATE_PATH_KEYS = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
] as const;

const KORY_BRIDGE_ENV_KEYS = [
  'KORY_BACKEND_URL',
  'KORY_BRIDGE_AUTH_FILE',
  'KORY_SESSION_ID',
  'KORY_MCP_BRIDGE_SCRIPT',
  'KORY_MCP_BRIDGE_COMMAND',
  'KORY_HOOK_BRIDGE_SCRIPT',
] as const;

const PROVIDER_ENV_KEYS: Record<NativeCliProvider, readonly string[]> = {
  claude: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
    'MAX_THINKING_TOKENS',
  ],
  codex: [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORGANIZATION',
    'OPENAI_PROJECT',
    'CODEX_HOME',
  ],
  cline: [
    'CLINE_API_KEY',
    'CLINE_BASE_URL',
    'CLINE_HOME',
    // Current Cline CLI configuration contracts. Provider/global settings can
    // remain CLI-owned while session/database/team state is redirected into a
    // private Koryphaios runtime directory.
    'CLINE_PROVIDER_SETTINGS_PATH',
    'CLINE_GLOBAL_SETTINGS_PATH',
    'CLINE_MCP_SETTINGS_PATH',
    'CLINE_DB_DATA_DIR',
    'CLINE_SESSION_DATA_DIR',
    'CLINE_TEAM_DATA_DIR',
    'CLINE_HOOKS_DIR',
    'CLINE_HOOKS_LOG_PATH',
    // Retained for compatibility probes and older Cline builds. The current
    // adapter deliberately does not set CLINE_DATA_DIR because modern Cline
    // uses it to relocate provider settings as well as runtime state.
    'CLINE_DATA_DIR',
    'CLINE_SANDBOX',
    'CLINE_SANDBOX_DATA_DIR',
    'CLINE_SESSION_BACKEND_MODE',
    'CLINE_COMMAND_PERMISSIONS',
    'CLINE_TOOL_APPROVAL_MODE',
    'CLINE_TOOL_APPROVAL_DIR',
  ],
  cursor: ['CURSOR_API_KEY', 'CURSOR_CONFIG_DIR'],
  devin: ['COGNITION_API_KEY', 'DEVIN_API_KEY', 'DEVIN_CONFIG_DIR', 'XDG_CONFIG_HOME'],
  antigravity: [
    'ANTIGRAVITY_API_KEY',
    'ANTIGRAVITY_HOME',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'HOME',
    'USERPROFILE',
  ],
  grok: ['GROK_CODE_XAI_API_KEY', 'XAI_API_KEY', 'GROK_HOME'],
};

function allowedKeysFor(provider: NativeCliProvider): ReadonlySet<string> {
  return new Set([
    ...PROCESS_ENV_KEYS,
    ...EXPLICIT_PRIVATE_PATH_KEYS,
    ...KORY_BRIDGE_ENV_KEYS,
    ...PROVIDER_ENV_KEYS[provider],
  ]);
}

/**
 * Build a provider child environment from an explicit allowlist. Overrides are
 * validated against the same list so a future caller cannot accidentally
 * reintroduce ambient secret inheritance through object spreading.
 */
export function buildProviderCliEnv(
  provider: NativeCliProvider,
  overrides: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = allowedKeysFor(provider);
  const result: NodeJS.ProcessEnv = {};

  for (const key of allowed) {
    if ((EXPLICIT_PRIVATE_PATH_KEYS as readonly string[]).includes(key)) continue;
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (!allowed.has(key)) {
      throw new Error(`Refusing non-allowlisted ${provider} CLI environment key: ${key}`);
    }
    if (value === undefined) delete result[key];
    else result[key] = value;
  }

  return result;
}

export function providerCliEnvironmentKeys(provider: NativeCliProvider): readonly string[] {
  return [...allowedKeysFor(provider)].sort();
}

export const PROVIDER_CLI_SECRET_KEYS_FOR_TESTING = Object.freeze({
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  cline: 'CLINE_API_KEY',
  cursor: 'CURSOR_API_KEY',
  devin: 'COGNITION_API_KEY',
  antigravity: 'ANTIGRAVITY_API_KEY',
  grok: 'GROK_CODE_XAI_API_KEY',
} satisfies Record<NativeCliProvider, string>);
