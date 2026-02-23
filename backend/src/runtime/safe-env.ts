/**
 * Safe environment for subprocesses — allowlist only.
 * Never pass API keys, auth tokens, or JWT secrets to child processes.
 * Works on all consumer platforms (Windows, macOS, Linux).
 */

const ALLOWED_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "NODE_ENV",
  "NO_COLOR",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
]);

/** Patterns that must never be passed (case-insensitive key match). */
const BLOCKED_PATTERNS = [
  /_API_KEY$/i,
  /_AUTH_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /^JWT_SECRET$/i,
  /^GITHUB_TOKEN$/i,
  /^CODECX_/i,
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^GOOGLE_/i,
  /^GEMINI_/i,
  /^CLINE_/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GCP_/i,
  /^VAULT_/i,
];

function isBlocked(key: string): boolean {
  if (ALLOWED_KEYS.has(key)) return false;
  return BLOCKED_PATTERNS.some((re) => re.test(key));
}

/**
 * Build an env object safe to pass to child processes (Bun.spawn, etc.).
 * Only includes allowlisted keys; strips all credentials and provider env vars.
 */
export function getSafeSubprocessEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};

  for (const key of ALLOWED_KEYS) {
    const val = process.env[key];
    if (val !== undefined && val !== "") out[key] = val;
  }

  for (const [key, value] of Object.entries(extra)) {
    if (!isBlocked(key) && value !== undefined && value !== "") out[key] = value;
  }

  return out;
}
