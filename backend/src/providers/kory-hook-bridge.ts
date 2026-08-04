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

import { readFileSync } from 'node:fs';

function parseArgs(argv: string[]): {
  event: string;
  sessionId: string;
  backendUrl: string;
  auth: string;
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
    sessionId: args['session-id'] || args.sessionId || process.env.KORY_SESSION_ID || '',
    backendUrl: args['backend-url'] || args.backendUrl || process.env.KORY_BACKEND_URL || 'http://127.0.0.1:3001',
    auth: args.auth || process.env.KORY_LOCAL_AUTH || '',
  };
}

async function readStdin(): Promise<string> {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv);
  const stdinRaw = await readStdin();
  let payload: Record<string, unknown> = {};
  try {
    payload = stdinRaw.trim() ? JSON.parse(stdinRaw) : {};
  } catch {
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
    // Unknown event — approve by default.
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  const body = {
    session_id: config.sessionId,
    tool_name: payload.tool_name ?? payload.toolName ?? '',
    tool_input: payload.tool_input ?? payload.toolInput ?? {},
    tool_response: payload.tool_response ?? payload.toolResponse,
  };

  try {
    const resp = await fetch(`${config.backendUrl}/api/v1/mcp-bridge/hooks/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.auth ? { authorization: config.auth } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({ decision: 'block', reason: `Kory hook returned HTTP ${resp.status}` }));
    // The hook endpoints return { decision, reason, ... } or { ok, ... }.
    // Normalize to the format CLIs expect.
    if ('decision' in data) {
      process.stdout.write(JSON.stringify(data));
    } else {
      process.stdout.write(resp.ok
        ? JSON.stringify({ decision: 'approve', ...data })
        : JSON.stringify({ decision: 'block', reason: data.error ?? `Kory hook returned HTTP ${resp.status}` }));
    }
  } catch (err: any) {
    // Native tools must never gain authority just because the host gate is unavailable.
    process.stderr.write(`[kory-hook-bridge] backend unreachable: ${err?.message}\n`);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Kory permission host is unavailable' }));
  }
}

main().catch((err) => {
  process.stderr.write(`[kory-hook-bridge] fatal: ${err}\n`);
  process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Kory permission hook failed' }));
});
