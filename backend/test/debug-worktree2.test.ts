import { test, expect } from "bun:test";
import { WorkspaceManager } from "../src/kory/workspace-manager";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";

const TEST_DIR = "/tmp/worktree-real-test2";

test("debug worktree spawn with await", async () => {
  // Setup fresh repo
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  spawnSync(["git", "init"], { cwd: TEST_DIR });
  spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: TEST_DIR });
  spawnSync(["git", "config", "user.name", "Test"], { cwd: TEST_DIR });
  writeFileSync(join(TEST_DIR, "README.md"), "# Test");
  spawnSync(["git", "add", "."], { cwd: TEST_DIR });
  spawnSync(["git", "commit", "-m", "init"], { cwd: TEST_DIR });

  console.log("Repo initialized at:", TEST_DIR);
  
  // Create WorkspaceManager
  const workspace = new WorkspaceManager(TEST_DIR, {
    worktreeDir: ".trees",
    worktreeLimit: 4,
    copyEnvFiles: false,
  });
  
  console.log("WorkspaceManager created");
  
  // Try to spawn - check if it's async
  const result = workspace.spawn("test-1", "Test task", "agent-1");
  console.log("Result type:", typeof result);
  console.log("Result is Promise:", result instanceof Promise);
  
  if (result instanceof Promise) {
    console.log("Awaiting promise...");
    const worktree = await result;
    console.log("Awaited result:", worktree);
  } else {
    console.log("Direct result:", result);
  }
});
