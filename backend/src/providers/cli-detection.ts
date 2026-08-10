// Agent-CLI auto-detection.
//
// Koryphaios scans the user's machine for installed agent CLIs and local login/credential
// signals. The registry may use the same signals (via auth-utils) to enable a local adapter,
// but presence does not prove that the remote account accepts the credential. This module is
// the single, side-effect-free source of the detection picture for the API/UI.
//
// "installed" = the CLI binary is on PATH. "loginDetected" = a local credential/login signal
// exists. "loggedIn" is retained as a compatibility alias only. "autoEnabled" means the local
// adapter was enabled from that signal; it is not an authentication verdict.

import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import type { ProviderName } from '@koryphaios/shared';
import {
  detectClaudeCodeLogin,
  detectCodexCLILogin,
  detectAntigravityApiKey,
  detectAntigravityCLILogin,
  createAntigravityCLIAuthMarker,
  detectGrokCLILogin,
  detectGrokXaiKey,
  detectCursorCLILogin,
  createClaudeCLIAuthMarker,
  createCodexCLIAuthMarker,
  createGrokCLIAuthMarker,
  createCursorCLIAuthMarker,
  detectDevinCLILogin,
  createDevinCLIAuthMarker,
  detectClineCLILogin,
  createClineCLIAuthMarker,
  detectKimiCodeCLILogin,
  detectFreebuffCLILogin,
  detectKiloCLILogin,
} from './auth-utils';
import { discoverCliAccounts } from './cli-accounts';
import { createKimiCodeAuthMarker, createKimiCodeCliMarker } from './kimicode-auth';

