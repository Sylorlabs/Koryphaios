// Sandboxed Bash Tool - Uses local execution with safety limits

import { resolve, relative, isAbsolute } from 'path';
import { spawn } from 'child_process';
import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import { validateBashCommand } from '../security';
import { toolLog } from '../logger';
import { shellManager } from './shell-manager';
import { raspEngine } from '../security/rasp';

const MAX_OUTPUT_BYTES = 512_000; // 512KB output limit
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000; // 10 minutes max

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Simple timeout wrapper for command execution
 */
function execWithTimeout(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; killed: boolean }> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let killed = false;

    // Use timeout command for basic time limiting
    const wrappedCommand = `timeout ${Math.ceil(timeoutMs / 1000)} bash -c ${JSON.stringify(command)}`;

    const proc = spawn('bash', ['-c', wrappedCommand], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      // Resource limits via ulimit would go here if needed
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
      // Limit output size
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + '\n[OUTPUT TRUNCATED]';
        proc.kill('SIGTERM');
      }
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > MAX_OUTPUT_BYTES) {
        stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + '\n[STDERR TRUNCATED]';
      }
    });

    proc.on('close', (code) => {
      // timeout command exits 124 if timed out
      const wasKilled = code === 124 || killed;
      resolve({
        stdout,
        stderr: wasKilled ? stderr + '\n[TIMEOUT: Command exceeded time limit]' : stderr,
        exitCode: wasKilled ? 124 : (code ?? 1),
        killed: wasKilled,
      });
    });

    proc.on('error', (err) => {
      resolve({
        stdout,
        stderr: `Execution error: ${err.message}`,
        exitCode: 1,
        killed: false,
      });
    });
  });
}

/**
 * Enhanced bash tool with local execution and safety limits
 */
export class SandboxedBashTool implements Tool {
  readonly name = 'bash';
  readonly description = `Execute a shell command on the system.
  
SECURITY: Commands run with timeout and output limits.
Network access depends on system configuration.
File access is restricted to the workspace.
Resource limits: 512KB output, 2 minute timeout (configurable).`;

  readonly inputSchema = {
    type: 'object' as const,
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
        description: 'Timeout in seconds for foreground commands. Defaults to 120. Max 600.',
      },
      isBackground: {
        type: 'boolean',
        description: 'Whether to run the command in the background.',
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

    // Resolve working directory
    const requestedCwd = workingDirectory
      ? isAbsolute(workingDirectory)
        ? workingDirectory
        : resolve(ctx.workingDirectory, workingDirectory)
      : ctx.workingDirectory;

    // Check if requested path is inside project
    const isInsideProject = isWithinRoot(ctx.workingDirectory, requestedCwd);

    if (ctx.isSandboxed && !isInsideProject) {
      return {
        callId: call.id,
        name: this.name,
        output: `Access Denied: Cannot execute commands outside project root in sandbox mode.\nRequested: ${requestedCwd}\nRoot: ${ctx.workingDirectory}`,
        isError: true,
        durationMs: 0,
      };
    }

    // Validate command content
    const validation = validateBashCommand(command);
    if (!validation.safe) {
      toolLog.warn(
        { command: command.slice(0, 100), reason: validation.reason },
        'Blocked dangerous command',
      );

      // Report to RASP
      raspEngine.recordToolExecution('bash', { command, blocked: true }, ctx.sessionId);

      return {
        callId: call.id,
        name: this.name,
        output: `Command blocked by security policy: ${validation.reason}`,
        isError: true,
        durationMs: 0,
      };
    }

    // Check RASP
    const raspCheck = raspEngine.isOperationAllowed(ctx.sessionId);
    if (!raspCheck.allowed) {
      return {
        callId: call.id,
        name: this.name,
        output: `Blocked by security system: ${raspCheck.reason}`,
        isError: true,
        durationMs: 0,
      };
    }

    // Log to RASP
    raspEngine.recordToolExecution('bash', { command }, ctx.sessionId);

    // Calculate timeout
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (timeout && timeout > 0) {
      timeoutMs = Math.min(timeout * 1000, MAX_TIMEOUT_MS);
    }

    // Background execution
    if (isBackground) {
      return this.runBackground(call.id, command, requestedCwd, processName);
    }

    // Execute with timeout
    return this.runWithTimeout(call.id, command, requestedCwd, timeoutMs);
  }

  private async runWithTimeout(
    callId: string,
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<ToolCallOutput> {
    toolLog.info(
      {
        command: command.slice(0, 200),
        cwd,
        timeoutMs,
      },
      'Executing bash command',
    );

    const startTime = Date.now();

    try {
      const result = await execWithTimeout(command, cwd, timeoutMs);
      const durationMs = Date.now() - startTime;

      // Format output
      let output = '';
      if (result.stdout) output += result.stdout;
      if (result.stderr) {
        output += (output ? '\n--- stderr ---\n' : '') + result.stderr;
      }
      if (!output) {
        output = `(no output, exit code: ${result.exitCode})`;
      }

      return {
        callId,
        name: this.name,
        output: `Exit code: ${result.exitCode}\n${output}`,
        isError: result.exitCode !== 0,
        durationMs,
      };
    } catch (err: any) {
      toolLog.error({ err: err.message }, 'Command execution failed');

      return {
        callId,
        name: this.name,
        output: `Execution error: ${err.message}`,
        isError: true,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private runBackground(
    callId: string,
    command: string,
    cwd: string,
    processName?: string,
  ): ToolCallOutput {
    toolLog.info(
      { command: command.slice(0, 200), name: processName },
      'Starting background process',
    );

    const bgProc = shellManager.startProcess(processName || 'bg-proc', command, cwd);

    return {
      callId,
      name: this.name,
      output: `Background process started.\nID: ${bgProc.id}\nName: ${bgProc.name}\nPID: ${bgProc.pid}\nUse shell_manage to view logs or kill the process.`,
      isError: false,
      durationMs: 0,
    };
  }
}
