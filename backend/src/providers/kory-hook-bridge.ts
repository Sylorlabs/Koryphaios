#!/usr/bin/env node
// Koryphaios CLI lifecycle hook bridge.
//
// This script is invoked by CLI lifecycle hooks (Devin hooks.v1.json, Claude
// Code .claude/hooks, Antigravity .claude/hooks). It reads the hook event from
// stdin (or CLI args), calls the Koryphaios backend hook endpoint, and writes
// the decision to stdout in the format the CLI expects.
//
// Usage (from hooks config):
//   node kory-hook-bridge.js --event <EventName> --session-id <sid> [--backend-url <url>]
//
// stdin: JSON object with tool_name, tool_input, tool_response, etc.
// stdout: JSON object with { decision: "approve"|"block", reason: string, ... }

import { readSync } from 'node:fs';
import { serverLog } from '../logger';
import { readBridgeGrantScopeFromFile, signedBridgeHeadersFromFile } from './bridge-grant';

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const HOOK_REQUEST_TIMEOUT_MS = 10_000;

/** Which decision words the calling CLI understands. */
export type HookDecisionVocabulary = 'claude' | 'antigravity';

function requestTimeoutMs(): number {
  if (process.env.NODE_ENV !== 'test') return HOOK_REQUEST_TIMEOUT_MS;
  const requested = Number(process.env.KORY_TEST_BRIDGE_TIMEOUT_MS);
  return Number.isFinite(requested)
    ? Math.max(25, Math.min(HOOK_REQUEST_TIMEOUT_MS, requested))
    : HOOK_REQUEST_TIMEOUT_MS;
}

export function parseArgs(argv: string[]): {
  event: string;
  backendUrl: string;
  authFile: string;
  decisionVocabulary: HookDecisionVocabulary;
  provider: string;
} {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
      args[key] = val;
    }
  }
  const requested = args['decision-vocabulary'] || args.decisionVocabulary || '';
  return {
    event: args['event'] || args.event || '',
    backendUrl:
      args['backend-url'] ||
      args.backendUrl ||
      process.env.KORY_BACKEND_URL ||
      'http://127.0.0.1:3001',
    authFile: args['auth-file'] || args.authFile || process.env.KORY_BRIDGE_AUTH_FILE || '',
    // Default to Claude Code's approve/block vocabulary; `antigravity` selects
    // agy's allow/deny/ask vocabulary, which rejects anything else.
    decisionVocabulary: requested === 'antigravity' ? 'antigravity' : 'claude',
    // Which CLI harness wrote the hook; the backend uses it to phrase native
    // tool denials in vocabulary that harness can act on.
    provider: args['provider'] || args.provider || '',
  };
}

/**
 * Resolve the active bridge grant file for a hook invocation.
 *
 * When a CLI shares a global hooks file (such as Antigravity's
 * `$GEMINI_DIR/config/hooks.json`), a nested or concurrent turn can overwrite
 * `--auth-file` on disk and then revoke that file when the inner turn exits.
 * Prefer `KORY_BRIDGE_AUTH_FILE` from the spawning CLI process's environment
 * whenever it points to a valid live grant, falling back to `--auth-file`.
 */
