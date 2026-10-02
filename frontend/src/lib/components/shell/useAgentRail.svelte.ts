import { wsStore } from '$lib/stores/websocket.svelte';
import { agentStore } from '$lib/stores/agents.svelte';
import { sessionStore } from '$lib/stores/sessions.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { ACTIVE_AGENT_STATUSES, TERMINAL_AGENT_STATUSES } from '$lib/stores/run-state-core';
import { apiUrl } from '$lib/utils/api-url';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';

export function useAgentRail() {
  let selectedAgentId = $state('');
  let closingAgentIds = $state(new Set<string>());

  let sessionAgentChats = $derived(
    [...wsStore.agents.values()]
      .filter(
        (a) =>
          a.sessionId === sessionStore.activeSessionId &&
          a.identity.id !== 'kory-manager' &&
          a.identity.role !== 'manager',
      )
      .sort((a, b) => {
        const activeWeight = (status: typeof a.status) =>
          status !== 'done' && status !== 'idle' ? 1 : 0;
        return activeWeight(b.status) - activeWeight(a.status);
      }),
  );

  let selectedAgent = $derived(
    selectedAgentId ? (wsStore.agents.get(selectedAgentId) ?? null) : null,
  );

  let selectedAgentFeed = $derived.by(() => {
    const _version = wsStore.agentThreadVersion;
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId || !selectedAgentId) return [];
    return wsStore.getAgentThreadFeed(sessionId, selectedAgentId);
  });

  // Agent-scoped running predicate using the canonical ACTIVE_AGENT_STATUSES
  // set from the run-state reducer — one definition, no drift. The session-
  // level runStateStore.isRunning answers "is the manager loop alive?" and
  // stays true while the manager synthesizes results AFTER a worker finishes.
  // Using it here made the AgentThreadFeed composer show Stop for a completed
  // worker while its WorkerCard showed it as inactive. This predicate answers
  // "is THIS agent still producing?" from the agent's own status.
  // Note: waiting/waiting_user are NOT active — a parked worker shows Send,
  // not Stop, matching the session-level Waiting behavior.
  let selectedAgentIsRunning = $derived(
    !!selectedAgent && ACTIVE_AGENT_STATUSES.has(selectedAgent.status),
  );

  let inputPlaceholder = $derived(
    selectedAgent ? `Steer ${selectedAgent.identity.name} directly…` : "What's the move?",
  );

  let lastLoadedAgentThreadKey = $state('');

  $effect(() => {
    const activeId = sessionStore.activeSessionId;
    const selectedId = selectedAgentId;
    if (!activeId || !selectedId) return;
    const key = `${activeId}:${selectedId}`;
    if (key === lastLoadedAgentThreadKey) return;
    lastLoadedAgentThreadKey = key;
    void wsStore.loadAgentThreadMessages(activeId, selectedId);
  });

  $effect(() => {
    if (!selectedAgentId) return;
    const activeId = sessionStore.activeSessionId;
    const exists = sessionAgentChats.some((agent) => agent.identity.id === selectedAgentId);
    if (!activeId || !exists) {
      selectedAgentId = '';
    }
  });

  function clearSelection() {
    selectedAgentId = '';
  }

  function selectAgent(agentId: string) {
    selectedAgentId = agentId;
    if (sessionStore.activeSessionId) {
      void wsStore.loadAgentThreadMessages(sessionStore.activeSessionId, agentId);
    }
  }

  /**
   * Close a sub-agent card. A still-running worker is cancelled on the backend
   * first so the process actually stops; a finished one is only a view concern
   * and closes locally. Either way the card is removed from the rail and, if it
   * was the open transcript, the feed returns to the manager.
   *
   * A failed cancel keeps the card and reports the error — dropping a card
   * whose worker is still running would hide live work from the user.
   */
  async function closeAgent(agentId: string): Promise<void> {
    if (closingAgentIds.has(agentId)) return;
    const agent = wsStore.agents.get(agentId);
    if (!agent) return;

    const isRunning = !TERMINAL_AGENT_STATUSES.has(agent.status);
    closingAgentIds = new Set(closingAgentIds).add(agentId);
    if (isRunning) {
      try {
        const res = await apiFetch(apiUrl(`/api/agent/${encodeURIComponent(agentId)}/cancel`), {
          method: 'POST',
        });
        const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
        if (!res.ok || data?.ok === false) {
          throw new Error(data?.error || `Request failed: ${res.status} ${res.statusText}`);
        }
      } catch (error) {
        closingAgentIds = new Set([...closingAgentIds].filter((id) => id !== agentId));
        toastStore.error(
          error instanceof Error && error.message
            ? `Could not stop ${agent.identity.name}: ${error.message}`
            : `Could not stop ${agent.identity.name}.`,
        );
        return;
      }
    }

    wsStore.markAgentStopped(agentId);
    agentStore.removeAgent(agentId);
    if (selectedAgentId === agentId) clearSelection();
    closingAgentIds = new Set([...closingAgentIds].filter((id) => id !== agentId));
  }

  return {
    get selectedAgentId() {
      return selectedAgentId;
    },
    set selectedAgentId(value: string) {
      selectedAgentId = value;
    },
    get sessionAgentChats() {
      return sessionAgentChats;
    },
    get selectedAgent() {
      return selectedAgent;
    },
    get selectedAgentFeed() {
      return selectedAgentFeed;
    },
    get selectedAgentIsRunning() {
      return selectedAgentIsRunning;
    },
    get closingAgentIds() {
      return closingAgentIds;
    },
    get inputPlaceholder() {
      return inputPlaceholder;
    },
    clearSelection,
    selectAgent,
    closeAgent,
  };
}

export type AgentRailState = ReturnType<typeof useAgentRail>;
