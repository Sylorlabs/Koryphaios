// Shared Jules orchestration — polls cloud sessions and maps activities to ProviderEvents.

import type { ProviderContentBlock, ProviderEvent, ProviderMessage } from './types';
import {
  JulesClient,
  type JulesActivity,
  type JulesSession,
  matchJulesSource,
  resolveGitHubRepoFromDir,
} from './jules-client';
import { getJulesSessionMeta, setJulesSessionMeta } from './jules-session-store';
import { providerLog } from '../logger';
import { JULES_SYNC_INSTRUCTIONS } from './provider-display';

const POLL_INTERVAL_MS = 2_000;
const JULES_TIMEOUT_MS = 30 * 60_000;
const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED']);

export interface JulesRunConfig {
  apiKey: string;
  prompt: string;
  workingDirectory?: string;
  korySessionId?: string;
  resumeSessionId?: string;
  defaultBranch?: string;
  automationMode?: string;
  requirePlanApproval?: boolean;
  repolessFallback?: boolean;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function buildPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const lines: string[] = [];
  if (systemPrompt?.trim()) lines.push(systemPrompt.trim(), '');
  const turns = messages.filter((m) => m.role !== 'system');

  if (turns.length === 1 && turns[0].role === 'user' && lines.length === 0) {
    return flattenContent(turns[0].content);
  }

  for (const m of turns) {
    const text = flattenContent(m.content);
    if (!text.trim()) continue;
    const label =
      m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool result' : 'User';
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n\n');
}

function flattenContent(content: string | ProviderContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'tool_use')
      parts.push(`[tool call: ${block.toolName ?? 'tool'} ${JSON.stringify(block.toolInput ?? {})}]`);
    else if (block.type === 'tool_result') parts.push(`[tool result: ${block.toolOutput ?? ''}]`);
    else if (block.type === 'image') parts.push('[image omitted — Jules API text-only in this integration]');
  }
  return parts.join('\n');
}

function* mapActivityToEvents(activity: JulesActivity): Generator<ProviderEvent> {
  if (activity.planGenerated?.plan?.steps?.length) {
    const steps = activity.planGenerated.plan.steps
      .map((s, i) => `${i + 1}. ${s.title ?? 'Step'}`)
      .join('\n');
    yield { type: 'thinking_delta', thinking: `**Jules plan (cloud):**\n${steps}\n` };
  }

  if (activity.progressUpdated) {
    const title = activity.progressUpdated.title ?? 'Progress';
    const desc = activity.progressUpdated.description;
    yield {
      type: 'content_delta',
      content: desc ? `**${title}**\n${desc}\n` : `**${title}**\n`,
    };
  }

  for (const artifact of activity.artifacts ?? []) {
    if (artifact.bashOutput) {
      const cmd = artifact.bashOutput.command?.trim() ?? 'command';
      const out = artifact.bashOutput.output ?? '';
      const code = artifact.bashOutput.exitCode;
      yield {
        type: 'tool_executed',
        toolName: 'bash',
        toolInput: JSON.stringify({ command: cmd }),
        toolOutput: code !== undefined ? `${out}\n(exit ${code})` : out,
        isError: code !== undefined && code !== 0,
      };
    }

    const patch = artifact.changeSet?.gitPatch?.unidiffPatch;
    if (patch && patch.trim()) {
      const fileMatch = patch.match(/^\+\+\+ b\/(.+)$/m) ?? patch.match(/^--- a\/(.+)$/m);
      const filePath = fileMatch?.[1] ?? 'changes.patch';
      yield {
        type: 'file_edit',
        filePath,
        fileContent: patch,
        fileOperation: 'edit',
      };
    }
  }

  if (activity.sessionCompleted) {
    yield { type: 'content_delta', content: '\n**Jules session completed (cloud).**\n' };
  }
}

function formatSessionSummary(session: JulesSession): string {
  const lines: string[] = [];
  if (session.url) lines.push(`Session: ${session.url}`);
  if (session.state) lines.push(`State: ${session.state}`);
  for (const output of session.outputs ?? []) {
    if (output.pullRequest?.url) {
      lines.push(`Pull request: ${output.pullRequest.url}`);
      if (output.pullRequest.title) lines.push(`PR title: ${output.pullRequest.title}`);
    }
  }
  return lines.join('\n');
}

async function resolveSourceContext(
  client: JulesClient,
  workingDirectory: string | undefined,
  defaultBranch: string,
  repolessFallback: boolean,
): Promise<{ sourceContext?: { source: string; githubRepoContext: { startingBranch: string } }; repoless: boolean }> {
  if (!workingDirectory) {
    return { repoless: repolessFallback };
  }

  const git = await resolveGitHubRepoFromDir(workingDirectory);
  if (!git) {
    providerLog.info({ workingDirectory }, 'Jules: no GitHub origin — repoless if enabled');
    return { repoless: repolessFallback };
  }

  const sources = await client.listSources();
  const match = matchJulesSource(sources, git.owner, git.repo);
  if (!match?.name) {
    providerLog.warn(
      { owner: git.owner, repo: git.repo },
      'Jules: GitHub repo not connected in Jules settings — falling back to repoless',
    );
    return { repoless: repolessFallback };
  }

  return {
    sourceContext: {
      source: match.name,
      githubRepoContext: { startingBranch: git.branch || defaultBranch },
    },
    repoless: false,
  };
}

