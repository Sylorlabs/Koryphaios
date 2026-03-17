# New Services Documentation

This document describes the five new services added to Koryphaios to improve multi-agent orchestration capabilities.

## Overview

The following services have been implemented to address the "good but improvable" areas identified in the 2026 best practices analysis:

1. **ConflictResolutionService** - Multi-agent file conflict detection and resolution
2. **HumanInTheLoopService** - Approval gates for high-risk operations
3. **AgentOpsService** - Prompt versioning, A/B testing, and evaluation
4. **MemoryManagerService** - Tiered memory management with semantic search
5. **CostOptimizationService** - Smart routing and response caching

---

## 1. ConflictResolutionService

### Purpose
Handles conflicts when multiple workers modify the same files, implementing multiple resolution strategies.

### Features
- **File-level conflict detection** across worktrees
- **Multiple resolution strategies** (last-write-wins, merge, critic-mediated, voting)
- **Automatic merge** for non-overlapping changes
- **Human escalation** for critical conflicts

### Usage

```typescript
import { ConflictResolutionService, FileChange } from "@/kory/services";

// Register file changes from workers
const change: FileChange = {
  path: "src/utils.ts",
  content: "// modified content",
  checksum: "abc123",
  modifiedAt: Date.now(),
  agentId: "worker-1",
  worktreeId: "task-123",
};

manager.registerFileChange(change);

// Detect conflicts
const conflicts = manager.getPendingConflicts();
console.log(`Found ${conflicts.length} conflicts`);

// Resolve conflicts automatically
const result = await manager.resolveConflicts();
console.log(`Resolved ${result.resolvedConflicts} conflicts`);
```

### Configuration

```typescript
const config = {
  strategy: "critic-mediated", // or "last-write-wins", "merge", "voting"
  autoResolveThreshold: "medium", // Risk level threshold for auto-resolution
  enableMergeForNonOverlapping: true,
  criticModel: "claude-3-7-sonnet",
  escalationTimeoutMs: 300000,
};
```

---

## 2. HumanInTheLoopService

### Purpose
Provides configurable human approval checkpoints for high-risk operations.

### Features
- **Risk-based approval requirements**
- **Configurable approval policies** per operation type
- **Timeout handling** with automatic rejection
- **Batch approval** for multiple operations
- **Audit trail** of all decisions

### Usage

```typescript
// Request approval for a high-risk operation
const decision = await manager.requestApproval({
  type: "bash-execution",
  description: "Execute: rm -rf node_modules",
  details: { command: "rm -rf node_modules" },
  riskLevel: "high",
  estimatedCost: 0,
  sessionId: "session-123",
  agentId: "worker-1",
});

if (decision.approved) {
  // Proceed with operation
} else {
  // Handle rejection
  console.log(`Rejected: ${decision.reason}`);
}

// Submit human decision (from frontend)
manager.submitApprovalDecision(operationId, true, "Looks good");

// Get pending approvals
const pending = manager.getPendingApprovals(sessionId);
```

### Default Policies

| Operation Type | Risk Level | Timeout | Auto-Reject |
|---|---|---|---|
| file-delete | medium | 5 min | Yes |
| bash-execution | high | 10 min | Yes |
| git-push | medium | 5 min | Yes |
| api-key-modify | critical | 10 min | Yes |
| cost-threshold | medium | 5 min | Yes |

---

## 3. AgentOpsService

### Purpose
Provides MLOps-style operations for AI agents including prompt versioning, A/B testing, and evaluation.

### Features
- **Prompt versioning** with semantic versioning
- **A/B testing framework** with statistical significance
- **Automated evaluation** on test datasets
- **Simulation environment** for safe testing
- **Shadow mode** for testing new prompts

### Usage

