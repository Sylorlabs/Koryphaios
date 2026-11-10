/** Agent/tool execution location, NOT the location of model inference. An API
 * model can be hosted remotely while all Kory workspace actions run locally. */
export type ProviderExecutionMode = 'local' | 'cloud';

export interface ProviderExecutionOption {
  id: ProviderExecutionMode;
  available: boolean;
  reason?: string;
}

export interface ProviderExecutionCapabilities {
  modes: ProviderExecutionOption[];
  defaultMode: ProviderExecutionMode;
}

/** This reflects the integrated adapter, not every feature a provider markets.
 * Never infer dual execution support merely from API-key authentication. */
export function providerExecutionCapabilities(
  name: string,
  deployment?: 'local' | 'cloud' | 'api' | 'hybrid',
): ProviderExecutionCapabilities {
  if (name === 'hoplite') {
    const reason =
      'Hoplite supports local and cloud agents, but live delegation is not implemented in Koryphaios. No execution mode can be enabled yet.';
    return {
      modes: [
        { id: 'local', available: false, reason },
        { id: 'cloud', available: false, reason },
      ],
      defaultMode: 'local',
    };
  }
  const mode = deployment === 'cloud' ? 'cloud' : 'local';
  return { modes: [{ id: mode, available: true }], defaultMode: mode };
}

export function showsExecutionModeSelector(capabilities?: ProviderExecutionCapabilities): boolean {
  return !!capabilities && new Set(capabilities.modes.map((mode) => mode.id)).size > 1;
}
