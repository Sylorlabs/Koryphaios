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
  return {
    event: args['event'] || args.event || '',
    backendUrl: args['backend-url'] || args.backendUrl || process.env.KORY_BACKEND_URL || 'http://127.0.0.1:3001',
    authFile:
      args['auth-file'] || args.authFile || process.env.KORY_BRIDGE_AUTH_FILE || '',
  };
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
      JSON.stringify({ decision: 'block', reason: 'Kory permission input exceeded the safe limit' }),
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
    'PreToolUse': 'pre-tool',
    'PostToolUse': 'post-tool',
    'PermissionRequest': 'permission',
    'UserPromptSubmit': 'prompt-submit',
    'Stop': 'stop',
    'SessionStart': 'session-start',
    'SessionEnd': 'session-end',
  };

  const endpoint = eventMap[config.event];
  if (!endpoint) {
    process.stdout.write(
      JSON.stringify({ decision: 'block', reason: 'Unknown Kory permission event' }),
    );
    return;
  }

  let sessionId = '';
  try {
    sessionId = readBridgeGrantScopeFromFile(config.authFile).sessionId;
  } catch {
    process.stdout.write(
      JSON.stringify({ decision: 'block', reason: 'Kory permission authorization is unavailable' }),
    );
    return;
  }

  const body = {
    session_id: sessionId,
    tool_name: payload.tool_name ?? payload.toolName ?? '',
    tool_input: payload.tool_input ?? payload.toolInput ?? {},
    tool_response: payload.tool_response ?? payload.toolResponse,
  };

  try {
    if (!config.authFile) throw new Error('Bridge grant file is unavailable');
    const path = `/api/v1/mcp-bridge/hooks/${endpoint}`;
    const signedHeaders = signedBridgeHeadersFromFile(
      config.authFile,
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
    const data = await resp.json().catch(() => ({ decision: 'block', reason: `Kory hook returned HTTP ${resp.status}` }));
    // The hook endpoints return { decision, reason, ... } or { ok, ... }.
    // Normalize to the format CLIs expect.
    if ('decision' in data) {
      process.stdout.write(JSON.stringify(data));
    } else {
      process.stdout.write(resp.ok
        ? JSON.stringify({ decision: 'approve', ...data })
        : JSON.stringify({ decision: 'block', reason: `Kory hook returned HTTP ${resp.status}` }));
    }
  } catch {
    // Native tools must never gain authority just because the host gate is unavailable.
    process.stderr.write('[kory-hook-bridge] backend or private authorization unavailable\n');
    process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Kory permission host is unavailable' }));
  }
}

if (import.meta.main) {
  main().catch(() => {
    process.stderr.write('[kory-hook-bridge] fatal error\n');
    process.stdout.write(
      JSON.stringify({ decision: 'block', reason: 'Kory permission hook failed' }),
    );
  });
}
