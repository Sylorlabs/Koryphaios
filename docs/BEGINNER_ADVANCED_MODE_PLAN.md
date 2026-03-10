# Beginner vs Advanced Mode Implementation Plan

## Overview

This document outlines the implementation plan for two distinct user experience modes in Koryphaios:

- **Beginner Mode**: For users who want to build something cool without technical knowledge
- **Advanced Mode**: For experienced developers who want full control and technical detail

---

## Current State Analysis

The mode system already exists with basic infrastructure:

| Component | Status | Location |
|-----------|--------|----------|
| Mode types & config | ✅ Exists | `shared/src/types/ModeTypes.ts`, `shared/src/config/ModeConfig.ts` |
| Mode manager (backend) | ✅ Exists | `backend/src/mode/mode-manager.ts` |
| Mode store (frontend) | ✅ Exists | `frontend/src/lib/stores/mode.svelte.ts` |
| Mode toggle UI | ✅ Exists | `frontend/src/lib/components/ModeToggle.svelte` |
| No Git warning | ✅ Exists | `frontend/src/lib/components/NoGitWarning.svelte` |
| Prompt templates | ✅ Exists | `backend/src/kory/prompts/index.ts` |

---

## Feature Matrix

### Beginner Mode

| Feature | Behavior |
|---------|----------|
| **Git Controls** | ❌ Completely hidden from UI |
| **Git Warning** | ⚠️ Shows warning if no Git repo detected |
| **AI Communication** | Friendly, encouraging, non-technical language |
| **Auto-commit** | ✅ Enabled - changes automatically saved |
| **Agent Details** | ❌ Hidden - users don't see worker/critic agents |
| **Cost Tracking** | ❌ Hidden - no token/cost display |
| **Confirmations** | ❌ Minimal - AI handles most decisions |
| **Tool Access** | Curated whitelist (basic file ops only) |
| **Worktrees** | ❌ Disabled |
| **Critic Gate** | ❌ Disabled (runs silently in background) |
| **Shadow Logger UI** | ❌ Hidden |
| **Max Workers** | 2 (limited parallelism) |

### Advanced Mode

| Feature | Behavior |
|---------|----------|
| **Git Controls** | ✅ Full access - staging, commits, branches, push/pull |
| **Git Warning** | ❌ No warning shown |
| **AI Communication** | Technical, concise, "nerdy" terminology |
| **Auto-commit** | ❌ Manual control |
| **Agent Details** | ✅ Full visibility - see all agents, workers, critic |
| **Cost Tracking** | ✅ Token usage, cost estimates visible |
| **Confirmations** | ✅ Required before actions |
| **Tool Access** | Full access to all tools |
| **Worktrees** | ✅ Enabled for parallel agent isolation |
| **Critic Gate** | ✅ Visible review process |
| **Shadow Logger UI** | ✅ Time travel, ghost commits visible |
| **Max Workers** | 8 (full parallelism) |

---

## Implementation Details

### 1. Frontend UI Changes

#### 1.1 Git Panel Visibility

**File**: `frontend/src/routes/+page.svelte`

```svelte
<!-- Line 604: Already conditionally renders based on modeStore.showGitPanel -->
{#if !zenMode && showGit && modeStore.showGitPanel}
  <aside ...>
    <SourceControlPanel />
  </aside>
{/if}
```

✅ **Already implemented** - Git panel only shows when `modeStore.showGitPanel` is true (advanced mode).

#### 1.2 Agent Cards Visibility

**File**: `frontend/src/routes/+page.svelte` (Line 542)

```svelte
{#if !zenMode && showAgents && modeStore.showAgentDetails && activeAgents.length > 0}
```

✅ **Already implemented** - Agent cards only show in advanced mode.

#### 1.3 Context Usage / Cost Tracking

**File**: `frontend/src/routes/+page.svelte` (Line 567)

```svelte
{#if wsStore.contextUsage.isReliable && modeStore.showCostTracking}
```

✅ **Already implemented** - Cost tracking only shows in advanced mode.

#### 1.4 No Git Warning (Beginner Mode Only)

**File**: `frontend/src/lib/components/NoGitWarning.svelte`

```svelte
let shouldShow = $derived(
  modeStore.isBeginner && 
  !gitStore.state.isRepo && 
  !dismissed &&
  modeStore.shouldWarnNoGit
);
```

✅ **Already implemented** - Warning only shows in beginner mode when no repo.

#### 1.5 Menu Bar Git Toggle

**File**: `frontend/src/lib/components/MenuBar.svelte`

Need to hide Git toggle button in beginner mode:

```svelte
{#if modeStore.showGitPanel}
  <button onclick={() => onAction('toggle_git')}>
    Git Panel
  </button>
{/if}
```

**Status**: ⚠️ Needs verification

---

### 2. Backend Prompt Changes

#### 2.1 Manager System Prompts

**File**: `backend/src/kory/prompts/index.ts`

