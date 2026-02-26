// Docker-based sandbox for secure bash command execution.
// Provides true isolation for command execution with resource limits.

import { serverLog } from "../logger";

async function bunExec(cmd: string): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const error: any = new Error(stderr || "Command failed");
    error.stdout = stdout;
    error.stderr = stderr;
    error.code = exitCode;
    throw error;
  }
  return { stdout, stderr };
}

export interface SandboxConfig {
    enabled: boolean;
    image?: string;
    memoryLimit?: string; // e.g., "512m"
    cpuLimit?: string; // e.g., "0.5"
    timeout?: number; // milliseconds
    networkDisabled?: boolean;
    readOnlyRootfs?: boolean;
    workdir?: string; // Mount point inside container
}

export interface SandboxResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    duration: number;
}

const DEFAULT_CONFIG: Required<SandboxConfig> = {
    enabled: true,
    image: "alpine:latest",
    memoryLimit: "512m",
    cpuLimit: "0.5",
    timeout: 30000,
    networkDisabled: true,
    readOnlyRootfs: false,
    workdir: "/workspace",
};

/**
 * Check if Docker is available and running.
 */
export async function isDockerAvailable(): Promise<boolean> {
    try {
        await bunExec("docker --version");
        await bunExec("docker info > /dev/null 2>&1");
        return true;
    } catch {
        return false;
    }
}

/**
 * Execute a command in a Docker container with strict isolation.
 */
export async function executeInSandbox(
    command: string,
    workdir: string,
    config: Partial<SandboxConfig> = {},
): Promise<SandboxResult> {
    const finalConfig = { ...DEFAULT_CONFIG, ...config };

    if (!finalConfig.enabled) {
        throw new Error("Docker sandbox is disabled");
    }

    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
        throw new Error("Docker is not available. Please install Docker to enable secure command execution.");
    }

    const containerName = `koryphaios-sandbox-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const startTime = Date.now();

    try {
        // Build docker run command with security constraints
        const dockerArgs = [
            "run",
            "--rm", // Remove container after execution
            "--name", containerName,
            `--memory=${finalConfig.memoryLimit}`,
            `--cpus=${finalConfig.cpuLimit}`,
            `--memory-swap=${finalConfig.memoryLimit}`, // Disable swap
            "--security-opt=no-new-privileges", // Prevent privilege escalation
            "--cap-drop=ALL", // Drop all capabilities
            "--cap-add=NET_BIND_SERVICE", // Add back only what's needed
            "--pids-limit=1024", // Limit processes to prevent fork bombs
            "--shm-size=64m", // Limit shared memory
            finalConfig.networkDisabled ? "--network=none" : "",
            finalConfig.readOnlyRootfs ? "--read-only" : "",
            `-v`, `${workdir}:${finalConfig.workdir}:rw`, // Mount workspace
            `-w`, finalConfig.workdir, // Set working directory
            finalConfig.image,
            "sh", "-c", command,
        ].filter(Boolean);

        serverLog.debug({ command, containerName }, "Executing in Docker sandbox");

        // Execute with timeout
        const result = await execWithTimeout(
            `docker ${dockerArgs.join(" ")}`,
            finalConfig.timeout,
        );

        const duration = Date.now() - startTime;

        return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            duration,
        };
    } catch (error: any) {
        const duration = Date.now() - startTime;

        // Clean up container if it still exists
        try {
            await bunExec(`docker rm -f ${containerName} > /dev/null 2>&1`);
        } catch {
            // Ignore cleanup errors
        }

        if (error.killed && error.signal === "SIGTERM") {
            throw new Error(`Command timed out after ${finalConfig.timeout}ms`);
        }

        return {
            stdout: error.stdout || "",
            stderr: error.stderr || error.message,
            exitCode: error.code || 1,
            duration,
        };
    }
}

/**
 * Execute a command with a timeout.
 * Uses shell: true so the full command string is passed to sh without naive splitting.
 */
async function execWithTimeout(
    command: string,
    timeout: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const child = Bun.spawn(["sh", "-c", command], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });

    const timer = setTimeout(() => {
        child.kill();
        setTimeout(() => child.kill(9), 5000);
    }, timeout);

    try {
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        clearTimeout(timer);

        if (exitCode === 0) {
            return { stdout, stderr, exitCode };
        }

        const error: any = new Error(stderr || "Command failed");
        error.stdout = stdout;
        error.stderr = stderr;
        error.code = exitCode;
        throw error;
    } catch (error) {
        clearTimeout(timer);
        throw error;
    }
}

/**
 * Execute multiple commands in sequence within the same container.
 * Useful for multi-step operations.
 */
export async function executeCommandsInSandbox(
    commands: string[],
    workdir: string,
    config: Partial<SandboxConfig> = {},
): Promise<SandboxResult[]> {
    const finalConfig = { ...DEFAULT_CONFIG, ...config };
    const containerName = `koryphaios-sandbox-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    if (!finalConfig.enabled) {
        throw new Error("Docker sandbox is disabled");
    }

    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
        throw new Error("Docker is not available");
    }

    try {
        // Start container in background
        const startArgs = [
            "run",
            "-d",
            "--name", containerName,
            `--memory=${finalConfig.memoryLimit}`,
            `--cpus=${finalConfig.cpuLimit}`,
            `--memory-swap=${finalConfig.memoryLimit}`,
            "--security-opt=no-new-privileges",
            "--cap-drop=ALL",
            "--cap-add=NET_BIND_SERVICE",
            "--pids-limit=1024",
            "--shm-size=64m",
            finalConfig.networkDisabled ? "--network=none" : "",
            `-v`, `${workdir}:${finalConfig.workdir}:rw`,
            `-w`, finalConfig.workdir,
            finalConfig.image,
            "sh", "-c", "tail -f /dev/null", // Keep container running
        ].filter(Boolean);

        await bunExec(`docker ${startArgs.join(" ")}`);

        const results: SandboxResult[] = [];

        for (const command of commands) {
            const startTime = Date.now();
            try {
                const execResult = await bunExec(`docker exec ${containerName} sh -c "${command.replace(/"/g, '\\"')}"`);
                results.push({
                    stdout: execResult.stdout,
                    stderr: execResult.stderr,
                    exitCode: 0,
                    duration: Date.now() - startTime,
                });
            } catch (error: any) {
                // Assuming 'span' is defined in a broader scope or intended to be added.
                // The provided snippet has a syntax error with `t: error.stdout`.
                // Correcting it to match the existing structure for error handling.
                results.push({
                    stdout: error.stdout || "",
                    stderr: error.stderr || error.message,
                    exitCode: error.code || 1,
                    duration: Date.now() - startTime,
                });
            }
        }

        return results;
    } finally {
        // Clean up container
        try {
            await bunExec(`docker rm -f ${containerName} > /dev/null 2>&1`);
        } catch {
            // Ignore cleanup errors
        }
    }
}

