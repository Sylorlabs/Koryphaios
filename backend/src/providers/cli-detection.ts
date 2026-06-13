// Agent-CLI auto-detection.
//
// Koryphaios scans the user's machine for installed + logged-in agent CLIs (Claude Code,
// Codex, Gemini CLI, Grok Build, Cursor) and surfaces them so their providers light up
// with zero manual configuration. The registry uses the same signals (via auth-utils) to
// auto-enable providers on boot; this module is the single, side-effect-free source of the
// detection picture for the API/UI.
//
// "installed" = the CLI binary is on PATH. "loggedIn" = a credential/login signal exists.
// "autoEnabled" = Koryphaios can drive a working provider from it right now (the rest are
// detected + surfaced, but chatting through them needs an API key or a dedicated harness).

import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import type { ProviderName } from '@koryphaios/shared';
import {
  detectClaudeCodeLogin,
  detectCodexAuthToken,
  detectCodexCLILogin,
  detectGeminiCLILogin,
  detectGeminiApiKey,
  detectGrokCLILogin,
  detectGrokXaiKey,
  detectCursorCLILogin,
  createClaudeCLIAuthMarker,
  createCodexCLIAuthMarker,
  createGrokCLIAuthMarker,
} from './auth-utils';

export interface AgentCliStatus {
  /** Stable id for the CLI. */
  id: 'claude' | 'codex' | 'gemini' | 'grok' | 'cursor';
  displayName: string;
  /** Candidate binary names looked up on PATH. */
  binaries: string[];
  /** The CLI binary was found on PATH. */
  installed: boolean;
  binaryPath: string | null;
  /** A login/credential signal for the CLI was found. */
  loggedIn: boolean;
  /** Where the login signal came from (for display; never the secret itself). */
  authSource: string | null;
  /** Koryphaios provider this CLI maps to (null = no provider wired yet). */
  provider: ProviderName | null;
  /** Koryphaios can drive a working provider from this CLI right now. */
  autoEnabled: boolean;
  /** Human-readable status / next step. */
  note: string;
  docsUrl: string;
}

