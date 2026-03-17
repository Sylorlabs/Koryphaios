import { test, expect } from "bun:test";
import { ShadowLogger } from "../src/kory/shadow-logger";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";

const TEST_DIR = "/tmp/recover-debug";

test("debug shadow recover", async () => {
  // Setup
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  spawnSync(["git", "init"], { cwd: TEST_DIR });
  spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: TEST_DIR });
  spawnSync(["git", "config", "user.name", "Test"], { cwd: TEST_DIR });
  writeFileSync(join(TEST_DIR, "README.md"), "# Test");
  spawnSync(["git", "add", "."], { cwd: TEST_DIR });
  spawnSync(["git", "commit", "-m", "init"], { cwd: TEST_DIR });

  const logger = new ShadowLogger(TEST_DIR);
  
  // Create ghost
  writeFileSync(join(TEST_DIR, "file1.txt"), "Content 1");
  const hash1 = await logger.createGhostCommit("First state", { model: "gpt-4" });
  console.log("Ghost 1:", hash1);
  
  // Create another file
  writeFileSync(join(TEST_DIR, "file2.txt"), "Content 2");
  console.log("Before recover - file2 exists?:", existsSync(join(TEST_DIR, "file2.txt")));
  
  // Try recover
  console.log("\nCalling recover with hash:", hash1);
  const result = logger.recover(hash1!);
  console.log("Recover result:", result);
  console.log("Result type:", typeof result);
  
  // Check if it's a promise
  if (result instanceof Promise) {
    const awaited = await result;
    console.log("Awaited result:", awaited);
  }
  
  console.log("\nAfter recover - file2 exists?:", existsSync(join(TEST_DIR, "file2.txt")));
});
