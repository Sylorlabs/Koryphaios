// Jules provider — Google Labs async cloud coding agent (API only).
//
// Jules runs tasks in remote VMs against GitHub repos (or repoless ephemeral envs).
// Unlike local CLI harnesses (Antigravity, Claude Code), Jules is cloud-only and
// returns progress via polled session activities.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { type Provider, type ProviderEvent, type StreamRequest } from './types';
import { JULES_APPROVAL_REQUIRED_ERROR } from './jules-runner';

export class JulesProvider implements Provider {
  readonly name = 'jules' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return false;
  }

  /** Jules v1alpha has no models endpoint — these are virtual cloud agent selectors. */
  listModels(): ModelDef[] {
    return [];
  }

  getModelDiscoveryError(): string {
    return JULES_APPROVAL_REQUIRED_ERROR;
  }

  async *streamResponse(_request: StreamRequest): AsyncGenerator<ProviderEvent> {
    yield { type: 'error', error: JULES_APPROVAL_REQUIRED_ERROR };
  }
}
