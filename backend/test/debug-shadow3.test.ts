import { test, expect } from "bun:test";
import { ShadowLogger } from "../src/kory/shadow-logger";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";

const TEST_DIR = "/tmp/shadow-test3";

test("debug shadow logger timeline", async () => {
  // Setup fresh repo
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  spawnSync(["git", "init"], { cwd: TEST_DIR });
  spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: TEST_DIR });
  spawnSync(["git", "config", "user.name", "Test"], { cwd: TEST_DIR });
  writeFileSync(join(TEST_DIR, "README.md"), "# Test");
  spawnSync(["git", "add", "."], { cwd: TEST_DIR });
  spawnSync(["git", "commit", "-m", "init"], { cwd: TEST_DIR });

  const logger = new ShadowLogger(TEST_DIR);
  
  // Create a file and ghost commit
  writeFileSync(join(TEST_DIR, "ghost.txt"), "Ghost content");
  const hash = await logger.createGhostCommit("Test ghost", { model: "gpt-4" });
  console.log("Created ghost:", hash);
  
  // Check reflog manually
  const reflog = spawnSync(["git", "reflog", "show", "HEAD", "--format=%H|%gd|%gs|%ct", "-n", "10"], { 
    cwd: TEST_DIR, 
    encoding: "utf-8" 
  });
  console.log("Raw reflog:");
  console.log(reflog.stdout);
  
  // Check getTimeline result type
  const timeline = logger.getTimeline(10);
  console.log("Timeline type:", typeof timeline);
  console.log("Is array:", Array.isArray(timeline));
  console.log("Timeline:", timeline);
  console.log("Timeline length:", timeline?.length);
});
