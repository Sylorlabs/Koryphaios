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
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'devin'
  | 'antigravity'
  | 'grok'
  | 'freebuff'
  | 'omnirush'
  | 'codebuddy'
  | 'workbuddy-desktop'
  | 'opencode';

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
  cursor: ['CURSOR_API_KEY', 'CURSOR_CONFIG_DIR'],
  devin: ['COGNITION_API_KEY', 'DEVIN_API_KEY', 'DEVIN_CONFIG_DIR', 'XDG_CONFIG_HOME'],
  antigravity: [
    'ANTIGRAVITY_API_KEY',
    'ANTIGRAVITY_HOME',
    'GEMINI_DIR',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'HOME',
    'USERPROFILE',
    // agy keeps OAuth tokens in the OS keyring; the jailed child reaches it
    // over the D-Bus user bus, so both the address and the runtime dir must
    // flow through (the socket itself is bound via WrapOptions.sockets).
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
  ],
  grok: ['GROK_CODE_XAI_API_KEY', 'XAI_API_KEY', 'GROK_HOME'],
  // CODEBUDDY_CONFIG_DIR controls configuration, not the separate HOME-relative
  // CodeBuddyExtension auth store. Preserve the user's product endpoint choice.
  codebuddy: [
    'CODEBUDDY_CONFIG_DIR',
    'CODEBUDDY_API_KEY',
    'CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT',
    'ACC_PRODUCT_CONFIG_PATH',
  ],
  // The WorkBuddy Desktop runtime is the app's own bundled CLI started in
  // --serve mode. It authenticates through the shared CodeBuddy login state
  // (CODEBUDDY_HOME / CODEBUDDY_API_KEY) while WORKBUDDY_CONFIG_DIR carries
  // the desktop app's user settings context (--setting-sources user).
  'workbuddy-desktop': [
    'CODEBUDDY_HOME',
    'CODEBUDDY_API_KEY',
    'CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT',
    'WORKBUDDY_CONFIG_DIR',
    'CODEBUDDY_CONFIG_DIR',
    'ACC_PRODUCT_CONFIG_PATH',
    'WORKBUDDY_DESKTOP_APP_PATH',
  ],
  // Authentication is copied into the PTY adapter's private HOME. Never pass
  // the Freebuff credential through process.env.
  freebuff: [],
  // Omnirush authentication remains in the CLI-owned OMNIRUSH_DIR/auth.json.
  // Never copy a bearer token into the child environment.
  // opencode resolves its config, credentials, state, and session db under the
  // user's HOME (~/.config/opencode, ~/.local/share/opencode, ~/.local/state/opencode,
  // ~/.cache/opencode). Koryphaios must not copy any ambient provider keys into the
  // child: the CLI is the sole credential authority, and the caller passes the real
  // HOME explicitly as an override. No provider-specific keys are allowlisted.
  opencode: [],
  omnirush: [
    'OMNIRUSH_DIR',
    'OMNIRUSH_AGENT_DIR',
    'OMNIRUSH_AUTO_UPDATE',
    'OMNIRUSH_UPDATE_DELEGATED',
    'OMNIRUSH_OPENCODE_BIN',
    'OMNIRUSH_OPENCODE_CWD',
    'OMNIRUSH_PACKAGE_ROOT',
    'OMNIRUSH_CODING_AGENT_DIR',
    'OMNIRUSH_ENGINE_VERSION',
    'OMNIRUSH_VERSION',
    'OMNIRUSH_GATEWAY_URL',
    'OMNIRUSH_ORIGIN',
    'OMNIRUSH_PROJECT_CONFIG_DIR',
    'OMNIRUSH_BOX_BIN_DIR',
    'OMNIRUSH_BOX_HOME',
    'OMNIRUSH_INSTALL_LOG',
    // The normal Claude engine starts its managed Linux sandbox through the
    // host container runtime. Pass only the endpoint, never the Docker config
    // or registry credentials; the provider resolves the active endpoint from
    // the host context when the child HOME is private.
    'DOCKER_HOST',
    // The current Omnirush 2.x launcher removes inline config from the
    // provider-locked child environment. Omnirush's project-config gate is the
    // supported way for a per-turn OpenCode plugin to load, so the provider
    // opts into its disposable project workspace explicitly.
    'OMNIRUSH_PROJECT_CODE',
    'OPENCODE_CONFIG_CONTENT',
    'PI_CODING_AGENT_DIR',
    'PI_OFFLINE',
    'PI_TELEMETRY',
  ],
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
  cursor: 'CURSOR_API_KEY',
  devin: 'COGNITION_API_KEY',
  antigravity: 'ANTIGRAVITY_API_KEY',
  grok: 'GROK_CODE_XAI_API_KEY',
  codebuddy: 'CODEBUDDY_API_KEY',
  'workbuddy-desktop': 'CODEBUDDY_API_KEY',
} satisfies Partial<Record<NativeCliProvider, string>>);
