#!/usr/bin/env bun
/** Explicit opt-in live smoke: real Freebuff TUI -> signed MCP -> real read_note.
 * Uses only a synthetic note and disposable DB. No credentials or model output
 * are printed. Never run as part of the closed-transport core test suite. */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

if (process.env.KORY_RUN_LIVE_PROVIDER_TESTS !== '1') {
  console.error(
    'Set KORY_RUN_LIVE_PROVIDER_TESTS=1 to authorize a real Freebuff turn using the CLI-owned login.',
  );
  process.exit(2);
}
const root = mkdtempSync(join(tmpdir(), 'kory-freebuff-live-notes-'));
process.env.DATABASE_URL = join(root, 'probe.db');
process.env.KORYPHAIOS_DATA_DIR = join(root, 'data');
process.env.PROJECT_ROOT = root;
const { initDb, getDb } = await import('../backend/src/db');
const { createNote } = await import('../backend/src/notes/notes-service');
const { readNoteTool } = await import('../backend/src/tools/notes');
const { ToolRegistry } = await import('../backend/src/tools/registry');
const { resolveToolPermissionPolicy } = await import('../backend/src/tools/permission-policy');
const { DEFAULT_AGENT_SETTINGS } = await import('../backend/src/agent-settings');
const { verifySignedBridgeRequest } = await import('../backend/src/providers/bridge-grant');
const { discoverFreebuffAccounts } = await import('../backend/src/providers/auth-utils');
const { FreebuffProvider, freebuffStartupState, readFreebuffLogRows } =
  await import('../backend/src/providers/freebuff-cli');
const { refreshFreebuffRuntimeStatus, createFreebuffTurnRuntime } =
  await import('../backend/src/providers/freebuff-runtime');