**Current Beginner Prompt**:
```typescript
managerSystem: `You are Kory, a helpful AI coding assistant...
• Use friendly, conversational language
• Explain technical terms simply
• Focus on what the user wants to achieve, not how
• Be encouraging and supportive`
```

**Current Advanced Prompt**:
```typescript
managerSystem: `You are Kory, the manager agent in an AI orchestration system...
Architecture:
• Manager (you): Full tool access, unsandboxed...
• Workers: Sandboxed specialists...
• Critic: Read-only reviewer...`
```

✅ **Already implemented** with distinct tones.

**Enhancement Needed**: Make the distinction even more pronounced:

**Beginner** should sound like:
- "I'll help you build that!"
- "Let me take care of the technical stuff"
- "Great idea! Here's what we'll do..."
- Avoid: "orchestration", "sandboxed", "worktrees", "reflog"

**Advanced** should sound like:
- "Spawning worker in isolated worktree..."
- "Running critic gate validation..."
- "Shadow logger created ghost commit"
- Use: technical terminology, concise, precise

#### 2.2 Worker System Prompts

**Current Beginner**:
```typescript
workerSystem: `You are a specialist helping with a specific task...
• Write clean, working code
• Keep changes minimal and focused`
```

**Current Advanced**:
```typescript
workerSystem: `You are a specialist Worker Agent...
Constraints:
• Sandboxed to allowed paths only
• Use ask_manager if you need guidance`
```

✅ **Already implemented**.

#### 2.3 Critic System Prompts

**Current Beginner**:
```typescript
criticSystem: `You are a code reviewer...
Output either "PASS" or "FAIL" with brief feedback.`
```

**Current Advanced**:
```typescript
criticSystem: `You are the Critic agent...
Your final message MUST end with exactly "PASS" or "FAIL: <reason>"`
```

✅ **Already implemented**.

#### 2.4 Thought Messages

**Current Beginner**:
```typescript
thoughts: {
  analyzing: "Let me understand what you need...",
  planning: "Here's what I'll do...",
  executing: "Working on it...",
  reviewing: "Double-checking everything...",
  complete: "All done! Here's what I did:",
}
```

**Current Advanced**:
```typescript
thoughts: {
  analyzing: "Analyzing request...",
  planning: "Planning approach...",
  executing: "Executing...",
  reviewing: "Reviewing output...",
  complete: "Complete.",
}
```

✅ **Already implemented**.

#### 2.5 Error Messages

**Current Beginner**:
```typescript
errors: {
  noGitRepo: "⚠️ No backup system detected. I recommend adding your project to Git so your work is safely backed up. Would you like help with that?",
}
```

**Current Advanced**:
```typescript
errors: {
  noGitRepo: "No Git repository detected. Shadow logger and worktree isolation unavailable.",
}
```

✅ **Already implemented**.

---

### 3. Backend Behavior Changes

#### 3.1 Mode Manager Configuration

**File**: `backend/src/mode/mode-manager.ts`

Key methods already implemented:
- `shouldHideGitPanel()` - Returns true in beginner mode
- `shouldWarnNoGitRepo()` - Returns true only in beginner mode without repo
- `shouldAutoCommit()` - Returns true in beginner mode
- `shouldShowAgentDetails()` - Returns false in beginner mode
- `shouldShowCostTracking()` - Returns false in beginner mode
- `isToolAllowed(toolName)` - Checks whitelist in beginner mode
- `filterTools(tools)` - Filters to whitelist in beginner mode

✅ **Already implemented**.

#### 3.2 Git Manager Integration

**File**: `backend/src/kory/git-manager.ts`

The mode manager checks git repo status:

```typescript
shouldWarnNoGitRepo(): boolean {
  if (this.currentMode !== "beginner") return false;
  return !this.gitManager?.isGitRepo();
}
```

✅ **Already implemented**.

#### 3.3 API Routes

**File**: `backend/src/routes/mode.ts`

Endpoints:
- `GET /api/mode` - Get current mode, config, and context
- `PUT /api/mode` - Switch between beginner/advanced

Returns:
```typescript
{
  mode: "beginner" | "advanced",
  config: ModeConfig,
  context: ModeContext,
  shouldWarnNoGit: boolean,
  noGitWarning: string | null
}
```

✅ **Already implemented**.

---

## Implementation Complete ✅

All enhancements have been implemented:

### ✅ Enhancement 1: Strengthened Prompt Tone Distinction

**File**: `backend/src/kory/prompts/index.ts`

**Beginner Mode** - Friendly, encouraging, jargon-free:
- Manager talks like "an enthusiastic friend who's good with tech"
- Never uses terms like "orchestration", "sandboxed", "worktrees", "reflog"
- Celebrates wins: "Great idea!", "You've got this!", "This is going to be awesome!"
- Focuses on what the user wants to build, not technical details

**Advanced Mode** - Technical, precise, nerdy:
- Uses ASCII architecture diagrams
- Technical terminology: "Shadow Logger", "Worktree Isolation", "Critic Gate"
- Concise, precise language
- References to git internals and AI architecture