```typescript
// Register a new prompt version
const prompt = manager.registerPromptVersion({
  name: "coder-agent",
  version: "1.2.0",
  content: "You are a coding assistant...",
  system: "System prompt here",
  createdBy: "developer",
  tags: ["coding", "typescript"],
  metadata: {
    description: "Improved TypeScript support",
    model: "claude-3-7-sonnet",
  },
});

// Create A/B test experiment
const experiment = manager.createExperiment({
  name: "Prompt v1.2 vs v1.1",
  hypothesis: "New prompt produces more correct code",
  variants: [
    {
      id: "control",
      name: "Current",
      promptVersionId: "prompt-v1-1-id",
      trafficPercentage: 50,
      results: { totalRequests: 0, avgLatencyMs: 0, successRate: 0, customMetrics: {} },
    },
    {
      id: "treatment",
      name: "New Version",
      promptVersionId: "prompt-v1-2-id",
      trafficPercentage: 50,
      results: { totalRequests: 0, avgLatencyMs: 0, successRate: 0, customMetrics: {} },
    },
  ],
  controlVersionId: "prompt-v1-1-id",
  trafficSplit: 50,
});

// Run evaluation
const result = await manager.evaluatePrompt(prompt.id, "dataset-123");
console.log(`Accuracy: ${result.metrics.accuracy}`);

// Run simulation
const scenario = {
  name: "Code generation test",
  description: "Test TypeScript function generation",
  steps: [
    { id: "1", type: "user-message", content: "Write a factorial function" },
    { id: "2", type: "assertion", content: "function factorial" },
  ],
  expectedOutcome: "Function is generated correctly",
};

const simResult = await manager.runSimulation(scenario, prompt.id);
console.log(`Simulation ${simResult.success ? "passed" : "failed"}`);
```

---

## 4. MemoryManagerService

### Purpose
Provides tiered memory management with three tiers: short-term, long-term, and vector memory.

### Features
- **Automatic context window management** with pruning
- **Semantic retrieval** for cross-session knowledge
- **Memory compression** for long contexts
- **Conversation summarization**
- **Relevance scoring** and ranking

### Usage

```typescript
// Store a memory entry
const entry = await manager.storeMemory({
  content: "User prefers React hooks over class components",
  tokens: 15,
  sessionId: "session-123",
  agentId: "kory-manager",
  importance: 0.8,
  metadata: {
    type: "fact",
    tags: ["preferences", "react"],
  },
});

// Retrieve relevant memories
const results = await manager.retrieveMemories({
  content: "How should I implement components?",
  sessionId: "session-123",
  limit: 10,
  minImportance: 0.5,
});

// Get context window for LLM
const context = await manager.getContextWindow("session-123", 8000);

// Create conversation summary
const summary = await manager.createConversationSummary("session-123");
console.log(`Key points: ${summary.keyPoints.join(", ")}`);
```

### Memory Tiers

| Tier | Storage | TTL | Use Case |
|---|---|---|---|
| Short-term | In-memory | 30 min | Current session context |
| Long-term | Persistent | Indefinite | Important facts across sessions |
| Vector | Semantic search | 1 hour | Similarity-based retrieval |

---

## 5. CostOptimizationService

### Purpose
Provides intelligent cost optimization through smart routing and caching.

### Features
- **Smart model routing** based on task complexity
- **Response caching** with semantic similarity
- **Request deduplication**
- **Budget tracking** and alerts
- **Automatic model downgrading** for simple tasks

### Usage

```typescript
// Get optimal routing for a task
const routing = await manager.routeTask(
  "Summarize this article about TypeScript",
  "claude-3-7-sonnet", // preferred
  false // don't force
);

console.log(`Use ${routing.model} - ${routing.reason}`);
console.log(`Estimated cost: $${routing.estimatedCost.toFixed(4)}`);

// Check cache before making request
const cached = await manager.checkCache("Summarize this article...");
if (cached) {
  console.log("Cache hit! Using cached response");
}

// Record usage for budget tracking
manager.recordUsage(0.05, 1000, 500); // cost, tokensIn, tokensOut

// Check budget status
const budget = manager.getBudgetStatus();
console.log(`Daily: $${budget.dailyUsed}/$${budget.dailyLimit}`);
console.log(`Alert triggered: ${budget.alertTriggered}`);

// Get cost analytics
const analytics = manager.getCostAnalytics(30);
console.log(`Total savings: $${analytics.totalSavings.toFixed(2)}`);
console.log(`Cache hit rate: ${(analytics.cacheHitRate * 100).toFixed(1)}%`);
```

### Smart Routing Logic

