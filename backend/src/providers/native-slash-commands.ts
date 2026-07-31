// Native CLI slash commands — provider-harness command surface.
//
// When the manager is a CLI-backed provider (Claude Code, Codex, Devin, Grok
// Build, Cursor, Cline, Antigravity, Kimi Code), the user can invoke that
// harness's own `/command`s from the Koryphaios composer. These commands are
// interactive-only inside the native CLIs (print mode rejects them, e.g.
// `claude -p /help` → "/help isn't available in this environment"), so this
// module is the bridge: it knows each harness's command set and runs a real
// headless equivalent where one exists (e.g. `grok models`, `codex doctor`,
// `cursor-agent about`, `git diff`), or surfaces a short, attributed note
// describing the command for the purely-interactive ones.
//
// Output is streamed back to the frontend as `native.command` WebSocket events
// attributed to the provider harness (not Kory), so the user sees the harness's
// reply in the feed labeled "Claude Code", "Devin", etc.

import { spawn } from 'node:child_process';
import { nanoid } from 'nanoid';
import type { ProviderName } from '@koryphaios/shared';
import { whichBinary } from './cli-detection';

/** A native slash command a user can invoke from the composer. */
export interface NativeSlashCommand {
  /** Command name without the leading slash (e.g. "models", "status"). */
  command: string;
  /** Alternate spellings the user might type (e.g. ["m"] for /model). */
  aliases?: string[];
  /** One-line description shown in the slash picker. */
  description: string;
  /** Grouping label for the picker (e.g. "Session", "Models", "Diagnostics"). */
  category: string;
  /** Usage hint for args, if any (e.g. "[model]"). */
  argsHint?: string;
}

/** Context handed to a command executor. */
export interface NativeCommandExecContext {
  provider: string;
  model?: string;
  workingDirectory: string;
  /** Command name without the leading slash (e.g. "diff", "models"). */
  command: string;
  /** Arguments after the command name (e.g. "/diff --stat" → ["--stat"]). */
  args: string[];
  /** Raw command line the user typed, for display. */
  rawCommand: string;
  /** Stream output back to the frontend. Returns false on the final chunk. */
  emit: (text: string, opts?: { isPartial?: boolean; isError?: boolean }) => void;
}

type Executor = (ctx: NativeCommandExecContext) => Promise<void>;

interface NativeCommandDefinition extends NativeSlashCommand {
  execute: Executor;
}

// ─── Provider display labels (mirror the frontend's providerLabel map) ────

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  devin: 'Devin',
  grok: 'Grok Build',
  cursor: 'Cursor',
  cline: 'Cline',
  antigravity: 'Antigravity',
  kimicode: 'Kimi Code',
};

export function getNativeProviderLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** Providers that expose a native slash-command surface through this module. */
export function isNativeCliProvider(provider: string): boolean {
  return provider in PROVIDER_LABELS;
}

// ─── Executor helpers ───────────────────────────────────────────────────────

/** Spawn a binary, stream stdout/stderr to the frontend, emit a final chunk. */
function runCli(
  binary: string,
  args: string[],
  cwd: string,
  ctx: NativeCommandExecContext,
): Promise<void> {
  return new Promise((resolve) => {
    const resolved = whichBinary(binary);
    if (!resolved) {
      ctx.emit(`${binary} is not installed on this machine.`, { isError: true });
      resolve();
      return;
    }
    let stdout = '';
    let stderr = '';
    let firstChunk = true;
    const child = spawn(resolved, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const flush = (data: string, stream: 'stdout' | 'stderr') => {
      if (!data) return;
      if (stream === 'stdout') stdout += data;
      else stderr += data;
      // Stream incrementally so long output (e.g. `devin models list`) appears live.
      ctx.emit(data, { isPartial: true });
      firstChunk = false;
    };
    child.stdout?.on('data', (d: Buffer) => flush(d.toString(), 'stdout'));
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      // Surface stderr too — many CLIs write status/progress to stderr.
      ctx.emit(d.toString(), { isPartial: true });
    });
    child.on('error', (err) => {
      ctx.emit(`\nFailed to run ${binary}: ${err.message}`, { isError: true });
      resolve();
    });
    child.on('close', (code) => {
      if (code !== 0 && !stdout) {
        // Nothing on stdout and non-zero exit: surface stderr as the result.
        ctx.emit(stderr.trim() || `${binary} exited with code ${code}`, {
          isError: true,
        });
      } else {
        // Final marker so the frontend finalizes the accumulated entry.
        ctx.emit('', { isPartial: false });
      }
      void firstChunk;
      resolve();
    });
    // Guard against hangs — cap at 60s for headless status/list commands.
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGTERM');
        ctx.emit('\n(timed out after 60s)', { isError: true });
      }
    }, 60_000);
  });
}

