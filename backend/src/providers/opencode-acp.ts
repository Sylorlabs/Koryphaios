// OpenCode ACP (Agent Client Protocol) client.
//
// `opencode acp` (verified live against `opencode --version` 2.0.32, protocolVersion 1)
// speaks the generic ACP transport implemented in ./acp/client.ts. This module keeps
// the opencode-specific naming and the historical exports so existing callers and
// tests are unchanged. The transport, permission veto and session-update mapping
// are shared with the generic `acp:<id>` provider.

import type { spawn } from 'node:child_process';
import { AcpClient, type AcpClientOptions } from './acp/client';

export {
  ACP_PERMISSION_PROFILES,
  decideAcpPermission,
  isRecord,
  mapSessionUpdate,
  pickAcpPermissionOption,
  type AcpConfigOption,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPermissionDecision,
  type AcpPermissionProfile,
  type AcpPermissionRequest,
  type AcpPromptBlock,
  type AcpPromptResult,
  type AcpSessionEvent,
  type AcpStdioMcpServer,
} from './acp/protocol';

export interface OpenCodeAcpClientOptions {
  /** Executable to spawn (the CLI itself, or the OS sandbox wrapper). */
  command: string;
  /** Arguments for the executable — ['acp'] for a direct spawn. */
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Process seam: defaults to node's spawn; replay tests inject a transcript process. */
  spawnChild?: typeof spawn;
}

export class OpenCodeAcpClient extends AcpClient {
  constructor(opts: OpenCodeAcpClientOptions) {
    const shared: AcpClientOptions = {
      ...opts,
      providerName: 'opencode',
      label: 'OpenCode',
    };
    super(shared);
  }
}