export interface AgentCliStatus {
  /** Stable id for the CLI. */
  id:
    | 'claude'
    | 'codex'
    | 'antigravity'
    | 'grok'
    | 'cursor'
    | 'devin'
    | 'cline'
    | 'kimi'
    | 'freebuff'
    | 'kilo';
  displayName: string;
  /** Candidate binary names looked up on PATH. */
  binaries: string[];
  /** The CLI binary was found on PATH. */
  installed: boolean;
  binaryPath: string | null;
  /** Legacy alias for loginDetected; never interpret this as remote verification. */
  loggedIn: boolean;
  /** A local login/credential signal for the CLI was found. */
  loginDetected: boolean;
  /** Where the login signal came from (for display; never the secret itself). */
  authSource: string | null;
  /** Koryphaios provider this CLI maps to (null = no provider wired yet). */
  provider: ProviderName | null;
  /** Koryphaios enabled the local adapter from detected setup material. */
  autoEnabled: boolean;
  /** Human-readable status / next step. */
  note: string;
  docsUrl: string;
  /** Deep-integration capability flags (Phase 0). Populated lazily by each
   *  provider's capability probe; false/0 when not yet probed. These drive
   *  the UI's "what's wired" indicators and the bridge transport selection. */
  capabilities?: {
    supportsAgentConfig: boolean;
    supportsSandbox: boolean;
    supportsExport: boolean;
    supportsPermissionMode: boolean;
    supportsAcp: boolean;
    supportsMcp: boolean;
    supportsRules: boolean;
    supportsSkills: boolean;
    supportsHooks: boolean;
    version: string | null;
    probedAt: number;
  };
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
 * installed and a local credential signal present. A bare env var is intentionally not enough
 * (matches the registry's "no auto-auth from environment without intent" rule); the CLI's
 * presence on the machine is the intent signal. Honors KORY_DISABLE_CLI_AUTODETECT.
 */
export function canAutoEnable(provider: ProviderName): boolean {
  if (process.env.KORY_DISABLE_CLI_AUTODETECT) return false;
  switch (provider) {
    case 'claude':
      return !!whichBinary('claude') && detectClaudeCodeLogin();
    case 'codex':
      return (
        !!whichBinary('codex') &&
        (detectCodexCLILogin() ||
          discoverCliAccounts().some((account) => account.provider === 'codex'))
      );
    case 'antigravity':
      return !!whichBinary('agy') && detectAntigravityCLILogin();
    case 'grok':
      // Grok Build subscription CLI — installed + logged in (subscription or xAI key).
      return !!whichBinary('grok') && detectGrokCLILogin();
    case 'cursor':
      return !!whichBinary('cursor-agent') && detectCursorCLILogin();
    case 'devin':
      return !!whichBinary('devin') && detectDevinCLILogin();
    case 'cline':
      return !!whichBinary('cline') && detectClineCLILogin();
    case 'kimicode':
      // The kimi CLI owns its own OAuth session. Koryphaios reads the stored
      // token directly, so the binary is NOT required — a ~/.kimi session
      // from a prior `kimi login` is enough (the user may have uninstalled
      // the CLI but kept the credentials). The binary is still the preferred
      // intent signal, so we check it first.
      return (
        detectKimiCodeCLILogin() ||
        (!!whichBinary('kimi') &&
          discoverCliAccounts().some((account) => account.provider === 'kimicode'))
      );
    case 'freebuff':
      // Detection remains informational, but the undocumented SDK/backend
      // adapter is fail-closed and must never be auto-enabled.
      return false;
    case 'kilocode':
      // Detection is informational only. Koryphaios cannot currently enforce
      // Kilo's tool permissions or workspace sandbox, so it must never be
      // auto-enabled even when the binary and login are present.
      return false;
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
    case 'antigravity':
      return { authToken: createAntigravityCLIAuthMarker() };
    case 'grok':
      // The CLI owns the real token; the marker just signals "use the CLI harness".
      return { authToken: createGrokCLIAuthMarker() };
    case 'cursor':
      return { authToken: createCursorCLIAuthMarker() };
    case 'devin':
      return { authToken: createDevinCLIAuthMarker() };
    case 'cline':
      return { authToken: createClineCLIAuthMarker() };
    case 'kimicode': {
      // Point at the first discovered ~/.kimi* profile. If none are found
      // (e.g. only KIMI_CODE_AUTH_TOKEN is set), fall back to a managed
      // marker so the provider still lights up and the user can sign in
      // via the device flow.
      const account = discoverCliAccounts().find((a) => a.provider === 'kimicode');
      return {
        authToken: account
          ? createKimiCodeCliMarker(account.profileDir)
          : createKimiCodeAuthMarker(),
      };
    }
    case 'kilocode':
      return null;
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
    workingNote:
      'Claude Code login material detected. Chat is routed through the local CLI; account access is verified only when the CLI runs.',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  });

  // ── Codex → `codex` provider. The installed CLI owns its own login. ──
  const machineCodex = detectCodexCLILogin();
  const codex = mk('codex', 'Codex CLI', ['codex'], 'codex', {
    loggedIn: machineCodex,
    authSource: machineCodex ? '~/.codex/auth.json' : null,
    autoEnabled: canAutoEnable('codex'),
    workingNote: machineCodex
      ? 'Codex login material detected. Chat is routed through the installed CLI; account access is verified only when the CLI runs.'
      : 'Codex CLI is installed; no local login material was detected.',
    loggedOutNote: 'No Codex login material detected — run "codex login".',
    docsUrl: 'https://developers.openai.com/codex/cli',
  });

  // ── Antigravity CLI (`agy`) → its own `antigravity` provider. ──
  const antigravityKey = detectAntigravityApiKey();
  const antigravityLogin = detectAntigravityCLILogin();
  const antigravity = mk('antigravity', 'Antigravity CLI', ['agy'], 'antigravity', {
    loggedIn: antigravityLogin,
    authSource: antigravityKey
      ? 'ANTIGRAVITY_API_KEY'
      : antigravityLogin
        ? '~/.gemini/antigravity-cli/'
        : null,
    autoEnabled: canAutoEnable('antigravity'),
    // agy login alone is enough — Koryphaios drives the agy CLI harness
    // directly. ANTIGRAVITY_API_KEY is an optional extra route, never a
    // required step (the old note dead-ended users on an env var the GUI
    // has no field for).
    workingNote: antigravityLogin
      ? 'Antigravity login material detected. Chat is routed through the CLI; account access is verified only when the CLI runs.'
      : antigravityKey
        ? 'ANTIGRAVITY_API_KEY detected. Chat is routed through the CLI; account access is verified only when the CLI runs.'
        : 'Antigravity CLI is installed but not configured.',
    loggedOutNote: 'No Antigravity login material detected — run "agy login".',
    docsUrl: 'https://antigravity.google/docs/cli-getting-started',
  });

  // ── Grok Build → `grok` provider (its own CLI harness, like Claude Code / Codex). ──
  const grokKey = detectGrokXaiKey();
  const grokLogin = detectGrokCLILogin();
  const grok = mk('grok', 'Grok Build', ['grok'], 'grok', {
    loggedIn: grokLogin,
    authSource: grokKey ? 'GROK_CODE_XAI_API_KEY' : grokLogin ? '~/.grok/auth.json' : null,
    autoEnabled: canAutoEnable('grok'),
    workingNote:
      'Grok Build login material detected. Chat is routed through the CLI; account access is verified only when the CLI runs.',
    docsUrl: 'https://docs.x.ai/build/cli/headless-scripting',
  });

  // ── Cursor (cursor-agent) → `cursor` provider (CLI harness, fully working). ──
  const cursorLogin = detectCursorCLILogin();
  const cursor = mk('cursor', 'Cursor CLI', ['cursor-agent'], 'cursor', {
    loggedIn: cursorLogin,
    authSource: cursorLogin
      ? process.env.CURSOR_API_KEY
        ? 'CURSOR_API_KEY'
        : '~/.cursor/cli-config.json'
      : null,
    autoEnabled: canAutoEnable('cursor'),
    workingNote:
      'Cursor login material detected. Chat is routed through cursor-agent; account access is verified only when the CLI runs.',
    loggedOutNote: 'No Cursor login material detected — run "cursor-agent login".',
    docsUrl: 'https://cursor.com/docs/cli',
  });

  // ── Devin (devin) → `devin` provider (CLI harness, cloud-backed subscription). ──
  const devinLogin = detectDevinCLILogin();
  const devin = mk('devin', 'Devin CLI', ['devin'], 'devin', {
    loggedIn: devinLogin,
    authSource: devinLogin
      ? process.env.COGNITION_API_KEY
        ? 'COGNITION_API_KEY'
        : '~/.local/share/devin/credentials.toml'
      : null,
    autoEnabled: canAutoEnable('devin'),
    workingNote:
      'Devin login material detected. Chat is routed through the CLI; account access is verified only when the CLI runs.',
    loggedOutNote: 'No Devin login material detected — run "devin auth login".',
    docsUrl: 'https://docs.devin.ai/',
  });

  const clineLogin = detectClineCLILogin();
  const cline = mk('cline', 'Cline CLI', ['cline'], 'cline', {
    loggedIn: clineLogin,
    authSource: clineLogin ? '~/.cline/data/secrets.json' : null,
    autoEnabled: canAutoEnable('cline'),
    workingNote:
      'Cline credential material detected. Chat is routed through the CLI; provider access is verified only when the CLI runs.',
    loggedOutNote:
      'No Cline credential material detected — run "cline auth --provider <p> --apikey <k>".',
    docsUrl: 'https://docs.cline.bot/cli',
  });

  // ── Kimi Code → `kimicode` provider. The official `kimi` CLI owns its OAuth
  // session at ~/.kimi; Koryphaios reads the stored token directly and calls
  // api.kimi.com/coding/v1 (no subprocess). The binary is optional — a prior
  // `kimi login` is enough — but its presence is the strongest intent signal. ──
  const kimiLogin = detectKimiCodeCLILogin();
  const kimi = mk('kimi', 'Kimi Code CLI', ['kimi'], 'kimicode', {
    loggedIn: kimiLogin,
    authSource: kimiLogin
      ? process.env.KIMI_CODE_AUTH_TOKEN
        ? 'KIMI_CODE_AUTH_TOKEN'
        : '~/.kimi/credentials/kimi-code.json'
      : null,
    autoEnabled: canAutoEnable('kimicode'),
    workingNote:
      'Kimi Code login material detected. Koryphaios verifies it against the Kimi model API before reporting access as verified.',
    loggedOutNote:
      'No Kimi Code login material detected — run "kimi login", or sign in from Settings.',
    docsUrl: 'https://kimi.com/docs/cli',
  });

  // ── Freebuff detection is informational only. The prior undocumented
  // Codebuff SDK/backend adapter is unavailable and never auto-enabled. ──
  const freebuffLogin = detectFreebuffCLILogin();
  const freebuff = mk('freebuff', 'Freebuff CLI', ['freebuff'], 'freebuff', {
    loggedIn: freebuffLogin,
    authSource: freebuffLogin ? '~/.config/manicode/credentials.json' : null,
    autoEnabled: false,
    workingNote:
      'Freebuff login material detected. Execution is unavailable because this build has no supportable authenticated Freebuff provider contract.',
    loggedOutNote:
      'Freebuff integration is unavailable in this build; installation or login detection does not enable execution.',
    docsUrl: 'https://github.com/CodebuffAI/codebuff',
  });

  // ── Kilo Code → `kilocode` provider. The official `kilo` CLI (a fork of
  // OpenCode) owns its own auth at ~/.local/share/kilo/auth.json. Koryphaios
  // drives it as a headless harness (kilo run --format json). ──
  const kiloLogin = detectKiloCLILogin();
  const kilo = mk('kilo', 'Kilo Code CLI', ['kilo'], 'kilocode', {
    loggedIn: kiloLogin,
    authSource: kiloLogin ? '~/.local/share/kilo/auth.json' : null,
    autoEnabled: canAutoEnable('kilocode'),
    workingNote:
      'Kilo Code CLI detected, but Koryphaios cannot yet enforce its tool permissions or workspace sandbox. Chat is unavailable and no Kilo process will be started.',
    loggedOutNote:
      'No Kilo login material detected — run "kilo" and use /connect to sign in. Execution remains unavailable in this build.',
    docsUrl: 'https://kilo.ai/cli',
  });

  return [claude, codex, antigravity, grok, cursor, devin, cline, kimi, freebuff, kilo];
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
    /** Shown when installed but no local login material is detected. */
    loggedOutNote?: string;
    docsUrl: string;
  },
): AgentCliStatus {
  const binaryPath = firstInstalled(binaries);
  const installed = !!binaryPath;
  const note = !installed
    ? `${displayName} CLI not found on PATH.`
    : !opts.loggedIn
      ? (opts.loggedOutNote ?? `${displayName} CLI installed; no login material detected.`)
      : opts.workingNote;
  return {
    id,
    displayName,
    binaries,
    installed,
    binaryPath,
    loggedIn: opts.loggedIn,
    loginDetected: opts.loggedIn,
    authSource: opts.authSource,
    provider,
    // Only claim auto-enabled when the CLI is actually present AND we can drive it.
    autoEnabled: opts.autoEnabled && installed && opts.loggedIn,
    note,
    docsUrl: opts.docsUrl,
  };
}
