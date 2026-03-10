// Bash tool — execute shell commands with security sandboxing.
// Uses Bun's spawn for process execution with command validation.

import { resolve, relative, isAbsolute } from "path";
import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from "./registry";
import { validateBashCommand } from "../security";
import { toolLog } from "../logger";
import { shellManager } from "./shell-manager";
import {
  buildCommandWithLimits,
  validateResourceRequest,
  AGENT_RESOURCE_LIMITS,
} from "../security/resource-limits";

const MAX_OUTPUT_BYTES = 512_000; // 512KB output limit per command

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

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
    const cleaned = segment.replace(/^[\s(${]*/, "");
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const firstExecutable = tokens.find((t) => !t.includes("=") || t.startsWith("./") || t.startsWith("/"));
    if (!firstExecutable) continue;
    // Strip any remaining shell metacharacters from the executable name
    const sanitized = firstExecutable.replace(/^['"(${]+|['")}]+$/g, "");
    if (sanitized) bases.push(sanitized);
  }

  return bases;
}

export class BashTool implements Tool {
  readonly name = "bash";
  readonly description = `Execute a shell command on the system.
  
SECURITY NOTE: By default, commands are sandboxed to the project directory and only safe development tools (npm, git, ls, grep, etc.) are allowed.
Absolute paths outside the project are blocked.
Network access via curl/wget is blocked unless explicitly authorized.`;

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
        description: "Timeout in seconds for foreground commands. Defaults to 120.",
      },
      isBackground: {
        type: "boolean",
        description: "Whether to run the command in the background and keep it running. Use for long-lived processes like servers.",
      },
      processName: {
        type: "string",
        description: "Optional descriptive name for the background process.",
      },
    },
    required: ["command"],
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
      ? (isAbsolute(workingDirectory) ? workingDirectory : resolve(ctx.workingDirectory, workingDirectory))
      : ctx.workingDirectory;

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

    // 3. Sandbox Constraints
    if (ctx.isSandboxed) {
      // Check against whitelist/blacklist
      const baseCommands = parseBaseCommands(command);
      const allTokens = command.trim().split(/\s+/);

      // Blacklist check — scan ALL tokens for blocked network tools
      const blockedToken = allTokens.find(p => NETWORK_CMD_BLACKLIST.has(p));
      if (blockedToken) {
         return {
          callId: call.id,
          name: this.name,
          output: `Access Denied: Network tool '${blockedToken}' is blocked in sandbox mode. Ask Manager to authorize if needed.`,
          isError: true,
          durationMs: 0,
        };
      }

      // Whitelist check — ALL base commands must be whitelisted
      const disallowed = baseCommands.find((cmd) => !SANDBOX_CMD_WHITELIST.has(cmd));
      if (disallowed) {
        return {
          callId: call.id,
          name: this.name,
          output: `Access Denied: Command '${disallowed}' is not allowed in sandbox mode.`,
          isError: true,
          durationMs: 0,
        };
      }
    }

    // 4. Background Execution
    if (isBackground) {
      toolLog.info({ command: command.slice(0, 200), name: processName }, "Starting background process");
      const bgProc = shellManager.startProcess(processName || "bg-proc", command, requestedCwd);
      return {
        callId: call.id,
        name: this.name,
        output: `Background process started.\nID: ${bgProc.id}\nName: ${bgProc.name}\nPID: ${bgProc.pid}\nUse shell_manage to view logs or kill the process.`,
        isError: false,
        durationMs: 0,
      };
    }

    const timeoutMs = (timeout ?? 120) * 1000;

    toolLog.info({ command: command.slice(0, 200), cwd: requestedCwd, sandboxed: ctx.isSandboxed }, "Executing bash command");

    // Apply resource limits to the command
    const limitedCommand = buildCommandWithLimits(command, AGENT_RESOURCE_LIMITS);

    try {
      const proc = Bun.spawn(["bash", "-c", limitedCommand], {
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
