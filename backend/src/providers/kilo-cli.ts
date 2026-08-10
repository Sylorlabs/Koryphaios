// Kilo Code CLI provider.
//
// Kilo can execute tools and mutate a workspace, but its headless CLI does not
// currently expose a permission/sandbox contract Koryphaios can enforce. Keep
// the adapter visible as an explicit unavailable state and never spawn it until
// that boundary is implemented and regression-tested.

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import type { Provider, ProviderEvent, StreamRequest } from './types';

export const KILO_PERMISSION_BOUNDARY_ERROR =
  'Kilo Code is unavailable in this build: Koryphaios cannot yet enforce Kilo tool permissions or workspace sandboxing. No Kilo process was started.';

export class KiloCodeCLIProvider implements Provider {
  readonly name = 'kilocode' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return false;
  }

  getModelDiscoveryError(): string {
    return KILO_PERMISSION_BOUNDARY_ERROR;
  }

  getCliCommands(): [] {
    return [];
  }

  listModels(): ModelDef[] {
    return [];
  }

  async *streamResponse(_request: StreamRequest): AsyncGenerator<ProviderEvent> {
    yield { type: 'error', error: KILO_PERMISSION_BOUNDARY_ERROR };
  }
}