/** Run `git diff` in the working directory, forwarding args. */
function runGitDiff(ctx: NativeCommandExecContext): Promise<void> {
  return runCli('git', ['diff', ...ctx.args], ctx.workingDirectory, ctx);
}

/** Emit a single, final informational note (no headless equivalent). */
async function note(text: string, ctx: NativeCommandExecContext): Promise<void> {
  ctx.emit(text);
}

/** Build a "this is an interactive-only command" note. */
function interactiveNote(
  provider: string,
  command: string,
  description: string,
  koryHint?: string,
): string {
  const label = getNativeProviderLabel(provider);
  const hint = koryHint ? `\n\nIn Koryphaios: ${koryHint}` : '';
  return `/${command} is an interactive ${label} command — ${description}.${hint}\n\nIt runs inside the ${label} TUI, not in Koryphaios's headless harness, so there is no live output to show here.`;
}

// ─── Per-provider command definitions ───────────────────────────────────────
//
// Commands that Koryphaios already owns as built-ins (new, resume, compact,
// clear, help, yolo, settings, theme, sidebar, zen, goal, beginner, advanced)
// are intentionally excluded — Kory's handler resolves those first, so listing
// them here would only duplicate the picker.

const CLAUDE_COMMANDS: NativeCommandDefinition[] = [
  {
    command: 'version',
    description: 'Show the installed Claude Code CLI version.',
    category: 'Diagnostics',
    execute: (ctx) => runCli('claude', ['--version'], ctx.workingDirectory, ctx),
  },
  {
    command: 'diff',
    description: 'Show uncommitted changes in the working tree.',
    category: 'Review',
    execute: runGitDiff,
  },
  {
    command: 'doctor',
    description: 'Diagnose the Claude Code installation and configuration.',
    category: 'Diagnostics',
    execute: (ctx) =>
      note(
        interactiveNote(
          'claude',
          'doctor',
          'runs a setup checkup that diagnoses installation and configuration issues',
          'run `claude doctor` in a terminal to inspect the CLI directly',
        ),
        ctx,
      ),
  },
  {
    command: 'model',
    aliases: ['models'],
    argsHint: '[model]',
    description: 'Switch the active Claude model or list available models.',
    category: 'Models',
    execute: (ctx) =>
      note(
        interactiveNote(
          'claude',
          'model',
          'opens a model picker (and reasoning-effort slider)',
          'use the model picker in the composer to switch Claude models',
        ),
        ctx,
      ),
  },
  {
    command: 'status',
    description: 'Show version, model, account, and connectivity.',
    category: 'Diagnostics',
    execute: (ctx) =>
      note(
        interactiveNote('claude', 'status', 'shows version, model, account, and connectivity'),
        ctx,
      ),
  },
  {
    command: 'cost',
    aliases: ['usage', 'stats'],
    description: 'Show token usage and cost for the session.',
    category: 'Usage',
    execute: (ctx) =>
      note(
        interactiveNote(
          'claude',
          'cost',
          'shows session token usage and cost statistics',
          'Koryphaios tracks per-session token usage and cost in the session history',
        ),
        ctx,
      ),
  },
  {
    command: 'context',
    description: 'Show what is filling the context window.',
    category: 'Usage',
    execute: (ctx) =>
      note(
        interactiveNote(
          'claude',
          'context',
          'shows what is filling the context window',
          'the context bar above the composer shows the current window usage',
        ),
        ctx,
      ),
  },
  {
    command: 'review',
    description: 'Review the current diff for correctness and cleanups.',
    category: 'Review',
    execute: (ctx) =>
      note(
        interactiveNote(
          'claude',
          'review',
          'reviews the current diff for correctness bugs and cleanups',
          'open the Git panel to review changes, or ask Kory to review the diff',
        ),
        ctx,
      ),
  },
  {
    command: 'rewind',
    description: 'Roll code and conversation back to a checkpoint.',
    category: 'Session',
    execute: (ctx) =>
      note(
        interactiveNote(
          'claude',
          'rewind',
          'rolls code and conversation back to a checkpoint',
          'use Time Travel in the sidebar to step back to an earlier state',
        ),
        ctx,
      ),
  },
  {
    command: 'permissions',
    description: 'Set tool approval rules for the session.',
    category: 'Config',
    execute: (ctx) =>
      note(
        interactiveNote(
          'claude',
          'permissions',
          'opens the permissions editor for tool approval rules',
          'configure approval rules in Settings',
        ),
        ctx,
      ),
  },
  {
    command: 'mcp',
    description: 'Manage MCP servers for the project.',
    category: 'Config',
    execute: (ctx) =>
      note(
        interactiveNote(
          'claude',
          'mcp',
          'manages MCP servers connected to Claude Code',
          'configure MCP servers in Settings → MCP',
        ),
        ctx,
      ),
  },
  {
    command: 'memory',
    description: 'Edit the project memory file (CLAUDE.md).',
    category: 'Config',
    execute: (ctx) =>
      note(
        interactiveNote(
          'claude',
          'memory',
          'opens the project memory file for editing',
          'edit CLAUDE.md directly or use the Notes panel',
        ),
        ctx,
      ),
  },
  {
    command: 'init',
    description: 'Generate a starter CLAUDE.md for the project.',
    category: 'Config',
    execute: (ctx) =>
      note(
        interactiveNote(
          'claude',
          'init',
          'generates a starter CLAUDE.md',
          'ask Kory to generate a CLAUDE.md/AGENTS.md for the project',
        ),
        ctx,
      ),
  },
  {
    command: 'feedback',
    description: 'Report a bug with session context attached.',
    category: 'System',
    execute: (ctx) =>
      note(
        interactiveNote(
          'claude',
          'feedback',
          'reports a bug with session context attached',
          'use Koryphaios Feedback in Settings to send diagnostics',
        ),
        ctx,
      ),
  },
];