/** Locate an executable on PATH without spawning a process. */
export function whichBinary(name: string): string | null {
  const PATH = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function firstInstalled(binaries: string[]): string | null {
  for (const b of binaries) {
    const p = whichBinary(b);
    if (p) return p;
  }
  return null;
}

/**
 * The single gate for auto-enabling a CLI-backed provider: the CLI binary must be
 * INSTALLED and a working credential present. A bare env var is intentionally NOT enough
 * (matches the registry's "no auto-auth from environment without intent" rule); the CLI's
 * presence on the machine is the intent signal. Honors KORY_DISABLE_CLI_AUTODETECT.
 */
export function canAutoEnable(provider: ProviderName): boolean {
  if (process.env.KORY_DISABLE_CLI_AUTODETECT) return false;
  switch (provider) {
    case 'claude':
      return !!whichBinary('claude') && detectClaudeCodeLogin();
    case 'codex':
      return !!whichBinary('codex') && !!detectCodexAuthToken();
    case 'google':
      return !!whichBinary('gemini') && !!detectGeminiApiKey();
    case 'grok':
      // Grok Build subscription CLI — installed + logged in (subscription or xAI key).
      return !!whichBinary('grok') && detectGrokCLILogin();
    default:
      return false;
  }
}

/**
 * Credentials to inject when auto-enabling a CLI-backed provider, or null if it isn't
 * auto-enableable. Used by the registry; shares {@link canAutoEnable}'s gate so the
 * detection report and the actual provider state never disagree.
 */
export function cliAutoEnableCreds(
  provider: ProviderName,
): { apiKey?: string; authToken?: string } | null {
  if (!canAutoEnable(provider)) return null;
  switch (provider) {
    case 'claude':
      // The CLI owns the real token; the marker just signals "use the CLI harness".
      return { authToken: createClaudeCLIAuthMarker() };
    case 'codex':
      return { authToken: createCodexCLIAuthMarker() };
    case 'google':
      return { apiKey: detectGeminiApiKey() ?? undefined };
    case 'grok':
      // The CLI owns the real token; the marker just signals "use the CLI harness".
      return { authToken: createGrokCLIAuthMarker() };
    default:
      return null;
  }
}

/**
 * Build the full detection picture. `autoDetectDisabled` mirrors the registry's
 * KORY_DISABLE_CLI_AUTODETECT opt-out so the reported `autoEnabled` matches reality.
 */
export function detectAgentClis(): AgentCliStatus[] {
  // ── Claude Code → `claude` provider (CLI harness, fully working) ──
  const claudeLogin = detectClaudeCodeLogin();
  const claude = mk('claude', 'Claude Code', ['claude'], 'claude', {
    loggedIn: claudeLogin,
    authSource: claudeLogin ? '~/.claude (subscription login)' : null,
    autoEnabled: canAutoEnable('claude'),
    workingNote: 'Chats through the Claude Code CLI harness.',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  });

  // ── Codex → `codex` provider. Koryphaios uses an isolated codex-home for the actual
  // token; a machine-wide ~/.codex login is surfaced too. ──
  const koryCodexToken = !!detectCodexAuthToken();
  const machineCodex = detectCodexCLILogin();
  const codex = mk('codex', 'OpenAI Codex', ['codex'], 'codex', {
    loggedIn: koryCodexToken || machineCodex,
    authSource: koryCodexToken
      ? 'Koryphaios codex-home'
      : machineCodex
        ? '~/.codex/auth.json'
        : null,
    autoEnabled: canAutoEnable('codex'),
    workingNote: koryCodexToken
      ? 'Chats through the Codex provider.'
      : machineCodex
        ? 'Codex CLI login found — run the in-app Codex connect to link it to Koryphaios.'
        : 'Codex CLI is installed but not logged in.',
    docsUrl: 'https://developers.openai.com/codex/cli',
  });

  // ── Gemini CLI → `google` provider. The provider needs an API key; the CLI's OAuth
  // login is detected/surfaced but can't drive the API directly without a key. ──
  const geminiKey = detectGeminiApiKey();
  const geminiLogin = detectGeminiCLILogin();
  const gemini = mk('gemini', 'Gemini CLI', ['gemini'], 'google', {
    loggedIn: geminiLogin,
    authSource: geminiKey
      ? 'GEMINI_API_KEY / GOOGLE_API_KEY'
      : geminiLogin
        ? '~/.gemini/oauth_creds.json'
        : null,
    autoEnabled: canAutoEnable('google'),
    workingNote: geminiKey
      ? 'Chats through the Google (Gemini) provider.'
      : geminiLogin
        ? 'Gemini CLI login detected — set a Gemini API key to chat (the CLI OAuth token cannot call the API directly).'
        : 'Gemini CLI is installed but not logged in.',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  });

  // ── Grok Build → `grok` provider (its own CLI harness, like Claude Code / Codex). ──
  const grokKey = detectGrokXaiKey();
  const grokLogin = detectGrokCLILogin();
  const grok = mk('grok', 'Grok Build', ['grok'], 'grok', {
    loggedIn: grokLogin,
    authSource: grokKey ? 'GROK_CODE_XAI_API_KEY' : grokLogin ? '~/.grok/auth.json' : null,
    autoEnabled: canAutoEnable('grok'),
    workingNote: 'Chats through the Grok Build CLI harness.',
    docsUrl: 'https://docs.x.ai/build/cli/headless-scripting',
  });

  // ── Cursor (cursor-agent) → no Koryphaios provider yet; detected + surfaced. ──
  const cursorLogin = detectCursorCLILogin();
  const cursor = mk('cursor', 'Cursor CLI', ['cursor-agent'], null, {
    loggedIn: cursorLogin,
    authSource: cursorLogin
      ? process.env.CURSOR_API_KEY
        ? 'CURSOR_API_KEY'
        : '~/.cursor/cli-config.json'
      : null,
    autoEnabled: false,
    workingNote: cursorLogin
      ? 'Cursor CLI detected and logged in — direct chat needs the Cursor CLI harness (not yet wired).'
      : 'Cursor CLI is installed but not logged in.',
    docsUrl: 'https://cursor.com/docs/cli',
  });

  return [claude, codex, gemini, grok, cursor];
}

function mk(
  id: AgentCliStatus['id'],
  displayName: string,
  binaries: string[],
  provider: ProviderName | null,
  opts: {
    loggedIn: boolean;
    authSource: string | null;
    autoEnabled: boolean;
    workingNote: string;
    docsUrl: string;
  },
): AgentCliStatus {
  const binaryPath = firstInstalled(binaries);
  const installed = !!binaryPath;
  const note = !installed
    ? `${displayName} CLI not found on PATH.`
    : !opts.loggedIn
      ? `${displayName} CLI installed but not logged in.`
      : opts.workingNote;
  return {
    id,
    displayName,
    binaries,
    installed,
    binaryPath,
    loggedIn: opts.loggedIn,
    authSource: opts.authSource,
    provider,
    // Only claim auto-enabled when the CLI is actually present AND we can drive it.
    autoEnabled: opts.autoEnabled && installed && opts.loggedIn,
    note,
    docsUrl: opts.docsUrl,
  };
}