export async function* runJulesTask(config: JulesRunConfig): AsyncGenerator<ProviderEvent> {
  const prompt = config.prompt.trim();
  if (!prompt) {
    yield { type: 'error', error: 'Jules: empty prompt' };
    return;
  }

  const client = new JulesClient({ apiKey: config.apiKey, signal: config.signal });
  const defaultBranch = config.defaultBranch ?? process.env.JULES_DEFAULT_BRANCH ?? 'main';
  const repolessFallback = config.repolessFallback ?? process.env.JULES_REPOLESS_FALLBACK !== 'false';
  const automationMode =
    config.automationMode ?? process.env.JULES_AUTOMATION_MODE ?? 'AUTO_CREATE_PR';
  const requirePlanApproval =
    config.requirePlanApproval ?? process.env.JULES_REQUIRE_PLAN_APPROVAL === 'true';

  let julesSessionId = config.resumeSessionId;
  let isFollowUp = false;

  if (!julesSessionId && config.korySessionId) {
    const stored = await getJulesSessionMeta(config.korySessionId);
    if (stored?.sessionId) {
      julesSessionId = stored.sessionId;
      isFollowUp = true;
    }
  }

  yield {
    type: 'thinking_delta',
    thinking:
      '**Jules (cloud agent)** — task runs in a remote Google VM, not on this machine. Local files are unchanged until you pull or checkout the PR. Polling for progress…\n',
  };

  try {
    if (isFollowUp && julesSessionId) {
      await client.sendMessage(julesSessionId, prompt);
      yield {
        type: 'content_delta',
        content: `Continuing Jules cloud session \`${julesSessionId}\`…\n`,
      };
    } else {
      const { sourceContext, repoless } = await resolveSourceContext(
        client,
        config.workingDirectory,
        defaultBranch,
        repolessFallback,
      );

      const body: Parameters<JulesClient['createSession']>[0] = {
        prompt,
        title: prompt.slice(0, 80),
        requirePlanApproval,
      };

      if (sourceContext) {
        body.sourceContext = sourceContext;
        if (automationMode) body.automationMode = automationMode;
        yield {
          type: 'content_delta',
          content: `Starting Jules on **${sourceContext.source}** (branch \`${sourceContext.githubRepoContext.startingBranch}\`)…\n`,
        };
      } else if (repoless) {
        yield {
          type: 'content_delta',
          content: 'Starting **repoless** Jules session (ephemeral cloud environment)…\n',
        };
      } else {
        yield {
          type: 'error',
          error:
            'Jules: no GitHub source matched. Connect the repo in Jules settings or enable repoless fallback (JULES_REPOLESS_FALLBACK=true).',
        };
        return;
      }

      const created = await client.createSession(body);
      julesSessionId = created.id ?? created.name?.replace(/^sessions\//, '');
      if (!julesSessionId) {
        yield { type: 'error', error: 'Jules: session created but no session id returned' };
        return;
      }

      if (config.korySessionId) {
        await setJulesSessionMeta(config.korySessionId, {
          sessionId: julesSessionId,
          url: created.url,
          updatedAt: Date.now(),
        });
      }

      if (created.url) {
        yield { type: 'content_delta', content: `Jules session: ${created.url}\n` };
      }
    }

    const seenActivityIds = new Set<string>();
    let lastCreateTime: string | undefined;
    const startedAt = Date.now();

    while (true) {
      if (config.signal?.aborted) {
        yield { type: 'error', error: 'Jules: aborted' };
        return;
      }
      if (Date.now() - startedAt > JULES_TIMEOUT_MS) {
        yield {
          type: 'error',
          error: `Jules: timed out after ${JULES_TIMEOUT_MS / 60_000} minutes (cloud task still running)`,
        };
        return;
      }

      const activities = await client.listActivities(julesSessionId!, {
        pageSize: 50,
        createTime: lastCreateTime,
      });

      for (const activity of activities) {
        const aid = activity.id ?? activity.name;
        if (aid && seenActivityIds.has(aid)) continue;
        if (aid) seenActivityIds.add(aid);
        if (activity.createTime) lastCreateTime = activity.createTime;

        for (const event of mapActivityToEvents(activity)) yield event;

        if (activity.planGenerated && requirePlanApproval) {
          try {
            await client.approvePlan(julesSessionId!);
            yield { type: 'content_delta', content: 'Plan approved — Jules executing in the cloud…\n' };
          } catch (err) {
            providerLog.warn({ err }, 'Jules approvePlan failed');
          }
        }
      }

      const session = await client.getSession(julesSessionId!);
      if (session.state && TERMINAL_STATES.has(session.state)) {
        const summary = formatSessionSummary(session);
        if (summary) yield { type: 'content_delta', content: `\n${summary}\n` };

        if (session.state === 'FAILED') {
          yield { type: 'error', error: 'Jules cloud session failed' };
          return;
        }

        yield {
          type: 'content_delta',
          content: `\n**Sync to this machine:**\n${JULES_SYNC_INSTRUCTIONS}\n`,
        };

        if (config.korySessionId) {
          await setJulesSessionMeta(config.korySessionId, {
            sessionId: julesSessionId!,
            url: session.url,
            updatedAt: Date.now(),
          });
        }

        yield { type: 'complete', finishReason: 'end_turn' };
        return;
      }

      if (session.state === 'AWAITING_PLAN_APPROVAL' && requirePlanApproval) {
        try {
          await client.approvePlan(julesSessionId!);
        } catch {
          /* polled on next activity batch */
        }
      }

      await sleep(POLL_INTERVAL_MS, config.signal);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Abort')) {
      yield { type: 'error', error: 'Jules: aborted' };
      return;
    }
    yield { type: 'error', error: `Jules: ${msg}` };
  }
}

export { buildPrompt };