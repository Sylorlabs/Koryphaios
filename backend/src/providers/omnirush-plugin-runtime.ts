// Bundled by omnirush-plugin-bundle.ts. The default export is the native
// OpenCode 2.x plugin; KoryToolsV1 remains a compatibility export for the
// direct bridge test and older engines.
import { z } from 'zod/v4';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { ProviderToolDef } from './types';

interface ToolContext {
  abort?: AbortSignal;
  callID?: string;
}
interface PluginTool {
  description: string;
  args: z.ZodRawShape;
  execute(input: unknown, context?: ToolContext): Promise<string>;
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
    .join(',')}}`;
}

export async function KoryToolsV1(options: { markReady?: boolean } = {}) {
  const settings = JSON.parse(readFileSync(new URL('./turn.json', import.meta.url), 'utf8')) as {
    tools: ProviderToolDef[];
    authFile: string;
    backendUrl: string;
    systemPrompt: string;
    readyFile?: string;
  };
  const allowed = new Map(settings.tools.map((t) => [t.name, t]));
  const tool: Record<string, PluginTool> = Object.create(null);
  for (const [name, definition] of allowed) {
    // Keep the full JSON Schema validator, including nested constraints, and
    // expose its raw object shape as required by OpenCode's plugin tool API.
    const schema = z.fromJSONSchema(definition.inputSchema) as z.ZodObject;
    if (!schema.shape) throw new Error('Kory tool requires an object input schema');
    tool[name] = {
      description: definition.description,
      args: schema.shape,
      async execute(input: unknown, context: ToolContext = {}) {
        const validated = schema.parse(input);
        const grant = JSON.parse(readFileSync(settings.authFile, 'utf8'));
        if (
          grant.version !== 1 ||
          grant.expiresAt <= Date.now() ||
          !grant.actions.includes('mcp:execute')
        ) {
          throw new Error('Kory tool authorization expired or unavailable');
        }
        const path = '/api/v1/mcp-bridge/execute';
        const body = {
          sessionId: grant.sessionId,
          role: grant.role,
          toolName: name.replace(/^kory__/, ''),
          input: validated,
          target: {
            kind: 'local',
            backendId: process.env.KORY_BACKEND_ID?.trim() || 'local',
          },
        };
        const timestamp = Date.now();
        const nonce = randomBytes(18).toString('base64url');
        const digest = createHash('sha256').update(canonical(body)).digest('base64url');
        const payload = ['kory-bridge-v1', 'mcp', 'POST', path, timestamp, nonce, digest].join(
          '\n',
        );
        const signature = createHmac('sha256', Buffer.from(grant.secret, 'base64url'))
          .update(payload)
          .digest('base64url');
        const response = await fetch(`${settings.backendUrl}${path}`, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-kory-bridge-grant': grant.grantId,
            'x-kory-bridge-timestamp': String(timestamp),
            'x-kory-bridge-nonce': nonce,
            'x-kory-bridge-signature': signature,
          },
          body: JSON.stringify(body),
          signal: context.abort
            ? AbortSignal.any([context.abort, AbortSignal.timeout(300_000)])
            : AbortSignal.timeout(300_000),
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500).replace(/\s+/g, ' ').trim();
          throw new Error(
            `Kory backend rejected tool request (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
          );
        }
        const result = (await response.json()) as { output?: unknown; isError?: unknown };
        if (
          typeof result.output !== 'string' ||
          (result.isError !== undefined && typeof result.isError !== 'boolean')
        ) {
          throw new Error('Kory backend returned an invalid tool result');
        }
        if (result.isError) throw new Error(result.output);
        return result.output;
      },
    };
  }
  if (options.markReady !== false) {
    writeFileSync(
      settings.readyFile ?? new URL('./ready.json', import.meta.url),
      JSON.stringify({ tools: [...allowed.keys()] }),
      { mode: 0o600 },
    );
  }
  return {
    tool,
    'experimental.chat.system.transform': async (_input: unknown, output: { system: string[] }) => {
      output.system.splice(
        0,
        output.system.length,
        settings.systemPrompt,
        'You are running inside Koryphaios. Use only the supplied kory__ custom tools. Native tools and native subagents are disabled. Koryphaios owns workspace access and permissions.',
      );
    },
    'tool.execute.before': async (input: { tool: string }) => {
      if (!allowed.has(input.tool))
        throw new Error('Native tools are disabled. Use the Kory tools.');
    },
  };
}

/** OpenCode 2.x does not consume the V1 returned `tool` map. Register each
 * bridge tool through the native replayable tool catalog transform instead. */
export default {
  id: 'koryphaios.kory-tools',
  async setup(ctx: {
    tool: {
      transform(callback: (editor: { add(tool: unknown): void }) => void): Promise<unknown>;
      hook(
        name: 'execute.before',
        callback: (event: { tool?: unknown }) => Promise<void>,
      ): Promise<unknown>;
    };
    session: {
      hook(
        name: 'context',
        callback: (event: { system?: unknown[] }) => Promise<void>,
      ): Promise<unknown>;
    };
  }) {
    const hooks = await KoryToolsV1({ markReady: false });
    const settings = JSON.parse(readFileSync(new URL('./turn.json', import.meta.url), 'utf8')) as {
      tools: ProviderToolDef[];
      systemPrompt: string;
      readyFile?: string;
    };
    await ctx.tool.transform((editor) => {
      for (const definition of settings.tools) {
        const implementation = hooks.tool[definition.name];
        if (!implementation) throw new Error(`Kory tool ${definition.name} was not initialized`);
        editor.add({
          name: definition.name,
          description: definition.description,
          input: definition.inputSchema,
          options: { codemode: false },
          async execute(input: unknown, context: { signal?: AbortSignal }) {
            return {
              content: await implementation.execute(input, { abort: context.signal }),
            };
          },
        });
      }
    });
    await ctx.tool.hook('execute.before', async (event) => {
      const toolName = typeof event.tool === 'string' ? event.tool : '';
      if (!settings.tools.some((definition) => definition.name === toolName)) {
        throw new Error('Native tools are disabled. Use the Kory tools.');
      }
    });
    await ctx.session.hook('context', async (event) => {
      if (!Array.isArray(event.system)) return;
      event.system.push(
        { type: 'text', text: settings.systemPrompt },
        {
          type: 'text',
          text: 'You are running inside Koryphaios. Use only the supplied kory__ custom tools. Native tools and native subagents are disabled. Koryphaios owns workspace access and permissions.',
        },
      );
    });
    // Write readiness only after the native catalog transform succeeds. This
    // keeps the provider's fail-closed check meaningful if registration fails.
    writeFileSync(
      settings.readyFile ?? new URL('./ready.json', import.meta.url),
      JSON.stringify({ tools: settings.tools.map((tool) => tool.name) }),
      { mode: 0o600 },
    );
  },
};
