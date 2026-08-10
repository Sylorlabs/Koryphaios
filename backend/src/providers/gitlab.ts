// GitLab Duo provider — GitLab's hosted AI chat, via the GitLab Duo Chat Completions API.
//
// This is NOT OpenAI-compatible: the real endpoint is POST {instance}/api/v4/chat/completions
// with a GitLab-specific body ({ content, additional_context? }) authenticated by a GitLab
// PAT (Bearer), and it returns a single (non-streamed) JSON answer — not OpenAI SSE chunks.
// Ref: https://docs.gitlab.com/api/chat/
//
// GitLab documents this REST surface as internal/team-restricted. Until a
// supportable customer contract exists, the adapter remains visible but fails
// closed and never contacts GitLab.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { type Provider, type ProviderEvent, type StreamRequest } from './types';

export const GITLAB_DUO_UNAVAILABLE_ERROR =
  'GitLab Duo Chat is unavailable in this build. GitLab documents the REST Chat endpoint as internal-only on GitLab.com and restricted to GitLab team members; self-managed use also requires the access_rest_chat feature. Koryphaios will not treat a PAT or a generic /models response as proof of Duo access.';

export class GitLabProvider implements Provider {
  readonly name = 'gitlab' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    // Fail closed: a token cannot establish entitlement to GitLab's
    // internal/team-restricted Duo Chat REST endpoint.
    return false;
  }

  /** GitLab Duo Chat has no /models API — the endpoint picks the backend model. */
  listModels(): ModelDef[] {
    return [];
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    void request;
    yield { type: 'error', error: GITLAB_DUO_UNAVAILABLE_ERROR };
  }
}
