/** Opt-in live Critic probe. Only synthetic prompts and disposable files leave
 * the host. Never logs credentials or changes the application's configuration.
 * bun run scripts/probe-critic-auto-cline.ts --live --config /path/koryphaios.json
 */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (!process.argv.includes('--live')) throw new Error('Pass --live to run real Cline requests.');
const configArg = process.argv.indexOf('--config');
const configPath = configArg >= 0 ? resolve(process.argv[configArg + 1]) : undefined;
const apiKey = process.env.CLINE_API_KEY || (configPath
  ? JSON.parse(readFileSync(configPath, 'utf8')).providers?.cline?.apiKey : undefined);
if (!apiKey) throw new Error('Set CLINE_API_KEY or provide a configuration containing the Cline key.');
const root = mkdtempSync(join(tmpdir(), 'kory-critic-cline-probe-'));
const project = join(root, 'project');
mkdirSync(project);
// Configure isolation before importing modules with database/log side effects.
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: join(root, 'probe.db'), PROJECT_ROOT: project,
  KORYPHAIOS_DATA_DIR: join(root, 'data'), KORYPHAIOS_SKILLS_HOME: join(root, 'skills'),
  LOG_DIR: join(root, 'logs'), KORY_DISABLE_CLI_AUTODETECT: '1',
});
const model = 'nvidia/nemotron-3.5-lightning:free';
const results: unknown[] = [];
try {
  const { ClineProvider } = await import('../backend/src/providers/cline');
  const { CRITIC_OUTPUT_CONTRACT, parseCriticReport } = await import('../backend/src/kory/critic-util');
  const { CRITIC_OUTPUT_TOKEN_LIMIT } = await import('../backend/src/kory/prompts');
  const provider = new ClineProvider({ name: 'cline', apiKey, baseUrl: 'https://api.cline.bot/api/v1' });
  await provider.refreshModels(true);
  const catalog = provider.listModels().find((row) => row.id === model);
  if (!catalog || catalog.costPerMInputTokens !== 0 || catalog.costPerMOutputTokens !== 0) {
    throw new Error('Exact zero-priced target is not confirmed in the live catalog.');
  }
  console.log(JSON.stringify({ model, contextWindow: catalog.contextWindow, outputLimit: catalog.maxOutputTokens, criticBudget: CRITIC_OUTPUT_TOKEN_LIMIT }));
  for (const [answer, expected] of [['437', 'PASS'], ['400', 'FAIL']] as const) {
    let content = '', thinkingChars = 0;
    let finishReason: string | undefined;
    const errors: string[] = [];
    let usage: unknown;
    const started = Date.now();
    for await (const event of provider.streamResponse({
      model, systemPrompt: `Independently check the proposed answer against the original request. No worker skills were supplied. ${CRITIC_OUTPUT_CONTRACT}`,
      messages: [{ role: 'user', content: `Original request: What is 19 multiplied by 23? Proposed answer: ${answer}.` }],
      tools: [], maxTokens: provider.name === 'cline' ? 8_192 : CRITIC_OUTPUT_TOKEN_LIMIT, signal: AbortSignal.timeout(60_000),
      harnessRole: 'critic', interactionMode: 'plan', workingDirectory: project,
    })) {
      if (event.type === 'content_delta') content += event.content ?? '';
      if (event.type === 'thinking_delta') thinkingChars += event.thinking?.length ?? 0;
      if (event.type === 'complete') finishReason = event.finishReason;
      if (event.type === 'error') errors.push(event.error ?? 'Provider error');
      if (event.type === 'usage_update') usage = { tokensIn: event.tokensIn, tokensOut: event.tokensOut };
    }
    const report = parseCriticReport(content, []);
    results.push({ stage: 'adapter', expected, actual: report?.verdict ?? null,
      passed: report?.verdict === expected && !errors.length, finishReason,
      thinkingChars, content, usage, errors, elapsedMs: Date.now() - started });
  }
  console.log(JSON.stringify({ results }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
