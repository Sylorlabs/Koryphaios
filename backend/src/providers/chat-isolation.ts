import { SANDBOX_PRESETS } from '@koryphaios/shared';
import { sessionWorkspaceOwnership } from '../kory/session-workspace';
import type { StreamRequest } from './types';

/** Provider execution cannot opt out of a host-owned chat write boundary.
 * API providers return tool calls to the registry. Native inference transports
 * must use an enforced outer jail or refuse the turn before spawning. */
export function enforceChatProviderIsolation(
  provider: string,
  request: StreamRequest,
): StreamRequest {
  if (!request.workingDirectory || !sessionWorkspaceOwnership(request.workingDirectory))
    return request;
  if (['codex', 'codex-auth', 'devin'].includes(provider)) {
    throw new Error(
      `Provider ${provider} cannot enforce isolated-chat filesystem writes yet. Select an API provider or a confined CLI provider; unsafe native execution is disabled.`,
    );
  }
  return {
    ...request,
    sandbox: {
      ...(request.sandbox ?? SANDBOX_PRESETS.readonly),
      filesystemIsolation: true,
      allowEdits: false,
      allowShell: false,
      allowNetwork: true,
    },
  };
}
