/**
 * Remote provider client orchestrator — ties the relay guest connection to the
 * local provider registry. On connect it registers a RemoteProvider for each of
 * the host's shared (non-agentic) providers so they appear in the model picker;
 * on disconnect it removes them.
 */

import { serverLog } from '../logger';
import { getContext } from '../context';
import { relayGuestClient } from './relay-guest-client';
import { RemoteProvider } from '../providers/remote-provider';
import type { ModelDef, ProviderName, SharedProviderCatalog } from '@koryphaios/shared';

const log = serverLog.child({ module: 'remote-provider-client' });

let connectedHostName: string | null = null;
let catalogUnsub: (() => void) | null = null;

function registerFromCatalog(catalog: SharedProviderCatalog): void {
  const registry = getContext().providers;
  registry.clearRemoteProviders();
  connectedHostName = catalog.hostName;

  for (const entry of catalog.providers) {
    const id = `remote-${entry.provider}` as ProviderName;
    const models: ModelDef[] = entry.models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: id,
      contextWindow: m.contextWindow ?? 128_000,
      maxOutputTokens: m.maxOutputTokens ?? 8_192,
      canReason: m.canReason,
      reasoningLevels: m.reasoningLevels,
      contextVerified: m.contextWindow != null,
    }));
    if (models.length === 0) continue;

    // Agentic (CLI-harness) providers are registered too — the RemoteProvider
    // syncs the client's project to the host sandbox and writes edits back.
    registry.registerRemoteProvider(
      new RemoteProvider({
        id,
        label: `${catalog.hostName} · ${entry.label}${entry.agentic ? ' (runs on host)' : ''}`,
        hostProvider: entry.provider,
        agentic: entry.agentic,
        models,
      }),
    );
  }
  log.info(
    { hostName: catalog.hostName, count: catalog.providers.length },
    'Registered remote providers from host catalog',
  );
}

/** Connect to a host by join code and register its shared providers locally. */
export async function connectToProviderHost(
  joinCode: string,
  displayName: string,
): Promise<{ hostName: string | null }> {
  await relayGuestClient.connect(joinCode, displayName);
  catalogUnsub?.();
  catalogUnsub = relayGuestClient.onCatalog(registerFromCatalog);
  // If the catalog already arrived during connect, onCatalog fired synchronously.
  return { hostName: connectedHostName };
}

export function disconnectFromProviderHost(): void {
  catalogUnsub?.();
  catalogUnsub = null;
  relayGuestClient.disconnect();
  getContext().providers.clearRemoteProviders();
  connectedHostName = null;
}

export function remoteProviderStatus(): {
  connected: boolean;
  hostName: string | null;
  catalog: SharedProviderCatalog | null;
} {
  return {
    connected: relayGuestClient.isConnected,
    hostName: connectedHostName,
    catalog: relayGuestClient.hostCatalog,
  };
}
