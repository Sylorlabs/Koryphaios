<script lang="ts">
  import { onMount } from 'svelte';
  import { Send, ChevronDown, Sparkles, Square, Users, User, ShieldCheck, ShieldAlert, Circle, Paperclip, Clipboard, X } from 'lucide-svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { shortcutStore } from '$lib/stores/shortcuts.svelte';
  import { experimentalStore } from '$lib/stores/experimental.svelte';
  import { agentSettingsStore } from '$lib/stores/agent-settings.svelte';
  import { getReasoningConfig, hasReasoningSupport } from '@koryphaios/shared';
  import BrainIcon from '$lib/components/icons/BrainIcon.svelte';
  import { getModelConfigurationWarning } from '$lib/utils/model-config';
  import { invoke } from '@tauri-apps/api/core';
  import { toastStore } from '$lib/stores/toast.svelte';

  export type Attachment = { type: 'image' | 'file'; data: string; name: string };

  interface Props {
    onSend: (message: string, model?: string, reasoningLevel?: string, attachments?: Attachment[]) => void;
    onExecuteCommand?: (command: string) => Promise<boolean> | boolean;
    /** When true, show Stop instead of Send; clicking stops manager and workers for the session. */
    isRunning?: boolean;
    onStop?: () => void;
    onOpenSettings?: () => void;
    inputRef?: HTMLTextAreaElement;
    value?: string;
    slashCommands?: Array<{ command: string; label: string; description: string }>;
    fileMentions?: string[];
    /** When true, disables input because no project is open */
    disabled?: boolean;
    disabledMessage?: string;
    placeholder?: string;
  }

  let {
    onSend,
    onExecuteCommand,
    isRunning = false,
    onStop,
    onOpenSettings,
    inputRef = $bindable(),
    value = $bindable(''),
    slashCommands = [],
    fileMentions = [],
    disabled = false,
    disabledMessage = 'Open a project to start chatting',
    placeholder = 'Ask Koryphaios to inspect, explain, or change this project...',
  }: Props = $props();
  let actionPanelRef = $state<HTMLDivElement>();
  let showModelPicker = $state(false);
  let selectedModel = $state<string>('auto');
  let selectedPickerIndex = $state(0);
  let attachments = $state<Attachment[]>([]);
  let fileInputRef = $state<HTMLInputElement>();

  type ComposerPickerItem =
    | { type: 'command'; key: string; label: string; value: string; description: string }
    | { type: 'file'; key: string; label: string; value: string; description: string };

  function providerLabel(provider: string): string {
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'codex') return 'Codex';
    if (provider === 'anthropic') return 'Anthropic';
    if (provider === 'google') return 'Google';
    if (provider === 'xai') return 'xAI';
    if (provider === 'openrouter') return 'OpenRouter';
    if (provider === 'vertexai') return 'Vertex AI';
    if (provider === 'copilot') return 'Copilot';
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
  
  // Reasoning state - now tracks provider AND model
  let reasoningLevel = $state('medium');
  let showReasoningMenu = $state(false);

  function parseModelSelection(value: string): { provider?: string; model?: string } {
    if (value === 'auto') return {};
    const separator = value.indexOf(':');
    if (separator === -1) return {};
    return {
      provider: value.slice(0, separator),
      model: value.slice(separator + 1),
    };
  }

  let fallbackProvider = $derived.by(() => {
    const preferred = wsStore.providers.find((p) => p.enabled && p.authenticated);
    return preferred?.name ?? 'anthropic';
  });

  // Extract provider and model from selection. In auto mode, use 'auto' provider for specific reasoning config.
  let currentProvider = $derived(selectedModel === 'auto' ? 'auto' : (parseModelSelection(selectedModel).provider ?? fallbackProvider));
  let currentModel = $derived(parseModelSelection(selectedModel).model);

  // Get reasoning config based on provider + model
  let reasoningConfig = $derived(getReasoningConfig(currentProvider, currentModel));
  let reasoningSupported = $derived(selectedModel === 'auto' || hasReasoningSupport(currentProvider, currentModel));

  const configurationWarning = $derived(
    disabled ? null : getModelConfigurationWarning(wsStore.providers, selectedModel),
  );

  let availableModels = $derived.by(() => {
    const models: Array<{ label: string; value: string; provider: string; isAuto?: boolean }> = [
      { label: 'Auto (Smart Selection)', value: 'auto', provider: '', isAuto: true },
    ];
    for (const p of wsStore.providers) {
      if (p.authenticated) {
        for (const m of p.models) {
          models.push({ label: `(${providerLabel(p.name)}) ${m}`, value: `${p.name}:${m}`, provider: p.name });
        }
      }
    }
    return models;
  });

  let selectedModelLabel = $derived.by(() => {
    if (selectedModel === 'auto') return 'Auto';
    const parsed = parseModelSelection(selectedModel);
    if (!parsed.model || !parsed.provider) return selectedModel;
    return `(${providerLabel(parsed.provider)}) ${parsed.model}`;
  });

  // Cooldown to prevent duplicate sends (double Enter, key repeat, double-click)
  const SEND_COOLDOWN_MS = 800;
  let lastSendAt = $state(0);

  function getCaretPosition(): number {
    return inputRef?.selectionStart ?? value.length;
  }

  function getTriggerContext() {
    const caret = getCaretPosition();
    const beforeCaret = value.slice(0, caret);
    const match = beforeCaret.match(/(?:^|\s)([/@])([^\s/]*)$/);
    if (!match || match.index == null) return null;
    const trigger = match[1] as '/' | '@';
    const query = match[2] ?? '';
    const start = match.index + (match[0].startsWith(' ') ? 1 : 0);
    return { trigger, query, start, end: caret };
  }

  let triggerContext = $derived(getTriggerContext());
  let pickerItems = $derived.by<ComposerPickerItem[]>(() => {
    const ctx = triggerContext;
    if (!ctx) return [];
    const query = ctx.query.trim().toLowerCase();

    if (ctx.trigger === '/') {
      return slashCommands
        .filter((item) => !query || item.command.toLowerCase().includes(query) || item.label.toLowerCase().includes(query))
        .slice(0, 8)
        .map((item) => ({
          type: 'command' as const,
          key: item.command,
          label: item.label,
          value: item.command,
          description: item.description,
        }));
    }

    return fileMentions
      .filter((path) => !query || path.toLowerCase().includes(query))
      .slice(0, 8)
      .map((path) => ({
        type: 'file' as const,
        key: path,
        label: path.split('/').pop() || path,
        value: path,
        description: path,
      }));
  });
  let pickerOpen = $derived(pickerItems.length > 0 && !!triggerContext);

  $effect(() => {
    pickerItems;
    selectedPickerIndex = 0;
  });

  function replaceRange(start: number, end: number, nextText: string) {
    value = value.slice(0, start) + nextText + value.slice(end);
  }

  async function focusComposer() {
    await Promise.resolve();
    inputRef?.focus();
  }

  async function applyPickerItem(item: ComposerPickerItem): Promise<void> {
    const ctx = triggerContext;
    if (!ctx) return;

    if (item.type === 'command') {
      value = '';
      await onExecuteCommand?.(`/${item.value}`);
      resizeToMin();
      return;
    }

    replaceRange(ctx.start, ctx.end, `@${item.value} `);
    await focusComposer();
  }

  async function executeSlashIfNeeded(): Promise<boolean> {
    const trimmed = value.trim();
    if (!trimmed.startsWith('/')) return false;
    const handled = await onExecuteCommand?.(trimmed);
    if (handled) {
      value = '';
      resizeToMin();
      return true;
    }
    return false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.repeat) return; // ignore key repeat (e.g. holding Enter)
    if (pickerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedPickerIndex = (selectedPickerIndex + 1) % pickerItems.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedPickerIndex = (selectedPickerIndex - 1 + pickerItems.length) % pickerItems.length;
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        void applyPickerItem(pickerItems[selectedPickerIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        inputRef?.focus();
        return;
      }
    }
    // Ctrl+Shift+V / Cmd+Shift+V → force paste image from clipboard
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      (e.key === 'v' || e.key === 'V')
    ) {
      e.preventDefault();
      void pasteImageFromClipboard();
      return;
    }

    if (isRunning && shortcutStore.matches('send', e)) {
      e.preventDefault();
      stop();
      return;
    }
    if (shortcutStore.matches('send', e)) {
      e.preventDefault();
      send();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (isRunning) stop();
      else send();
    }
  }

  async function send() {
    if (disabled) return;
    if (configurationWarning) {
      onOpenSettings?.();
      return;
    }
    if (await executeSlashIfNeeded()) return;
    const trimmed = value.trim();
    if (!trimmed && attachments.length === 0) return;
    const now = Date.now();
    if (now - lastSendAt < SEND_COOLDOWN_MS) return; // debounce duplicate sends
    lastSendAt = now;
    onSend(trimmed, selectedModel, reasoningLevel, attachments.length > 0 ? [...attachments] : undefined);
    value = '';
    attachments = [];
    resizeToMin();
  }

  function stop() {
    onStop?.();
  }

  const BASE_MIN_HEIGHT_PX = 88;
  const MAX_HEIGHT_PX = 280;
  let minHeightPx = $state(BASE_MIN_HEIGHT_PX);

  function syncComposerMinHeight() {
    if (typeof window === 'undefined') return;
    const isDesktopTwoColumn = window.innerWidth >= 1280;
    const actionPanelHeight = actionPanelRef?.getBoundingClientRect().height ?? 0;
    minHeightPx = isDesktopTwoColumn
      ? Math.max(BASE_MIN_HEIGHT_PX, Math.ceil(actionPanelHeight))
      : BASE_MIN_HEIGHT_PX;
  }

  function resizeToMin() {
    if (!inputRef) return;
    inputRef.style.height = 'auto';
    inputRef.style.height = minHeightPx + 'px';
  }

  function autoResize() {
    if (!inputRef) return;
    inputRef.style.height = 'auto';
    const h = inputRef.scrollHeight;
    inputRef.style.height = Math.max(minHeightPx, Math.min(h, MAX_HEIGHT_PX)) + 'px';
  }

  onMount(() => {
    if (typeof window === "undefined") return;

    // Global Esc listener to stop running agent
    const handleGlobalEsc = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        isRunning &&
        !showModelPicker &&
        !showReasoningMenu &&
        !pickerOpen
      ) {
        stop();
      }
    };
    window.addEventListener("keydown", handleGlobalEsc);

    const resizeObserver = new ResizeObserver(() => {
      syncComposerMinHeight();
      autoResize();
    });

    if (actionPanelRef) {
      resizeObserver.observe(actionPanelRef);
    }

    const handleWindowResize = () => {
      syncComposerMinHeight();
      autoResize();
    };

    window.addEventListener("resize", handleWindowResize);
    requestAnimationFrame(() => {
      syncComposerMinHeight();
      autoResize();
    });

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      window.removeEventListener("keydown", handleGlobalEsc);
    };
  });

  $effect(() => {
    actionPanelRef;
    if (typeof requestAnimationFrame === 'undefined') return;
    requestAnimationFrame(() => {
      syncComposerMinHeight();
      autoResize();
    });
  });

  $effect(() => {
    value; // track value so we resize when it changes (e.g. paste or programmatic set)
    if (typeof requestAnimationFrame === 'undefined') return;
    requestAnimationFrame(() => autoResize());
  });

  function selectModel(value: string) {
    selectedModel = value;
    showModelPicker = false;
    // Reasoning will auto-update via $effect
  }

  function selectReasoning(value: string) {
    reasoningLevel = value;
    showReasoningMenu = false;
  }

  function reasoningLabel(value: string): string {
    const config = getReasoningConfig(currentProvider, currentModel);
    if (config) {
      const opt = config.options.find(o => o.value === value);
      if (opt) return opt.label;
    }
    // Fallback for Auto/None/Max etc
    if (value === 'none') return 'None';
    if (value === 'low') return 'Low';
    if (value === 'medium') return 'Medium';
    if (value === 'high') return 'High';
    if (value === 'xhigh') return 'max/xhigh';
    if (value === 'max') return 'Max';
    if (value === 'adaptive') return 'Auto';
    return value;
  }

  let modelDisplayName = $derived.by(() => {
    if (selectedModel === 'auto') return 'Auto';
    const modelId = currentModel;
    if (!modelId) return currentProvider.charAt(0).toUpperCase() + currentProvider.slice(1);
    
    // Try to find in wsStore models if they have names, otherwise clean up the ID
    const provider = wsStore.providers.find(p => p.name === currentProvider);
    if (provider) {
      // If we had a model catalog on frontend we'd use it, for now prettify the ID
      return modelId.split('-').map((word: string) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    }
    return modelId;
  });

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('.model-picker')) showModelPicker = false;
    if (!target.closest('.reasoning-picker')) showReasoningMenu = false;
  }

  let canSend = $derived(!disabled && !configurationWarning && (value.trim().length > 0 || attachments.length > 0));

  function cycleAgentExecutionMode() {
    const current = agentSettingsStore.settings.agentExecutionMode ?? 'auto';
    const next =
      current === 'auto' ? 'single' :
      current === 'single' ? 'multi' :
      'auto';

    void agentSettingsStore.saveSettings({
      ...agentSettingsStore.settings,
      agentExecutionMode: next,
    }, { quietSuccess: true });
  }

  let agentExecutionModeMeta = $derived.by(() => {
    const mode = agentSettingsStore.settings.agentExecutionMode ?? 'auto';
    if (mode === 'multi') {
      return {
        label: 'Multi-Agent',
        title: 'Agent Mode: Multi-Agent',
        icon: Users,
        className: 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30',
      };
    }
    if (mode === 'single') {
      return {
        label: 'Single Agent',
        title: 'Agent Mode: Single Agent',
        icon: User,
        className: 'bg-[var(--color-surface-3)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:brightness-110',
      };
    }
    return {
      label: 'Auto',
      title: 'Agent Mode: Auto',
      icon: Sparkles,
      className: 'bg-emerald-500/14 text-emerald-300 border border-emerald-500/25 hover:brightness-110',
    };
  });

  async function handleFileInput(e: Event) {
    const target = e.target as HTMLInputElement;
    if (!target.files) return;
    for (const file of target.files) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const result = e.target?.result as string;
          if (result) {
            const data = result.split(',')[1];
            attachments = [...attachments, { type: 'image', data, name: file.name }];
          }
        };
        reader.readAsDataURL(file);
      }
    }
    target.value = '';
  }

  function removeAttachment(index: number) {
    attachments = attachments.filter((_, i) => i !== index);
  }

  /** Force-paste image from OS clipboard (bypasses text). Used by Ctrl+Shift+V and the paste-image button. */
  async function pasteImageFromClipboard() {
    // Try browser clipboard first (works for images copied from web pages)
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            const reader = new FileReader();
            const loaded = await new Promise<string>((resolve) => {
              reader.onload = (e) => resolve(e.target?.result as string);
              reader.readAsDataURL(blob);
            });
            const data = loaded.split(',')[1];
            const ext = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : type === 'image/gif' ? 'gif' : type === 'image/webp' ? 'webp' : 'png';
            attachments = [...attachments, { type: 'image', data, name: `clipboard-image.${ext}` }];
            return;
          }
        }
      }
    } catch (_) {
      // navigator.clipboard.read() may fail if permission denied — fall through to Tauri
    }

    // Tauri native clipboard (for OS-level screenshot tools)
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        const { readImage } = await import('@tauri-apps/plugin-clipboard-manager');
        const image = await readImage();
        if (image) {
          const pngData = await image.png();
          const blob = new Blob([pngData], { type: 'image/png' });
          const reader = new FileReader();
          const loaded = await new Promise<string>((resolve) => {
            reader.onload = (ev) => resolve(ev.target?.result as string);
            reader.readAsDataURL(blob);
          });
          const base64 = loaded.split(',')[1];
          attachments = [...attachments, { type: 'image', data: base64, name: 'clipboard-image.png' }];
          return;
        }
      } catch (err: any) {
        toastStore.error("Clipboard error: " + err.message);
        return;
      }
    }

    toastStore.error("No image found in clipboard");
  }

  function handlePaste(e: ClipboardEvent) {
    // ALWAYS prevent default first — we'll manually handle everything.
    // This stops the browser from inserting text before we can check for images.
    e.preventDefault();

    const items = e.clipboardData?.items;
    const files = e.clipboardData?.files;
    let handled = false;

    // Check items first (usually browser images, e.g. copied from web pages)
    if (items) {
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          handled = true;
          const file = item.getAsFile();
          if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
              const result = ev.target?.result as string;
              if (result) {
                const data = result.split(',')[1];
                attachments = [...attachments, { type: 'image', data, name: file.name || 'pasted-image.png' }];
              }
            };
            reader.readAsDataURL(file);
          }
        }
      }
    }

    // Fallback to files array (sometimes OS files copied)
    if (!handled && files) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.type.startsWith('image/')) {
          handled = true;
          const reader = new FileReader();
          reader.onload = (ev) => {
            const result = ev.target?.result as string;
            if (result) {
              const data = result.split(',')[1];
              attachments = [...attachments, { type: 'image', data, name: file.name }];
            }
          };
          reader.readAsDataURL(file);
        }
      }
    }

    if (handled) return;

    // No browser-visible image found. Try Tauri native clipboard asynchronously.
    // We already called preventDefault(), so text won't leak through.
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      void (async () => {
        try {
          const { readImage } = await import('@tauri-apps/plugin-clipboard-manager');
          const image = await readImage();
          if (image) {
            const pngData = await image.png();
            const blob = new Blob([pngData], { type: 'image/png' });
            const reader = new FileReader();
            reader.onload = (ev) => {
              const result = ev.target?.result as string;
              if (result) {
                const base64 = result.split(',')[1];
                attachments = [...attachments, { type: 'image', data: base64, name: 'clipboard-image.png' }];
              }
            };
            reader.readAsDataURL(blob);
            return;
          }
        } catch (_) {
          // Silently fall through to text paste
        }

        // No image found anywhere — paste text manually at cursor position
        void navigator.clipboard.readText().then((text) => {
          if (text && inputRef) {
            const start = inputRef.selectionStart ?? value.length;
            const end = inputRef.selectionEnd ?? value.length;
            value = value.slice(0, start) + text + value.slice(end);
            // Move cursor after pasted text
            requestAnimationFrame(() => {
              if (inputRef) {
                const newPos = start + text.length;
                inputRef.selectionStart = newPos;
                inputRef.selectionEnd = newPos;
                inputRef.focus();
              }
            });
          }
        }).catch(() => {});
      })();
      return;
    }

    // Browser environment: no image, just paste text
    void navigator.clipboard.readText().then((text) => {
      if (text && inputRef) {
        const start = inputRef.selectionStart ?? value.length;
        const end = inputRef.selectionEnd ?? value.length;
        value = value.slice(0, start) + text + value.slice(end);
        requestAnimationFrame(() => {
          if (inputRef) {
            const newPos = start + text.length;
            inputRef.selectionStart = newPos;
            inputRef.selectionEnd = newPos;
            inputRef.focus();
          }
        });
      }
    }).catch(() => {});
  }
