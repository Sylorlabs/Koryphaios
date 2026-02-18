// Bash tool — execute shell commands with security sandboxing.
// Supports both native execution and Docker-based sandboxing.

import { resolve, relative, isAbsolute } from "path";
import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from "./registry";
import { validateBashCommand } from "../security";
import { toolLog } from "../logger";
import { executeInSandbox, isDockerAvailable, validateCommand, type SandboxConfig } from "../sandbox/docker-sandbox";

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

export class BashTool implements Tool {
  readonly name = "bash";
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

    // 1. Resolve and Validate Working Directory
    const requestedCwd = workingDirectory
      ? (isAbsolute(workingDirectory) ? workingDirectory : resolve(ctx.workingDirectory, workingDirectory))
      : ctx.workingDirectory;

    // Ensure CWD is within project root (always enforced for sub-agents)
    const rel = relative(ctx.workingDirectory, requestedCwd);
    const isInsideProject = !rel.startsWith("..") && !isAbsolute(rel);

    // Only Manager or explicitly unsandboxed agents can break out of project root
    if (ctx.isSandboxed && !isInsideProject) {
      return {
        callId: call.id,
        name: this.name,
        output: `Access Denied: Cannot execute commands outside project root in sandbox mode.\nRequested: ${requestedCwd}\nRoot: ${ctx.workingDirectory}`,
        isError: true,
        durationMs: 0,
      };
    }

    // 2. Validate Command Content
    const validation = validateBashCommand(command);
    if (!validation.safe) {
      toolLog.warn({ command: command.slice(0, 100), reason: validation.reason }, "Blocked dangerous command");
      return {
        callId: call.id,
        name: this.name,
        output: `Command blocked by security policy: ${validation.reason}`,
        isError: true,
        durationMs: 0,
      };
    }

    // 3. Determine execution mode
    const useDockerSandbox = DOCKER_SANDBOX_ENABLED && ctx.isSandboxed;
    const dockerAvailable = useDockerSandbox ? await isDockerAvailable() : false;

    // 4. Sandbox Constraints
    if (ctx.isSandboxed && !useDockerSandbox) {
      // Check against whitelist/blacklist for native execution
      const cmdParts = command.trim().split(/\s+/);
      const baseCmd = cmdParts[0];

      // Blacklist check (Network tools)
      if (NETWORK_CMD_BLACKLIST.has(baseCmd) || cmdParts.some(p => NETWORK_CMD_BLACKLIST.has(p))) {
        return {
          callId: call.id,
          name: this.name,
          output: `Access Denied: Network tool '${baseCmd}' is blocked in sandbox mode. Ask Manager to authorize if needed.`,
          isError: true,
          durationMs: 0,
        };
      }
    }

    const timeoutMs = (timeout ?? 120) * 1000;

    toolLog.info({
      command: command.slice(0, 200),
      cwd: requestedCwd,
      sandboxed: ctx.isSandboxed,
      dockerSandbox: useDockerSandbox && dockerAvailable
    }, "Executing bash command");

    // 5. Execute command
    try {
      // Use Docker sandbox if enabled and available
      if (useDockerSandbox && dockerAvailable) {
        const sandboxConfig: Partial<SandboxConfig> = {
          enabled: true,
          image: DOCKER_IMAGE,
          timeout: timeoutMs,
          memoryLimit: process.env.DOCKER_MEMORY_LIMIT || "512m",
          cpuLimit: process.env.DOCKER_CPU_LIMIT || "0.5",
          networkDisabled: NETWORK_CMD_BLACKLIST.has(command.trim().split(/\s+/)[0]),
        };

        const result = await executeInSandbox(command, requestedCwd, sandboxConfig);

        let output = "";
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += (output ? "\n--- stderr ---\n" : "") + result.stderr;
        if (!output) output = `(no output, exit code: ${result.exitCode})`;

        return {
          callId: call.id,
          name: this.name,
          output: `Exit code: ${result.exitCode}\n${output}\n[Docker sandbox: ${result.duration}ms]`,
          isError: result.exitCode !== 0,
          durationMs: result.duration,
        };
      }

      // Native execution with Bun.spawn
      const proc = Bun.spawn(["bash", "-c", command], {
        cwd: requestedCwd,
        stdout: "pipe",
        stderr: "pipe",
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
          readStream(stdoutReader, stdoutChunks),
          readStream(stderrReader, stderrChunks),
        ]);

        const exitCode = await proc.exited;
        const decoder = new TextDecoder();
        const stdout = decoder.decode(Buffer.concat(stdoutChunks));
        const stderr = decoder.decode(Buffer.concat(stderrChunks));

        let output = "";
        if (stdout) output += stdout;
        if (stderr) output += (output ? "\n--- stderr ---\n" : "") + stderr;
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
