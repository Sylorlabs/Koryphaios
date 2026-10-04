import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

// generate_video — lets agents produce short video clips through the video
// capability adapters (Luma Dream Machine, Kling AI, Prodia, Replicate).
//
// The tool returns a small JSON descriptor, not base64 video: a clip is far too
// large to inline into a model context. The completed clip is written to the
// video gallery and its history id is returned, and the user sees it rendered
// in the video studio.
//
// Generation is asynchronous upstream and typically takes minutes. The tool
// waits for the terminal state and reports a timeout as an error rather than
// pretending the job failed — the provider may still be rendering.

export interface GenerateVideoResult {
  provider: string;
  model: string;
  prompt: string;
  duration?: string;
  aspectRatio?: string;
  historyId?: string;
  note: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class GenerateVideoTool implements Tool {
  readonly name = 'generate_video';
  readonly description =
    'Generate a short video clip from a text description using a connected video provider ' +
    '(Luma Dream Machine, Kling AI, Prodia, or Replicate). Generation is asynchronous and usually ' +
    'takes 30 seconds to several minutes, so this tool blocks until the clip is ready or times out. ' +
    'The finished clip is saved to the video gallery and shown to the user — you cannot watch it ' +
    'yourself. Use this only when the user explicitly asks for video; for a still image, use the ' +
    'image studio instead. Confirm the provider and model with the user before calling when the ' +
    'choice is not obvious, because video generation is billed per clip.';
  readonly role = 'manager' as const;

  readonly inputSchema = {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'What the video should show, including subject, motion, and camera direction.',
      },
      provider: {
        type: 'string',
        description:
          'Connected video provider id. Known ids: luma, klingai, prodia, replicate.',
      },
      model: {
        type: 'string',
        description:
          'Provider model id. Ask the user which they prefer when unsure.',
      },
      duration: {
        type: 'string',
        description:
          'Clip length, e.g. "5s" or "10s". Availability depends on the provider and model.',
      },
      aspectRatio: {
        type: 'string',
        description: 'Frame shape, e.g. "16:9", "9:16", "1:1".',
      },
      negativePrompt: {
        type: 'string',
        description: 'What to avoid in the clip (Kling and Replicate support this).',
      },
      resolution: { type: 'string', description: 'Optional resolution, e.g. "720p" or "1080p", when supported by the model.' },
      sound: { type: 'boolean', description: 'Generate synchronized audio when supported by the selected model.' },
      seed: { type: 'integer', description: 'Optional reproducibility seed when supported by the model.' },
    },
    required: ['prompt', 'provider', 'model'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const started = Date.now();
    const fail = (output: string): ToolCallOutput => ({
      callId: call.id,
      name: this.name,
      output,
      isError: true,
      durationMs: Date.now() - started,
    });

    const prompt = asString(call.input.prompt);
    if (!prompt) return fail('Error: A non-empty prompt is required to generate a video.');

    // Imported lazily so the tool module does not pull the billing and spend-cap
    // stacks into every process that merely registers the toolset.
    const { runVideoJob } = await import('../routes/v1/video');

    try {
      const response = await runVideoJob(
        {
          prompt,
          provider: asString(call.input.provider),
          model: asString(call.input.model),
          duration: asString(call.input.duration),
          aspectRatio: asString(call.input.aspectRatio),
          negativePrompt: asString(call.input.negativePrompt),
          resolution: asString(call.input.resolution),
          sound: typeof call.input.sound === 'boolean' ? call.input.sound : undefined,
          seed: typeof call.input.seed === 'number' && Number.isSafeInteger(call.input.seed) ? call.input.seed : undefined,
        },
        { signal: ctx.signal },
      );
      const result: GenerateVideoResult = {
        provider: response.data.provider,
        model: response.data.model,
        prompt,
        duration: asString(call.input.duration),
        aspectRatio: asString(call.input.aspectRatio),
        historyId: response.data.historyId,
        note:
          'The clip is saved to the video gallery and shown to the user. You cannot view video ' +
          'frames; describe what you generated instead of claiming to have watched it.',
      };
      return {
        callId: call.id,
        name: this.name,
        output: JSON.stringify(result),
        isError: false,
        durationMs: Date.now() - started,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = /did not finish generating within/.test(message);
      return fail(
        timedOut
          ? `Error: The video provider did not finish in time. The clip may still finish upstream; ` +
              'tell the user it is still rendering rather than reporting failure. ' +
              message
          : `Error: Video generation failed. ${message}`,
      );
    }
  }
}
