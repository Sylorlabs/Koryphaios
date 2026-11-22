// Hoplite provider — hybrid async coding agent (API-key verified).
//
// Hoplite is an async agent control plane, not an LLM inference API. It is not
// cloud-only: a thread either runs in a Hoplite cloud sandbox or on a local
// Codex/Claude agent bound to one of the
// caller's machines (`executionTarget.kind: 'local'`), and either way it
// produces threads and pull requests. The organization API key (hop_…) is fully
// verifiable in Settings and the platform model catalog is exposed for
// selection, but what is NOT wired in this release is live delegation, so the
// adapter stays inert and never claims chat capability.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { type Provider, type ProviderEvent, type StreamRequest } from './types';
import { HOPLITE_MODELS } from './hoplite-models';
import type { HopliteSpeed } from './hoplite-client';

/** Map a stream request's selected speed tier onto Hoplite's `speed` request
 *  field: the composer's `fast` tier sends `speed: 'fast'`; every other
 *  selection (including off) omits the field so the platform default applies.
 *  Exported for the delegation request builder — Hoplite's adapter is inert
 *  this release, but the mapping is where `speed` enters when it is wired. */
export function hopliteSpeedForRequest(request: Pick<StreamRequest, 'speedTier'>):
    | HopliteSpeed
    | undefined {
  return request.speedTier === 'fast' ? 'fast' : undefined;
}

/**
 * Why this adapter refuses to stream: delegation into Hoplite would need
 * an approval-capable remote workflow. The API key itself is
 * verified in Settings against the live /api/projects catalog.
 */
export const HOPLITE_DELEGATION_NOT_AVAILABLE =
  'Hoplite runs tasks in Hoplite cloud sandboxes or on a local Codex/Claude agent bound to your machine, and opens pull requests; results arrive as Hoplite threads/PRs rather than local output. Live delegation from Koryphaios is not wired in this release — your API key is verified in Settings, and no chat or streaming execution is available from this provider.';

export class HopliteProvider implements Provider {
  readonly imageInputTransport = 'none' as const;
  readonly name = 'hoplite' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return false;
  }

  /**
   * Hoplite's platform catalog. The public API exposes no models endpoint
   * (`GET /api/models` is a 404), so this is the table Hoplite ships in its own
   * app bundle — see hoplite-models.ts for provenance.
   *
   * These are per-thread delegation selectors, not chat targets: a thread runs
   * on exactly one of them, chosen when the thread is created.
   */
  listModels(): ModelDef[] {
    return HOPLITE_MODELS;
  }

  getModelDiscoveryError(): string {
    return HOPLITE_DELEGATION_NOT_AVAILABLE;
  }

  async *streamResponse(_request: StreamRequest): AsyncGenerator<ProviderEvent> {
    yield { type: 'error', error: HOPLITE_DELEGATION_NOT_AVAILABLE };
  }
}
