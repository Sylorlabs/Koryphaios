import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { serverLog } from '../logger';

export interface SkillUsageRecord {
  skill: string;
  count: number;
  lastUsedAt: string;
}

const usagePath = (projectRoot: string) =>
  join(resolve(projectRoot), '.koryphaios', 'skills', 'usage.json');

const validUsageRecord = (value: unknown): value is SkillUsageRecord => {
  const record = value as SkillUsageRecord;
  return Boolean(
    record &&
    typeof record.skill === 'string' &&
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(record.skill) &&
    Number.isInteger(record.count) &&
    record.count >= 0 &&
    typeof record.lastUsedAt === 'string' &&
    Number.isFinite(Date.parse(record.lastUsedAt)),
  );
};

export function listSkillUsage(projectRoot: string): SkillUsageRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(usagePath(projectRoot), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(validUsageRecord) : [];
  } catch (error: unknown) {
    serverLog.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to read skill usage ledger',
    );
    return [];
  }
}

/**
 * Record only aggregate selection counts. Prompts, session ids, and user data
 * are deliberately excluded from this health signal.
 */
export function recordSkillUsage(
  projectRoot: string,
  skills: string[],
  usedAt: Date | string = new Date(),
): SkillUsageRecord[] {
  const timestamp = usedAt instanceof Date ? usedAt : new Date(usedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('Invalid skill usage timestamp');
  const names = [...new Set(skills.map((name) => name.trim()).filter(Boolean))];
  if (names.some((name) => !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name))) {
    throw new Error('Invalid skill usage name');
  }
  if (!names.length) return listSkillUsage(projectRoot);

  const byName = new Map(listSkillUsage(projectRoot).map((record) => [record.skill, record]));
  const iso = timestamp.toISOString();
  for (const skill of names) {
    const previous = byName.get(skill);
    byName.set(skill, {
      skill,
      count: (previous?.count ?? 0) + 1,
      lastUsedAt: iso,
    });
  }
  const next = [...byName.values()].sort((left, right) => left.skill.localeCompare(right.skill));
  const path = usagePath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return next;
}
