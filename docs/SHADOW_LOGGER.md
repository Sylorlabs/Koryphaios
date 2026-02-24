# Shadow Logger - Time Travel for AI Changes

The Shadow Logger provides **undo/redo functionality** for AI-generated changes by creating "ghost commits" - dangling Git commits that capture state snapshots without polluting the branch history.

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  User requests change → AI makes edits → Shadow Logger      │
│  creates ghost commit → Stored in reflog with metadata      │
│                                                              │
│  [Time Travel UI] ←── reflog scraper ←── git notes          │
│       │                                                      │
│       └── User selects state ──→ git reset --hard [ghost]   │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### Using TimeTravelService (Recommended)

```typescript
import { TimeTravelService } from "@/services";

const timeTravel = new TimeTravelService("/path/to/repo", {
  timelineLimit: 50,
  autoCheckpoint: true,
  costThreshold: 0.01, // Only checkpoint if cost > 1 cent
});

// After AI makes changes
timeTravel.checkpoint("Fixed login bug", {
  model: "claude-sonnet-4-5",
  prompt: "Fix the authentication bug in login.ts",
  cost: 0.023,
  tokensIn: 1500,
  tokensOut: 800,
  agentId: "agent-123",
});

// Get current state for UI
const state = await timeTravel.getState();
console.log(`Total states: ${state.stats.totalStates}`);
console.log(`Total cost: $${state.stats.totalCost.toFixed(2)}`);

// Travel back in time
timeTravel.undo();        // Go back one state
timeTravel.redo();        // Go forward one state
timeTravel.travelTo(hash); // Go to specific state
```

### Using ShadowLogger Directly

```typescript
import { ShadowLogger } from "@/kory";

const logger = new ShadowLogger("/path/to/repo");

// Create ghost commit
const ghostHash = logger.createGhostCommit("Added user API endpoint", {
  model: "gpt-5",
  prompt: "Create a REST API for user management",
  cost: 0.045,
});

// Get timeline for UI
const timeline = logger.getTimeline(20);
for (const entry of timeline) {
  console.log(`${entry.timestamp}: ${entry.description} ($${entry.cost})`);
}

// Recover to a specific state
logger.recover(ghostHash);
```

## Ghost Commits Explained

### What is a Ghost Commit?

A **ghost commit** is a dangling Git commit created with `git commit-tree`:

```bash
# Normal commit (on a branch)
git commit -m "message"  # → Creates commit reachable from HEAD

# Ghost commit (dangling)
git commit-tree tree -p parent -m "[GHOST] message"  # → Dangling, not on any branch
```

Ghost commits:
- ✅ Exist in the object database
- ✅ Appear in `git reflog`
- ✅ Can be reset to (`git reset --hard`)
- ❌ Don't appear in `git log` (not on a branch)
- ❌ Won't be pushed (dangling refs)

### Metadata via Git Notes

Each ghost commit stores metadata using Git Notes:

```bash
# ShadowLogger attaches:
git notes --ref refs/notes/shadow-logger add -m '{"model":"gpt-5","cost":0.02}' [hash]

# Retrieved later:
git notes --ref refs/notes/shadow-logger show [hash]
```

## Time Travel UI Integration

### Get State for Display

```typescript
const state = await timeTravel.getState();

// state.currentHash - Current HEAD
// state.timeline - Array of available states
// state.canUndo - Is there a previous state?
// state.canRedo - Is there a newer state?
// state.stats - Total states, cost, models used
```

### Timeline Entry Format

```typescript
interface TimelineEntry {
  hash: string;           // Ghost commit hash
  description: string;    // Human-readable description
  timestamp: number;      // When created
  model?: string;         // AI model used
  cost?: number;          // Cost in USD
  recoverable: boolean;   // Can we reset to this?
}
```

### Preview Before Travel

```typescript
const preview = timeTravel.previewTravel(ghostHash);

// preview.canTravel - Is this a valid target?
// preview.diff - Git diff showing what would change
// preview.filesChanged - Array of affected files
// preview.message - Description of target state
```

