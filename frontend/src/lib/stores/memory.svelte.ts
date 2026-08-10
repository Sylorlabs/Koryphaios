/**
 * Unified Memory Store
 *
 * Manages all memory types:
 * - Universal Memory (global across all projects)
 * - Project Memory (specific to current project)
 * - Session Memory (per-chat persistent storage)
 * - Project rules Markdown files
 * - Memory Settings (toggles and configuration)
 */

import { apiUrl } from '$lib/utils/api-url';
import { toastStore } from './toast.svelte';
import { apiFetch } from '$lib/api.svelte';
import { projectStore } from './project.svelte';
import { DEFAULT_CONTEXT_BUDGET_TOKENS } from '@koryphaios/shared';
import { KeyedRequestGate } from '$lib/utils/keyed-request-gate';

// ============================================================================
// Types
// ============================================================================

export interface MemoryFile {
  path: string;
  content: string;
  exists: boolean;
  lastModified: number | null;
  size: number;
  revision: string | null;
}

export interface MemorySettings {
  universalMemoryEnabled: boolean;
  projectMemoryEnabled: boolean;
  sessionMemoryEnabled: boolean;
  agentMemoryEnabled: boolean;
  rulesEnabled: boolean;
  autoIncludeInContext: boolean;
  maxContextTokens: number;
  maxContextTokensEnabled: boolean;
  autosaveEnabled: boolean;
  autosaveDelayMs: number;
  documentSizeLimitEnabled: boolean;
  maxDocumentBytes: number;
}

