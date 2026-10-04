import type { CapabilityModelDef } from '../types';
import { KLING_IMAGE_MODELS, KLING_VIDEO_MODELS } from './klingai';
import { LUMA_IMAGE_MODELS, LUMA_VIDEO_MODELS } from './luma';
import { PRODIA_IMAGE_MODELS, PRODIA_VIDEO_MODELS } from './prodia';
import { REPLICATE_MODEL_PRESETS } from './replicate';

/**
 * Model lists for the modality pickers.
 *
 * Re-exported from the adapter modules that actually call them, so the picker
 * and the request path can never disagree about which model ids exist. These
 * are defaults, not an entitlement claim: every surface also accepts any other
 * model id the user's account can run.
 */
export {
  KLING_IMAGE_MODELS,
  KLING_VIDEO_MODELS,
  LUMA_IMAGE_MODELS,
  LUMA_VIDEO_MODELS,
  PRODIA_IMAGE_MODELS,
  PRODIA_VIDEO_MODELS,
  REPLICATE_MODEL_PRESETS,
};

export const LMNT_SPEECH_MODELS: CapabilityModelDef[] = [
  { id: 'blizzard', label: 'Blizzard 2', capability: 'audio' },
  { id: 'aurora', label: 'Aurora', capability: 'audio' },
];

export const VOYAGE_EMBEDDING_MODELS: CapabilityModelDef[] = [
  { id: 'voyage-3.5', label: 'Voyage 3.5', capability: 'embedding' },
  { id: 'voyage-3.5-lite', label: 'Voyage 3.5 Lite', capability: 'embedding' },
  { id: 'voyage-3-large', label: 'Voyage 3 Large', capability: 'embedding' },
  { id: 'voyage-code-3', label: 'Voyage Code 3', capability: 'embedding' },
];

export const VOYAGE_RERANK_MODELS: CapabilityModelDef[] = [
  { id: 'rerank-3', label: 'Rerank 3', capability: 'rerank' },
  { id: 'rerank-3-lite', label: 'Rerank 3 Lite', capability: 'rerank' },
  { id: 'rerank-2.5', label: 'Rerank 2.5', capability: 'rerank' },
];

/** Every capability provider that can serve each modality, for pickers. */
export const CAPABILITY_IMAGE_MODELS = new Map<string, CapabilityModelDef[]>([
  ['prodia', PRODIA_IMAGE_MODELS],
  ['luma', LUMA_IMAGE_MODELS],
  ['klingai', KLING_IMAGE_MODELS],
  ['replicate', REPLICATE_MODEL_PRESETS.filter((model) => model.capability === 'image')],
]);

export const CAPABILITY_VIDEO_MODELS = new Map<string, CapabilityModelDef[]>([
  ['luma', LUMA_VIDEO_MODELS],
  ['klingai', KLING_VIDEO_MODELS],
  ['prodia', PRODIA_VIDEO_MODELS],
  ['replicate', REPLICATE_MODEL_PRESETS.filter((model) => model.capability === 'video')],
]);
