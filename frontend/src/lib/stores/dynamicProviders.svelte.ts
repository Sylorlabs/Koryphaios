/**
 * Dynamic providers store — Svelte 5 runes-based state management
 */

import type { 
  DynamicProviderConfig, 
  ProviderPreset, 
  ReasoningConfig,
  APIResponse 
} from '@koryphaios/shared';
import {
  getProviderPresets,
  getDynamicProviders,
  addDynamicProvider as apiAddProvider,
  updateDynamicProvider as apiUpdateProvider,
  removeDynamicProvider as apiRemoveProvider,
  testDynamicProvider as apiTestProvider,
  setProviderReasoning as apiSetReasoning,
} from '$lib/api.svelte';

// ─── State ─────────────────────────────────────────────────────────────────

/** All configured dynamic providers */
const _providers = $state<DynamicProviderConfig[]>([]);

/** Available presets */
const _presets = $state<ProviderPreset[]>([]);

/** Loading states */
const _loading = $state({
  providers: false,
  presets: false,
  saving: false,
  testing: new Set<string>(),
});

/** Error state */
let _error = $state<string | null>(null);

// ─── Public API ────────────────────────────────────────────────────────────

export function useDynamicProviders() {
  return {
    // Readonly state
    get providers() { return _providers; },
    get presets() { return _presets; },
    get loading() { return _loading; },
    get error() { return _error; },
    get isLoading() { return _loading.providers || _loading.presets; },
    get isSaving() { return _loading.saving; },
    
    // Actions
    refresh: loadProviders,
    refreshPresets: loadPresets,
    add: addProvider,
    update: updateProvider,
    remove: removeProvider,
    test: testProvider,
    setReasoning: updateReasoning,
    getProvider: (name: string) => _providers.find(p => p.name === name),
    getPreset: (name: string) => _presets.find(p => p.name === name),
  };
}

// ─── Actions ───────────────────────────────────────────────────────────────

/** Load all dynamic providers from the API */
async function loadProviders(): Promise<void> {
  _loading.providers = true;
  _error = null;
  
  try {
    const response = await getDynamicProviders();
    if (response.ok && response.data) {
      _providers.length = 0;
      _providers.push(...response.data);
    } else {
      _error = response.error || 'Failed to load providers';
    }
  } catch (err) {
    _error = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    _loading.providers = false;
  }
}

/** Load available presets from the API */
async function loadPresets(): Promise<void> {
  _loading.presets = true;
  _error = null;
  
  try {
    const presets = await getProviderPresets();
    _presets.length = 0;
    _presets.push(...presets);
  } catch (err) {
    _error = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    _loading.presets = false;
  }
}

/** Add a new dynamic provider */
async function addProvider(config: DynamicProviderConfig): Promise<APIResponse> {
  _loading.saving = true;
  _error = null;
  
  try {
    const response = await apiAddProvider(config);
    if (response.ok) {
      // Refresh the list to get the server-side state
      await loadProviders();
    } else {
      _error = response.error || 'Failed to add provider';
    }
    return response;
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    _error = error;
    return { ok: false, error };
  } finally {
    _loading.saving = false;
  }
}

/** Update an existing provider */
async function updateProvider(
  name: string, 
  updates: Partial<DynamicProviderConfig>
): Promise<APIResponse> {
  _loading.saving = true;
  _error = null;
  
  try {
    const response = await apiUpdateProvider(name, updates);
    if (response.ok) {
      await loadProviders();
    } else {
      _error = response.error || 'Failed to update provider';
    }
    return response;
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    _error = error;
    return { ok: false, error };
  } finally {
    _loading.saving = false;
  }
}

/** Remove a provider */
async function removeProvider(name: string): Promise<APIResponse> {
  _error = null;
  
  try {
    const response = await apiRemoveProvider(name);
    if (response.ok) {
      const index = _providers.findIndex(p => p.name === name);
      if (index >= 0) {
        _providers.splice(index, 1);
      }
    } else {
      _error = response.error || 'Failed to remove provider';
    }
    return response;
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    _error = error;
    return { ok: false, error };
  }
}

/** Test a provider connection */
async function testProvider(
  name: string, 
  config: Partial<DynamicProviderConfig> = {}
): Promise<APIResponse> {
  _loading.testing.add(name);
  
  try {
    return await apiTestProvider(name, config);
  } finally {
    _loading.testing.delete(name);
  }
}

/** Update reasoning configuration for a provider */
async function updateReasoning(
  name: string, 
  reasoning: ReasoningConfig
): Promise<APIResponse> {
  _loading.saving = true;
  
  try {
    const response = await apiSetReasoning(name, reasoning);
    if (response.ok) {
      await loadProviders();
    }
    return response;
  } finally {
    _loading.saving = false;
  }
}

// Initialize on module load
void loadPresets();
void loadProviders();