/**
 * Validate a command before execution.
 * This is a pre-check; Docker provides the real security.
 */
export function validateCommand(command: string): { safe: boolean; reason?: string } {
    const trimmed = command.trim();

    // Block obviously dangerous patterns (defense in depth)
    const dangerousPatterns = [
        /:\s*\{\s*:\s*\|:\s*&\s*;\s*:\s*\}/, // Fork bomb
        /rm\s+(-rf\s+)?\/\w/, // rm -rf /anything
        /mkfs/,
        /dd\s+.*of=\/dev\//,
        /chmod\s+(-R\s+)?777\s+\//,
        /chown\s+(-R\s+)?.*\s+\//,
        />\s*\/dev\/sd[a-z]/,
    ];

    for (const pattern of dangerousPatterns) {
        if (pattern.test(trimmed)) {
            return {
                safe: false,
                reason: `Command matches dangerous pattern: ${pattern.source}`,
            };
        }
    }

    return { safe: true };
}

/**
 * Get resource usage statistics for a running sandbox container.
 * Returns null if the container is not found or stats are unavailable.
 */
export async function getSandboxStats(containerName: string): Promise<{
    memoryUsageMb: number;
    cpuPercent: number;
} | null> {
    try {
        // docker stats --no-stream outputs: CONTAINER ID, NAME, CPU %, MEM USAGE / LIMIT, ...
        const result = await bunExec(
            `docker stats ${containerName} --no-stream --format "{{.CPUPerc}} {{.MemUsage}}"`,
        );
        const line = result.stdout.trim();
        if (!line) return null;

        // Format: "0.05% 12.3MiB / 512MiB"
        const cpuRegex = /^([\d.]+)%/;
        const memRegex = /([\d.]+)(MiB|GiB|KiB|MB|GB|KB)/;
        const cpuMatch = cpuRegex.exec(line);
        const memMatch = memRegex.exec(line);


        const cpuPercent = cpuMatch ? Number.parseFloat(cpuMatch[1]) : 0;
        let memoryUsageMb = 0;
        if (memMatch) {
            const value = Number.parseFloat(memMatch[1]);

            const unit = memMatch[2].toLowerCase();
            if (unit === "gib" || unit === "gb") memoryUsageMb = value * 1024;
            else if (unit === "kib" || unit === "kb") memoryUsageMb = value / 1024;
            else memoryUsageMb = value; // MiB / MB
        }

        return { memoryUsageMb, cpuPercent };
    } catch {
        return null;
    }
}
