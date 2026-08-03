import { wsStore } from '$lib/stores/websocket.svelte';
import { sessionStore } from '$lib/stores/sessions.svelte';

export function useAgentRail() {
  let selectedAgentId = $state('');

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

  let managerAgent = $derived(wsStore.agents.get('kory-manager') ?? null);

  // Agent ids are global, while the rail is session-scoped.  A chat switch
  // schedules selection cleanup, but this derived guard is deliberately
  // synchronous: for the render between the switch and that cleanup, an old
  // worker must never lend its Stop state or controls to the new chat.
  let selectedAgent = $derived.by(() => {
    if (!selectedAgentId) return null;
    const agent = wsStore.agents.get(selectedAgentId) ?? null;
    return agent?.sessionId === sessionStore.activeSessionId ? agent : null;
  });

  let selectedAgentFeed = $derived.by(() => {
    const _version = wsStore.agentThreadVersion;
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId || !selectedAgentId) return [];
    return wsStore.getAgentThreadFeed(sessionId, selectedAgentId);
  });

  let selectedAgentIsRunning = $derived(
    !!selectedAgent && !['done', 'idle', 'error'].includes(selectedAgent.status),
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
    get managerAgent() {
      return managerAgent;
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
    get inputPlaceholder() {
      return inputPlaceholder;
    },
    clearSelection,
    selectAgent,
  };
}

export type AgentRailState = ReturnType<typeof useAgentRail>;
