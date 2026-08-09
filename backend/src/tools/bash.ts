// Bash tool — execute shell commands with security sandboxing.
// Uses Bun's spawn for process execution with command validation.

import { resolve, relative, isAbsolute } from 'path';
import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import {
  validateBashCommand,
  auditBashCommand,
  SANDBOX_CMD_WHITELIST,
} from '../security/bash-sandbox';
import { toolLog } from '../logger';
import { shellManager } from './shell-manager';
import { processSupervisor } from '../process-supervisor/supervisor';
import { getCollaborationToolPolicy } from '../collaboration/tool-policy';
import {
  buildCommandWithLimits,
  validateResourceRequest,
  AGENT_RESOURCE_LIMITS,
} from '../security/resource-limits';
import { requireBash } from '../runtime/shell';
import { tokenizeCommand, resolveCommandPath } from '../runtime/shell-argv';
import {
  spawnSandboxed as spawnOsSandboxed,
  osSandboxEnabled,
  defaultAllowedRoots,
} from '../security/os-sandbox';
import { bypassLocalRiskPrompts } from './permission-policy';
import { loadAgentSettings, saveAgentSettings } from '../agent-settings';

const MAX_OUTPUT_BYTES = 512_000; // 512KB output limit per command

const NETWORK_CMD_BLACKLIST = new Set([
  'curl',
  'wget',
  'ssh',
  'nc',
  'netcat',
  'telnet',
  'ftp',
  'scp',
  'rsync',
  'ping',
  'traceroute',
  'dig',
  'nslookup',
  'whois',
  'nmap',
  'tcpdump',
  'wireshark',
]);

const CATASTROPHIC_COMMAND_PATTERNS = [
  /\brm\s+[^\n]*(?:-[a-z]*r[a-z]*f|-rf|-fr)[^\n]*(?:\s\/\s*$|\s\/\*|\s~(?:\/|\s|$)|\$HOME|\/home\/[^/\s]+\/?\s*$)/i,
  /\bmkfs(?:\.[a-z0-9]+)?\b/i,
  /\bdd\s+[^\n]*\bof=\/dev\/(?:sd|hd|nvme|vd)[a-z0-9]*/i,
  /(?:^|\s)>\s*\/dev\/(?:sd|hd|nvme|vd)[a-z0-9]*/i,
  /\b(?:shutdown|reboot|poweroff|halt)\b/i,
  /\bsystemctl\s+(?:poweroff|reboot|halt)\b/i,
  /:\(\)\s*\{\s*:\|:&\s*;\s*\}\s*;/,
];

