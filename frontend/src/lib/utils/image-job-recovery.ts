/**
 * A renderer reload must not abandon an image job already accepted by the
 * backend. Keep only an opaque, short-lived job id in session storage: image
 * bytes, prompts, provider credentials, and request options remain out of
 * browser persistence entirely.
 */

export type RecoverableImageJob = {
  jobId: string;
  expiresAt: number;
};

const STORAGE_KEY = 'koryphaios-active-image-job-v1';
export const IMAGE_JOB_RECOVERY_TTL_MS = 15 * 60_000;

function getSessionStorage(storage?: Storage): Storage | undefined {
  if (storage) return storage;
  if (typeof sessionStorage === 'undefined') return undefined;
  return sessionStorage;
}

function clean(value: unknown, now = Date.now()): RecoverableImageJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.jobId !== 'string' ||
    !raw.jobId ||
    raw.jobId.length > 128 ||
    typeof raw.expiresAt !== 'number' ||
    !Number.isFinite(raw.expiresAt) ||
    raw.expiresAt <= now
  ) {
    return null;
  }
  return { jobId: raw.jobId, expiresAt: raw.expiresAt };
}

export function loadRecoverableImageJob(
  storage?: Storage,
  now = Date.now(),
): RecoverableImageJob | null {
  const session = getSessionStorage(storage);
  if (!session) return null;
  try {
    const recovered = clean(JSON.parse(session.getItem(STORAGE_KEY) ?? 'null'), now);
    if (!recovered) session.removeItem(STORAGE_KEY);
    return recovered;
  } catch {
    try {
      session.removeItem(STORAGE_KEY);
    } catch {
      // Storage can be unavailable in private/restricted browser contexts.
    }
    return null;
  }
}

export function saveRecoverableImageJob(
  jobId: string,
  storage?: Storage,
  now = Date.now(),
): RecoverableImageJob | null {
  const session = getSessionStorage(storage);
  if (!session) return null;
  const job = clean({ jobId, expiresAt: now + IMAGE_JOB_RECOVERY_TTL_MS }, now);
  if (!job) return null;
  try {
    session.setItem(STORAGE_KEY, JSON.stringify(job));
    return job;
  } catch {
    return null;
  }
}

export function clearRecoverableImageJob(storage?: Storage): void {
  try {
    getSessionStorage(storage)?.removeItem(STORAGE_KEY);
  } catch {
    // Losing session storage must not interfere with a durable backend job.
  }
}