export function resolveHookAuthFile(
  cliAuthFile: string,
  envAuthFile = process.env.KORY_BRIDGE_AUTH_FILE ?? '',
): string {
  const candidates = [...new Set([envAuthFile.trim(), cliAuthFile.trim()].filter(Boolean))];
  for (const candidate of candidates) {
    try {
      readBridgeGrantScopeFromFile(candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  return cliAuthFile.trim() || envAuthFile.trim();
}

/**
 * Read the proposed tool call out of a hook payload.
 *
 * agy sends camelCase protojson — `{ toolCall: { name, args } }` — while Claude
 * Code and Devin send `{ tool_name, tool_input }`. Reading only the latter
 * yields an empty tool name, which every CLI would then treat as an unknown
 * tool rather than the specific call under review.
 */
export function readToolCall(payload: Record<string, unknown>): {
  toolName: string;
  toolInput: Record<string, unknown>;
} {
  const toolCall = payload.toolCall;
  if (toolCall && typeof toolCall === 'object' && !Array.isArray(toolCall)) {
    const call = toolCall as Record<string, unknown>;
    const args = call.args;
    return {
      toolName: typeof call.name === 'string' ? call.name : '',
      toolInput:
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
    };
  }
  const toolInput = payload.tool_input ?? payload.toolInput;
  return {
    toolName:
      typeof (payload.tool_name ?? payload.toolName) === 'string'
        ? ((payload.tool_name ?? payload.toolName) as string)
        : '',
    toolInput:
      toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
        ? (toolInput as Record<string, unknown>)
        : {},
  };
}

/**
 * Translate Koryphaios's internal approve/block verdict into the exact shape the
 * calling CLI parses.
 *
 * The `claude` vocabulary is only correct for *some* events. Claude Code reads
 * a top-level `decision` for `Stop`, `UserPromptSubmit`, and `PostToolUse`, but
 * `PreToolUse` is a `hookSpecificOutput` with `permissionDecision`, and
 * `PermissionRequest` is a `hookSpecificOutput` with `decision.behavior`.
 * Emitting the top-level form for `PreToolUse` is silently ignored, which reads
 * as "no decision" — i.e. the call proceeds.
 */
export function encodeHookDecision(
  verdict: { decision: string; reason?: string },
  vocabulary: HookDecisionVocabulary,
  event = '',
): Record<string, unknown> {
  const reason = typeof verdict.reason === 'string' ? verdict.reason : '';
  const approve = verdict.decision === 'approve';
  if (vocabulary === 'antigravity') {
    // agy accepts allow | deny | ask | force_ask and treats the rest as an
    // unsupported hook decision, so nothing else may be emitted here.
    return { decision: approve ? 'allow' : 'deny', reason };
  }
  if (event === 'PreToolUse') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: approve ? 'allow' : 'deny',
        permissionDecisionReason: reason,
      },
    };
  }
  if (event === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: approve ? 'allow' : 'deny' },
      },
    };
  }
  // Stop / UserPromptSubmit / PostToolUse take a top-level `decision`. Only
  // "block" is meaningful there; approval is the default flow, and an empty
  // object is what these events expect when there is nothing to report.
  if (approve) return {};
  return { decision: 'block', reason };
}

/**
 * Build the request body for a hook endpoint.
 *
 * The body is HMAC-signed here and re-digested on the backend AFTER Elysia
 * validates it against the route's `t.Object` schema — which normalizes away
 * every undeclared key. Signing anything beyond the declared fields (an empty
 * `tool_name: ''` or `tool_input: {}` on non-tool events, `tool_input` on
 * post-tool) desyncs the digest and the request 401s. Send exactly what each
 * route declares.
 */
export function buildHookBody(
  endpoint: string,
  payload: Record<string, unknown>,
  sessionId: string,
  provider?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { session_id: sessionId };
  if (endpoint === 'pre-tool' || endpoint === 'permission') {
    const call = readToolCall(payload);
    out.tool_name = call.toolName;
    out.tool_input = call.toolInput;
    // Only the pre-tool/permission schemas declare `provider` — sending it on
    // another endpoint would sign an undeclared key and desync the digest.
    if (provider) out.provider = provider;
  } else if (endpoint === 'post-tool') {
    const call = readToolCall(payload);
    out.tool_name = call.toolName;
    const toolResponse = payload.tool_response ?? payload.toolResponse;
    if (toolResponse !== undefined) out.tool_response = toolResponse;
  }
  return out;
}

