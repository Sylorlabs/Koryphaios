import { getProcessHealthById, type PersistedProcess } from './database';

function parseMetadata(metadata?: string): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  try {
    return JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function serializeProcess(process: PersistedProcess | null | undefined) {
  if (!process) return null;

  const health = await getProcessHealthById(process.id);

  return {
    id: process.id,
    name: process.name,
    command: process.command,
    pid: process.pid,
    sessionId: process.sessionId,
    status: process.status,
    exitCode: process.exitCode,
    signal: process.signal,
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