export interface MemoryState {
  universal: MemoryFile | null;
  project: MemoryFile | null;
  session: MemoryFile | null;
  rules: MemoryFile | null;
  settings: MemorySettings | null;
  isLoading: boolean;
  error: string | null;
  activeTab: 'universal' | 'project' | 'session' | 'rules' | 'settings';
}
export interface ProjectMemoryDocument {
  name: string;
  path: string;
  kind: 'memory' | 'rules';
}
export interface ProjectMemoryDocumentFile extends MemoryFile {
  name: string;
  kind: 'memory' | 'rules';
}
export interface MemoryConflict {
  scope: 'universal' | 'project' | 'session' | 'rules' | 'document';
  remote: MemoryFile;
  name?: string;
  kind?: 'memory' | 'rules';
}
export type MemorySourceKey =
  | 'universal'
  | 'project'
  | 'session'
  | 'rules'
  | 'settings'
  | 'documents'
  | `document:${'memory' | 'rules'}:${string}`;

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
  maxContextTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
  maxContextTokensEnabled: true,
  autosaveEnabled: true,
  autosaveDelayMs: 1500,
  documentSizeLimitEnabled: true,
  maxDocumentBytes: 1_000_000,
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
    error: null,
    activeTab: 'project',
  });
  let documents = $state<ProjectMemoryDocument[]>([]);
  let conflict = $state<MemoryConflict | null>(null);
  let settingsSaveRevision = 0;
  let settingsSaveQueue: Promise<void> = Promise.resolve();
  let projectGeneration = 0;
  let sourceErrors = $state<Record<string, string>>({});
  let sourceLoading = $state<Record<string, boolean>>({});
  const sourceRequests = new KeyedRequestGate<MemorySourceKey>();

  function documentSource(name: string, kind: 'memory' | 'rules'): MemorySourceKey {
    return `document:${kind}:${name}`;
  }

  function startSourceRequest(source: MemorySourceKey): number {
    const requestId = sourceRequests.begin(source);
    sourceLoading = { ...sourceLoading, [source]: true };
    const { [source]: _ignored, ...remaining } = sourceErrors;
    sourceErrors = remaining;
    state.error = Object.values(remaining)[0] ?? null;
    return requestId;
  }

  function sourceRequestIsCurrent(source: MemorySourceKey, requestId: number): boolean {
    return sourceRequests.isCurrent(source, requestId);
  }

  function finishSourceRequest(source: MemorySourceKey, requestId: number): void {
    if (!sourceRequestIsCurrent(source, requestId)) return;
    sourceLoading = { ...sourceLoading, [source]: false };
  }

  function failSource(source: MemorySourceKey, message: string, showToast = true): void {
    sourceErrors = { ...sourceErrors, [source]: message };
    state.error = message;
    if (showToast) toastStore.error(message);
  }

  function clearSourceError(source: MemorySourceKey): void {
    const { [source]: _ignored, ...remaining } = sourceErrors;
    sourceErrors = remaining;
    state.error = Object.values(remaining)[0] ?? null;
  }

  function captureProjectScope() {
    return { projectPath: projectStore.currentPath, generation: projectGeneration };
  }

  function projectScopeIsCurrent(scope: ReturnType<typeof captureProjectScope>): boolean {
    return scope.generation === projectGeneration && scope.projectPath === projectStore.currentPath;
  }

  function beginProjectTransition(): void {
    projectGeneration++;
    state.project = null;
    state.session = null;
    state.rules = null;
    state.settings = null;
    state.isLoading = false;
    state.error = null;
    documents = [];
    conflict = null;
    sourceErrors = {};
    sourceLoading = {};
    sourceRequests.reset();
  }

  async function responseMessage(response: Response, fallback: string): Promise<string> {
    try {
      const body = (await response.clone().json()) as { error?: string };
      return body.error || fallback;
    } catch {
      return fallback;
    }
  }

  function clearError(source?: MemorySourceKey): void {
    if (source) {
      clearSourceError(source);
      return;
    }
    state.error = null;
    sourceErrors = {};
  }

  async function loadDocuments(): Promise<void> {
    const scope = captureProjectScope();
    const source: MemorySourceKey = 'documents';
    const requestId = startSourceRequest(source);
    try {
      const res = await apiFetch(apiUrl('/api/memory/documents'));
      if (!res.ok) throw new Error(await responseMessage(res, 'Failed to load memory documents'));
      const data = await res.json();
      if (projectScopeIsCurrent(scope) && sourceRequestIsCurrent(source, requestId)) {
        documents = data.ok && Array.isArray(data.data) ? data.data : [];
        clearSourceError(source);
      }
    } catch (error) {
      if (projectScopeIsCurrent(scope) && sourceRequestIsCurrent(source, requestId)) {
        failSource(
          source,
          error instanceof Error ? error.message : 'Failed to load memory documents',
          false,
        );
      }
    } finally {
      finishSourceRequest(source, requestId);
    }
  }

  async function createDocument(
    name: string,
    kind: 'memory' | 'rules',
  ): Promise<ProjectMemoryDocument | null> {
    const scope = captureProjectScope();
    try {
      const res = await apiFetch(apiUrl('/api/memory/documents'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, kind }),
      });
      if (!res.ok) {
        if (projectScopeIsCurrent(scope)) {
          failSource('documents', await responseMessage(res, 'Failed to create document'));
        }
        return null;
      }
      const data = (await res.json()) as { ok?: boolean; data?: ProjectMemoryDocument };
      if (!data.ok || !data.data) {
        if (projectScopeIsCurrent(scope)) failSource('documents', 'Failed to create document');
        return null;
      }
      if (!projectScopeIsCurrent(scope)) return null;
      await loadDocuments();
      toastStore.success('Markdown document created');
      return (
        documents.find(
          (document) => document.name === data.data!.name && document.kind === data.data!.kind,
        ) ?? data.data
      );
    } catch (error) {
      if (projectScopeIsCurrent(scope)) {
        failSource(
          'documents',
          error instanceof Error ? error.message : 'Failed to create document',
        );
      }
      return null;
    }
  }

  async function loadDocument(
    name: string,
    kind: 'memory' | 'rules',
  ): Promise<ProjectMemoryDocumentFile | null> {
    const scope = captureProjectScope();
    const source = documentSource(name, kind);
    const requestId = startSourceRequest(source);
    try {
      const res = await apiFetch(
        apiUrl(`/api/memory/documents/${kind}/${encodeURIComponent(name)}`),
      );
      if (!res.ok) throw new Error(await responseMessage(res, 'Failed to load document'));
      const data = await res.json();
      if (!projectScopeIsCurrent(scope) || !sourceRequestIsCurrent(source, requestId)) return null;
      clearSourceError(source);
      return data.ok ? { ...data.data, name, kind } : null;
    } catch (err) {
      if (projectScopeIsCurrent(scope) && sourceRequestIsCurrent(source, requestId)) {
        failSource(source, err instanceof Error ? err.message : 'Failed to load document');
      }
      return null;
    } finally {
      finishSourceRequest(source, requestId);
    }
  }

  async function saveDocument(
    name: string,
    kind: 'memory' | 'rules',
    content: string,
    expectedRevision?: string | null,
  ): Promise<ProjectMemoryDocumentFile | null> {
    const scope = captureProjectScope();
    const source = documentSource(name, kind);
    try {
      const res = await apiFetch(
        apiUrl(`/api/memory/documents/${kind}/${encodeURIComponent(name)}`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, expectedRevision }),
        },
      );
      if (res.status === 409) {
        if (!projectScopeIsCurrent(scope)) return null;
        const remote = await loadDocument(name, kind);
        if (remote) conflict = { scope: 'document', remote, name, kind };
        failSource(
          source,
          'This document changed elsewhere. Review both versions before choosing which one to keep.',
        );
        return null;
      }
      if (!res.ok) throw new Error(await responseMessage(res, 'Failed to save document'));
      const data = await res.json();
      if (!data.ok) return null;
      if (!projectScopeIsCurrent(scope)) return null;
      const document = { ...data.data, name, kind } as ProjectMemoryDocumentFile;
      conflict = null;
      clearSourceError(source);
      toastStore.success('Document saved');
      return document;
    } catch (err) {
      if (projectScopeIsCurrent(scope)) {
        failSource(source, err instanceof Error ? err.message : 'Failed to save document');
      }
      return null;
    }
  }

  // ========================================================================
  // Universal Memory
  // ========================================================================

  async function loadUniversalMemory(): Promise<void> {
    const source: MemorySourceKey = 'universal';
    const requestId = startSourceRequest(source);
    try {
      const res = await apiFetch(apiUrl('/api/memory/universal'));

      if (res.ok) {
        const data = await res.json();
        if (data.ok && sourceRequestIsCurrent(source, requestId)) {
          state.universal = data.data;
          clearSourceError(source);
        }
      } else if (sourceRequestIsCurrent(source, requestId)) {
        failSource(source, await responseMessage(res, 'Failed to load universal memory'), false);
      }
    } catch (err) {
      if (sourceRequestIsCurrent(source, requestId)) {
        failSource(
          source,
          err instanceof Error ? err.message : 'Failed to load universal memory',
          false,
        );
      }
    } finally {
      finishSourceRequest(source, requestId);
    }
  }

  async function saveUniversalMemory(
    content: string,
    expectedRevision?: string | null,
  ): Promise<boolean> {
    state.isLoading = true;
    try {
      const res = await apiFetch(apiUrl('/api/memory/universal'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, expectedRevision }),
      });

      if (res.status === 409) {
        await loadUniversalMemory();
        if (state.universal) conflict = { scope: 'universal', remote: state.universal };
        failSource(
          'universal',
          'Universal memory changed elsewhere. Review both versions before saving.',
        );
        return false;
      }
      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.universal = data.data as MemoryFile;
          conflict = null;
          clearSourceError('universal');
          toastStore.success('Universal memory saved');
          return true;
        }
      }
      throw new Error(await responseMessage(res, 'Failed to save universal memory'));
    } catch (err) {
      failSource(
        'universal',
        err instanceof Error ? err.message : 'Failed to save universal memory',
      );
      return false;
    } finally {
      state.isLoading = false;
    }
  }

  async function initializeUniversalMemory(): Promise<void> {
    try {
      const res = await apiFetch(apiUrl('/api/memory/universal/init'), { method: 'POST' });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          state.universal = data.data;
          toastStore.success('Universal memory initialized with template');
        }
      }
    } catch (err) {
      toastStore.error('Failed to initialize universal memory');
    }
  }

  // ========================================================================
  // Project Memory
  // ========================================================================

  async function loadProjectMemory(): Promise<void> {
    const scope = captureProjectScope();
    const source: MemorySourceKey = 'project';
    const requestId = startSourceRequest(source);
    try {
      const res = await apiFetch(apiUrl('/api/memory/project'));

      if (res.ok) {
        const data = await res.json();
        if (data.ok && projectScopeIsCurrent(scope) && sourceRequestIsCurrent(source, requestId)) {
          state.project = data.data;
          clearSourceError(source);
        }
      } else if (projectScopeIsCurrent(scope) && sourceRequestIsCurrent(source, requestId)) {
        failSource(source, await responseMessage(res, 'Failed to load project memory'), false);
      }
    } catch (err) {
      if (projectScopeIsCurrent(scope) && sourceRequestIsCurrent(source, requestId)) {
        failSource(
          source,
          err instanceof Error ? err.message : 'Failed to load project memory',
          false,
        );
      }
    } finally {
      finishSourceRequest(source, requestId);
    }
  }

  async function saveProjectMemory(
    content: string,
    expectedRevision?: string | null,
  ): Promise<boolean> {
    const scope = captureProjectScope();
    state.isLoading = true;
    try {
      const res = await apiFetch(apiUrl('/api/memory/project'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, expectedRevision }),
      });

      if (res.status === 409) {
        if (!projectScopeIsCurrent(scope)) return false;
        await loadProjectMemory();
        if (state.project) conflict = { scope: 'project', remote: state.project };
        failSource(
          'project',
          'Project memory changed elsewhere. Review both versions before saving.',
        );
        return false;
      }
      if (res.ok) {
        const data = await res.json();
        if (data.ok && projectScopeIsCurrent(scope)) {
          state.project = data.data as MemoryFile;
          conflict = null;
          clearSourceError('project');
          toastStore.success('Project memory saved');
          return true;
        }
      }
      throw new Error(await responseMessage(res, 'Failed to save project memory'));
    } catch (err) {
      if (projectScopeIsCurrent(scope)) {
        failSource('project', err instanceof Error ? err.message : 'Failed to save project memory');
      }
      return false;
    } finally {
      if (projectScopeIsCurrent(scope)) state.isLoading = false;
    }
  }

  async function initializeProjectMemory(): Promise<void> {
    const scope = captureProjectScope();
    try {
      const res = await apiFetch(apiUrl('/api/memory/project/init'), { method: 'POST' });

      if (res.ok) {
        const data = await res.json();
        if (data.ok && projectScopeIsCurrent(scope)) {
          state.project = data.data;
          toastStore.success('Project memory initialized with template');
        }
      }
    } catch (err) {
      if (projectScopeIsCurrent(scope)) toastStore.error('Failed to initialize project memory');
    }
  }

  // ========================================================================
  // Session Memory
  // ========================================================================

  async function loadSessionMemory(sessionId: string): Promise<void> {
    const scope = captureProjectScope();
    const source: MemorySourceKey = 'session';
    const requestId = startSourceRequest(source);
    try {
      const res = await apiFetch(apiUrl(`/api/memory/sessions/${sessionId}`));

      if (res.ok) {
        const data = await res.json();
        if (data.ok && projectScopeIsCurrent(scope) && sourceRequestIsCurrent(source, requestId)) {
          state.session = data.data;
          clearSourceError(source);
        }
      } else if (projectScopeIsCurrent(scope) && sourceRequestIsCurrent(source, requestId)) {
        failSource(source, await responseMessage(res, 'Failed to load session memory'), false);
      }
    } catch (err) {
      if (projectScopeIsCurrent(scope) && sourceRequestIsCurrent(source, requestId)) {
        failSource(
          source,
          err instanceof Error ? err.message : 'Failed to load session memory',
          false,
        );
      }
    } finally {
      finishSourceRequest(source, requestId);
    }
  }

  async function saveSessionMemory(
    sessionId: string,
    content: string,
    expectedRevision?: string | null,
  ): Promise<boolean> {
    const scope = captureProjectScope();
    state.isLoading = true;
    try {
      const res = await apiFetch(apiUrl(`/api/memory/sessions/${sessionId}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, expectedRevision }),
      });

      if (res.status === 409) {
        if (!projectScopeIsCurrent(scope)) return false;
        await loadSessionMemory(sessionId);
        if (state.session) conflict = { scope: 'session', remote: state.session };
        failSource(
          'session',
          'Session memory changed elsewhere. Review both versions before saving.',
        );
        return false;
      }
      if (res.ok) {
        const data = await res.json();
        if (data.ok && projectScopeIsCurrent(scope)) {
          state.session = data.data as MemoryFile;
          conflict = null;
          clearSourceError('session');
          toastStore.success('Session memory saved');
          return true;
        }
      }
      throw new Error(await responseMessage(res, 'Failed to save session memory'));
    } catch (err) {
      if (projectScopeIsCurrent(scope)) {
        failSource('session', err instanceof Error ? err.message : 'Failed to save session memory');
      }
      return false;
    } finally {
      if (projectScopeIsCurrent(scope)) state.isLoading = false;
    }
  }

  async function initializeSessionMemory(sessionId: string): Promise<void> {
    const scope = captureProjectScope();
    try {
      const res = await apiFetch(apiUrl(`/api/memory/sessions/${sessionId}/init`), {
        method: 'POST',
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok && projectScopeIsCurrent(scope)) {
          state.session = data.data;
          toastStore.success('Session memory initialized with template');
        }
      }
    } catch (err) {
      if (projectScopeIsCurrent(scope)) toastStore.error('Failed to initialize session memory');
    }
  }

  async function deleteSessionMemory(sessionId: string): Promise<boolean> {
    const scope = captureProjectScope();
    try {
      const res = await apiFetch(apiUrl(`/api/memory/sessions/${sessionId}`), { method: 'DELETE' });

      if (res.ok && projectScopeIsCurrent(scope)) {
        state.session = null;
        toastStore.success('Session memory deleted');
        return true;
      }
      return false;
    } catch (err) {
      if (projectScopeIsCurrent(scope)) toastStore.error('Failed to delete session memory');
      return false;
    }
  }

  // ========================================================================
  // Rules
  // ========================================================================

  async function loadRules(): Promise<void> {
    const scope = captureProjectScope();
    const source: MemorySourceKey = 'rules';
    const requestId = startSourceRequest(source);
    try {
      const res = await apiFetch(apiUrl('/api/memory/rules'));

      if (res.ok) {
        const data = await res.json();
        if (data.ok && projectScopeIsCurrent(scope) && sourceRequestIsCurrent(source, requestId)) {
          state.rules = data.data;
          clearSourceError(source);
        }
      } else if (projectScopeIsCurrent(scope) && sourceRequestIsCurrent(source, requestId)) {
        failSource(source, await responseMessage(res, 'Failed to load rules'), false);
      }
    } catch (err) {
      if (projectScopeIsCurrent(scope) && sourceRequestIsCurrent(source, requestId)) {
        failSource(source, err instanceof Error ? err.message : 'Failed to load rules', false);
      }
    } finally {
      finishSourceRequest(source, requestId);
    }
  }

  async function saveRules(content: string, expectedRevision?: string | null): Promise<boolean> {
    const scope = captureProjectScope();
    state.isLoading = true;
    try {
      const res = await apiFetch(apiUrl('/api/memory/rules'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, expectedRevision }),
      });

      if (res.status === 409) {
        if (!projectScopeIsCurrent(scope)) return false;
        await loadRules();
        if (state.rules) conflict = { scope: 'rules', remote: state.rules };
        failSource('rules', 'Project rules changed elsewhere. Review both versions before saving.');
        return false;
      }
      if (res.ok) {
        const data = await res.json();
        if (data.ok && projectScopeIsCurrent(scope)) {
          state.rules = data.data as MemoryFile;
          conflict = null;
          clearSourceError('rules');
          toastStore.success('Rules saved');
          return true;
        }
      }
      throw new Error(await responseMessage(res, 'Failed to save rules'));
    } catch (err) {
      if (projectScopeIsCurrent(scope)) {
        failSource('rules', err instanceof Error ? err.message : 'Failed to save rules');
      }
      return false;
    } finally {
      if (projectScopeIsCurrent(scope)) state.isLoading = false;
    }
  }

  async function initializeRules(): Promise<void> {
    const scope = captureProjectScope();
    try {
      const res = await apiFetch(apiUrl('/api/memory/rules/init'), { method: 'POST' });

      if (res.ok) {
        const data = await res.json();
        if (data.ok && projectScopeIsCurrent(scope)) {
          state.rules = data.data;
          toastStore.success('Rules initialized with template');
        }
      }
    } catch (err) {
      if (projectScopeIsCurrent(scope)) toastStore.error('Failed to initialize rules');
    }
  }

  // ========================================================================
  // Settings
  // ========================================================================

  async function loadSettings(): Promise<void> {
    const scope = captureProjectScope();
    const source: MemorySourceKey = 'settings';
    const requestId = startSourceRequest(source);
    try {
      const res = await apiFetch(apiUrl('/api/memory/settings'));

      if (res.ok) {
        const data = await res.json();
        if (data.ok && projectScopeIsCurrent(scope) && sourceRequestIsCurrent(source, requestId)) {
          state.settings = { ...DEFAULT_SETTINGS, ...data.data } as MemorySettings;
          clearSourceError(source);
        }
      } else {
        throw new Error(await responseMessage(res, 'Failed to load memory settings'));
      }
    } catch (err) {
      if (!projectScopeIsCurrent(scope) || !sourceRequestIsCurrent(source, requestId)) return;
      console.error('Failed to load memory settings:', err);
      state.settings ??= { ...DEFAULT_SETTINGS };
      failSource(
        source,
        err instanceof Error ? err.message : 'Failed to load memory settings',
        false,
      );
    } finally {
      finishSourceRequest(source, requestId);
    }
  }

  async function saveSettings(settings: Partial<MemorySettings>): Promise<boolean> {
    const scope = captureProjectScope();
    const pendingSettings = settings;
    const previousSettings = state.settings ?? DEFAULT_SETTINGS;
    const revision = ++settingsSaveRevision;

    state.settings = { ...previousSettings, ...pendingSettings };

    const persist = async (): Promise<boolean> => {
      try {
        const res = await apiFetch(apiUrl('/api/memory/settings'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pendingSettings),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.ok) {
            if (revision === settingsSaveRevision && projectScopeIsCurrent(scope)) {
              state.settings = { ...state.settings, ...data.data } as MemorySettings;
            }
            if (projectScopeIsCurrent(scope)) toastStore.success('Memory settings saved');
            return true;
          }
        }
        throw new Error(await responseMessage(res, 'Failed to save memory settings'));
      } catch (err) {
        if (revision === settingsSaveRevision && projectScopeIsCurrent(scope)) {
          state.settings = previousSettings;
        }
        if (projectScopeIsCurrent(scope)) {
          failSource(
            'settings',
            err instanceof Error ? err.message : 'Failed to save memory settings',
          );
        }
        return false;
      }
    };
    const operation = settingsSaveQueue.then(persist, persist);
    settingsSaveQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async function resetSettings(): Promise<boolean> {
    const scope = captureProjectScope();
    try {
      const res = await apiFetch(apiUrl('/api/memory/settings/reset'), { method: 'POST' });

      if (res.ok && projectScopeIsCurrent(scope)) {
        const data = await res.json();
        if (data.ok) {
          state.settings = data.data;
          clearSourceError('settings');
          toastStore.success('Memory settings reset to defaults');
          return true;
        }
      }
      if (projectScopeIsCurrent(scope)) {
        failSource('settings', await responseMessage(res, 'Failed to reset memory settings'));
      }
      return false;
    } catch (err) {
      if (projectScopeIsCurrent(scope)) {
        failSource(
          'settings',
          err instanceof Error ? err.message : 'Failed to reset memory settings',
        );
      }
      return false;
    }
  }

  // ========================================================================
  // Bulk Operations
  // ========================================================================

  async function loadAllMemory(_sessionId?: string): Promise<void> {
    const scope = captureProjectScope();
    state.isLoading = true;
    try {
      // Load only the default visible document plus the small workspace index.
      // Other sources are fetched when their row is opened.
      await Promise.all([loadProjectMemory(), loadSettings(), loadDocuments()]);
    } finally {
      if (projectScopeIsCurrent(scope)) state.isLoading = false;
    }
  }

  async function loadBuiltIn(
    source: 'universal' | 'project' | 'session' | 'rules',
    sessionId?: string | null,
  ): Promise<void> {
    if (source === 'universal') await loadUniversalMemory();
    else if (source === 'project') await loadProjectMemory();
    else if (source === 'rules') await loadRules();
    else if (sessionId) await loadSessionMemory(sessionId);
  }

  function setActiveTab(tab: MemoryState['activeTab']): void {
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
    get universal() {
      return state.universal;
    },
    get project() {
      return state.project;
    },
    get session() {
      return state.session;
    },
    get rules() {
      return state.rules;
    },
    get settings() {
      return state.settings;
    },
    get isLoading() {
      return state.isLoading;
    },
    get activeTab() {
      return state.activeTab;
    },
    get documents() {
      return documents;
    },
    get error() {
      return state.error;
    },
    get conflict() {
      return conflict;
    },
    errorFor(source: MemorySourceKey) {
      return sourceErrors[source] ?? null;
    },
    isLoadingSource(source: MemorySourceKey) {
      return sourceLoading[source] ?? false;
    },

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
    loadBuiltIn,
    beginProjectTransition,
    setActiveTab,
    loadDocuments,
    createDocument,
    loadDocument,
    saveDocument,
    clearError,
    clearConflict() {
      conflict = null;
    },
  };
}

export const memoryStore = createMemoryStore();
