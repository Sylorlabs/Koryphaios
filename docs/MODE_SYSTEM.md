# Koryphaios Mode System

## Overview

Koryphaios now supports two distinct modes to accommodate different user skill levels:

- **Beginner Mode**: Simple, guided experience with automatic backups and friendly language
- **Advanced Mode**: Full control with Git integration, technical terminology, and advanced features

## Mode Differences

| Feature | Beginner Mode | Advanced Mode |
|---------|---------------|---------------|
| **Git Panel** | ❌ Hidden | ✅ Full access |
| **Language** | Friendly, simple | Technical, concise |
| **Auto-commit** | ✅ Enabled | ❌ Manual control |
| **Agent Details** | ❌ Hidden | ✅ Visible |
| **Cost Tracking** | ❌ Hidden | ✅ Visible |
| **Tool Access** | Curated whitelist | Full access |
| **Worktrees** | ❌ Disabled | ✅ Enabled |
| **Critic Gate** | ❌ Disabled | ✅ Enabled |
| **Shadow Logger** | ❌ Hidden | ✅ Full UI |
| **Confirmations** | Minimal | Per-action |

## Backend Implementation

### Files Created

```
backend/src/
├── mode/
│   ├── mode-manager.ts      # Core mode state management
│   └── index.ts             # Exports
└── kory/prompts/
    └── index.ts             # Mode-aware prompt templates
```

### Mode Manager

The `ModeManager` class handles:
- Current mode state (beginner/advanced)
- Mode-specific configuration
- Tool filtering based on mode
- Prompt template selection
- Git repo detection for warnings

```typescript
import { getModeManager } from "./mode";

const modeManager = getModeManager();
modeManager.setMode("advanced");
const config = modeManager.getModeConfig();
const prompts = modeManager.getPrompts();
```

### Prompt Templates

Prompts adapt based on mode:

**Beginner Mode:**
```
"You are Kory, a helpful AI coding assistant. I'll help you with your projects 
in a simple, friendly way. I'll handle most tasks automatically..."
```

**Advanced Mode:**
```
"You are Kory, the manager agent in an AI orchestration system. Architecture:
• Manager (you): Full tool access, unsandboxed, coordinates all operations
• Workers: Sandboxed specialists spawned via delegate_to_worker..."
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/mode` | Get current mode and config |
| PUT | `/api/mode` | Set mode (beginner/advanced) |
| POST | `/api/mode/toggle` | Toggle between modes |

## Frontend Implementation

### Files Created

```
frontend/src/lib/
├── stores/mode.svelte.ts       # Mode reactive store
└── components/
    ├── ModeToggle.svelte       # Mode switcher UI
    └── NoGitWarning.svelte     # Beginner mode warning
```

### Mode Store

```typescript
import { modeStore } from "$lib/stores/mode.svelte";

// Reactive values
modeStore.mode;           // "beginner" | "advanced"
modeStore.isBeginner;     // boolean
modeStore.isAdvanced;     // boolean
modeStore.showGitPanel;   // boolean
modeStore.showAgentDetails; // boolean

// Actions
modeStore.setMode("advanced");
modeStore.toggleMode();
modeStore.fetchMode();    // Sync with backend
```

### UI Components

**ModeToggle**: Switch between modes
```svelte
<ModeToggle variant="buttons" />  // Two separate buttons
<ModeToggle variant="switch" />   // Single toggle button
```

**NoGitWarning**: Shows in beginner mode when no Git repo detected
```svelte
<NoGitWarning />
```

## Configuration

Add to `koryphaios.json`:

```json
{
  "ui": {
    "mode": "beginner",
    "adaptiveThreshold": 10
  },
  "modes": {
    "beginner": {
      "hideGitPanel": true,
      "autoCommit": true,
      "simplifiedPrompts": true,
      "maxWorkers": 2,
      "requireConfirmations": false,
      "toolAccess": "curated",
      "explanations": "verbose",
      "enableShadowLoggerUI": false,
      "enableWorktrees": false,
      "enableCriticGate": false,
      "showAgentDetails": false,
      "showCostTracking": false
    },
    "advanced": {
      "hideGitPanel": false,
      "autoCommit": false,
      "simplifiedPrompts": false,
      "maxWorkers": 8,
      "requireConfirmations": true,
      "toolAccess": "full",
      "explanations": "minimal",
      "enableShadowLoggerUI": true,
      "enableWorktrees": true,
      "enableCriticGate": true,
      "showAgentDetails": true,
      "showCostTracking": true
    }
  }
}
```

## No Git Repo Warning

In beginner mode, if no Git repository is detected:

1. A friendly warning appears in the sidebar
2. Suggests adding the project to Git for backup
3. Can be dismissed by the user
4. Only shows in beginner mode (advanced users already know about Git)

## Switching Modes

### Via UI
- Use the mode toggle in the sidebar footer
- Or use the MenuBar (if visible)

### Via API
```bash
# Get current mode
curl http://localhost:3000/api/mode

# Set mode
curl -X PUT http://localhost:3000/api/mode \
  -H "Content-Type: application/json" \
  -d '{"mode": "advanced"}'

# Toggle mode
curl -X POST http://localhost:3000/api/mode/toggle
```

## Future Enhancements

1. **Adaptive Mode**: Automatically suggest advanced mode after N sessions
2. **Mode-Specific Onboarding**: Different first-time user flows
3. **Custom Modes**: User-defined mode configurations
4. **Mode Analytics**: Track which features are used in each mode
5. **Graduated Mode**: Unlock features as users demonstrate proficiency

## Migration Notes

- Existing users will default to beginner mode
- Mode preference is persisted in localStorage
- Backend mode is independent per session
- Git operations are automatically hidden/shown based on mode
