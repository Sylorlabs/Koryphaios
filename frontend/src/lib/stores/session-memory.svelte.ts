/**
 * Session Memory Store
 * 
 * Manages the persistent memory file for the current session.
 * Memory files survive compaction and store long-term context.
 */

import { apiUrl } from "$lib/utils/api-url";
import { toastStore } from "./toast.svelte";

interface MemoryState {
  content: string | null;
  exists: boolean;
  isLoading: boolean;
  lastUpdated: number | null;
}

function createSessionMemoryStore() {
  let state = $state<MemoryState>({
    content: null,
    exists: false,
    isLoading: false,
    lastUpdated: null,
  });

  async function loadMemory(sessionId: string): Promise<void> {
    state.isLoading = true;
    try {
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}/memory`), {
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.exists = data.data.exists;
          state.content = data.data.content;
          state.lastUpdated = Date.now();
        }
      }
    } catch (err) {
      console.error("Failed to load session memory:", err);
    } finally {
      state.isLoading = false;
    }
  }

  async function saveMemory(sessionId: string, content: string): Promise<boolean> {
    state.isLoading = true;
    try {
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}/memory`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content }),
      });

      if (res.ok) {
        state.content = content;
        state.exists = true;
        state.lastUpdated = Date.now();
        toastStore.success("Session memory saved");
        return true;
      } else {
        throw new Error("Failed to save memory");
      }
    } catch (err) {
      toastStore.error("Failed to save session memory");
      console.error(err);
      return false;
    } finally {
      state.isLoading = false;
    }
  }

  function clearMemory(): void {
    state.content = null;
    state.exists = false;
    state.lastUpdated = null;
  }

  return {
    get content() { return state.content; },
    get exists() { return state.exists; },
    get isLoading() { return state.isLoading; },
    get lastUpdated() { return state.lastUpdated; },
    
    loadMemory,
    saveMemory,
    clearMemory,
  };
}

export const sessionMemoryStore = createSessionMemoryStore();
