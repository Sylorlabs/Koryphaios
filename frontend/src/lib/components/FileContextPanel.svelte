<script lang="ts">
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { FileText, FolderOpen, Edit3, Eye } from 'lucide-svelte';
  import FileIcon from './icons/FileIcon.svelte';

  interface FileContext {
    path: string;
    type: 'read' | 'write';
    timestamp: number;
    agentId: string;
    agentName: string;
  }

  let files = $derived.by(() => {
    const fileMap = new Map<string, FileContext>();

    for (const entry of wsStore.feed) {
      if (entry.type === 'tool_result' || entry.type === 'tool_call') {
        const toolCall = entry.metadata?.toolCall as { name?: string; input?: Record<string, unknown> } | undefined;
        const toolResult = entry.metadata?.toolResult as { input?: Record<string, unknown> } | undefined;

        let filePath: string | undefined;
        let fileType: 'read' | 'write' = 'read';

        if (!toolCall) continue;

        const toolName = toolCall.name || '';

        if (toolName === 'read_file' || toolName === 'grep' || toolName === 'ls') {
          fileType = 'read';
          filePath = (toolCall.input?.path as string) || (toolResult?.input?.path as string);
        } else if (toolName === 'write_file' || toolName === 'edit_file') {
          fileType = 'write';
          filePath = (toolCall.input?.path as string) || (toolResult?.input?.path as string);
        }

        if (filePath) {
          if (!fileMap.has(filePath)) {
            fileMap.set(filePath, {
              path: filePath,
              type: fileType,
              timestamp: entry.timestamp,
              agentId: entry.agentId,
              agentName: entry.agentName,
            });
          } else {
            const existing = fileMap.get(filePath)!;
            if (fileType === 'write') {
              existing.type = 'write';
            }
            existing.timestamp = entry.timestamp;
          }
        }
      }
    }

    return Array.from(fileMap.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 15);
  });

  function getFileName(path: string): string {
    return path.split('/').pop() || path;
  }

  function getDirName(path: string): string {
    const parts = path.split('/');
    parts.pop();
    return parts.join('/') || '.';
  }
</script>

<div class="h-full flex flex-col">
  <div class="panel-header">
    <span class="panel-title">
      <FolderOpen size={14} />
      Active Files
    </span>
    <span class="text-[10px] text-text-muted">{files.length}</span>
  </div>

  {#if files.length === 0}
    <div class="empty-state">
      <FileText size={32} class="empty-state-icon" />
      <p class="text-xs">No files accessed yet</p>
      <p class="text-[10px] mt-1">Files agents read or write will appear here</p>
    </div>
  {:else}
    <div class="flex-1 overflow-y-auto p-2 space-y-1">
      {#each files as file (file.path)}
        <div class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-3 transition-colors group">
          <FileIcon path={file.path} size={14} />
          <div class="flex-1 min-w-0">
            <div class="text-xs text-text-primary truncate font-mono">
              {getFileName(file.path)}
            </div>
            <div class="text-[10px] text-text-muted truncate">
              {getDirName(file.path)}
            </div>
          </div>
          <span class="file-badge {file.type === 'read' ? 'read' : 'modified'}">
            {file.type}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>
