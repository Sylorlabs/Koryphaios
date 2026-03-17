import { test, expect } from "bun:test";
import { AutoCommitService } from "../src/kory/auto-commit-service";
import { GitManager } from "../src/kory/git-manager";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";

const TEST_DIR = "/tmp/autocommit-debug";

test("debug autocommit flow", async () => {
  // Setup
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  spawnSync(["git", "init"], { cwd: TEST_DIR });
  spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: TEST_DIR });
  spawnSync(["git", "config", "user.name", "Test"], { cwd: TEST_DIR });
  writeFileSync(join(TEST_DIR, "README.md"), "# Test");
  spawnSync(["git", "add", "."], { cwd: TEST_DIR });
  spawnSync(["git", "commit", "-m", "init"], { cwd: TEST_DIR });

  const git = new GitManager(TEST_DIR);
  const autoCommit = new AutoCommitService(TEST_DIR, git);
  
  console.log("Initial branch:", await git.getBranch());
  console.log("Initial files:", spawnSync(["ls", "-la"], { cwd: TEST_DIR, encoding: "utf-8" }).stdout);
  
  // Create file
  writeFileSync(join(TEST_DIR, "feature.txt"), "New feature");
  console.log("\nAfter creating file:");
  console.log("Files:", spawnSync(["ls", "-la"], { cwd: TEST_DIR, encoding: "utf-8" }).stdout);
  
  // Auto-commit
  const result = await autoCommit.autoCommitAndCreatePR("Add new feature");
  console.log("\nAuto-commit result:", result);
  
  console.log("\nAfter auto-commit:");
  console.log("Current branch:", await git.getBranch());
  console.log("Files:", spawnSync(["ls", "-la"], { cwd: TEST_DIR, encoding: "utf-8" }).stdout);
  
  // Check if file exists
  console.log("\nfeature.txt exists?:", existsSync(join(TEST_DIR, "feature.txt")));
  
  // The issue: file is committed to the new branch, then we checkout main
  // The file doesn't exist in main because it was never committed there
  // We need to MERGE or the file won't be in main
  
  // Let's check the branches
  console.log("\nAll branches:");
  console.log(spawnSync(["git", "branch", "-a"], { cwd: TEST_DIR, encoding: "utf-8" }).stdout);
  
  // Check the kory branch
  const branches = await git.getBranches();
  const koryBranch = branches.find(b => b.includes("kory/"));
  console.log("\nKory branch:", koryBranch);
  
  // Check what's in the kory branch
  if (koryBranch) {
    spawnSync(["git", "checkout", koryBranch], { cwd: TEST_DIR });
    console.log("\nIn kory branch, files:");
    console.log(spawnSync(["ls", "-la"], { cwd: TEST_DIR, encoding: "utf-8" }).stdout);
    console.log("feature.txt exists?:", existsSync(join(TEST_DIR, "feature.txt")));
  }
});
