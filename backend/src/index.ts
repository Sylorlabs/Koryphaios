// Koryphaios Backend Entry Point
// Main index for library usage or direct execution

export * from './providers';
export * from './tools';
export * from './kory';
export * from './bootstrap';
export * from './config-schema';
export * from './constants';
export * from './logger';
export * from './context';

// Sample selectModel usage showing how to resolve a model from tier + user preferences
import { selectModel } from './core/orchestration/ManagerSession';
import { getEnabledModelIds } from './core/model-settings';

/**
 * Sample demonstrating model selection based on user's checked models.
 */
export async function sampleSelectModel(intent: 'SMALL' | 'MEDIUM' | 'LARGE', userId: string) {
  const checked = await getEnabledModelIds(userId);

  if (checked.length === 0) {
    console.log('No models enabled by user. Using system defaults.');
  }

  return selectModel(intent, checked);
}
