// Auto-initialization store - handles setup automatically without user intervention
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { toastStore } from './toast.svelte';

interface InitStep {
  name: string;
  status: 'pending' | 'loading' | 'complete' | 'error';
  message?: string;
}

// State declarations at module level (Svelte 5 runes)
let isInitialized = $state(false);
let isLoading = $state(false);
let error = $state<string | null>(null);
let steps = $state<InitStep[]>([
  { name: 'Connection', status: 'pending' },
  { name: 'Providers', status: 'pending' },
  { name: 'Settings', status: 'pending' },
  { name: 'Ready', status: 'pending' },
]);

function updateStep(name: string, status: InitStep['status'], message?: string) {
  steps = steps.map(step => 
    step.name === name ? { ...step, status, message } : step
  );
}

async function checkConnection() {
  try {
    const res = await apiFetch('/api/health');
    if (!res.ok) throw new Error('Backend not responding');
  } catch {
    throw new Error('Cannot connect to backend');
  }
}

async function autoDetectCLIProviders() {
  const cliProviders = ['copilot', 'claude', 'cline', 'codex'];
  
  for (const provider of cliProviders) {
    try {
      await apiFetch('/api/providers/' + provider + '/detect', { method: 'POST' });
    } catch {
      // Silent fail - CLI probably not installed
    }
  }
}

async function loadProviders() {
  try {
    const res = await apiFetch('/api/providers');
    const data = await parseJsonResponse(res);
    if (!data?.ok) throw new Error('Failed to load providers');
    
    const providers = data.data || [];
    const activeProviders = providers.filter((p: any) => p.authenticated);
    
    if (activeProviders.length === 0) {
      await autoDetectCLIProviders();
    }
  } catch (err) {
    throw new Error('Failed to initialize providers');
  }
}

async function loadSettings() {
  try {
    const res = await apiFetch('/api/settings');
    const data = await parseJsonResponse(res);
    if (!data?.ok) throw new Error('Failed to load settings');
  } catch {
    // Settings might not exist yet - that's OK
  }
}

async function initialize() {
  if (isInitialized || isLoading) return;
  
  isLoading = true;
  error = null;
  
  try {
    updateStep('Connection', 'loading');
    await checkConnection();
    updateStep('Connection', 'complete', 'Connected to backend');
    
    updateStep('Providers', 'loading');
    await loadProviders();
    updateStep('Providers', 'complete', 'Providers configured');
    
    updateStep('Settings', 'loading');
    await loadSettings();
    updateStep('Settings', 'complete', 'Settings loaded');
    
    updateStep('Ready', 'complete', 'Ready to go!');
    isInitialized = true;
    
  } catch (err) {
    error = err instanceof Error ? err.message : 'Initialization failed';
    toastStore.error(error);
  } finally {
    isLoading = false;
  }
}

function reset() {
  isInitialized = false;
  isLoading = false;
  error = null;
  steps = steps.map(step => ({ ...step, status: 'pending', message: undefined }));
}

export const autoInitStore = {
  get isInitialized() { return isInitialized; },
  get isLoading() { return isLoading; },
  get error() { return error; },
  get steps() { return steps; },
  initialize,
  reset,
};
