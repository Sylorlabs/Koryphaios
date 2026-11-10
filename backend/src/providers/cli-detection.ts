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
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import type { ProviderName } from '@koryphaios/shared';
import { locateWorkBuddyDesktopApp } from './workbuddy-desktop-runtime';
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
  createWorkBuddyDesktopAuthMarker,
  detectKimiCodeCLILogin,
  discoverFreebuffAccounts,
  createFreebuffCLIAuthMarker,
  detectOmnirushCLILogin,
  createOmnirushCLIAuthMarker,
  detectCodeBuddyCLILogin,
  createCodeBuddyCLIAuthMarker,
  detectOpenCodeCLILogin,
  createOpenCodeCLIAuthMarker,
} from './auth-utils';
import { discoverCliAccounts } from './cli-accounts';
import { createKimiCodeAuthMarker, createKimiCodeCliMarker } from './kimicode-auth';
import { executableSuffixes, findOnPath, isWindows } from '../runtime/platform';

export interface AgentCliStatus {
  /** Stable id for the CLI. */
  id:
    | 'claude'
    | 'codex'
    | 'antigravity'
    | 'grok'
    | 'codebuddy'
    | 'cursor'
    | 'devin'
    | 'kimi'
    | 'freebuff'
    | 'omnirush'
    | 'opencode';
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
  return findOnPath(name);
}

function firstInstalled(binaries: string[]): string | null {
  for (const b of binaries) {
    const p = whichBinary(b);
    if (p) return p;
  }
  return null;
}

const CLI_PROBE_TIMEOUT_MS = 8_000;

function cliVersionArgs(provider: ProviderName): string[] {
  // Devin uses a subcommand rather than a flag. Everything else that ships a
  // `--version` flag is probed with it. This is intentionally conservative:
  // a missing or incompatible flag is treated as a failed probe.
  return provider === 'devin' ? ['version'] : ['--version'];
}

/**
 * Verify the discovered binary is actually executable. A binary on PATH with
 * local login material is not enough: it may be a shim, a broken install, or
 * missing runtime dependencies. Running a lightweight `--version`/`version`
 * probe is the fastest way to prove the CLI can respond.
 */
export function probeCliVersion(binary: string, provider: ProviderName): boolean {
  try {
    const result = spawnSync(binary, cliVersionArgs(provider), {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLI_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      shell: isWindows(),
    });
    return result.status === 0 && (result.stdout?.trim().length ?? 0) > 0;
  } catch (err: unknown) {
    return false;
  }
}

/** Explicit verification may contact the account backend. Keep it asynchronous
 * so a slow CLI cannot stall health checks or unrelated HTTP requests. */
