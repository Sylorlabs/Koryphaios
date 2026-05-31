<script lang="ts">
  import { processStore } from "$lib/stores/processes.svelte";
  import { onMount, onDestroy } from "svelte";
  import { 
    Play, 
    Square, 
    RefreshCw, 
    Trash2, 
    Terminal, 
    Activity,
    Search,
    Filter,
    Clock,
    AlertCircle,
    CheckCircle2,
    XCircle,
    PauseCircle,
    Zap
  } from "lucide-svelte";

  // Load processes on mount
  onMount(() => {
    void processStore.loadProcesses();
    processStore.startAutoRefresh(3000);
  });

  onDestroy(() => {
    processStore.stopAutoRefresh();
  });

  // Status filter options
  const statusFilters = [
    { value: "all", label: "All", color: "var(--color-text-muted)" },
    { value: "running", label: "Running", color: "#22c55e" },
    { value: "starting", label: "Starting", color: "#3b82f6" },
    { value: "exited", label: "Exited", color: "#6b7280" },
    { value: "crashed", label: "Crashed", color: "#ef4444" },
    { value: "killed", label: "Killed", color: "#f59e0b" },
  ];

  // Format timestamp
  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString();
  }

  function formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString();
  }

  // Truncate command for display
  function truncateCommand(cmd: string, maxLen = 60): string {
    if (cmd.length <= maxLen) return cmd;
    return cmd.slice(0, maxLen) + "...";
  }

  let showLogsModal = $state(false);
  let logsViewMode = $state<"stdout" | "stderr" | "events">("stdout");
</script>

