/**
 * Unified Memory Store
 * 
 * Manages all memory types:
 * - Universal Memory (global across all projects)
 * - Project Memory (specific to current project)
 * - Session Memory (per-chat persistent storage)
 * - Rules (.cursorrules file)
 * - Memory Settings (toggles and configuration)
 */

import { apiUrl } from "$lib/utils/api-url";
import { toastStore } from "./toast.svelte";

// ============================================================================
// Types
// ============================================================================

export interface MemoryFile {
  path: string;
  content: string;
  exists: boolean;
  lastModified: number | null;
  size: number;
}

export interface MemorySettings {
  universalMemoryEnabled: boolean;
  projectMemoryEnabled: boolean;
  sessionMemoryEnabled: boolean;
  agentMemoryEnabled: boolean;
  rulesEnabled: boolean;
  autoIncludeInContext: boolean;
  maxContextTokens: number;
}

export interface MemoryState {
  universal: MemoryFile | null;
  project: MemoryFile | null;
  session: MemoryFile | null;
  rules: MemoryFile | null;
  settings: MemorySettings | null;
  isLoading: boolean;
  activeTab: "universal" | "project" | "session" | "rules" | "settings";
}

// ============================================================================
// Default Settings
// ============================================================================

export const DEFAULT_SETTINGS: MemorySettings = {
  universalMemoryEnabled: true,
  projectMemoryEnabled: true,
  sessionMemoryEnabled: true,
  agentMemoryEnabled: true,
  rulesEnabled: true,
  autoIncludeInContext: true,
  maxContextTokens: 2000,
};

// ============================================================================
// Store Factory
// ============================================================================