const CODEX_COMMANDS: NativeCommandDefinition[] = [
  {
    command: 'version',
    description: 'Show the installed Codex CLI version.',
    category: 'Diagnostics',
    execute: (ctx) => runCli('codex', ['--version'], ctx.workingDirectory, ctx),
  },
  {
    command: 'doctor',
    description: 'Diagnose the local Codex installation, config, and auth.',
    category: 'Diagnostics',
    execute: (ctx) => runCli('codex', ['doctor'], ctx.workingDirectory, ctx),
  },
  {
    command: 'diff',
    description: 'Show the Git diff, including untracked files.',
    category: 'Review',
    execute: runGitDiff,
  },
  {
    command: 'review',
    argsHint: '[instructions]',
    description: 'Run a non-interactive code review of the working tree.',
    category: 'Review',
    execute: (ctx) =>
      runCli('codex', ['review', ...ctx.args], ctx.workingDirectory, ctx),
  },
  {
    command: 'model',
    aliases: ['models', 'fast'],
    argsHint: '[model]',
    description: 'Switch the active Codex model or toggle fast mode.',
    category: 'Models',
    execute: (ctx) =>
      note(
        interactiveNote(
          'codex',
          'model',
          'opens a model picker (and reasoning-effort)',
          'use the model picker in the composer to switch Codex models',
        ),
        ctx,
      ),
  },
  {
    command: 'status',
    description: 'Show session config and token usage.',
    category: 'Usage',
    execute: (ctx) =>
      note(interactiveNote('codex', 'status', 'shows session configuration and token usage'), ctx),
  },
  {
    command: 'permissions',
    description: 'Open the approval-preset picker.',
    category: 'Config',
    execute: (ctx) =>
      note(interactiveNote('codex', 'permissions', 'opens an approval-preset picker'), ctx),
  },
];