## API Reference

### ShadowLogger

| Method | Returns | Description |
|--------|---------|-------------|
| `createGhostCommit(message, metadata)` | `string \| null` | Create a new ghost commit |
| `getTimeline(limit?)` | `TimelineEntry[]` | Get timeline from reflog |
| `getGhostCommit(hash)` | `GhostCommit \| null` | Get detailed ghost info |
| `recover(hash)` | `{ success, message }` | Reset to ghost state |
| `compareWithGhost(hash)` | `string` | Get diff vs current |
| `prune(days)` | `{ removed, message }` | Clean old entries |
| `getStats()` | `{ totalGhosts, totalCost, ... }` | Get statistics |
| `getMetadata(hash)` | `GhostCommitMetadata \| undefined` | Get attached metadata |

### TimeTravelService

| Method | Returns | Description |
|--------|---------|-------------|
| `getState()` | `TimeTravelState` | Full state for UI |
| `checkpoint(desc, metadata)` | `{ success, hash, message }` | Create checkpoint |
| `undo()` | `{ success, message, newHash }` | Go back one state |
| `redo()` | `{ success, message, newHash }` | Go forward one state |
| `travelTo(hash)` | `{ success, message, newHash }` | Go to specific state |
| `previewTravel(hash)` | `{ canTravel, diff, filesChanged }` | Preview changes |
| `createBranchFromState(hash, branchName)` | `{ success, message }` | Branch from ghost |
| `exportTimeline()` | `JSON object` | Export for backup |

## Configuration

### Auto-Checkpointing

```typescript
const timeTravel = new TimeTravelService(repoPath, {
  autoCheckpoint: true,
  costThreshold: 0.01, // Only checkpoint if > 1¢
});
```

With auto-checkpointing enabled, the service only creates ghost commits for:
- Changes above the cost threshold
- Or when explicitly called with `checkpoint()`

### Timeline Limits

```typescript
// Keep last 50 states in UI
const timeTravel = new TimeTravelService(repoPath, {
  timelineLimit: 50,
});
```

## Best Practices

### 1. Checkpoint After Significant Changes

```typescript
// Good: Checkpoint after complete task
timeTravel.checkpoint("Implemented login flow", { ... });

// Avoid: Checkpointing every small edit
timeTravel.checkpoint("Added semicolon", { ... }); // Too granular
```

### 2. Include Rich Metadata

```typescript
timeTravel.checkpoint("Fixed API bug", {
  model: "claude-sonnet-4-5",
  prompt: userMessage,        // Full prompt for context
  cost: calculateCost(),      // Track spending
  tokensIn: usage.input,
  tokensOut: usage.output,
  agentId: agent.id,          // For debugging
});
```

### 3. Handle Recovery Errors

```typescript
const result = timeTravel.travelTo(hash);
if (!result.success) {
  // Show error in UI
  toast.error(`Failed to time travel: ${result.message}`);
} else {
  toast.success(`Restored: ${result.message}`);
  refreshUI();
}
```

### 4. Prune Old States

```typescript
// Clean up states older than 30 days
await timeTravel.prune(30);
```

## Implementation Details

### Storage Format

Ghost commits are stored as:
1. **Commit object**: Tree + parent + message `[GHOST] description`
2. **Reflog entry**: `HEAD@{n}` points to ghost hash
3. **Git notes**: `refs/notes/shadow-logger` stores metadata JSON

### Recovery Safety

Before `git reset --hard`, the service:
1. Creates a backup ghost commit of current state
2. Validates the target ghost exists
3. Performs the reset
4. Cleans untracked files (`git clean -fd`)

### Performance

- Creating ghost commit: ~10-50ms
- Getting timeline (50 entries): ~20-100ms
- Recovery: ~50-200ms (depends on repo size)

## Security Considerations

- Ghost commits are local only (dangling refs)
- Git notes are not pushed by default
- Recovery creates backup before reset
- Prune respects reflog expiration rules
