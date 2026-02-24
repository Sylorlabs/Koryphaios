import { toolLog } from "../logger";
import { nanoid } from "nanoid";

export interface BackgroundProcess {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid: number;
  status: "running" | "exited" | "killed";
  exitCode?: number;
  stdout: string;
  stderr: string;
  startTime: number;
  proc: any; // Bun process
}

export class ShellManager {
  private static instance: ShellManager;
  private processes = new Map<string, BackgroundProcess>();
  private readonly MAX_LOG_SIZE = 100_000; // 100KB per buffer

  private constructor() {}

  static getInstance(): ShellManager {
    if (!ShellManager.instance) {
      ShellManager.instance = new ShellManager();
    }
    return ShellManager.instance;
  }

  startProcess(name: string, command: string, cwd: string): BackgroundProcess {
    const id = nanoid(8);
    
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: process.env.PATH },
    });

    const bgProc: BackgroundProcess = {
      id,
      name,
      command,
      cwd,
      pid: proc.pid,
      status: "running",
      stdout: "",
      stderr: "",
      startTime: Date.now(),
      proc,
    };

    this.processes.set(id, bgProc);

    // Async readers for logs
    this.readStream(proc.stdout.getReader(), id, "stdout");
    this.readStream(proc.stderr.getReader(), id, "stderr");

    // Track exit
    proc.exited.then((code) => {
      bgProc.status = "exited";
      bgProc.exitCode = code;
      toolLog.info({ id, name, code }, "Background process exited");
    });

    return bgProc;
  }

  private async readStream(reader: ReadableStreamDefaultReader<Uint8Array>, id: string, type: "stdout" | "stderr") {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const proc = this.processes.get(id);
        if (!proc) break;

        const chunk = decoder.decode(value);
        if (type === "stdout") {
          proc.stdout += chunk;
          if (proc.stdout.length > this.MAX_LOG_SIZE) {
            proc.stdout = proc.stdout.slice(-this.MAX_LOG_SIZE);
          }
        } else {
          proc.stderr += chunk;
          if (proc.stderr.length > this.MAX_LOG_SIZE) {
            proc.stderr = proc.stderr.slice(-this.MAX_LOG_SIZE);
          }
        }
      }
    } catch (err) {
      toolLog.error({ id, err }, "Error reading background process stream");
    }
  }

  killProcess(id: string): boolean {
    const proc = this.processes.get(id);
    if (proc && proc.status === "running") {
      proc.proc.kill();
      proc.status = "killed";
      return true;
    }
    return false;
  }

  getProcess(id: string): BackgroundProcess | undefined {
    return this.processes.get(id);
  }

  listProcesses(): Omit<BackgroundProcess, "proc">[] {
    return Array.from(this.processes.values()).map(({ proc, ...rest }) => rest);
  }

  cleanup() {
    for (const proc of this.processes.values()) {
      if (proc.status === "running") {
        proc.proc.kill();
      }
    }
  }
}

export const shellManager = ShellManager.getInstance();