export function isCatastrophicBashCommand(command: string): boolean {
  return CATASTROPHIC_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Extract base command names from a compound shell command.
 *  Also extracts commands from subshells and command substitutions. */
function parseBaseCommands(command: string): string[] {
  // Split on shell operators: ||, &&, |, ;, and newlines
  const segments = command
    .split(/(?:\|\||&&|[|;\n])/g)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const bases: string[] = [];
  for (const segment of segments) {
    // Strip leading subshell/grouping characters: (, {, $(
    const cleaned = segment.replace(/^[\s(${]*/, '');
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const firstExecutable = tokens.find(
      (t) => !t.includes('=') || t.startsWith('./') || t.startsWith('/'),
    );
    if (!firstExecutable) continue;
    // Strip any remaining shell metacharacters from the executable name
    const sanitized = firstExecutable.replace(/^['"(${]+|['")}]+$/g, '');
    if (sanitized) bases.push(sanitized);
  }

  return bases;
}

function commandPatternMatches(command: string, pattern: string): boolean {
  const base = command.split('/').pop() || command;
  const normalized = pattern.trim();
  if (normalized === '*') return true;
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp(`^${escaped}$`);
  return re.test(command) || re.test(base);
}

// ─── Sandboxed execution helpers ───────────────────────────────────────
//
// Sandboxed commands route through the OS sandbox (bwrap on Linux,
// sandbox-exec on macOS) when enabled, otherwise argv-only execution
// (no shell). The old `bash -c <string>` path is only used for
// unsandboxed (manager) commands that legitimately need shell features.

interface SpawnedProc {
  kill(signal?: string): void;
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  pid: number;
}

function spawnSandboxedCommand(
  command: string,
  cwd: string,
  ctx: ToolContext,
  _isSandboxed: boolean,
): SpawnedProc {
  const { argv, needsShell, shellFeatures } = tokenizeCommand(command);

  if (needsShell) {
    // The command uses shell features (pipes, redirects, &&). Route through
    // the OS sandbox which confines the shell and its children. If the OS
    // sandbox is not enabled, REJECT — running shell-feature commands
    // without confinement is exactly the bypass the old path allowed.
    if (!osSandboxEnabled()) {
      throw new Error(
        `Sandboxed command uses shell features (${shellFeatures?.join(', ')}) ` +
          'but OS sandbox is not enabled. Set KORYPHAIOS_OS_SANDBOX=1 to enable ' +
          'kernel-level confinement, or run the command without shell operators.',
      );
    }
    // OS sandbox enabled: run the command through a confined shell.
    const shell = requireBash();
    const roots = defaultAllowedRoots(cwd);
    const { proc, cleanup } = spawnOsSandboxed(
      [shell.command, ...shell.args, command],
      {
        allowedRoots: roots,
        cwd,
        blockNetwork: true,
        blockSubprocesses: false,
      },
    );
    return wrapChildProcess(proc, cleanup);
  }

  // Argv-only: no shell. Resolve the command on PATH and spawn directly.
  if (argv.length === 0) {
    throw new Error('Empty command after tokenization');
  }
  const resolved = resolveCommandPath(argv[0]);
  if (!resolved) {
    throw new Error(`Command not found: ${argv[0]}`);
  }

  if (osSandboxEnabled()) {
    const roots = defaultAllowedRoots(cwd);
    const { proc, cleanup } = spawnOsSandboxed([resolved, ...argv.slice(1)], {
      allowedRoots: roots,
      cwd,
      blockNetwork: true,
      blockSubprocesses: false,
    });
    return wrapChildProcess(proc, cleanup);
  }

  // No OS sandbox: argv-only with shell:false. This is still a major
  // improvement over `bash -c` because no shell interprets the string.
  const proc = Bun.spawn([resolved, ...argv.slice(1)], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PATH: process.env.PATH },
  });
  return proc as unknown as SpawnedProc;
}

function spawnUnsandboxedCommand(command: string, cwd: string): SpawnedProc {
  const shell = requireBash();
  const proc = Bun.spawn([shell.command, ...shell.args, command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PATH: process.env.PATH },
  });
  return proc as unknown as SpawnedProc;
}

// Wrap a node:child_process spawn result into the same shape Bun.spawn
// returns, so the rest of the bash tool can treat both uniformly.
function wrapChildProcess(
  proc: import('node:child_process').ChildProcess,
  cleanup: () => void,
): SpawnedProc {
  // Convert node streams to Web ReadableStreams.
  const stdout = nodeStreamToWebStream(proc.stdout);
  const stderr = nodeStreamToWebStream(proc.stderr);
  const exited = new Promise<number>((resolve) => {
    proc.on('exit', (code) => {
      cleanup();
      resolve(code ?? 1);
    });
    proc.on('error', (err) => {
      cleanup();
      toolLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'child process error');
      resolve(1);
    });
  });
  return {
    kill: (signal?: string) => {
      try {
        proc.kill(signal ? (signal as NodeJS.Signals) : 'SIGTERM');
      } catch {
        /* ignore */
      }
    },
    exited,
    stdout,
    stderr,
    pid: proc.pid ?? -1,
  };
}

function nodeStreamToWebStream(
  stream: import('node:stream').Readable | null,
): ReadableStream<Uint8Array> {
  if (!stream) return new ReadableStream({ start(c) { c.close(); } });
  const reader = stream[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value as Uint8Array);
    },
    cancel() {
      stream.destroy();
    },
  });
}

export class BashTool implements Tool {
  readonly name = 'bash';
  readonly description = `Execute a shell command on the system.
  
SECURITY NOTE: By default, commands are sandboxed to the project directory and only safe development tools (npm, git, ls, grep, etc.) are allowed.
Absolute paths outside the project are blocked.
Network access via curl/wget is blocked unless explicitly authorized.`;

