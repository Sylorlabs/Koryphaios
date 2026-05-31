/**
 * Model Settings Service
 */

import { db, modelSettings } from '../db';
import type { ProviderName } from '@koryphaios/shared';
import { nanoid } from 'nanoid';
import { eq, and } from 'drizzle-orm';

export async function getEnabledModelIds(userId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(modelSettings)
    .where(and(eq(modelSettings.userId, userId), eq(modelSettings.isChecked, 1)));
  return rows.map((r) => (r.provider ? `${r.provider}:${r.modelId}` : r.modelId));
}

export async function getEnabledModelsForRouting(
  userId: string,
): Promise<{ modelId: string; provider: ProviderName }[]> {
  const rows = await db
    .select()
    .from(modelSettings)
    .where(and(eq(modelSettings.userId, userId), eq(modelSettings.isChecked, 1)));
  return rows.map((r) => ({ modelId: r.modelId, provider: r.provider as ProviderName }));
}

export async function setModelChecked(
  userId: string,
  modelId: string,
  provider: ProviderName,
  isChecked: boolean,
): Promise<void> {
  const now = new Date();
  await db
    .insert(modelSettings)
    .values({
      id: nanoid(12),
      userId,
      modelId,
      provider,
      isChecked: isChecked ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    } as any)
    .onConflictDoUpdate({
      target: [modelSettings.userId, modelSettings.modelId],
      set: { isChecked: isChecked ? 1 : 0, updatedAt: now },
    });
}

export function ensureModelSettingsTable(): void {}
