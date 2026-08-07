<script lang="ts">
  import { Check, Eye, EyeOff, KeyRound, LoaderCircle } from 'lucide-svelte';
  import ProviderIcon from './icons/ProviderIcon.svelte';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { onMount } from 'svelte';
  import { providersStore } from '$lib/stores/providers.svelte';
  interface Props { id: string; name: string; description: string; configured?: boolean; onconnected?: () => void | Promise<void>; }
  let { id, name, description, configured = false, onconnected }: Props = $props();
  let connected = $state(false); let expanded = $state(false); let key = $state(''); let visible = $state(false); let saving = $state(false);
  let accountId = $state<string | null>(null);
  $effect(() => { if (configured || providersStore.statusList.some(provider => provider.name === id && provider.authenticated)) connected = true; });
  onMount(async () => {
    try {
      const result = await apiFetch(apiUrl(`/api/providers/${id}/accounts`)).then((response) => response.json());
      accountId = result.data?.[0]?.id ?? null;
      connected = connected || Boolean(accountId);
    } catch (err) {
      // Account lookup is best-effort; a 404/401 just means no account yet.
      console.debug(`No existing account for ${id}:`, err);
    }
  });
  async function connect() {
    if (!key.trim()) return; saving = true;
    try {
      const previousAccountId = accountId;
      const response = await apiFetch(apiUrl(`/api/providers/${id}/accounts`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: `${name} voice/image account`, apiKey: key.trim(), activate: false }) });
      const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error || 'Connection failed');
      if (previousAccountId && previousAccountId !== result.data?.account?.id) await apiFetch(apiUrl(`/api/providers/${id}/accounts/${previousAccountId}`), { method: 'DELETE' });
      key = ''; accountId = result.data?.account?.id ?? accountId; connected = true; expanded = false; toastStore.success(`${name} key saved`); await onconnected?.();
    } catch (error) { toastStore.error(error instanceof Error ? error.message : `Could not connect ${name}`); } finally { saving = false; }
  }
  async function disconnect() {
    if (!accountId || saving) return; saving = true;
    try { const response = await apiFetch(apiUrl(`/api/providers/${id}/accounts/${accountId}`), { method: 'DELETE' }); const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error || 'Disconnect failed'); connected = false; accountId = null; expanded = false; toastStore.success(`${name} disconnected`); await onconnected?.(); }
    catch (error) { toastStore.error(error instanceof Error ? error.message : `Could not disconnect ${name}`); } finally { saving = false; }
  }
</script>
<div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
  <div class="flex items-center gap-3"><div class="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-surface-3)]"><ProviderIcon provider={id} size={22}/></div><div class="min-w-0 flex-1"><div class="flex items-center gap-2 font-medium text-[var(--color-text-primary)]">{name}{#if connected}<span class="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400"><Check size={10}/> Available</span>{/if}</div><p class="text-xs text-[var(--color-text-muted)]">{description}</p></div><button class="btn" onclick={() => expanded = !expanded}>{connected ? 'Manage' : 'Add key'}</button></div>
  {#if expanded}<div class="mt-4 border-t border-[var(--color-border)] pt-4"><label class="text-xs text-[var(--color-text-muted)]">{connected ? 'Replace API key' : 'API key'}<div class="relative mt-1"><input class="input w-full pr-10" type={visible ? 'text' : 'password'} bind:value={key} placeholder="Paste your key" autocomplete="off"/><button type="button" class="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" onclick={() => visible = !visible} aria-label={visible ? 'Hide key' : 'Show key'}>{#if visible}<EyeOff size={15}/>{:else}<Eye size={15}/>{/if}</button></div></label><div class="mt-3 flex justify-between">{#if accountId}<button class="btn text-red-400" disabled={saving} onclick={disconnect}>Disconnect saved key</button>{:else}<span></span>{/if}<button class="btn btn-primary" disabled={saving || !key.trim()} onclick={connect}>{#if saving}<LoaderCircle size={14} class="animate-spin"/>{:else}<KeyRound size={14}/>{/if} Save securely</button></div><p class="mt-2 text-[10px] text-[var(--color-text-muted)]">Stored once in Koryphaios's encrypted credential store and reused for this provider's capabilities.</p></div>{/if}
</div>
