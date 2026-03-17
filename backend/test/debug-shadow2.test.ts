import { test, expect } from "bun:test";
import { ShadowLogger } from "../src/kory/shadow-logger";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";

const TEST_DIR = "/tmp/shadow-test2";

test("debug shadow logger with await", async () => {
  // Setup fresh repo
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  spawnSync(["git", "init"], { cwd: TEST_DIR });
  spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: TEST_DIR });
  spawnSync(["git", "config", "user.name", "Test"], { cwd: TEST_DIR });
  writeFileSync(join(TEST_DIR, "README.md"), "# Test");
  spawnSync(["git", "add", "."], { cwd: TEST_DIR });
  spawnSync(["git", "commit", "-m", "init"], { cwd: TEST_DIR });

  console.log("Repo initialized");
  
  const logger = new ShadowLogger(TEST_DIR);
  
  // Create a file
  writeFileSync(join(TEST_DIR, "ghost.txt"), "Ghost content");
  
  // Check if async
  const result = logger.createGhostCommit("Test commit", {
    model: "gpt-4",
    prompt: "Test",
    cost: 0.01,
  });
  
  console.log("Result is Promise:", result instanceof Promise);
  
  const hash = await result;
  console.log("Ghost commit hash:", hash);
  
  // Get timeline
  const timeline = logger.getTimeline(10);
  console.log("Timeline entries:", timeline.length);
  console.log("Timeline:", JSON.stringify(timeline, null, 2));
});
