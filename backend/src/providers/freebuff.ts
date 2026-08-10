// Freebuff provider boundary.
//
// The previous adapter bypassed the installed CLI and drove an undocumented
// Codebuff backend contract through @codebuff/sdk. It also patched global
// fetch, relied on reverse-engineered prompt/session behavior, and pulled a
// dependency chain with known security advisories. Local credential-file
// presence cannot prove that contract or user entitlement, so the adapter is
// deliberately unavailable until an official, testable integration exists.

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import type { Provider, ProviderEvent, StreamRequest } from './types';

export const FREEBUFF_UNAVAILABLE_ERROR =
  'Freebuff is unavailable in this build. The prior integration used an undocumented Codebuff SDK/backend path and could not provide a safe, supportable authentication and tool-execution contract. Koryphaios preserves local Freebuff detection as setup information but will not send requests or run tools through it.';

export class FreebuffProvider implements Provider {
  readonly name = 'freebuff' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return false;
  }

  listModels(): ModelDef[] {
    return [];
  }

  async *streamResponse(_request: StreamRequest): AsyncGenerator<ProviderEvent> {
    yield { type: 'error', error: FREEBUFF_UNAVAILABLE_ERROR };
  }
}