const DEVIN_COMMANDS: NativeCommandDefinition[] = [
  {
    command: 'version',
    description: 'Show the installed Devin CLI version.',
    category: 'Diagnostics',
    execute: (ctx) => runCli('devin', ['version'], ctx.workingDirectory, ctx),
  },
  {
    command: 'models',
    description: 'List the models available to your Devin account.',
    category: 'Models',
    execute: (ctx) => runCli('devin', ['models', 'list'], ctx.workingDirectory, ctx),
  },
  {
    command: 'sessions',
    aliases: ['ls', 'list-sessions'],
    description: 'List recent Devin sessions in the current directory.',
    category: 'Session',
    execute: (ctx) => runCli('devin', ['list'], ctx.workingDirectory, ctx),
  },
  {
    command: 'diff',
    description: 'Show uncommitted changes in the working tree.',
    category: 'Review',
    execute: runGitDiff,
  },
  {
    command: 'model',
    argsHint: '[model]',
    description: 'Switch the active Devin model.',
    category: 'Models',
    execute: (ctx) =>
      note(
        interactiveNote(
          'devin',
          'model',
          'switches the active model',
          'use the model picker in the composer to switch Devin models',
        ),
        ctx,
      ),
  },
  {
    command: 'usage',
    description: 'Show estimated credit/ACU usage for the session.',
    category: 'Usage',
    execute: (ctx) =>
      note(interactiveNote('devin', 'usage', 'shows estimated credit/ACU usage for the session'), ctx),
  },
  {
    command: 'context',
    description: 'Show context window usage.',
    category: 'Usage',
    execute: (ctx) =>
      note(interactiveNote('devin', 'context', 'shows context window usage'), ctx),
  },
  {
    command: 'steps',
    description: 'List conversation steps (used with /fork and /revert).',
    category: 'Session',
    execute: (ctx) =>
      note(interactiveNote('devin', 'steps', 'lists conversation steps for fork/revert'), ctx),
  },
  {
    command: 'update',
    argsHint: '[--force]',
    description: 'Check for and install Devin CLI updates.',
    category: 'System',
    execute: (ctx) => runCli('devin', ['update', ...ctx.args], ctx.workingDirectory, ctx),
  },
  {
    command: 'bug',
    argsHint: '[description]',
    description: 'Report a bug to the Devin CLI developers.',
    category: 'System',
    execute: (ctx) =>
      note(
        interactiveNote(
          'devin',
          'bug',
          'reports a bug to the Devin CLI developers',
          'use Koryphaios Feedback in Settings to send diagnostics',
        ),
        ctx,
      ),
  },
];

const GROK_COMMANDS: NativeCommandDefinition[] = [
  {
    command: 'version',
    description: 'Show the installed Grok Build CLI version.',
    category: 'Diagnostics',
    execute: (ctx) => runCli('grok', ['--version'], ctx.workingDirectory, ctx),
  },
  {
    command: 'models',
    aliases: ['model', 'm'],
    argsHint: '[model]',
    description: 'List available Grok models or switch the active model.',
    category: 'Models',
    execute: (ctx) => runCli('grok', ['models'], ctx.workingDirectory, ctx),
  },
  {
    command: 'inspect',
    description: 'Show the config Grok discovers for this directory.',
    category: 'Diagnostics',
    execute: (ctx) => runCli('grok', ['inspect'], ctx.workingDirectory, ctx),
  },
  {
    command: 'diff',
    description: 'Show uncommitted changes in the working tree.',
    category: 'Review',
    execute: runGitDiff,
  },
  {
    command: 'usage',
    description: 'Show token and credit usage.',
    category: 'Usage',
    execute: (ctx) =>
      note(interactiveNote('grok', 'usage', 'shows token and credit usage'), ctx),
  },
  {
    command: 'context',
    description: 'View context usage.',
    category: 'Usage',
    execute: (ctx) => note(interactiveNote('grok', 'context', 'shows context usage'), ctx),
  },
  {
    command: 'rewind',
    description: 'Rewind to a previous turn.',
    category: 'Session',
    execute: (ctx) =>
      note(
        interactiveNote(
          'grok',
          'rewind',
          'rewinds to a previous turn',
          'use Time Travel in the sidebar to step back',
        ),
        ctx,
      ),
  },
  {
    command: 'always-approve',
    aliases: ['yolo'],
    description: 'Toggle always-approve (yolo) mode.',
    category: 'Config',
    execute: (ctx) =>
      note(
        interactiveNote(
          'grok',
          'always-approve',
          'toggles auto-approve mode',
          'use /yolo in the composer (a Koryphaios built-in) to toggle YOLO mode',
        ),
        ctx,
      ),
  },
];