### ✅ Enhancement 2: Hide Git-Related Menu Items in Beginner Mode

**File**: `frontend/src/lib/components/MenuBar.svelte`

- Git toggle button hidden in beginner mode (`{#if modeStore.showGitPanel}`)
- View menu conditionally shows "Source Control" option only in advanced mode
- Agent toggle hidden in beginner mode

### ✅ Enhancement 3: Command Palette Mode Filtering

**File**: `frontend/src/lib/components/CommandPalette.svelte`

- Added `mode` property to command definitions
- Commands filtered based on current mode:
  - **Always available**: New Project, New Session, Toggle Sidebar, etc.
  - **Advanced only**: Toggle Source Control, Toggle Active Agents

### ✅ Enhancement 4: Auto-Commit with PR Creation

**Files**:
- `backend/src/kory/auto-commit-service.ts` (new)
- `backend/src/kory/manager.ts`
- `backend/src/kory/index.ts`

**Features**:
- Automatically commits changes after task completion in beginner mode
- Creates a new branch with a descriptive name based on the task
- Generates a conventional commit message
- Pushes branch to origin
- Creates a PR using GitHub CLI (`gh pr create`)
- Falls back to providing a PR URL if `gh` CLI isn't available
- Returns to original branch after completion
- Sends WebSocket notification to user with PR link

**Flow**:
1. User asks for changes in beginner mode
2. AI makes the changes
3. Auto-commit service:
   - Creates branch: `kory/task-description-timestamp`
   - Commits with message: `feat: task description`
   - Pushes to origin
   - Creates PR via `gh pr create`
4. User receives notification: "✨ I've saved your work and created a pull request for review: [URL]"

---

## Files Modified

| File | Changes |
|------|---------|
| `backend/src/kory/prompts/index.ts` | ✅ Enhanced prompt tone distinction |
| `frontend/src/lib/components/MenuBar.svelte` | ✅ Hide git controls in beginner mode |
| `frontend/src/lib/components/CommandPalette.svelte` | ✅ Filter commands by mode |
| `backend/src/kory/auto-commit-service.ts` | ✅ New service for auto-commit and PR creation |
| `backend/src/kory/manager.ts` | ✅ Integrated auto-commit into task completion |
| `backend/src/kory/index.ts` | ✅ Exported AutoCommitService |
| `shared/src/websocket/WSPayloads.ts` | ✅ Added metadata to NotificationPayload |

---

## Testing Checklist

### Frontend Tests

- [ ] Beginner mode hides Git panel completely
- [ ] Advanced mode shows Git panel
- [ ] Beginner mode shows warning when no Git repo
- [ ] Advanced mode does not show Git warning
- [ ] Beginner mode hides agent cards
- [ ] Advanced mode shows agent cards
- [ ] Beginner mode hides cost tracking
- [ ] Advanced mode shows cost tracking
- [ ] Mode toggle works correctly
- [ ] Mode persists across sessions

### Backend Tests

- [ ] Beginner prompts are friendly and non-technical
- [ ] Advanced prompts are technical and concise
- [ ] Beginner mode filters tools to whitelist
- [ ] Advanced mode allows all tools
- [ ] Beginner mode returns correct config from API
- [ ] Advanced mode returns correct config from API
- [ ] Mode switching updates prompts dynamically

### Integration Tests

- [ ] Full beginner mode workflow (no git, auto-commit)
- [ ] Full advanced mode workflow (manual git, full control)
- [ ] Mode switch mid-session updates UI correctly

---

## Files to Modify

| File | Changes |
|------|---------|
| `backend/src/kory/prompts/index.ts` | Enhance prompt tone distinction |
| `frontend/src/lib/components/MenuBar.svelte` | Hide git controls in beginner mode |
| `frontend/src/lib/components/CommandPalette.svelte` | Filter commands by mode |
| `backend/src/kory/manager.ts` | Implement auto-commit logic for beginner mode |

---

## Summary

The mode system is **mostly implemented**. The core infrastructure exists:

✅ Mode types and configuration  
✅ Mode manager (backend)  
✅ Mode store (frontend)  
✅ UI components (toggle, warning)  
✅ Basic prompt differentiation  
✅ Git panel conditional rendering  
✅ Agent details conditional rendering  
✅ Cost tracking conditional rendering  

**Remaining work**:
1. Strengthen the tone distinction in prompts (more friendly vs more technical)
2. Hide Git-related menu items in beginner mode
3. Filter command palette commands by mode
4. Implement auto-commit behavior for beginner mode

The system is designed to be extensible - adding new mode-specific behaviors only requires:
1. Adding the config option to `ModeConfig`
2. Setting the default in `DEFAULT_BEGINNER_CONFIG` / `DEFAULT_ADVANCED_CONFIG`
3. Implementing the conditional logic using `modeStore` or `modeManager`
