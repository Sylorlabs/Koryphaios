/** Official Codebuff API-key provider using @codebuff/sdk. */

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { CodebuffClient, type PrintModeEvent } from '@codebuff/sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGenericModel } from './models';
import type { Provider, ProviderEvent, StreamRequest } from './types';
import {
  buildKoryToolContext,
  buildOverrideTools,
  buildPrompt,
  translateSdkEvent,
} from './freebuff';

export const CODEBUFF_BASE_AGENT = 'codebuff/base@0.0.16';

export class CodebuffProvider implements Provider {
  readonly name = 'codebuff' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return !this.config.disabled && !!this.config.apiKey?.trim();
  }

  listModels(): ModelDef[] {
    const model = createGenericModel(CODEBUFF_BASE_AGENT, 'codebuff');
    model.name = 'Codebuff Base Agent 0.0.16';
    model.apiModelId = CODEBUFF_BASE_AGENT;
    return [model];
  }

  getModelDiscoveryError(): string | undefined {
    return 'The Codebuff SDK exposes runnable store agent IDs, not a model catalog. This adapter pins the documented codebuff/base@0.0.16 agent.';
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) {
      yield {
        type: 'error',
        error: 'Codebuff API key is missing. Create one at codebuff.com/api-keys.',
      };
      return;
    }
    if (!request.sessionId?.trim()) {
      yield {
        type: 'error',
        error:
          'Codebuff requires a Koryphaios session so SDK tools can be routed through Kory permissions.',
      };
      return;
    }
    const cwd = request.workingDirectory?.trim() || process.cwd();
    const role = request.harnessRole ?? 'manager';
    const interactionMode = request.permissionMode === 'plan' ? 'plan' : 'act';
    const toolContext = await buildKoryToolContext(
      request.sessionId,
      cwd,
      role,
      interactionMode,
      request,
      'codebuff',
    );
    // The published base agent contains a few SDK-local helpers that are not
    // part of overrideTools' public type. Keep their entire native filesystem
    // view disposable; only the explicit overrides below can reach the real
    // Kory workspace.
    const sdkWorkspace = mkdtempSync(join(tmpdir(), 'kory-codebuff-'));
    const eventQueue: ProviderEvent[] = [];
    let wake: (() => void) | null = null;
    let settled = false;
    let runError: Error | null = null;
    let runOutputError: string | null = null;
    let sawComplete = false;

    const pushEvent = (event: ProviderEvent): void => {
      if (event.type === 'complete') sawComplete = true;
      eventQueue.push(event);
      wake?.();
      wake = null;
    };
    const client = new CodebuffClient({
      apiKey,
      cwd: sdkWorkspace,
      overrideTools: buildOverrideTools(toolContext, 'codebuff'),
      fileFilter: () => ({ status: 'blocked' }),
      knowledgeFiles: {
        'knowledge.md': [
          request.systemPrompt,
          'Koryphaios owns authoritative filesystem and command execution. Supported SDK filesystem and terminal tools are overridden and routed through Kory ToolRegistry and permission policy. Any provider-local planning artifact is confined to a disposable workspace and does not change the real project.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      maxAgentSteps: 50,
      handleEvent: (event: PrintModeEvent) => {
        for (const translated of translateSdkEvent(event) ?? []) pushEvent(translated);
      },
    });
    const runPromise = client
      .run({
        agent: request.model || CODEBUFF_BASE_AGENT,
        prompt: buildPrompt(request.systemPrompt, request.messages),
        signal: request.signal,
      })
      .then((state) => {
        if (state.output.type === 'error') runOutputError = state.output.message;
      })
      .catch((error: unknown) => {
        runError = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        settled = true;
        wake?.();
        wake = null;
      });

    while (!settled || eventQueue.length > 0) {
      if (eventQueue.length > 0) {
        yield eventQueue.shift()!;
        continue;
      }
      await new Promise<void>((resolveWait) => {
        wake = resolveWait;
      });
    }
    await runPromise;
    const finalRunError = runError as Error | null;
    if (finalRunError) {
      rmSync(sdkWorkspace, { recursive: true, force: true });
      yield { type: 'error', error: `Codebuff SDK run failed: ${finalRunError.message}` };
      return;
    }
    if (runOutputError) {
      rmSync(sdkWorkspace, { recursive: true, force: true });
      yield { type: 'error', error: `Codebuff run failed: ${runOutputError}` };
      return;
    }
    rmSync(sdkWorkspace, { recursive: true, force: true });
    if (!sawComplete) yield { type: 'complete', finishReason: 'end_turn' };
  }
}
