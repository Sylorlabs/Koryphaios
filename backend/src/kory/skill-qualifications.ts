import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { serverLog } from '../logger';

export type QualificationRole = 'worker' | 'critic';

export interface HarnessQualificationRecord {
  provider: string;
  model: string;
  harnessVersion: string;
  skill: string;
  role: QualificationRole;
  medium?: string;
  sampleSize: number;
  successes: number;
  quality: number;
  verification: number;
  updatedAt: string;
  evidence: string[];
}

const qualificationPath = (projectRoot: string) =>
  join(resolve(projectRoot), '.koryphaios', 'skills', 'qualifications.json');

export function listHarnessQualifications(projectRoot: string): HarnessQualificationRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(qualificationPath(projectRoot), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(validRecord) : [];
  } catch (err: unknown) {
    serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Failed to read harness qualifications file');
    return [];
  }
}

function validRecord(value: unknown): value is HarnessQualificationRecord {
  const item = value as HarnessQualificationRecord;
  return Boolean(
    item &&
    typeof item.provider === 'string' &&
    typeof item.model === 'string' &&
    typeof item.skill === 'string' &&
    (item.role === 'worker' || item.role === 'critic') &&
    Number.isInteger(item.sampleSize) &&
    item.sampleSize >= 0 &&
    Number.isInteger(item.successes) &&
    item.successes >= 0 &&
    item.successes <= item.sampleSize,
  );
}

export function saveHarnessQualification(
  projectRoot: string,
  record: HarnessQualificationRecord,
): HarnessQualificationRecord {
  if (!validRecord(record)) throw new Error('Invalid harness qualification record');
  if (![record.quality, record.verification].every((value) => value >= 0 && value <= 1)) {
    throw new Error('Qualification dimensions must be between 0 and 1');
  }
  const records = listHarnessQualifications(projectRoot);
  const key = (item: HarnessQualificationRecord) =>
    [item.provider, item.model, item.harnessVersion, item.skill, item.role, item.medium ?? ''].join(
      '\0',
    );
  const next = [...records.filter((item) => key(item) !== key(record)), record];
  const path = qualificationPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return record;
}

function conservativeScore(records: HarnessQualificationRecord[]): number | null {
  const eligible = records.filter((item) => item.sampleSize >= 3);
  if (!eligible.length) return null;
  const samples = eligible.reduce((sum, item) => sum + item.sampleSize, 0);
  const successes = eligible.reduce((sum, item) => sum + item.successes, 0);
  const passRate = (successes + 1) / (samples + 2);
  const quality = eligible.reduce((sum, item) => sum + item.quality * item.sampleSize, 0) / samples;
  const verification =
    eligible.reduce((sum, item) => sum + item.verification * item.sampleSize, 0) / samples;
  return passRate * 0.5 + quality * 0.3 + verification * 0.2;
}

export function rankHarnessCandidates<T extends { model: string; provider: string | undefined }>(
  projectRoot: string,
  candidates: T[],
  role: QualificationRole,
  skills: string[],
  medium?: string,
): T[] {
  const records = listHarnessQualifications(projectRoot).filter(
    (item) =>
      item.role === role &&
      skills.includes(item.skill) &&
      (!medium || !item.medium || item.medium === medium),
  );
  const scored = candidates.map((candidate, index) => ({
    candidate,
    index,
    score: conservativeScore(
      records.filter(
        (item) =>
          item.provider === (candidate.provider ?? 'unknown') && item.model === candidate.model,
      ),
    ),
  }));
  const measured = scored
    .filter((item) => item.score !== null)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.index - right.index);
  let measuredIndex = 0;
  return scored.map((item) =>
    item.score === null ? item.candidate : measured[measuredIndex++].candidate,
  );
}
