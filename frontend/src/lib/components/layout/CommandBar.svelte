<script lang="ts">
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { modeStore } from '$lib/stores/mode.svelte';
  import type { RecentProject } from '$lib/utils/projectManager';
  import MenuBar from '$lib/components/MenuBar.svelte';

  interface Agent {
    identity: { id: string };
    status: string;
    sessionId: string;
  }

  interface Props {
    showSidebar: boolean;
    showGit: boolean;
    showAgents: boolean;
    zenMode: boolean;
    projectName: string;
    recentProjects: RecentProject[];
    onAction: (action: string) => void;
  }

  let { 
    showSidebar, 
    showGit, 
    showAgents, 
    zenMode, 
    projectName, 
    recentProjects,
    onAction 
  }: Props = $props();

  let activeAgents = $derived([...wsStore.agents.values()].filter((a: Agent) => 
    a.sessionId && a.status !== 'done' && a.status !== 'idle'
  ));
</script>

<MenuBar
  {showSidebar}
  {showGit}
  {showAgents}
  {zenMode}
  {projectName}
  koryPhase={wsStore.koryPhase}
  isYoloMode={wsStore.isYoloMode}
  {activeAgents}
  {recentProjects}
  {onAction}
/>
