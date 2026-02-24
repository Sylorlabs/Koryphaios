# Workspace Manager - Parallel Agent Isolation

The Workspace Manager provides filesystem isolation for parallel AI agents using Git Worktrees, preventing them from clobbering each other's work.

## Overview

When a Manager Agent spawns a sub-agent task, the Workspace Manager:

1. Creates a new Git worktree with a dedicated branch (`ai/task-name-taskid`)
2. Runs the sub-agent in complete isolation from other agents
3. Reconciles (merges) changes back to main when the task completes
4. Cleans up the worktree and branch automatically

## Configuration

Add a `workspace` section to your `koryphaios.json`:

```json
{
  "workspace": {
    "worktreeLimit": 4,
    "worktreeDir": ".trees",
    "copyEnvFiles": false
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `worktreeLimit` | number | `4` | Maximum concurrent worktrees. Each uses ~200-500MB RAM. |
| `worktreeDir` | string | `.trees` | Directory for worktrees (relative to repo root) |
| `copyEnvFiles` | boolean | `false` | Whether to copy `.env` files into worktrees |

### Setting worktreeLimit Based on RAM

Choose your limit based on available system memory:

| System RAM | Recommended Limit | Notes |
|------------|-------------------|-------|
| 8 GB | 3-4 worktrees | Conservative to prevent swapping |
| 16 GB | 6-8 worktrees | Good balance for most workloads |
| 32 GB | 10-15 worktrees | Heavy parallel processing |
| 64 GB+ | 20+ worktrees | Maximum parallelism |

## Security

- The `.trees/` directory is automatically added to `.gitignore`
- `.env` files are **NOT** copied to worktrees unless `copyEnvFiles: true`
- Each worktree runs on an isolated Git branch

## API Usage

```typescript
import { WorkspaceManager } from "@/kory";
import { loadConfig } from "@/runtime/config";

// Initialize with configuration
const config = loadConfig(process.cwd());
const workspace = new WorkspaceManager(process.cwd(), config.workspace);

// Check capacity
if (!workspace.canSpawn()) {
  console.log("At capacity, wait for a task to complete");
}

// Create isolated worktree for a task
const worktree = workspace.spawn("task-123", "fix-login-bug", "agent-1");
if (worktree) {
  // Run agent in worktree.path
  console.log(`Agent running in: ${worktree.path}`);
}

// Reconcile changes back to main (squash merge)
const result = workspace.reconcile("task-123", true);
console.log(result.message);

// Get status
const status = workspace.getStatus();
console.log(`${status.active.length}/${status.maxAllowed} worktrees in use`);
```

## How It Works

### 1. Spawn Isolation

```bash
# WorkspaceManager executes:
git worktree add -b ai/task-name-taskid .trees/task-id HEAD
```

### 2. Reconcile (Squash)

```bash
# Switch to main and squash merge
git checkout main
git merge --squash ai/task-name-taskid
git commit -m "feat: task name [ai-taskid]"
```

### 3. Cleanup

```bash
# Remove worktree and branch
git worktree remove --force .trees/task-id
git branch -D ai/task-name-taskid
```

## Resource Guard

The manager enforces the `worktreeLimit` strictly:

```typescript
if (workspace.worktrees.size >= workspace.maxConcurrent) {
  return null; // Cannot spawn, at capacity
}
```

If you need to process more tasks than your limit allows:

1. Queue tasks and spawn as slots become available
2. Increase `worktreeLimit` if you have available RAM
3. Use `getStatus()` to monitor capacity

## Error Handling

```typescript
try {
  const workspace = new WorkspaceManager(repoRoot, config);
} catch (err) {
  if (err instanceof WorkspaceError) {
    console.error("Not a valid Git repository");
  }
}

const result = workspace.reconcile("task-123");
if (!result.success) {
  console.error("Reconcile failed:", result.message);
}
```

## Best Practices

1. **Start conservative**: Begin with 3-4 worktrees and increase based on performance
2. **Monitor RAM**: If system becomes sluggish, reduce `worktreeLimit`
3. **Don't copy .env**: Keep `copyEnvFiles: false` unless sub-agents need environment variables
4. **Reconcile promptly**: Don't leave worktrees hanging - reconcile or cleanup when done
5. **Use descriptive task names**: They become part of the branch name for easier debugging