function createMemoryStore() {
  let state = $state<MemoryState>({
    universal: null,
    project: null,
    session: null,
    rules: null,
    settings: null,
    isLoading: false,
    activeTab: "project",
  });

  // ========================================================================
  // Universal Memory
  // ========================================================================

  async function loadUniversalMemory(): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/memory/universal"), {
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.universal = data.data;
        }
      }
    } catch (err) {
      console.error("Failed to load universal memory:", err);
    }
  }

  async function saveUniversalMemory(content: string): Promise<boolean> {
    state.isLoading = true;
    try {
      const res = await fetch(apiUrl("/api/memory/universal"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.universal = {
            ...state.universal,
            content,
            exists: true,
            lastModified: Date.now(),
            size: content.length,
          } as MemoryFile;
          toastStore.success("Universal memory saved");
          return true;
        }
      }
      throw new Error("Failed to save");
    } catch (err) {
      toastStore.error("Failed to save universal memory");
      return false;
    } finally {
      state.isLoading = false;
    }
  }

  async function initializeUniversalMemory(): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/memory/universal/init"), {
        method: "POST",
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.universal = data.data;
          toastStore.success("Universal memory initialized with template");
        }
      }
    } catch (err) {
      toastStore.error("Failed to initialize universal memory");
    }
  }

  // ========================================================================
  // Project Memory
  // ========================================================================

  async function loadProjectMemory(): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/memory/project"), {
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.project = data.data;
        }
      }
    } catch (err) {
      console.error("Failed to load project memory:", err);
    }
  }

  async function saveProjectMemory(content: string): Promise<boolean> {
    state.isLoading = true;
    try {
      const res = await fetch(apiUrl("/api/memory/project"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.project = {
            ...state.project,
            content,
            exists: true,
            lastModified: Date.now(),
            size: content.length,
          } as MemoryFile;
          toastStore.success("Project memory saved");
          return true;
        }
      }
      throw new Error("Failed to save");
    } catch (err) {
      toastStore.error("Failed to save project memory");
      return false;
    } finally {
      state.isLoading = false;
    }
  }

  async function initializeProjectMemory(): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/memory/project/init"), {
        method: "POST",
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.project = data.data;
          toastStore.success("Project memory initialized with template");
        }
      }
    } catch (err) {
      toastStore.error("Failed to initialize project memory");
    }
  }

  // ========================================================================
  // Session Memory
  // ========================================================================

  async function loadSessionMemory(sessionId: string): Promise<void> {
    try {
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}/memory`), {
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.session = data.data;
        }
      }
    } catch (err) {
      console.error("Failed to load session memory:", err);
    }
  }

  async function saveSessionMemory(sessionId: string, content: string): Promise<boolean> {
    state.isLoading = true;
    try {
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}/memory`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.session = {
            ...state.session,
            content,
            exists: true,
            lastModified: Date.now(),
            size: content.length,
          } as MemoryFile;
          toastStore.success("Session memory saved");
          return true;
        }
      }
      throw new Error("Failed to save");
    } catch (err) {
      toastStore.error("Failed to save session memory");
      return false;
    } finally {
      state.isLoading = false;
    }
  }

  async function initializeSessionMemory(sessionId: string): Promise<void> {
    try {
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}/memory/init`), {
        method: "POST",
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.session = data.data;
          toastStore.success("Session memory initialized with template");
        }
      }
    } catch (err) {
      toastStore.error("Failed to initialize session memory");
    }
  }

  async function deleteSessionMemory(sessionId: string): Promise<boolean> {
    try {
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}/memory`), {
        method: "DELETE",
        credentials: "include",
      });

      if (res.ok) {
        state.session = null;
        toastStore.success("Session memory deleted");
        return true;
      }
      return false;
    } catch (err) {
      toastStore.error("Failed to delete session memory");
      return false;
    }
  }

  // ========================================================================
  // Rules
  // ========================================================================

  async function loadRules(): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/memory/rules"), {
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.rules = data.data;
        }
      }
    } catch (err) {
      console.error("Failed to load rules:", err);
    }
  }

  async function saveRules(content: string): Promise<boolean> {
    state.isLoading = true;
    try {
      const res = await fetch(apiUrl("/api/memory/rules"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.rules = {
            ...state.rules,
            content,
            exists: true,
            lastModified: Date.now(),
            size: content.length,
          } as MemoryFile;
          toastStore.success("Rules saved");
          return true;
        }
      }
      throw new Error("Failed to save");
    } catch (err) {
      toastStore.error("Failed to save rules");
      return false;
    } finally {
      state.isLoading = false;
    }
  }

  async function initializeRules(): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/memory/rules/init"), {
        method: "POST",
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.rules = data.data;
          toastStore.success("Rules initialized with template");
        }
      }
    } catch (err) {
      toastStore.error("Failed to initialize rules");
    }
  }

  // ========================================================================
  // Settings
  // ========================================================================

  async function loadSettings(): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/memory/settings"), {
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.settings = data.data;
        }
      }
    } catch (err) {
      console.error("Failed to load memory settings:", err);
      state.settings = DEFAULT_SETTINGS;
    }
  }

  async function saveSettings(settings: Partial<MemorySettings>): Promise<boolean> {
    state.isLoading = true;
    try {
      const res = await fetch(apiUrl("/api/memory/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(settings),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.settings = { ...state.settings, ...data.data } as MemorySettings;
          toastStore.success("Memory settings saved");
          return true;
        }
      }
      throw new Error("Failed to save");
    } catch (err) {
      toastStore.error("Failed to save memory settings");
      return false;
    } finally {
      state.isLoading = false;
    }
  }

  async function resetSettings(): Promise<boolean> {
    try {
      const res = await fetch(apiUrl("/api/memory/settings/reset"), {
        method: "POST",
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.settings = data.data;
          toastStore.success("Memory settings reset to defaults");
          return true;
        }
      }
      return false;
    } catch (err) {
      toastStore.error("Failed to reset memory settings");
      return false;
    }
  }

  // ========================================================================
  // Bulk Operations
  // ========================================================================

  async function loadAllMemory(sessionId?: string): Promise<void> {
    state.isLoading = true;
    try {
      await Promise.all([
        loadUniversalMemory(),
        loadProjectMemory(),
        sessionId ? loadSessionMemory(sessionId) : Promise.resolve(),
        loadRules(),
        loadSettings(),
      ]);
    } finally {
      state.isLoading = false;
    }
  }

  function setActiveTab(tab: MemoryState["activeTab"]): void {
    state.activeTab = tab;
  }

  function clearSessionMemory(): void {
    state.session = null;
  }

  // ========================================================================
  // Getters
  // ========================================================================

  return {
    // State getters
    get universal() { return state.universal; },
    get project() { return state.project; },
    get session() { return state.session; },
    get rules() { return state.rules; },
    get settings() { return state.settings; },
    get isLoading() { return state.isLoading; },
    get activeTab() { return state.activeTab; },

    // Universal memory
    loadUniversalMemory,
    saveUniversalMemory,
    initializeUniversalMemory,

    // Project memory
    loadProjectMemory,
    saveProjectMemory,
    initializeProjectMemory,

    // Session memory
    loadSessionMemory,
    saveSessionMemory,
    initializeSessionMemory,
    deleteSessionMemory,
    clearSessionMemory,

    // Rules
    loadRules,
    saveRules,
    initializeRules,

    // Settings
    loadSettings,
    saveSettings,
    resetSettings,

    // Bulk operations
    loadAllMemory,
    setActiveTab,
  };
}

export const memoryStore = createMemoryStore();
