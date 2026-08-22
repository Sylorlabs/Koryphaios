import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { getContext } from '../../context';
import { AuthenticationError, ValidationError } from '../../errors/types';

const EFFECT_PROMPTS: Record<string, string> = {
  none: '',
  cinematic: 'Cinematic lighting, dramatic composition, subtle film grain, high dynamic range.',
  illustration:
    'Polished editorial illustration, expressive shapes, rich color harmony, crisp detail.',
  neon: 'Neon glow, luminous color accents, atmospheric haze, deep contrast.',
  miniature: 'Tilt-shift miniature photography, tactile materials, shallow depth of field.',
  watercolor: 'Layered watercolor washes, textured paper, soft pigment blooms, elegant detail.',
};

const ImageRequest = t.Object({
  prompt: t.String({ minLength: 1, maxLength: 32000 }),
  effect: t.Optional(
    t.Union([
      t.Literal('none'),
      t.Literal('cinematic'),
      t.Literal('illustration'),
      t.Literal('neon'),
      t.Literal('miniature'),
      t.Literal('watercolor'),
    ]),
  ),
  size: t.Optional(
    t.Union([
      t.Literal('auto'),
      t.Literal('1024x1024'),
      t.Literal('1536x1024'),
      t.Literal('1024x1536'),
    ]),
  ),
  quality: t.Optional(
    t.Union([t.Literal('auto'), t.Literal('low'), t.Literal('medium'), t.Literal('high')]),
  ),
  background: t.Optional(
    t.Union([t.Literal('auto'), t.Literal('opaque'), t.Literal('transparent')]),
  ),
  outputFormat: t.Optional(t.Union([t.Literal('png'), t.Literal('jpeg'), t.Literal('webp')])),
});

type OpenAIImageResponse = {
  data?: Array<{ b64_json?: string; revised_prompt?: string }>;
  error?: { message?: string };
};

export const imageRoutes = new Elysia({ prefix: '/api/images' })
  .onBeforeHandle(({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
  })
  .get('/providers', () => {
    const config = getContext().providers.getConfigs().openai;
    return {
      ok: true,
      data: [{ id: 'openai', name: 'OpenAI Images', configured: Boolean(config?.apiKey) }],
    };
  })
  .post(
    '/generate',
    async ({ body }) => {
      const config = getContext().providers.getConfigs().openai;
      if (!config?.apiKey) {
        throw new ValidationError('Connect OpenAI in Providers before generating images.');
      }
      const effect = body.effect ?? 'none';
      const prompt = [body.prompt.trim(), EFFECT_PROMPTS[effect]].filter(Boolean).join('\n\n');
      const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
      const response = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-image-1',
          prompt,
          n: 1,
          size: body.size ?? '1024x1024',
          quality: body.quality ?? 'medium',
          background: body.background ?? 'auto',
          output_format: body.outputFormat ?? 'png',
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const result = (await response.json().catch(() => ({}))) as OpenAIImageResponse;
      if (!response.ok) {
        throw new ValidationError(
          result.error?.message || `OpenAI Images returned HTTP ${response.status}`,
        );
      }
      const image = result.data?.[0];
      if (!image?.b64_json) throw new ValidationError('OpenAI Images returned no image data.');
      const outputFormat = body.outputFormat ?? 'png';
      return {
        ok: true,
        data: {
          imageBase64: image.b64_json,
          mimeType: outputFormat === 'jpeg' ? 'image/jpeg' : `image/${outputFormat}`,
          revisedPrompt: image.revised_prompt,
          provider: 'openai',
          model: 'gpt-image-1',
        },
      };
    },
    { body: ImageRequest },
  );
