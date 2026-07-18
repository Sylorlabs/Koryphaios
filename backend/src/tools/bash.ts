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

    const catastrophic = isCatastrophicBashCommand(command);
    if (catastrophic) {
      if (!ctx.waitForUserInput) {
        return {
          callId: call.id,
          name: this.name,
          output: 'Catastrophic command blocked because no human approval channel is available.',
          isError: true,
          durationMs: 0,
        };
      }
      const selection = await ctx.waitForUserInput(
        `This command can destroy broad system or home-directory data:\n\n${command}\n\nRun it anyway?`,
        ['Cancel (Recommended)', 'Run catastrophic command'],
      );
      if (selection !== 'Run catastrophic command') {
        return {
          callId: call.id,
          name: this.name,
          output: 'Catastrophic command cancelled by the user.',
          isError: true,
          durationMs: 0,
        };
      }
    }

    // Check if requested path is inside project
    const isInsideProject = isWithinRoot(ctx.workingDirectory, requestedCwd);

    // Only enforce project root check if sandboxed
    if (ctx.isSandboxed && !isInsideProject) {
      return {
        callId: call.id,
        name: this.name,
        output: `Access Denied: Cannot execute commands outside project root in sandbox mode.\nRequested: ${requestedCwd}\nRoot: ${ctx.workingDirectory}`,
        isError: true,
        durationMs: 0,
      };
    }

    // 2. Validate Command Content (comprehensive security check)
    const validation = validateBashCommand(command, {
      isSandboxed: ctx.isSandboxed,
      allowNetwork: !ctx.isSandboxed, // Only allow network in unsandboxed mode
    });

    // Audit log the attempt
    auditBashCommand(command, {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      userId: 'system', // TODO: Get from auth context
      isSandboxed: ctx.isSandboxed ?? true,
      allowed: validation.safe ?? false,
      reason: validation.reason,
    });

    if (!validation.safe && !catastrophic) {
      return {
        callId: call.id,
        name: this.name,
        output: `Command blocked by security policy: ${validation.reason}${validation.requiresUnsandboxed ? '\n\nThis command requires unsandboxed mode. The Manager can run it with full permissions.' : ''}`,
        isError: true,
        durationMs: 0,
      };
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
        restartPolicy: 'on-failure',
        maxRestarts: 3,
        metadata: {
          toolCallId: call.id,
          isSandboxed: ctx.isSandboxed,
        },
      });

      return {
        callId: call.id,
        name: this.name,
        output: `Supervised background process started.\nID: ${bgProc.id}\nName: ${bgProc.name}\nPID: ${bgProc.pid}\nRestart Policy: ${bgProc.restartPolicy} (max ${bgProc.maxRestarts} restarts)\nUse shell_manage or Process Supervisor to view logs or kill the process.`,
        isError: false,
        durationMs: 0,
      };
    }

    const timeoutMs = (timeout ?? 120) * 1000;

    toolLog.info(
      { command: command.slice(0, 200), cwd: requestedCwd, sandboxed: ctx.isSandboxed },
      'Executing bash command',
    );

    // Apply resource limits to the command
    const limitedCommand = buildCommandWithLimits(command, AGENT_RESOURCE_LIMITS);

    try {
      const proc = Bun.spawn(['bash', '-c', limitedCommand], {
        cwd: requestedCwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PATH: process.env.PATH },
      });

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
    } catch (err: any) {
      return {
        callId: call.id,
        name: this.name,
        output: `Execution error: ${err.message}`,
        isError: true,
        durationMs: 0,
      };
    }
  }
}