  readonly inputSchema = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute.',
      },
      workingDirectory: {
        type: 'string',
        description:
          'Working directory for the command. Defaults to the session working directory.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds for foreground commands. Defaults to 120.',
      },
      isBackground: {
        type: 'boolean',
        description:
          'Whether to run the command in the background and keep it running. Use for long-lived processes like servers.',
      },
      processName: {
        type: 'string',
        description: 'Optional descriptive name for the background process.',
      },
    },
    required: ['command'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { command, workingDirectory, timeout, isBackground, processName } = call.input as {
      command: string;
      workingDirectory?: string;
      timeout?: number;
      isBackground?: boolean;
      processName?: string;
    };

    // 1. Resolve and Validate Working Directory
    const requestedCwd = workingDirectory
      ? isAbsolute(workingDirectory)
        ? workingDirectory
        : resolve(ctx.workingDirectory, workingDirectory)
      : ctx.workingDirectory;

    const collaborationPolicy = getCollaborationToolPolicy(ctx.sessionId);
    if (collaborationPolicy) {
      const commands = parseBaseCommands(command);
      const blocked = commands.find((cmd) =>
        collaborationPolicy.commandBlocklist.some((pattern) => commandPatternMatches(cmd, pattern)),
      );
      const notAllowed =
        collaborationPolicy.commandAllowlist.length &&
        !collaborationPolicy.commandAllowlist.includes('*')
          ? commands.find(
              (cmd) =>
                !collaborationPolicy.commandAllowlist.some((pattern) =>
                  commandPatternMatches(cmd, pattern),
                ),
            )
          : undefined;
      if (blocked || notAllowed) {
        return {
          callId: call.id,
          name: this.name,
          output: `Command blocked by team access policy: ${blocked || notAllowed}`,
          isError: true,
          durationMs: 0,
        };
      }
    }

    const approvedByPreset = ctx.approvedToolCallIds?.has(call.id) === true;
    const bypassRiskPrompts = bypassLocalRiskPrompts(ctx.permissionPolicy);
    const catastrophic = isCatastrophicBashCommand(command);
    if (catastrophic && !approvedByPreset && !bypassRiskPrompts) {
      // Check persisted bash command allowlist/blocklist first.
      const baseCmds = parseBaseCommands(command);
      const settings = loadAgentSettings(ctx.workingDirectory);
      const onBlocklist = baseCmds.some((cmd) =>
        settings.bashCommandBlocklist.some((pattern) => commandPatternMatches(cmd, pattern)),
      );
      if (onBlocklist) {
        return {
          callId: call.id,
          name: this.name,
          output: 'Catastrophic command blocked by user-configured blocklist.',
          isError: true,
          durationMs: 0,
        };
      }
      const onAllowlist = baseCmds.length > 0 && baseCmds.every((cmd) =>
        settings.bashCommandAllowlist.some((pattern) => commandPatternMatches(cmd, pattern)),
      );
      if (onAllowlist) {
        // User previously allowed this command pattern — skip the prompt.
      } else if (!ctx.waitForUserInput) {
        return {
          callId: call.id,
          name: this.name,
          output: 'Blocked catastrophic command because no human approval channel is available.',
          isError: true,
          durationMs: 0,
        };
      } else {
        const selection = await ctx.waitForUserInput(
          `This command can destroy broad system or home-directory data:\n\n${command}\n\nRun it anyway?`,
          ['Allow and add command to allowlist', 'Block and add command to blocklist', 'Run catastrophic command'],
          { allowOther: false, allowKeepChatting: false },
        );
        if (selection === 'Block and add command to blocklist') {
          // Persist the blocklist decision.
          const updated = loadAgentSettings(ctx.workingDirectory);
          for (const cmd of baseCmds) {
            if (!updated.bashCommandBlocklist.includes(cmd)) {
              updated.bashCommandBlocklist.push(cmd);
            }
          }
          saveAgentSettings(ctx.workingDirectory, updated);
          return {
            callId: call.id,
            name: this.name,
            output: 'Catastrophic command blocked by the user. Command added to blocklist.',
            isError: true,
            durationMs: 0,
          };
        }
        if (selection === 'Allow and add command to allowlist') {
          // Persist the allowlist decision and continue.
          const updated = loadAgentSettings(ctx.workingDirectory);
          for (const cmd of baseCmds) {
            if (!updated.bashCommandAllowlist.includes(cmd)) {
              updated.bashCommandAllowlist.push(cmd);
            }
          }
          saveAgentSettings(ctx.workingDirectory, updated);
        } else if (selection !== 'Run catastrophic command') {
          return {
            callId: call.id,
            name: this.name,
            output: 'Catastrophic command cancelled by the user.',
            isError: true,
            durationMs: 0,
          };
        }
      }
    }

    // Check if requested path is inside project
    const isInsideProject = isWithinRoot(ctx.workingDirectory, requestedCwd);

    // Resolve effective sandbox flags. Prefer the granular sandboxOptions
    // populated from agent settings; fall back to the legacy boolean for
    // callers that haven't been wired through the resolver yet.
    const sandbox = ctx.sandboxOptions;
    const effectiveSandboxed = sandbox ? sandbox.isSandboxed : ctx.isSandboxed;
    const enforcePathConfinement = sandbox ? sandbox.pathConfinement && sandbox.isSandboxed : ctx.isSandboxed;

    // Only enforce project root check if sandboxed (and path confinement enabled)
    if (enforcePathConfinement && !isInsideProject) {
      return {
        callId: call.id,
        name: this.name,
        output: `Access Denied: Cannot execute commands outside project root in sandbox mode.\nRequested: ${requestedCwd}\nRoot: ${ctx.workingDirectory}`,
        isError: true,
        durationMs: 0,
      };
    }

    // 2. Validate Command Content (comprehensive security check)
    const validation = validateBashCommand(command, sandbox
      ? {
          isSandboxed: sandbox.isSandboxed,
          allowNetwork: !sandbox.isSandboxed,
          commandWhitelist: sandbox.commandWhitelist,
          metacharacters: sandbox.metacharacters,
          network: sandbox.network,
          containerTools: sandbox.containerTools,
        }
      : {
          isSandboxed: ctx.isSandboxed,
          allowNetwork: !ctx.isSandboxed, // Only allow network in unsandboxed mode
        });

    // Audit log the attempt
    auditBashCommand(command, {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      userId: 'system', // TODO: Get from auth context
      isSandboxed: effectiveSandboxed ?? true,
      allowed: validation.safe ?? false,
      reason: validation.reason,
    });

    if (!validation.safe && !catastrophic && !approvedByPreset && !bypassRiskPrompts) {
      // Check persisted bash command allowlist/blocklist first.
      const baseCmds = parseBaseCommands(command);
      const settings = loadAgentSettings(ctx.workingDirectory);
      const onBlocklist = baseCmds.some((cmd) =>
        settings.bashCommandBlocklist.some((pattern) => commandPatternMatches(cmd, pattern)),
      );
      if (onBlocklist) {
        return {
          callId: call.id,
          name: this.name,
          output: `Command blocked by user-configured blocklist: ${validation.reason}`,
          isError: true,
          durationMs: 0,
        };
      }
      const onAllowlist = baseCmds.length > 0 && baseCmds.every((cmd) =>
        settings.bashCommandAllowlist.some((pattern) => commandPatternMatches(cmd, pattern)),
      );
      if (onAllowlist) {
        // User previously allowed this command pattern — skip the prompt.
      } else if (!ctx.waitForUserInput) {
        return {
          callId: call.id,
          name: this.name,
          output: `Risky command requires approval, but no human approval channel is available: ${validation.reason}`,
          isError: true,
          durationMs: 0,
        };
      } else {
        const selection = await ctx.waitForUserInput(
          `This command triggered a safety check (${validation.reason}):\n\n${command}\n\nRun it anyway?`,
          ['Allow and add command to allowlist', 'Block and add command to blocklist', 'Run risky command'],
          { allowOther: false, allowKeepChatting: false },
        );
        if (selection === 'Block and add command to blocklist') {
          const updated = loadAgentSettings(ctx.workingDirectory);
          for (const cmd of baseCmds) {
            if (!updated.bashCommandBlocklist.includes(cmd)) {
              updated.bashCommandBlocklist.push(cmd);
            }
          }
          saveAgentSettings(ctx.workingDirectory, updated);
          return {
            callId: call.id,
            name: this.name,
            output: 'Risky command blocked by the user. Command added to blocklist.',
            isError: true,
            durationMs: 0,
          };
        }
        if (selection === 'Allow and add command to allowlist') {
          const updated = loadAgentSettings(ctx.workingDirectory);
          for (const cmd of baseCmds) {
            if (!updated.bashCommandAllowlist.includes(cmd)) {
              updated.bashCommandAllowlist.push(cmd);
            }
          }
          saveAgentSettings(ctx.workingDirectory, updated);
        } else if (selection !== 'Run risky command') {
          return {
            callId: call.id,
            name: this.name,
            output: 'Risky command cancelled by the user.',
            isError: true,
            durationMs: 0,
          };
        }
      }
    }

    // 4. Background Execution (using Process Supervisor)
    if (isBackground) {
      toolLog.info(
        { command: command.slice(0, 200), name: processName, sessionId: ctx.sessionId },
        'Starting supervised background process',
      );

      const bgProc = await processSupervisor.startProcess({
        name: processName || 'bg-proc',
        command,
        cwd: requestedCwd,
        sessionId: ctx.sessionId,
        // Sandboxed agents can't plant persistent background processes.
        // When isSandboxed, force restartPolicy to 'never' and maxRestarts
        // to 0 so a dying process stays dead. The unsandboxed manager
        // keeps the auto-restart capability for legitimate long-running
        // services (dev servers, watchers, etc.).
        restartPolicy: effectiveSandboxed ? 'never' : 'on-failure',
        maxRestarts: effectiveSandboxed ? 0 : 3,
        metadata: {
          toolCallId: call.id,
          isSandboxed: effectiveSandboxed,
        },
      });

      return {
        callId: call.id,
        name: this.name,
        output: `Supervised background process started.\nID: ${bgProc.id}\nName: ${bgProc.name}\nPID: ${bgProc.pid}\nRestart Policy: ${bgProc.restartPolicy} (max ${bgProc.maxRestarts} restarts)\n${effectiveSandboxed ? 'Note: sandboxed agents cannot auto-restart background processes.\n' : ''}Use shell_manage or Process Supervisor to view logs or kill the process.`,
        isError: false,
        durationMs: 0,
      };
    }

    const timeoutMs = (timeout ?? 120) * 1000;

    toolLog.info(
      { command: command.slice(0, 200), cwd: requestedCwd, sandboxed: effectiveSandboxed },
      'Executing bash command',
    );

    // Apply resource limits to the command
    const limitedCommand = buildCommandWithLimits(command, AGENT_RESOURCE_LIMITS);

    try {
      // Sandboxed execution path: route through the OS sandbox when enabled,
      // otherwise argv-only (no shell). The old `bash -c <string>` path is
      // only used for unsandboxed (manager) commands that legitimately need
      // shell features (pipes, redirects, &&).
      const proc = effectiveSandboxed
        ? spawnSandboxedCommand(limitedCommand, requestedCwd, ctx, effectiveSandboxed)
        : spawnUnsandboxedCommand(limitedCommand, requestedCwd);

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => {
          proc.kill();
          reject(new Error(`Command timed out after ${timeout ?? 120}s`));
        }, timeoutMs),
      );

      const outputPromise = (async () => {
        const stdoutChunks: Uint8Array[] = [];
        const stderrChunks: Uint8Array[] = [];
        let totalBytes = 0;

        const stdoutReader = proc.stdout.getReader();
        const stderrReader = proc.stderr.getReader();

        // Read stdout
        const readStream = async (
          reader: ReadableStreamDefaultReader<Uint8Array>,
          chunks: Uint8Array[],
        ) => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (totalBytes < MAX_OUTPUT_BYTES) {
              chunks.push(value);
              totalBytes += value.length;
            }
          }
        };

        await Promise.all([
          readStream(stdoutReader, stdoutChunks),
          readStream(stderrReader, stderrChunks),
        ]);

        const exitCode = await proc.exited;
        const decoder = new TextDecoder();
        const stdout = decoder.decode(Buffer.concat(stdoutChunks));
        const stderr = decoder.decode(Buffer.concat(stderrChunks));

        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;
        if (!output) output = `(no output, exit code: ${exitCode})`;

        if (totalBytes >= MAX_OUTPUT_BYTES) {
          output += `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
        }

        return {
          callId: call.id,
          name: this.name,
          output: `Exit code: ${exitCode}\n${output}`,
          isError: exitCode !== 0,
          durationMs: 0,
        };
      })();

      return await Promise.race([outputPromise, timeoutPromise]);
    } catch (err: unknown) {
      toolLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'bash: command execution error');
      return {
        callId: call.id,
        name: this.name,
        output: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        durationMs: 0,
      };
    }
  }
}