| Task Type | Complexity | Recommended Model |
|---|---|---|
| Classification | Low | gpt-4o-mini |
| Summarization | Medium | gemini-2.0-flash |
| Extraction | Low | gpt-4o-mini |
| Generation | High | claude-3-7-sonnet |
| Reasoning | High | claude-3-7-sonnet |
| Coding | High | claude-3-7-sonnet |

---

## Integration Example

Here's how to use all services together in a workflow:

```typescript
async function processWithOptimization(sessionId: string, userMessage: string) {
  // 1. Check if we need human approval for risky operations
  const riskProfile = assessRisk(userMessage);
  if (riskProfile.level === "high") {
    const decision = await manager.requestApproval({
      type: "bash-execution",
      description: `Execute: ${riskProfile.command}`,
      riskLevel: "high",
      sessionId,
      agentId: "manager",
    });
    if (!decision.approved) {
      return "Operation cancelled by user";
    }
  }

  // 2. Route to optimal model
  const routing = await manager.routeTask(userMessage);
  
  // 3. Check cache
  const cached = await manager.checkCache(userMessage);
  if (cached) {
    manager.recordCacheHit(cached.cost);
    return cached.response;
  }

  // 4. Get relevant context from memory
  const memories = await manager.retrieveMemories({
    content: userMessage,
    sessionId,
    limit: 5,
  });

  // 5. Process the request
  const response = await processWithModel(userMessage, routing.model, memories);

  // 6. Store in memory
  await manager.storeMemory({
    content: `User asked: ${userMessage}\nResponse: ${response}`,
    tokens: estimateTokens(userMessage + response),
    sessionId,
    agentId: "manager",
    importance: 0.6,
    metadata: { type: "message", tags: ["conversation"] },
  });

  // 7. Record usage
  manager.recordUsage(routing.estimatedCost, tokensIn, tokensOut);

  // 8. Register any file changes for conflict detection
  for (const change of detectFileChanges()) {
    manager.registerFileChange(change);
  }

  // 9. Resolve any conflicts
  const conflictResult = await manager.resolveConflicts();
  if (conflictResult.escalatedConflicts > 0) {
    console.warn(`${conflictResult.escalatedConflicts} conflicts need human resolution`);
  }

  return response;
}
```

---

## Configuration

All services can be configured via `koryphaios.json`:

```json
{
  "conflictResolution": {
    "strategy": "critic-mediated",
    "autoResolveThreshold": "medium"
  },
  "humanInTheLoop": {
    "defaultTimeoutMs": 300000,
    "policies": [
      {
        "operationType": "bash-execution",
        "requireApproval": true,
        "minRiskLevel": "high"
      }
    ]
  },
  "memory": {
    "shortTerm": {
      "maxTokens": 16000,
      "pruningStrategy": "least-important"
    },
    "vector": {
      "enabled": true,
      "similarityThreshold": 0.7
    }
  },
  "costOptimization": {
    "routing": {
      "enabled": true,
      "complexityThresholds": {
        "low": 500,
        "medium": 2000
      }
    },
    "cache": {
      "enabled": true,
      "defaultTTLMs": 3600000
    },
    "budget": {
      "dailyLimit": 50,
      "monthlyLimit": 500,
      "alertThreshold": 0.8
    }
  }
}
```

---

## API Endpoints

The following REST endpoints are available for the new services:

### Conflict Resolution
- `GET /api/conflicts` - Get pending conflicts
- `POST /api/conflicts/resolve` - Trigger conflict resolution

### Human-in-the-Loop
- `GET /api/approvals` - Get pending approvals
- `POST /api/approvals/:id/decision` - Submit approval decision

### AgentOps
- `POST /api/prompts` - Register new prompt version
- `POST /api/experiments` - Create experiment
- `GET /api/experiments/:id` - Get experiment status
- `POST /api/evaluations` - Run evaluation

### Memory
- `POST /api/memory` - Store memory
- `GET /api/memory` - Retrieve memories
- `POST /api/memory/summarize` - Create summary

### Cost Optimization
- `POST /api/route` - Get routing decision
- `GET /api/budget` - Get budget status
- `GET /api/analytics` - Get cost analytics