</script>

<svelte:window onclick={handleClickOutside} onpaste={handlePaste} />

<div class="command-input px-4 py-3">
  <!-- No project: show error -->
  {#if disabled}
    <div class="mb-4 px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2" style="background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); color: var(--color-text-primary);">
      <span class="text-amber-400">⚠</span>
      <span>{disabledMessage}</span>
    </div>
  {/if}

  <!-- No provider: show blocking setup state -->
  {#if !disabled && configurationWarning}
    <div class="mb-4 flex items-center justify-between gap-3 px-4 py-3 rounded-xl" style="background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); color: var(--color-text-primary);">
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-red-400 font-semibold shrink-0">Setup required</span>
        <span class="text-sm min-w-0" style="color: var(--color-text-secondary);">{configurationWarning}</span>
      </div>
      <button
        type="button"
        class="btn btn-secondary shrink-0"
        onclick={() => onOpenSettings?.()}
      >
        Open Settings
      </button>
    </div>
  {/if}

  <div class="rounded-[20px] border px-5 py-3" style="background: rgba(12, 10, 9, 0.2); border-color: var(--color-border);">
    <!-- Controls row: Model picker + Reasoning toggle -->
    <div class="mb-3 flex flex-wrap items-center gap-3">
      <!-- Model selector -->
      <div class="relative model-picker">
        <button
          type="button"
          class="flex items-center gap-2 px-3.5 h-10 rounded-xl text-sm font-medium transition-all hover:brightness-110 active:scale-[0.98]"
          style="background: var(--color-surface-3); color: var(--color-text-primary); border: 1px solid var(--color-border);"
          onclick={() => showModelPicker = !showModelPicker}
        >
          <Sparkles size={16} class="text-amber-400" />
          <span>{selectedModelLabel}</span>
          <ChevronDown size={14} class="text-text-muted" />
        </button>

        {#if showModelPicker}
          <div
            class="absolute bottom-full left-0 mb-2 w-72 max-h-60 overflow-y-auto rounded-xl border shadow-2xl z-50"
            style="background: var(--color-surface-2); border-color: var(--color-border);"
          >
            {#each availableModels as model}
              <button
                type="button"
                class="w-full text-left px-4 py-3 text-sm transition-colors hover:bg-[var(--color-surface-3)] flex items-center gap-2 {selectedModel === model.value ? 'text-[var(--color-accent)]' : ''}"
                style="color: {selectedModel === model.value ? 'var(--color-accent)' : 'var(--color-text-secondary)'};"
                onclick={() => selectModel(model.value)}
              >
                {#if model.isAuto}
                  <Sparkles size={14} class="text-amber-400 shrink-0" />
                {/if}
                <span>{model.label}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Reasoning toggle - shows/hides based on provider+model -->
      {#if reasoningSupported && reasoningConfig}
        <div class="relative reasoning-picker">
          <button
            type="button"
            class="flex items-center gap-2 px-3.5 h-10 rounded-xl text-sm font-medium transition-all hover:brightness-110 active:scale-[0.98]"
            style="background: var(--color-surface-3); color: var(--color-text-primary); border: 1px solid var(--color-border);"
            onclick={() => showReasoningMenu = !showReasoningMenu}
            title="Set auto effort"
          >
            <BrainIcon {reasoningLevel} size={20} class="text-[#c890ab]" />
            <span>{reasoningLabel(reasoningLevel)}</span>
            <ChevronDown size={14} class="text-text-muted" />
          </button>

          {#if showReasoningMenu}
            <div
              class="absolute bottom-full left-0 mb-2 w-72 rounded-xl border shadow-2xl z-50 overflow-hidden backdrop-blur-md"
              style="background: var(--color-surface-2-alpha, rgba(30, 30, 35, 0.9)); border-color: var(--color-border);"
            >
              <div class="px-4 py-3 text-xs font-bold uppercase tracking-widest opacity-70" style="color: var(--color-text-muted); border-bottom: 1px solid var(--color-border); background: rgba(255,255,255,0.03);">
                {selectedModel === 'auto' ? 'Reasoning' : `${modelDisplayName} · ${reasoningLabel(reasoningLevel)}`}
              </div>
              <div class="py-1">
                {#each reasoningConfig.options as opt}
                  <button
                    type="button"
                    class="w-full text-left px-4 py-3 transition-all hover:bg-[var(--color-surface-3)] group"
                    onclick={() => selectReasoning(opt.value)}
                  >
                    <div class="flex items-center justify-between mb-0.5">
                      <span class="text-sm font-semibold {reasoningLevel === opt.value ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'}">
                        {opt.label}
                      </span>
                      {#if reasoningLevel === opt.value}
                        <div class="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] shadow-[0_0_8px_var(--color-accent)]"></div>
                      {/if}
                    </div>
                    <div class="text-[11px] leading-relaxed opacity-60 group-hover:opacity-100 transition-opacity" style="color: var(--color-text-muted);">
                      {opt.description}
                    </div>
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Input area -->
    <div class="flex flex-col gap-3 xl:flex-row xl:items-start">
      <div class="min-w-0 flex-1">
        {#if pickerOpen}
          <div class="mb-3 overflow-hidden rounded-xl border" style="background: var(--color-surface-2); border-color: var(--color-border);">
            <div class="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em]" style="color: var(--color-text-muted); border-bottom: 1px solid var(--color-border);">
              {triggerContext?.trigger === '/' ? 'Commands' : 'Files'}
            </div>
            <div class="py-1">
              {#each pickerItems as item, index (item.key)}
                <button
                  type="button"
                  class="flex w-full items-start justify-between gap-3 px-3 py-2 text-left transition-colors {index === selectedPickerIndex ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-3)]'}"
                  onclick={() => void applyPickerItem(item)}
                >
                  <div class="min-w-0">
                    <div class="text-sm font-medium" style="color: var(--color-text-primary);">
                      {item.type === 'command' ? `/${item.value}` : `@${item.label}`}
                    </div>
                    <div class="truncate text-xs" style="color: var(--color-text-muted);">
                      {item.description}
                    </div>
                  </div>
                  <div class="shrink-0 text-[10px] uppercase tracking-[0.12em]" style="color: var(--color-text-muted);">
                    {item.type}
                  </div>
                </button>
              {/each}
            </div>
          </div>
        {/if}
        
        <!-- Attachments Preview -->
        {#if attachments.length > 0}
          <div class="mb-3 flex flex-wrap gap-2">
            {#each attachments as attachment, i}
              <div class="relative group rounded-lg overflow-hidden border" style="border-color: var(--color-border); width: 64px; height: 64px;">
                {#if attachment.type === 'image'}
                  <img src={`data:image/png;base64,${attachment.data}`} alt={attachment.name} class="w-full h-full object-cover" />
                {/if}
                <button
                  type="button"
                  class="absolute top-1 right-1 p-0.5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
                  onclick={() => removeAttachment(i)}
                >
                  <X size={12} />
                </button>
              </div>
            {/each}
          </div>
        {/if}
        
        <textarea
          bind:this={inputRef}
          bind:value={value}
          oninput={autoResize}
          onkeydown={handleKeydown}
          onpaste={handlePaste}
          placeholder={disabled ? disabledMessage : placeholder}
          rows="1"
          class="input flex-1"
          class:yolo-active={wsStore.isYoloMode}
          disabled={disabled || !!configurationWarning}
          style="resize: none; min-height: {minHeightPx}px; max-height: 280px; font-size: 15px; line-height: 1.6; box-sizing: border-box; padding: 10px 12px; background: transparent; border: none; box-shadow: none; {disabled || configurationWarning ? 'opacity: 0.6; cursor: not-allowed;' : ''}"
        ></textarea>
      </div>
      <div class="w-full xl:w-auto xl:self-start">
        <div
          bind:this={actionPanelRef}
          class="flex flex-col gap-3 rounded-2xl border px-3 py-3 xl:min-w-[188px]"
          style="background: rgba(12, 10, 9, 0.34); border-color: var(--color-border);"
        >
          <div class="flex flex-wrap items-center gap-2 xl:justify-end">
            <button
              type="button"
              class="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-md transition-colors {agentExecutionModeMeta.className}"
              onclick={cycleAgentExecutionMode}
              title={agentExecutionModeMeta.title}
            >
              <agentExecutionModeMeta.icon size={12} />
              <span>{agentExecutionModeMeta.label}</span>
            </button>

            <button
              type="button"
              class="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-md transition-colors {agentSettingsStore.settings.criticGateEnabled ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-[var(--color-surface-3)] text-[var(--color-text-muted)] border border-[var(--color-border)] hover:brightness-110'}"
              onclick={() => agentSettingsStore.saveSettings(
                { ...agentSettingsStore.settings, criticGateEnabled: !agentSettingsStore.settings.criticGateEnabled },
                { quietSuccess: true },
              )}
              title="Toggle Critic Agent"
            >
              {#if agentSettingsStore.settings.criticGateEnabled}
                <ShieldCheck size={12} />
                <span>Critic: On</span>
              {:else}
                <ShieldAlert size={12} />
                <span>Critic: Off</span>
              {/if}
            </button>
          </div>

          <input
            type="file"
            multiple
            accept="image/*"
            class="hidden"
            bind:this={fileInputRef}
            onchange={handleFileInput}
          />
          <button
            type="button"
            onclick={isRunning ? stop : send}
            disabled={disabled || (!isRunning && !canSend)}
            class="btn flex w-full items-center justify-center gap-2 {isRunning ? 'bg-[var(--color-surface-3)] hover:bg-[var(--color-surface-2)] border-[var(--color-border)] hover:border-red-500/40' : 'btn-primary'}"
            style="height: 52px; padding: 0 20px; font-size: 14px; {disabled || configurationWarning ? 'opacity: 0.5; cursor: not-allowed;' : ''}"
          >
            {#if isRunning}
              <span class="stop-icon-ring">
                <Square size={12} fill="currentColor" class="text-red-400" />
              </span>
              <span class="text-red-400/90">Stop</span>
            {:else}
              <Send size={18} />
              Send
            {/if}
          </button>
        </div>
      </div>
    </div>
  </div>

  <div class="flex items-center justify-between mt-[var(--space-sm)]">
    <span class="text-xs" style="color: var(--color-text-muted);">
      {#if configurationWarning}
        Configure a provider to enable sending.
      {:else}
        Enter to send · Shift+Enter for new line · Ctrl+Shift+V paste image
      {/if}
    </span>
    <div class="flex items-center gap-3">
      <button
        type="button"
        class="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        onclick={() => fileInputRef?.click()}
        title="Attach Image"
      >
        <Paperclip size={16} />
      </button>
      <button
        type="button"
        class="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        onclick={() => pasteImageFromClipboard()}
        title="Paste Image (Ctrl+Shift+V)"
      >
        <Clipboard size={16} />
      </button>
      {#if value.length > 0}
        <span class="text-xs" style="color: var(--color-text-muted);">{value.length} chars</span>
      {/if}
    </div>
  </div>
</div>

<style>
  .yolo-active {
    border-color: #ef4444 !important;
    box-shadow: 0 0 0 1px #ef4444;
  }

  .stop-icon-ring {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 2px solid rgb(239 68 68 / 0.45);
    flex-shrink: 0;
  }
</style>