<div class="space-y-4">
  <!-- Stats Bar -->
  <div class="grid grid-cols-4 gap-2">
    <div class="p-3 rounded-lg" style="background: var(--color-surface-0); border: 1px solid var(--color-border);">
      <div class="flex items-center gap-2">
        <Activity size={14} style="color: #22c55e;" />
        <span class="text-[10px]" style="color: var(--color-text-muted);">Active</span>
      </div>
      <p class="text-xl font-semibold mt-1" style="color: var(--color-text-primary);">{processStore.activeCount}</p>
    </div>
    <div class="p-3 rounded-lg" style="background: var(--color-surface-0); border: 1px solid var(--color-border);">
      <div class="flex items-center gap-2">
        <AlertCircle size={14} style="color: #ef4444;" />
        <span class="text-[10px]" style="color: var(--color-text-muted);">Crashed</span>
      </div>
      <p class="text-xl font-semibold mt-1" style="color: var(--color-text-primary);">{processStore.crashedCount}</p>
    </div>
    <div class="p-3 rounded-lg" style="background: var(--color-surface-0); border: 1px solid var(--color-border);">
      <div class="flex items-center gap-2">
        <Terminal size={14} style="color: var(--color-text-muted);" />
        <span class="text-[10px]" style="color: var(--color-text-muted);">Total</span>
      </div>
      <p class="text-xl font-semibold mt-1" style="color: var(--color-text-primary);">{processStore.processes.length}</p>
    </div>
    <div class="p-3 rounded-lg" style="background: var(--color-surface-0); border: 1px solid var(--color-border);">
      <div class="flex items-center gap-2">
        <RefreshCw size={14} class={processStore.autoRefresh ? "animate-spin" : ""} style="color: var(--color-text-muted);" />
        <span class="text-[10px]" style="color: var(--color-text-muted);">Auto-refresh</span>
      </div>
      <button
        class="text-xs mt-1 px-2 py-0.5 rounded transition-colors"
        style="background: {processStore.autoRefresh ? 'rgba(34, 197, 94, 0.2)' : 'var(--color-surface-2)'}; 
               color: {processStore.autoRefresh ? '#22c55e' : 'var(--color-text-muted)'};"
        onclick={() => processStore.autoRefresh ? processStore.stopAutoRefresh() : processStore.startAutoRefresh()}
      >
        {processStore.autoRefresh ? 'ON' : 'OFF'}
      </button>
    </div>
  </div>

  <!-- Toolbar -->
  <div class="flex flex-wrap gap-2 items-center">
    <!-- Search -->
    <div class="relative flex-1 min-w-[200px]">
      <Search size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style="color: var(--color-text-muted);" />
      <input
        type="text"
        placeholder="Search processes..."
        value={processStore.searchQuery}
        oninput={(e) => processStore.setSearchQuery(e.currentTarget.value)}
        class="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border"
        style="background: var(--color-surface-0); border-color: var(--color-border); color: var(--color-text-primary);"
      />
    </div>

    <!-- Status Filter -->
    <div class="flex items-center gap-1 p-1 rounded-lg" style="background: var(--color-surface-0);">
      <Filter size={12} class="ml-1" style="color: var(--color-text-muted);" />
      {#each statusFilters as filter}
        <button
          class="px-2 py-1 text-[10px] rounded transition-colors"
          style="background: {processStore.filterStatus === filter.value ? 'var(--color-surface-3)' : 'transparent'};
                 color: {processStore.filterStatus === filter.value ? filter.color : 'var(--color-text-muted)'};"
          onclick={() => processStore.setFilterStatus(filter.value)}
        >
          {filter.label}
        </button>
      {/each}
    </div>

    <!-- Actions -->
    <button
      class="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg transition-colors hover:opacity-80"
      style="background: var(--color-surface-0); color: var(--color-text-muted); border: 1px solid var(--color-border);"
      onclick={() => processStore.loadProcesses()}
    >
      <RefreshCw size={12} />
      Refresh
    </button>
    <button
      class="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg transition-colors hover:opacity-80"
      style="background: var(--color-surface-0); color: var(--color-text-muted); border: 1px solid var(--color-border);"
      onclick={() => processStore.cleanupOldProcesses(7)}
    >
      <Trash2 size={12} />
      Cleanup
    </button>
  </div>

  <!-- Process List -->
  <div class="space-y-1 max-h-[400px] overflow-y-auto">
    {#if processStore.isLoading && processStore.processes.length === 0}
      <div class="flex items-center justify-center py-8">
        <RefreshCw size={20} class="animate-spin" style="color: var(--color-text-muted);" />
      </div>
    {:else if processStore.filteredProcesses.length === 0}
      <div class="text-center py-8" style="color: var(--color-text-muted);">
        <Terminal size={32} class="mx-auto mb-2 opacity-50" />
        <p class="text-sm">No processes found</p>
        <p class="text-[11px] mt-1">
          {processStore.processes.length === 0 
            ? "Background processes will appear here when started" 
            : "Try adjusting your filters"}
        </p>
      </div>
    {:else}
      {#each processStore.filteredProcesses as proc (proc.id)}
        {@const isSelected = processStore.selectedProcess?.id === proc.id}
        {@const statusColor = processStore.getStatusColor(proc.status)}
        <div
          class="p-3 rounded-lg cursor-pointer transition-colors"
          style="background: {isSelected ? 'var(--color-surface-3)' : 'var(--color-surface-0)'}; 
                 border: 1px solid {isSelected ? 'var(--color-accent)' : 'var(--color-border)'};"
          onclick={() => {
            processStore.selectProcess(proc);
            showLogsModal = true;
          }}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { processStore.selectProcess(proc); showLogsModal = true; }}}
          role="button"
          tabindex="0"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span 
                  class="w-2 h-2 rounded-full"
                  style="background: {statusColor};"
                ></span>
                <span class="text-xs font-medium truncate" style="color: var(--color-text-primary);">
                  {proc.name}
                </span>
                <span class="text-[9px] px-1.5 py-0.5 rounded-full" style="background: var(--color-surface-2); color: var(--color-text-muted);">
                  PID: {proc.pid}
                </span>
              </div>
              <p class="text-[10px] mt-1 font-mono truncate" style="color: var(--color-text-muted);">
                {truncateCommand(proc.command)}
              </p>
              <div class="flex items-center gap-3 mt-2 text-[9px]" style="color: var(--color-text-muted);">
                <span class="flex items-center gap-1">
                  <Clock size={10} />
                  {formatTime(proc.createdAt)}
                </span>
                {#if proc.restartCount > 0}
                  <span class="flex items-center gap-1" style="color: #f59e0b;">
                    <RefreshCw size={10} />
                    {proc.restartCount} restarts
                  </span>
                {/if}
                {#if proc.status === "running" && proc.health}
                  <span class="flex items-center gap-1" style="color: {proc.health.isHealthy ? '#22c55e' : '#ef4444'};">
                    <Activity size={10} />
                    {proc.health.isHealthy ? 'Healthy' : `${proc.health.consecutiveFailures} failures`}
                  </span>
                {/if}
              </div>
            </div>
            <div class="flex items-center gap-1">
              {#if proc.status === "running"}
                <button
                  class="p-1.5 rounded-md transition-colors hover:bg-red-500/20"
                  style="color: #ef4444;"
                  onclick={(e) => {
                    e.stopPropagation();
                    processStore.killProcess(proc.id);
                  }}
                  title="Kill"
                >
                  <Square size={14} />
                </button>
                <button
                  class="p-1.5 rounded-md transition-colors hover:bg-blue-500/20"
                  style="color: #3b82f6;"
                  onclick={(e) => {
                    e.stopPropagation();
                    processStore.restartProcess(proc.id);
                  }}
                  title="Restart"
                >
                  <RefreshCw size={14} />
                </button>
              {:else}
                <button
                  class="p-1.5 rounded-md transition-colors hover:bg-green-500/20"
                  style="color: #22c55e;"
                  onclick={(e) => {
                    e.stopPropagation();
                    processStore.restartProcess(proc.id);
                  }}
                  title="Start"
                >
                  <Play size={14} />
                </button>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<!-- Logs Modal -->
{#if showLogsModal && processStore.selectedProcess}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <button
      type="button"
      class="absolute inset-0 bg-black/60 backdrop-blur-sm"
      aria-label="Close process logs"
      onclick={() => showLogsModal = false}
    ></button>
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="process-logs-title"
      class="relative w-full max-w-4xl max-h-[80vh] rounded-xl shadow-2xl flex flex-col overflow-hidden"
      style="background: var(--color-surface-1); border: 1px solid var(--color-border);"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-3 border-b" style="border-color: var(--color-border);">
        <div>
          <h3 id="process-logs-title" class="text-sm font-medium" style="color: var(--color-text-primary);">
            {processStore.selectedProcess.name}
          </h3>
          <p class="text-[10px]" style="color: var(--color-text-muted);">
            PID: {processStore.selectedProcess.pid} • 
            Started: {formatDate(processStore.selectedProcess.createdAt)} {formatTime(processStore.selectedProcess.createdAt)}
          </p>
        </div>
        <div class="flex items-center gap-2">
          {#if processStore.selectedProcess.status === "running"}
            <button
              class="flex items-center gap-1 px-3 py-1.5 text-xs rounded-md transition-colors hover:opacity-80"
              style="background: rgba(239, 68, 68, 0.2); color: #ef4444;"
              onclick={() => processStore.killProcess(processStore.selectedProcess!.id)}
            >
              <Square size={12} />
              Kill
            </button>
            <button
              class="flex items-center gap-1 px-3 py-1.5 text-xs rounded-md transition-colors hover:opacity-80"
              style="background: rgba(59, 130, 246, 0.2); color: #3b82f6;"
              onclick={() => processStore.restartProcess(processStore.selectedProcess!.id)}
            >
              <RefreshCw size={12} />
              Restart
            </button>
          {:else}
            <button
              class="flex items-center gap-1 px-3 py-1.5 text-xs rounded-md transition-colors hover:opacity-80"
              style="background: rgba(34, 197, 94, 0.2); color: #22c55e;"
              onclick={() => processStore.restartProcess(processStore.selectedProcess!.id)}
            >
              <Play size={12} />
              Start
            </button>
          {/if}
          <button
            class="p-1.5 rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: var(--color-text-muted);"
            onclick={() => showLogsModal = false}
          >
            <XCircle size={18} />
          </button>
        </div>
      </div>

      <!-- Tabs -->
      <div class="flex border-b" style="border-color: var(--color-border);">
        <button
          class="flex-1 py-2 text-xs font-medium transition-colors border-b-2"
          style="border-color: {logsViewMode === 'stdout' ? 'var(--color-accent)' : 'transparent'};
                 color: {logsViewMode === 'stdout' ? 'var(--color-text-primary)' : 'var(--color-text-muted)'};"
          onclick={() => logsViewMode = "stdout"}
        >
          <span class="flex items-center justify-center gap-1">
            <CheckCircle2 size={12} />
            stdout
            {#if processStore.processLogs}
              <span class="text-[9px] px-1 rounded" style="background: var(--color-surface-2);">
                {processStore.processLogs.stdoutLineCount}
              </span>
            {/if}
          </span>
        </button>
        <button
          class="flex-1 py-2 text-xs font-medium transition-colors border-b-2"
          style="border-color: {logsViewMode === 'stderr' ? '#ef4444' : 'transparent'};
                 color: {logsViewMode === 'stderr' ? '#ef4444' : 'var(--color-text-muted)'};"
          onclick={() => logsViewMode = "stderr"}
        >
          <span class="flex items-center justify-center gap-1">
            <AlertCircle size={12} />
            stderr
            {#if processStore.processLogs}
              <span class="text-[9px] px-1 rounded" style="background: var(--color-surface-2);">
                {processStore.processLogs.stderrLineCount}
              </span>
            {/if}
          </span>
        </button>
        <button
          class="flex-1 py-2 text-xs font-medium transition-colors border-b-2"
          style="border-color: {logsViewMode === 'events' ? 'var(--color-accent)' : 'transparent'};
                 color: {logsViewMode === 'events' ? 'var(--color-text-primary)' : 'var(--color-text-muted)'};"
          onclick={() => logsViewMode = "events"}
        >
          <span class="flex items-center justify-center gap-1">
            <Zap size={12} />
            Events
            {#if processStore.processEvents.length > 0}
              <span class="text-[9px] px-1 rounded" style="background: var(--color-surface-2);">
                {processStore.processEvents.length}
              </span>
            {/if}
          </span>
        </button>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-auto p-4 font-mono text-xs" style="background: var(--color-surface-0);">
        {#if logsViewMode === "stdout"}
          {#if processStore.isLogsLoading}
            <div class="flex items-center justify-center py-8">
              <RefreshCw size={20} class="animate-spin" style="color: var(--color-text-muted);" />
            </div>
          {:else if processStore.processLogs?.stdout}
            <pre style="color: var(--color-text-secondary); white-space: pre-wrap; word-break: break-word;">
{processStore.processLogs.stdout}</pre>
          {:else}
            <p class="text-center py-8" style="color: var(--color-text-muted);">No stdout output</p>
          {/if}
        {:else if logsViewMode === "stderr"}
          {#if processStore.isLogsLoading}
            <div class="flex items-center justify-center py-8">
              <RefreshCw size={20} class="animate-spin" style="color: var(--color-text-muted);" />
            </div>
          {:else if processStore.processLogs?.stderr}
            <pre style="color: #ef4444; white-space: pre-wrap; word-break: break-word;">
{processStore.processLogs.stderr}</pre>
          {:else}
            <p class="text-center py-8" style="color: var(--color-text-muted);">No stderr output</p>
          {/if}
        {:else}
          {#if processStore.processEvents.length === 0}
            <p class="text-center py-8" style="color: var(--color-text-muted);">No events recorded</p>
          {:else}
            <div class="space-y-2">
              {#each processStore.processEvents as event}
                <div class="flex gap-3 text-[10px]">
                  <span class="shrink-0" style="color: var(--color-text-muted);">
                    {formatTime(event.timestamp)}
                  </span>
                  <span class="shrink-0 px-1.5 py-0.5 rounded" style="background: var(--color-surface-2); color: var(--color-text-muted);">
                    {event.eventType}
                  </span>
                  {#if event.eventData}
                    <span style="color: var(--color-text-secondary);">
                      {JSON.stringify(event.eventData)}
                    </span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </div>

      <!-- Footer -->
      <div class="flex items-center justify-between px-4 py-2 border-t text-[10px]" style="border-color: var(--color-border); color: var(--color-text-muted);">
        <span>
          Status: <span style="color: {processStore.getStatusColor(processStore.selectedProcess.status)};">{processStore.selectedProcess.status}</span>
          {#if processStore.selectedProcess.exitCode !== undefined}
            • Exit Code: {processStore.selectedProcess.exitCode}
          {/if}
        </span>
        <span>
          Restarts: {processStore.selectedProcess.restartCount}/{processStore.selectedProcess.maxRestarts}
          • Policy: {processStore.selectedProcess.restartPolicy}
        </span>
      </div>
    </div>
  </div>
{/if}
