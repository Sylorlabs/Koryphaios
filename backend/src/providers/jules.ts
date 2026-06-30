// Jules provider — Google Labs async cloud coding agent (API only).
//
// Jules runs tasks in remote VMs against GitHub repos (or repoless ephemeral envs).
// Unlike local CLI harnesses (Antigravity, Claude Code), Jules is cloud-only and
// returns progress via polled session activities.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import {
  type Provider,
  type ProviderEvent,
  type StreamRequest,
  getModelsForProvider,
} from './types';
import { detectJulesApiKey } from './auth-utils';
import { JulesModels } from './models/jules';
import { buildPrompt, runJulesTask } from './jules-runner';

export class JulesProvider implements Provider {
  readonly name = 'jules' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return !this.config.disabled && !!this.resolveApiKey();
  }

  /** Jules v1alpha has no models endpoint — these are virtual cloud agent selectors. */
  listModels(): ModelDef[] {
    return JulesModels.length > 0 ? JulesModels : getModelsForProvider('jules');
  }

  private resolveApiKey(): string | null {
    return this.config.apiKey?.trim() || detectJulesApiKey();
  }

  private readHeader(key: string): string | undefined {
    return this.config.headers?.[key];
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      yield {
        type: 'error',
        error:
          'Jules API key not configured. Create one at https://jules.google.com/settings#api and add it in Settings.',
      };
      return;
    }

    const prompt = buildPrompt(request.systemPrompt, request.messages);
    const defaultBranch =
      this.readHeader('x-kory-jules-default-branch') ??
      process.env.JULES_DEFAULT_BRANCH ??
      'main';
    const automationMode =
      this.readHeader('x-kory-jules-automation-mode') ??
      process.env.JULES_AUTOMATION_MODE ??
      'AUTO_CREATE_PR';
    const requirePlanApproval =
      this.readHeader('x-kory-jules-require-plan-approval') === 'true' ||
      process.env.JULES_REQUIRE_PLAN_APPROVAL === 'true';
    const repolessFallback =
      this.readHeader('x-kory-jules-repoless-fallback') !== 'false' &&
      process.env.JULES_REPOLESS_FALLBACK !== 'false';

    yield* runJulesTask({
      apiKey,
      prompt,
      workingDirectory: request.workingDirectory,
      korySessionId: request.sessionId,
      defaultBranch,
      automationMode,
      requirePlanApproval,
      repolessFallback,
      signal: request.signal,
    });
  }
}