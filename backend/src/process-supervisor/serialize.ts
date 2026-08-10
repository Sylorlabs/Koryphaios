import { getProcessHealthById, type PersistedProcess } from './database';
import { serverLog } from '../logger';
import { redactSecretsInText } from '../security';

function parseMetadata(metadata?: string): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  try {
    return JSON.parse(metadata) as Record<string, unknown>;
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to parse process metadata JSON',
    );
    return undefined;
  }
}

export async function serializeProcess(process: PersistedProcess | null | undefined) {
  if (!process) return null;

  const health = await getProcessHealthById(process.id);

  return {
    id: process.id,
    name: process.name,
    command: redactSecretsInText(process.command, 4_000),
    commandReplayable: process.commandReplayable === true,
    pid: process.pid,
    sessionId: process.sessionId,
    status: process.status,
    provenance: process.provenance,
    supervision: process.supervision,
    isBackground: process.isBackground,
    exitCode: process.exitCode,
    signal: process.signal,
    terminalReason: process.terminalReason,
    terminalError: process.terminalError
      ? redactSecretsInText(process.terminalError, 2_000)
      : undefined,
    restartCount: process.restartCount,
    maxRestarts: process.maxRestarts,
    restartPolicy: process.restartPolicy,
    createdAt: process.createdAt,
    updatedAt: process.updatedAt,
    endedAt: process.endedAt,
    metadata: parseMetadata(process.metadata),
    health: health
      ? {
          isHealthy: health.isHealthy,
          consecutiveFailures: health.consecutiveFailures,
          lastHeartbeat: health.lastHeartbeat,
          lastError: health.lastError ?? undefined,
        }
      : undefined,
  };
}