export function readBoundedStdin(fd = 0): { text: string; oversized: boolean } {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= MAX_HOOK_INPUT_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_HOOK_INPUT_BYTES + 1 - size));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      size += read;
    }
    if (size > MAX_HOOK_INPUT_BYTES) return { text: '', oversized: true };
    return { text: Buffer.concat(chunks, size).toString('utf8'), oversized: false };
  } catch {
    serverLog.debug({}, 'kory-hook-bridge: stdin read failed');
    return { text: '', oversized: false };
  }
}

export async function main(): Promise<void> {
  const config = parseArgs(process.argv);
  const { text: stdinRaw, oversized } = readBoundedStdin();
  if (oversized) {
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: 'Kory permission input exceeded the safe limit',
      }),
    );
    return;
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = stdinRaw.trim() ? JSON.parse(stdinRaw) : {};
  } catch {
    serverLog.debug({}, 'kory-hook-bridge: stdin JSON parse failed');
    payload = {};
  }

  const eventMap: Record<string, string> = {
    PreToolUse: 'pre-tool',
    PostToolUse: 'post-tool',
    PermissionRequest: 'permission',
    UserPromptSubmit: 'prompt-submit',
    Stop: 'stop',
    SessionStart: 'session-start',
    SessionEnd: 'session-end',
  };

  const endpoint = eventMap[config.event];
  if (!endpoint) {
    process.stdout.write(
      JSON.stringify(
        encodeHookDecision(
          { decision: 'block', reason: 'Unknown Kory permission event' },
          config.decisionVocabulary,
        ),
      ),
    );
    return;
  }

  const activeAuthFile = resolveHookAuthFile(config.authFile);
  let sessionId = '';
  try {
    sessionId = readBridgeGrantScopeFromFile(activeAuthFile).sessionId;
  } catch {
    process.stdout.write(
      JSON.stringify(
        encodeHookDecision(
          { decision: 'block', reason: 'Kory permission authorization is unavailable' },
          config.decisionVocabulary,
          config.event,
        ),
      ),
    );
    return;
  }

  const body = buildHookBody(endpoint, payload, sessionId, config.provider || undefined);

  try {
    if (!activeAuthFile) throw new Error('Bridge grant file is unavailable');
    const path = `/api/v1/mcp-bridge/hooks/${endpoint}`;
    const signedHeaders = signedBridgeHeadersFromFile(
      activeAuthFile,
      'hook',
      'POST',
      path,
      body,
    );
    const resp = await fetch(`${config.backendUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs()),
    });
    const data = await resp
      .json()
      .catch(() => ({ decision: 'block', reason: `Kory hook returned HTTP ${resp.status}` }));
    // The hook endpoints return { decision, reason, ... } or { ok, ... }.
    // Normalize to the decision vocabulary the calling CLI actually parses.
    const vocabulary = config.decisionVocabulary;
    if ('decision' in data) {
      process.stdout.write(JSON.stringify(encodeHookDecision(data, vocabulary, config.event)));
    } else {
      process.stdout.write(
        JSON.stringify(
          encodeHookDecision(
            resp.ok
              ? { decision: 'approve', reason: '' }
              : { decision: 'block', reason: `Kory hook returned HTTP ${resp.status}` },
            vocabulary,
            config.event,
          ),
        ),
      );
    }
  } catch {
    // Native tools must never gain authority just because the host gate is unavailable.
    process.stderr.write('[kory-hook-bridge] backend or private authorization unavailable\n');
    process.stdout.write(
      JSON.stringify(
        encodeHookDecision(
          { decision: 'block', reason: 'Kory permission host is unavailable' },
          config.decisionVocabulary,
          config.event,
        ),
      ),
    );
  }
}

if (import.meta.main) {
  main().catch(() => {
    process.stderr.write('[kory-hook-bridge] fatal error\n');
    process.stdout.write(
      JSON.stringify(
        encodeHookDecision({ decision: 'block', reason: 'Kory permission hook failed' }, 'claude'),
      ),
    );
  });
}
