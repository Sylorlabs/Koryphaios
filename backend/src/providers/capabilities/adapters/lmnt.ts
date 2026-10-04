import { ValidationError } from '../../../errors/types';
import { capabilityFetch } from '../http';
import type {
  CapabilityAdapter,
  CapabilityMediaResult,
  CapabilityModelDef,
  CapabilitySpeechRequest,
  CapabilityVerifyResult,
  ResolvedCapabilityConfig,
} from '../types';

/**
 * LMNT speech synthesis.
 *
 * Base URL: `https://api.lmnt.com/v1`
 * Auth:     `X-API-Key: <key>` plus a required `lmnt-version` pin — LMNT does
 *           not accept `Authorization: Bearer`, and rejects unversioned calls.
 * Submit:   `POST /ai/speech/bytes` streams binary audio; `POST /ai/speech`
 *           answers with base64 JSON plus optional word timestamps.
 *
 * LMNT is text-to-speech only. Its published API surface is speech, speech
 * sessions, voices, and accounts — there is no transcription endpoint, so this
 * adapter never claims `stt`.
 */
const BASE_URL = 'https://api.lmnt.com/v1';
/** Pinned per LMNT's own API-versioning requirement. */
const LMNT_VERSION = '1.2';

const MODELS: CapabilityModelDef[] = [
  { id: 'blizzard', label: 'Blizzard 2', capability: 'audio' },
  { id: 'aurora', label: 'Aurora', capability: 'audio' },
];

const FORMATS = ['mp3', 'wav', 'aac', 'raw', 'mulaw'] as const;

function headers(config: ResolvedCapabilityConfig): Record<string, string> {
  return { 'X-API-Key': config.apiKey, 'lmnt-version': LMNT_VERSION };
}

export const lmntAdapter: CapabilityAdapter = {
  provider: 'lmnt',
  capabilities: ['audio'],
  defaultBaseUrl: BASE_URL,

  async verify(config, signal): Promise<CapabilityVerifyResult> {
    try {
      // The voices list is the cheapest authenticated read LMNT exposes.
      await capabilityFetch('LMNT', `${config.baseUrl}/ai/voices`, config, {
        headers: headers(config),
        signal,
        timeoutMs: 15_000,
      });
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `LMNT credential check failed: ${message}`,
        credentialProblem: /HTTP 40[13]|credential|unauthorized|forbidden|api.?key/i.test(message),
      };
    }
  },

  listModels(_config, capability): Promise<CapabilityModelDef[]> {
    return Promise.resolve(capability === 'audio' ? MODELS : []);
  },

  /**
   * Voices are discovered from the account rather than hard-coded, so a cloned
   * or private voice appears in the picker the moment it exists upstream.
   */
  async listVoices(config, signal): Promise<string[]> {
    const result = await capabilityFetch('LMNT', `${config.baseUrl}/ai/voices`, config, {
      headers: headers(config),
      signal,
    });
    const payload = result.json;
    const voices = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as Record<string, unknown> | undefined)?.voices)
        ? ((payload as Record<string, unknown>).voices as unknown[])
        : [];
    const ids = voices
      .map((voice) =>
        typeof voice === 'string'
          ? voice
          : typeof (voice as Record<string, unknown> | undefined)?.id === 'string'
            ? String((voice as Record<string, unknown>).id)
            : '',
      )
      .map((id) => id.trim())
      .filter(Boolean);
    if (!ids.length) {
      throw new ValidationError('LMNT returned no voices for this account.');
    }
    return [...new Set(ids)];
  },

  async synthesize(request: CapabilitySpeechRequest): Promise<CapabilityMediaResult> {
    const { config, signal } = request;
    const format = asFormat(request);
    const voice = request.voice?.trim();
    if (!voice) {
      throw new ValidationError('LMNT requires a voice id. Pick one in Voice settings.');
    }
    if (request.text.length > 5_000) {
      throw new ValidationError(
        `LMNT accepts up to 5,000 characters per request; this text is ${request.text.length}.`,
      );
    }
    const payload: Record<string, unknown> = {
      model: request.model,
      text: request.text,
      voice,
      format,
    };
    const speed = request.speed;
    if (typeof speed === 'number' && Number.isFinite(speed)) {
      // LMNT's sampling controls accept 0.25–2.
      payload.speed = Math.min(2, Math.max(0.25, speed));
    }
    // `/ai/speech/bytes` streams raw audio, which is what the composer plays.
    const result = await capabilityFetch('LMNT', `${config.baseUrl}/ai/speech/bytes`, config, {
      method: 'POST',
      headers: headers(config),
      json: payload,
      signal,
      timeoutMs: 120_000,
    });
    const bytes = result.bytes;
    if (!bytes?.byteLength) {
      throw new ValidationError('LMNT returned no audio for this request.');
    }
    return {
      capability: 'audio',
      dataBase64: Buffer.from(bytes).toString('base64'),
      mimeType: mimeTypeFor(format),
      meta: { model: request.model, voice, format },
    };
  },
};

/** Only forward a format LMNT actually publishes; anything else becomes mp3. */
function asFormat(request: CapabilitySpeechRequest): (typeof FORMATS)[number] {
  const requested = request.format?.trim().toLowerCase();
  return requested && (FORMATS as readonly string[]).includes(requested)
    ? (requested as (typeof FORMATS)[number])
    : 'mp3';
}

function mimeTypeFor(format: string): string {
  switch (format) {
    case 'wav':
    case 'raw':
      return 'audio/wav';
    case 'aac':
      return 'audio/aac';
    case 'mulaw':
      return 'audio/basic';
    default:
      return 'audio/mpeg';
  }
}

export const LMNT_MODELS = MODELS;