export function probeCliConnection(binary: string, provider: ProviderName): Promise<boolean> {
  const args =
    provider === 'claude'
      ? ['auth', 'status', '--json']
      : provider === 'codex'
        ? ['login', 'status']
        : provider === 'devin'
          ? ['auth', 'status']
          : provider === 'grok' || provider === 'antigravity'
            ? ['models']
            : provider === 'omnirush'
              ? ['whoami']
              : provider === 'opencode'
                ? ['models']
                : cliVersionArgs(provider);
  return new Promise((resolve) => {
    const child = execFile(
      binary,
      args,
      {
        timeout: CLI_PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        shell: isWindows(),
      },
      (error, stdout, stderr) => {
        if (error) return resolve(false);
        const output = `${stdout}\n${stderr}`.trim();
        if (!output || /not authenticated|not logged in|logged out/i.test(output)) {
          return resolve(false);
        }
        if (provider === 'claude') {
          try {
            return resolve(JSON.parse(stdout || '{}').loggedIn === true);
          } catch {
            return resolve(false);
          }
        }
        resolve(true);
      },
    );
    child.stdin?.end();
  });
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
    case 'claude': {
      const bin = whichBinary('claude');
      return !!bin && detectClaudeCodeLogin();
    }
    case 'codex': {
      const bin = whichBinary('codex');
      return (
        !!bin &&
        (detectCodexCLILogin() ||
          discoverCliAccounts().some((account) => account.provider === 'codex'))
      );
    }
    case 'antigravity': {
      const bin = whichBinary('agy');
      return !!bin && detectAntigravityCLILogin();
    }
    case 'grok': {
      // Grok Build subscription CLI — installed + logged in (subscription or xAI key).
      const bin = whichBinary('grok');
      return !!bin && detectGrokCLILogin();
    }
    case 'codebuddy': {
      // CodeBuddy subscription CLI — installed + logged in (subscription or key).
      const bin = whichBinary('codebuddy');
      return !!bin && detectCodeBuddyCLILogin();
    }
    case 'workbuddy-desktop':
      // The WorkBuddy AI desktop app is the whole configuration: its runtime
      // owns the login, so there is no credential to detect. Installed means
      // ready — no token, no login step in Koryphaios.
      return locateWorkBuddyDesktopApp() !== null;
    case 'cursor': {
      const bin = whichBinary('cursor-agent');
      return !!bin && detectCursorCLILogin();
    }
    case 'devin': {
      const bin = whichBinary('devin');
      return !!bin && detectDevinCLILogin();
    }
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
      // Enable adapter discovery from CLI-owned setup material only. Runtime
      // readiness is asynchronous and checked by the provider: Darwin uses
      // Docker's Linux tmux/bwrap, not nonexistent host tmux/bwrap binaries.
      // As for other CLIs, this is detection, never an authentication verdict.
      return discoverFreebuffAccounts().some(
        (account) =>
          !!whichBinary('freebuff') ||
          executableSuffixes().some((suffix) => existsSync(join(account.profileDir, `freebuff${suffix}`))),
      );
    case 'omnirush':
      return !!whichBinary('omnirush') && detectOmnirushCLILogin();
    case 'opencode':
      // OpenCode subscription CLI — installed + logged in (~/.local/share/opencode/auth.json).
      return !!whichBinary('opencode') && detectOpenCodeCLILogin();
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
    case 'codebuddy':
      return { authToken: createCodeBuddyCLIAuthMarker() };
    case 'cursor':
      return { authToken: createCursorCLIAuthMarker() };
    case 'devin':
      return { authToken: createDevinCLIAuthMarker() };
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
    case 'freebuff':
      // The CLI's credentials file owns the real token; the marker just
      // signals "use the SDK harness".
      return { authToken: createFreebuffCLIAuthMarker() };
    case 'omnirush':
      return { authToken: createOmnirushCLIAuthMarker() };
    case 'opencode':
      // The CLI owns the real token; the marker just signals "use the CLI harness".
      return { authToken: createOpenCodeCLIAuthMarker() };
    case 'workbuddy-desktop':
      // No credential exists to detect: the marker only says "the desktop app
      // is installed, route turns through its runtime".
      return locateWorkBuddyDesktopApp()
        ? { authToken: createWorkBuddyDesktopAuthMarker() }
        : null;
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

  // ── CodeBuddy → `codebuddy` provider (its own CLI harness, like Claude Code / Codex). ──
  const codebuddyLogin = detectCodeBuddyCLILogin();
  const codebuddy = mk('codebuddy', 'CodeBuddy', ['codebuddy'], 'codebuddy', {
    loggedIn: codebuddyLogin,
    authSource: codebuddyLogin ? '~/.codebuddy' : null,
    autoEnabled: canAutoEnable('codebuddy'),
    workingNote:
      'CodeBuddy login material detected. Chat is routed through the CLI; the model catalog is read from the installed CLI product files.',
    loggedOutNote:
      'No CodeBuddy login material detected — complete the interactive `codebuddy` login. The international endpoint (www.codebuddy.ai) is currently banned upstream; run `CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT=internal codebuddy`.',
    docsUrl: 'https://copilot.tencent.com',
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

  // ── Freebuff: real TUI driven through a sandboxed tmux PTY. ──
  const freebuffLogin = discoverFreebuffAccounts().length > 0;
  const freebuff = mk('freebuff', 'Freebuff CLI', ['freebuff'], 'freebuff', {
    loggedIn: freebuffLogin,
    authSource: freebuffLogin ? '~/.config/manicode/credentials.json' : null,
    autoEnabled: canAutoEnable('freebuff'),
    workingNote:
      'Freebuff CLI login material detected. Native Linux uses tmux/bubblewrap; macOS uses the pinned Linux runtime through Docker/Colima with bubblewrap still mandatory. Reconnect to probe isolation. Account/model access is verified only by an actual turn; the real workspace is accessible through authenticated Kory MCP tools.',
    loggedOutNote: 'No Freebuff login material detected — run "freebuff login", then reconnect.',
    docsUrl: 'https://github.com/CodebuffAI/codebuff',
  });

  const omnirushLogin = detectOmnirushCLILogin();
  const omnirush = mk('omnirush', 'Omnirush CLI', ['omnirush'], 'omnirush', {
    loggedIn: omnirushLogin,
    authSource: omnirushLogin ? '~/.omnirush/auth.json' : null,
    autoEnabled: canAutoEnable('omnirush'),
    workingNote:
      'Omnirush login material detected. Chat is routed through the installed CLI; model, context, and thinking metadata are read from the CLI at runtime.',
    loggedOutNote: 'No Omnirush login material detected — run "omnirush login" in your terminal.',
    docsUrl: 'https://omnirush.ai/omnirush',
  });

  const opencodeLogin = detectOpenCodeCLILogin();
  const opencode = mk('opencode', 'OpenCode', ['opencode'], 'opencode', {
    loggedIn: opencodeLogin,
    authSource: opencodeLogin ? '~/.local/share/opencode/auth.json' : null,
    autoEnabled: canAutoEnable('opencode'),
    workingNote:
      'OpenCode login material detected. Chat is routed through the installed CLI (ACP); the model catalog and context windows come from the CLI\'s own authenticated catalog. Account access is verified only when the CLI runs.',
    loggedOutNote:
      'No OpenCode login material detected — run "opencode auth login" in your terminal, then click Auth again.',
    docsUrl: 'https://opencode.ai/docs/cli/',
  });

  return [claude, codex, antigravity, codebuddy, grok, cursor, devin, kimi, freebuff, omnirush, opencode];
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
