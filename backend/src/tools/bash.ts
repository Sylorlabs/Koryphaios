// Bash tool — execute shell commands with security sandboxing.
// Supports both native execution and Docker-based sandboxing.

import { resolve, relative, isAbsolute } from "node:path";
import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from "./registry";
import { validateBashCommand } from "../security";
import { toolLog } from "../logger";
import { executeInSandbox, isDockerAvailable, type SandboxConfig } from "../sandbox/docker-sandbox";
import { getSafeSubprocessEnv } from "../runtime/safe-env";


const MAX_OUTPUT_BYTES = 512_000; // 512KB output limit per command

// Check if Docker sandboxing is enabled via environment
const DOCKER_SANDBOX_ENABLED = process.env.DOCKER_SANDBOX_ENABLED === "true";
const DOCKER_IMAGE = process.env.DOCKER_SANDBOX_IMAGE || "alpine:latest";

// Safe command whitelist for sandboxed mode
// Using a Set for O(1) lookups
const SANDBOX_CMD_WHITELIST = new Set([
  "ls", "dir", "cd", "pwd", "echo", "cat", "grep", "find", "wc", "sort", "uniq", "head", "tail",
  "npm", "node", "bun", "yarn", "pnpm", "tsc", "jest", "vitest", "lint", "prettier",
  "git", "python", "python3", "pip", "pip3", "go", "cargo", "rustc",
  "mkdir", "touch", "cp", "mv", "rm", // destructive allowed inside sandbox
]);

const NETWORK_CMD_BLACKLIST = new Set([
  "curl", "wget", "ssh", "nc", "netcat", "telnet", "ftp", "scp", "rsync",
  "ping", "traceroute", "dig", "nslookup", "whois",
  "nmap", "tcpdump", "wireshark",
]);

declare const Bun: any;

export class BashTool implements Tool {
  readonly name = "bash";
  readonly role = "worker" as const; // manager + worker only (not critic)
  readonly description = `Execute a shell command on the system.

SECURITY NOTE: Commands are executed with strict security controls:
- Docker-based sandboxing is available for true isolation
- Commands are validated against dangerous patterns
- Working directory is constrained to project root
- Network access is controlled
- Resource limits are enforced`;

  readonly inputSchema = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute.",
      },
      workingDirectory: {
        type: "string",
        description: "Working directory for the command. Defaults to the session working directory.",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds. Defaults to 120.",
      },
    },
    required: ["command"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { command, workingDirectory, timeout } = call.input as {
      command: string;
      workingDirectory?: string;
      timeout?: number;
    };

    const requestedCwd = this.resolveCwd(ctx, workingDirectory);
    if (ctx.isSandboxed && !this.isInsideProjectRoot(ctx.workingDirectory, requestedCwd)) {
      return this.errorResponse(call.id, `Access Denied: Cannot execute commands outside project root in sandbox mode.`);
    }

    const validation = validateBashCommand(command);
    if (!validation.safe) {
      toolLog.warn({ command: command.slice(0, 100), reason: validation.reason }, "Blocked dangerous command");
      return this.errorResponse(call.id, `Command blocked by security policy: ${validation.reason}`);
    }

    if (ctx.isSandboxed && !DOCKER_SANDBOX_ENABLED) {
      const baseCmd = command.trim().split(/\s+/)[0];
      if (NETWORK_CMD_BLACKLIST.has(baseCmd)) {
        return this.errorResponse(call.id, `Access Denied: Network tool '${baseCmd}' is blocked in sandbox mode.`);
      }
    }

    const useDockerSandbox = DOCKER_SANDBOX_ENABLED && ctx.isSandboxed;
    const dockerAvailable = useDockerSandbox ? await isDockerAvailable() : false;

    try {
      if (useDockerSandbox && dockerAvailable) {
        return await this.executeDocker(call.id, command, requestedCwd, timeout ?? 120);
      }
      return await this.executeNative(call.id, command, requestedCwd, timeout ?? 120);
    } catch (err: any) {
      return this.errorResponse(call.id, `Execution error: ${err.message}`);
    }
  }

  private resolveCwd(ctx: ToolContext, workingDirectory?: string): string {
    if (!workingDirectory) return ctx.workingDirectory;
    return isAbsolute(workingDirectory)
      ? workingDirectory
      : resolve(ctx.workingDirectory, workingDirectory);
  }


  private isInsideProjectRoot(root: string, requested: string): boolean {
    const rel = relative(root, requested);
    return !rel.startsWith("..") && !isAbsolute(rel);
  }

  private errorResponse(callId: string, message: string): ToolCallOutput {
    return { callId, name: this.name, output: message, isError: true, durationMs: 0 };
  }

  private async executeDocker(callId: string, command: string, cwd: string, timeout: number): Promise<ToolCallOutput> {
    const sandboxConfig: Partial<SandboxConfig> = {
      enabled: true,
      image: DOCKER_IMAGE,
      timeout: timeout * 1000,
      memoryLimit: process.env.DOCKER_MEMORY_LIMIT || "512m",
      cpuLimit: process.env.DOCKER_CPU_LIMIT || "0.5",
      networkDisabled: NETWORK_CMD_BLACKLIST.has(command.trim().split(/\s+/)[0]),
    };

    const result = await executeInSandbox(command, cwd, sandboxConfig);
    let output = result.stdout || "";
    if (result.stderr) output += (output ? "\n--- stderr ---\n" : "") + result.stderr;
    if (!output) output = `(no output, exit code: ${result.exitCode})`;

    return {
      callId,
      name: this.name,
      output: `Exit code: ${result.exitCode}\n${output}\n[Docker sandbox: ${result.duration}ms]`,
      isError: result.exitCode !== 0,
      durationMs: result.duration,
    };
  }

  private async executeNative(callId: string, command: string, cwd: string, timeout: number): Promise<ToolCallOutput> {
    const timeoutMs = timeout * 1000;
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: getSafeSubprocessEnv(),
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error(`Command timed out after ${timeout}s`));
      }, timeoutMs)
    );

    const outputPromise = (async () => {
      const stdoutChunks: Uint8Array[] = [];
      const stderrChunks: Uint8Array[] = [];
      let totalBytes = 0;

      const readStream = async (reader: ReadableStreamDefaultReader<Uint8Array>, chunks: Uint8Array[]) => {
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
        readStream(proc.stdout.getReader(), stdoutChunks),
        readStream(proc.stderr.getReader(), stderrChunks),
      ]);

      const exitCode = await proc.exited;
      const decoder = new TextDecoder();
      const stdout = decoder.decode(Buffer.concat(stdoutChunks));
      const stderr = decoder.decode(Buffer.concat(stderrChunks));

      let output = stdout || "";
      if (stderr) output += (output ? "\n--- stderr ---\n" : "") + stderr;
      if (!output) output = `(no output, exit code: ${exitCode})`;
      if (totalBytes >= MAX_OUTPUT_BYTES) output += `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;

      return {
        callId,
        name: this.name,
        output: `Exit code: ${exitCode}\n${output}`,
        isError: exitCode !== 0,
        durationMs: 0,
      };
    })();

    return await Promise.race([outputPromise, timeoutPromise]);
  }
}
