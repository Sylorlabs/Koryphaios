const processes: Bun.Subprocess[] = [];

function start(name: string, script: string): Bun.Subprocess {
  const proc = Bun.spawn(["bun", "run", script], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: process.env,
  });

  processes.push(proc);
  console.log(`[dev] started ${name} (pid ${proc.pid})`);
  return proc;
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[dev] shutting down (${signal})`);
  for (const proc of processes) {
    try {
      proc.kill();
    } catch {
      // Process already exited.
    }
  }
  await Promise.allSettled(processes.map((proc) => proc.exited));
}

const backend = start("backend", "dev:backend");
const frontend = start("frontend", "dev:frontend");

for (const event of ["SIGINT", "SIGTERM"] as const) {
  process.on(event, async () => {
    await shutdown(event);
    process.exit(0);
  });
}

const [backendExit, frontendExit] = await Promise.all([backend.exited, frontend.exited]);
const code = backendExit !== 0 ? backendExit : frontendExit;
await shutdown("child-exit");
process.exit(code);