const CURSOR_COMMANDS: NativeCommandDefinition[] = [
  {
    command: 'version',
    description: 'Show the installed Cursor CLI version.',
    category: 'Diagnostics',
    execute: (ctx) => runCli('cursor-agent', ['--version'], ctx.workingDirectory, ctx),
  },
  {
    command: 'about',
    description: 'Show CLI version, system, and account info.',
    category: 'Diagnostics',
    execute: (ctx) => runCli('cursor-agent', ['about'], ctx.workingDirectory, ctx),
  },
  {
    command: 'models',
    aliases: ['model'],
    argsHint: '[filter]',
    description: 'List available Cursor models or switch the active model.',
    category: 'Models',
    execute: (ctx) => runCli('cursor-agent', ['models'], ctx.workingDirectory, ctx),
  },
  {
    command: 'status',
    aliases: ['whoami'],
    description: 'Show Cursor authentication status.',
    category: 'Diagnostics',
    execute: (ctx) => runCli('cursor-agent', ['status'], ctx.workingDirectory, ctx),
  },
  {
    command: 'diff',
    description: 'Show uncommitted changes in the working tree.',
    category: 'Review',
    execute: runGitDiff,
  },
  {
    command: 'summarize',
    aliases: ['compress'],
    description: 'Summarize the conversation to reduce context.',
    category: 'Session',
    execute: (ctx) =>
      note(
        interactiveNote(
          'cursor',
          'summarize',
          'summarizes the conversation to reduce context',
          'use /compact in the composer (a Koryphaios built-in) to compact the session',
        ),
        ctx,
      ),
  },
  {
    command: 'rewind',
    description: 'Jump back to a previous message.',
    category: 'Session',
    execute: (ctx) =>
      note(
        interactiveNote(
          'cursor',
          'rewind',
          'jumps back to a previous message',
          'use Time Travel in the sidebar to step back',
        ),
        ctx,
      ),
  },
  {
    command: 'plan',
    description: 'Switch to Plan mode.',
    category: 'Config',
    execute: (ctx) =>
      note(interactiveNote('cursor', 'plan', 'switches to Plan mode'), ctx),
  },
  {
    command: 'ask',
    description: 'Toggle Ask (read-only) mode.',
    category: 'Config',
    execute: (ctx) => note(interactiveNote('cursor', 'ask', 'toggles read-only Ask mode'), ctx),
  },
];

const CLINE_COMMANDS: NativeCommandDefinition[] = [
  {
    command: 'version',
    description: 'Show the installed Cline CLI version.',
    category: 'Diagnostics',
    execute: (ctx) => runCli('cline', ['--version'], ctx.workingDirectory, ctx),
  },
  {
    command: 'diff',
    description: 'Show uncommitted changes in the working tree.',
    category: 'Review',
    execute: runGitDiff,
  },
  {
    command: 'models',
    aliases: ['model'],
    description: 'Quick model switching.',
    category: 'Models',
    execute: (ctx) =>
      note(
        interactiveNote(
          'cline',
          'models',
          'opens quick model switching',
          'use the model picker in the composer to switch Cline models',
        ),
        ctx,
      ),
  },
  {
    command: 'history',
    description: 'Browse and resume previous tasks.',
    category: 'Session',
    execute: (ctx) =>
      note(
        interactiveNote(
          'cline',
          'history',
          'browses and resumes previous tasks',
          'use the session list in the sidebar to resume a chat',
        ),
        ctx,
      ),
  },
];

const ANTIGRAVITY_COMMANDS: NativeCommandDefinition[] = [
  {
    command: 'version',
    description: 'Show the installed Antigravity CLI version.',
    category: 'Diagnostics',
    execute: (ctx) => runCli('agy', ['--version'], ctx.workingDirectory, ctx),
  },
  {
    command: 'models',
    aliases: ['model'],
    argsHint: '[model]',
    description: 'List available Antigravity models or switch the active model.',
    category: 'Models',
    execute: (ctx) => runCli('agy', ['models'], ctx.workingDirectory, ctx),
  },
  {
    command: 'agents',
    aliases: ['agent'],
    description: 'List available Antigravity agents.',
    category: 'Diagnostics',
    execute: (ctx) => runCli('agy', ['agents'], ctx.workingDirectory, ctx),
  },
  {
    command: 'changelog',
    description: 'Show changelog and release notes.',
    category: 'System',
    execute: (ctx) => runCli('agy', ['changelog'], ctx.workingDirectory, ctx),
  },
  {
    command: 'diff',
    description: 'Show uncommitted changes in the working tree.',
    category: 'Review',
    execute: runGitDiff,
  },
  {
    command: 'usage',
    description: 'Show quota and rate-limit status across models.',
    category: 'Usage',
    execute: (ctx) =>
      note(interactiveNote('antigravity', 'usage', 'shows quota and rate-limit status'), ctx),
  },
  {
    command: 'context',
    description: 'Show token usage by category and checkpoint management.',
    category: 'Usage',
    execute: (ctx) =>
      note(interactiveNote('antigravity', 'context', 'shows token usage by category'), ctx),
  },
  {
    command: 'plan',
    description: 'Enter plan mode.',
    category: 'Config',
    execute: (ctx) => note(interactiveNote('antigravity', 'plan', 'enters plan mode'), ctx),
  },
  {
    command: 'rewind',
    description: 'Roll back to a previous turn.',
    category: 'Session',
    execute: (ctx) =>
      note(
        interactiveNote(
          'antigravity',
          'rewind',
          'rolls back to a previous turn',
          'use Time Travel in the sidebar to step back',
        ),
        ctx,
      ),
  },
];