let server: ReturnType<typeof Bun.serve> | undefined;
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 360_000);
try {
  const accounts = discoverFreebuffAccounts();
  if (!accounts.length)
    throw new Error('No Freebuff CLI account is available. Run freebuff login first.');
  const settingsPath = join(accounts[0]!.profileDir, 'settings.json');
  if (existsSync(settingsPath)) {
    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error();
    } catch {
      throw new Error(
        'Freebuff CLI settings are malformed. Open the CLI and repair its settings before this probe.',
      );
    }
    if (
      settings.mode === 'byok' ||
      settings.alwaysUseALaCarte === true ||
      settings.fallbackToALaCarte === true
    )
      throw new Error(
        'This smoke probe refuses BYOK or automatic paid-credit billing. Select a free CLI mode first.',
      );
  }
  const runtime = await refreshFreebuffRuntimeStatus(true);
  if (!runtime.available) throw new Error(runtime.reason ?? 'Freebuff runtime is unavailable');
  await initDb();
  const title = `Kory Freebuff smoke ${randomBytes(6).toString('hex')}`;
  const expected = `KORY_NOTE_${randomBytes(16).toString('hex')}`;
  const note = await createNote({ title, content: `Verification code: ${expected}` }, root);
  const registry = new ToolRegistry();
  registry.register(readNoteTool);
  let bridgeReads = 0;
  const sessionId = `freebuff-smoke-${randomBytes(8).toString('hex')}`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (
        request.method !== 'POST' ||
        !['/api/v1/mcp-bridge/catalog', '/api/v1/mcp-bridge/execute'].includes(path)
      )
        return new Response('Not found', { status: 404 });
      const body = (await request.json()) as Record<string, any>;
      const grant = verifySignedBridgeRequest(request.headers, 'mcp', request.method, path, body);
      if (
        !grant ||
        grant.sessionId !== sessionId ||
        grant.role !== 'critic' ||
        body.sessionId !== sessionId ||
        body.role !== 'critic'
      )
        return new Response('Unauthorized', { status: 401 });
      if (path.endsWith('/catalog'))
        return Response.json({
          tools: [
            {
              name: 'kory__read_note',
              description: readNoteTool.description,
              inputSchema: readNoteTool.inputSchema,
            },
          ],
        });
      if (
        body.toolName !== 'read_note' ||
        (body.input?.id !== note.id && body.input?.title !== title)
      )
        return Response.json({
          output: 'Only the synthetic verification note is available.',
          isError: true,
        });
      const result = await registry.execute(
        {
          sessionId,
          agentId: 'freebuff-live-smoke',
          callerRole: 'critic',
          workingDirectory: root,
          settingsRoot: root,
          allowedPaths: [root],
          validateToolInput: true,
          signal: abort.signal,
          permissionPolicy: resolveToolPermissionPolicy({
            ...DEFAULT_AGENT_SETTINGS,
            permissionMode: 'ask',
          }),
        },
        { id: `smoke-read-${++bridgeReads}`, name: 'read_note', input: body.input },
      );
      return Response.json({ output: result.output, isError: result.isError });
    },
  });
  process.env.KORYPHAIOS_HOST = '127.0.0.1';
  process.env.KORYPHAIOS_PORT = String(server.port);
  const provider = new FreebuffProvider(
    { name: 'freebuff', disabled: false },
    process.env.KORY_FREEBUFF_PROBE_DIAGNOSTICS === '1'
      ? {
          createRuntime: async (options) => {
            const runtime = await createFreebuffTurnRuntime(options);
            let polls = 0;
            let pasted = false;
            let capturePolls = 0;
            return {
              ...runtime,
              tmux: async (args) => {
                let result: string;
                try {
                  result = await runtime.tmux(args);
                } catch (error) {
                  if (args[0] === 'has-session') {
                    const pane = await runtime
                      .tmux(['capture-pane', '-p', '-J', '-t', runtime.session])
                      .catch(() => '');
                    console.log(
                      JSON.stringify({
                        stage: 'private_runtime_exit',
                        paneCharacters: pane.length,
                        freebucksVisible: /Freebucks/i.test(pane),
                        insufficientFreebucks: /not enough freebucks/i.test(pane),
                        errorVisible: /error|failed|unavailable/i.test(pane),
                        loginVisible: /sign in|log in/i.test(pane),
                        errorCode: (error as { code?: string | number }).code,
                      }),
                    );
                  }
                  throw error;
                }
                if (args[0] === 'paste-buffer') pasted = true;
                if (pasted && args[0] === 'capture-pane' && ++capturePolls % 5 === 1) {
                  const prompt = readFileSync(join(options.runRoot, 'prompt.txt'), 'utf8');
                  console.log(
                    JSON.stringify({
                      stage: 'paste_receipt',
                      expectedCharacters: prompt.length,
                      nativeTextCard: /\d[\d,]* chars/.test(result),
                      pasteToast: /Pasted text/.test(result),
                      promptSuffixVisible: result
                        .replace(/\s+/g, ' ')
                        .includes(prompt.trim().slice(-64).replace(/\s+/g, ' ')),
                      compactSuffixVisible: result
                        .replace(/\s+/g, '')
                        .includes(prompt.trim().slice(-64).replace(/\s+/g, '')),
                      shortSuffixVisible: result.includes(prompt.trim().slice(-12)),
                      promptWordsVisible: prompt
                        .split(/\s+/)
                        .filter((word) => word.length > 4 && result.includes(word)).length,
                      paneCharacters: result.length,
                      startupState: freebuffStartupState(result),
                    }),
                  );
                }
                if (args[0] === 'has-session' && ++polls % 5 === 1) {
                  const pane = await runtime.tmux([
                    'capture-pane',
                    '-p',
                    '-J',
                    '-t',
                    runtime.session,
                  ]);
                  const rows = await readFreebuffLogRows(
                    runtime,
                    join(options.runHome, '.config/manicode/projects'),
                    new Map(),
                  );
                  // Only fixed classifications/counters: never panes, row data, model handles or prompts.
                  console.log(
                    JSON.stringify({
                      stage: 'private_runtime_evidence',
                      startupState: freebuffStartupState(pane),
                      freebucksVisible: /Freebucks/i.test(pane),
                      confirmationVisible: /confirm|start session|purchase|take over/i.test(pane),
                      sessionStarting: /starting your model session|your message is saved/i.test(
                        pane,
                      ),
                      sessionConfirm: /enter: confirm and send/i.test(pane),
                      sessionRetry: /enter: retry/i.test(pane),
                      takeoverVisible: /take over/i.test(pane),
                      balanceUnavailable: /balance unavailable/i.test(pane),
                      insufficientFreebucks: /not enough freebucks/i.test(pane),
                      errorVisible: /error|failed|unavailable/i.test(pane),
                      submitted: rows.some(
                        (row) => row.msg === '[send-message] Sending message with sdk run config',
                      ),
                      agentStarted: rows.some(
                        (row) => typeof row.msg === 'string' && row.msg.startsWith('Start agent '),
                      ),
                      mainFinished: rows.some((row) => row.msg === 'Main prompt finished'),
                      mainOutputTypes: rows
                        .filter((row) => row.msg === 'Main prompt finished')
                        .map((row) => {
                          const data =
                            row.data && typeof row.data === 'object'
                              ? (row.data as Record<string, unknown>)
                              : {};
                          const values = Object.values(data).filter(
                            (value): value is string => typeof value === 'string',
                          );
                          return {
                            outputType:
                              typeof data.outputType === 'string' ? data.outputType : 'missing',
                            quotaMentioned: values.some((value) =>
                              /freebucks?|quota|balance|limit/i.test(value),
                            ),
                            modelMentioned: values.some((value) =>
                              /model|catalog|entitlement/i.test(value),
                            ),
                            errorMentioned: values.some((value) =>
                              /error|failed|unavailable/i.test(value),
                            ),
                          };
                        }),
                      rootEndCount: rows.filter((row) => {
                        if (typeof row.msg !== 'string' || !row.msg.startsWith('End agent '))
                          return false;
                        const data =
                          row.data && typeof row.data === 'object'
                            ? (row.data as Record<string, unknown>)
                            : {};
                        return data.agentId === 'main-agent';
                      }).length,
                      logRows: rows.length,
                    }),
                  );
                }
                return result;
              },
            };
          },
        }
      : {},
  );
  const models = await provider.refreshModels();
  if (!models.length)
    throw new Error(provider.getModelDiscoveryError() ?? 'CLI model discovery failed');
  const requestedModel = process.env.KORY_FREEBUFF_PROBE_MODEL;
  const selectedModel = requestedModel
    ? models.find((model) => model.id === requestedModel || model.apiModelId === requestedModel)
    : models[0];
  if (!selectedModel)
    throw new Error('The requested live probe model is not available in the account catalog.');
  console.log(
    JSON.stringify({
      stage: 'live_turn',
      runtime: runtime.kind,
      cliVersion: runtime.version,
      syntheticOnly: true,
      explicitAccountModel: selectedModel.apiModelId?.startsWith('freebuff/catalog-') === true,
    }),
  );
  let complete = false;
  let matched = false;
  let error: string | undefined;
  let inputContextTokens = 0;
  let processedInputTokens = 0;
  let billingSamples = 0;
  let accountAttributed = false;
  for await (const event of provider.streamResponse({
    sessionId,
    model: selectedModel.id,
    reasoningLevel: process.env.KORY_FREEBUFF_PROBE_REASONING,
    workingDirectory: root,
    harnessRole: 'critic',
    signal: abort.signal,
    systemPrompt: [
      'This is a synthetic integration check. Use the configured Kory MCP read_note tool only. Do not inspect local files or run commands. Read the requested note and reply with its exact verification code, and nothing else. No notes or files may be written.',
      process.env.KORY_FREEBUFF_PROBE_LONG_PROMPT === '1'
        ? 'Additional synthetic transport context: the verification code must be obtained only from the configured Kory read_note tool.\n'.repeat(
            40,
          )
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    messages: [
      {
        role: 'user',
        content: `Read the Kory note titled ${JSON.stringify(title)} using the configured MCP read_note tool. Reply with its verification code. The code is not in this prompt; you must retrieve the note.`,
      },
    ],
  })) {
    if (event.type === 'content_delta' && event.content?.includes(expected)) matched = true;
    if (event.type === 'complete') complete = true;
    if (event.type === 'error') error = event.error;
    if (event.type === 'usage_update' && event.usagePrecision === 'input-context-only') {
      inputContextTokens = event.tokensIn ?? 0;
      processedInputTokens = event.billingTokensIn ?? 0;
      billingSamples = event.billingUsageSamples?.length ?? 0;
      accountAttributed = event.accountId === accounts[0]!.id;
    }
  }
  const billingUsageVerified =
    inputContextTokens > 0 &&
    processedInputTokens >= inputContextTokens &&
    billingSamples > 0 &&
    accountAttributed;
  const verified = complete && matched && bridgeReads > 0 && billingUsageVerified && !error;
  console.log(
    JSON.stringify({
      verified,
      completed: complete,
      matchedSyntheticNote: matched,
      signedBridgeReads: bridgeReads,
      billingUsageVerified,
      inputContextTokens,
      processedInputTokens,
      billingSamples,
      accountAttributed,
      ...(error ? { error } : {}),
    }),
  );
  if (!verified) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Freebuff smoke failed');
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  abort.abort();
  server?.stop(true);
  try {
    getDb().close();
  } catch {
    /* database may not have opened */
  }
  rmSync(root, { recursive: true, force: true });
}