const KIMICODE_COMMANDS: NativeCommandDefinition[] = [
  {
    command: 'version',
    description: 'Show the installed Kimi Code CLI version.',
    category: 'Diagnostics',
    execute: (ctx) => runCli('kimi', ['--version'], ctx.workingDirectory, ctx),
  },
  {
    command: 'diff',
    description: 'Show uncommitted changes in the working tree.',
    category: 'Review',
    execute: runGitDiff,
  },
  {
    command: 'model',
    aliases: ['models'],
    argsHint: '[model]',
    description: 'Switch the LLM model and thinking mode.',
    category: 'Models',
    execute: (ctx) =>
      note(
        interactiveNote(
          'kimicode',
          'model',
          'switches the model and thinking mode',
          'use the model picker in the composer to switch Kimi models',
        ),
        ctx,
      ),
  },
  {
    command: 'sessions',
    description: 'Browse historical sessions and switch to one.',
    category: 'Session',
    execute: (ctx) =>
      note(
        interactiveNote(
          'kimicode',
          'sessions',
          'browses historical sessions',
          'use the session list in the sidebar to resume a chat',
        ),
        ctx,
      ),
  },
  {
    command: 'permission',
    description: 'Select a permission mode.',
    category: 'Config',
    execute: (ctx) =>
      note(interactiveNote('kimicode', 'permission', 'selects a permission mode'), ctx),
  },
  {
    command: 'provider',
    description: 'Open the interactive provider manager.',
    category: 'Config',
    execute: (ctx) =>
      note(
        interactiveNote(
          'kimicode',
          'provider',
          'opens the interactive provider manager',
          'configure providers in Settings',
        ),
        ctx,
      ),
  },
];

const REGISTRY: Record<string, NativeCommandDefinition[]> = {
  claude: CLAUDE_COMMANDS,
  codex: CODEX_COMMANDS,
  devin: DEVIN_COMMANDS,
  grok: GROK_COMMANDS,
  cursor: CURSOR_COMMANDS,
  cline: CLINE_COMMANDS,
  antigravity: ANTIGRAVITY_COMMANDS,
  kimicode: KIMICODE_COMMANDS,
};

/** Public command list for a provider (executors stripped) for the picker. */
export function getNativeSlashCommands(provider: ProviderName | string): NativeSlashCommand[] {
  const defs = REGISTRY[String(provider)];
  if (!defs) return [];
  return defs.map(({ command, aliases, description, category, argsHint }) => ({
    command,
    aliases,
    description,
    category,
    argsHint,
  }));
}

/** Look up a command (including aliases) for a provider. */
function resolveCommand(
  provider: string,
  name: string,
): NativeCommandDefinition | undefined {
  const defs = REGISTRY[provider];
  if (!defs) return undefined;
  return defs.find(
    (d) => d.command === name || (d.aliases?.includes(name) ?? false),
  );
}

/**
 * Execute a native slash command for a provider, streaming output to the
 * frontend via the provided `emit` callback. Returns true if the command was
 * recognized and executed (even if it only emitted a note), false if the
 * provider has no such command (so the caller can fall through to the model).
 */
export async function executeNativeSlashCommand(
  ctx: NativeCommandExecContext,
): Promise<boolean> {
  const def = resolveCommand(ctx.provider, ctx.command);
  if (!def) return false;
  await def.execute(ctx);
  return true;
}

/** Parse a raw `/command args...` line into a command name + args. */
export function parseNativeCommandLine(
  raw: string,
): { command: string; args: string[] } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  const command = parts[0]?.toLowerCase();
  if (!command) return null;
  return { command, args: parts.slice(1) };
}

/** Build a stable message id for accumulating streamed chunks in the frontend. */
export function newNativeMessageId(): string {
  return `native-${nanoid(10)}`;
}
