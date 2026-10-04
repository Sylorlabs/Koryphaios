import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_NOTE_TOOL_PERMISSIONS, NOTE_TOOL_DEFINITIONS } from '@koryphaios/shared';
import { DEFAULT_AGENT_SETTINGS } from '../../agent-settings';
import { initDb } from '../../db';
import {
  createNote,
  listNoteRelationships,
  proposeNoteRelationship,
} from '../../notes/notes-service';
import { saveNotesAgentPermissions } from '../../notes/notes-settings';
import { KORY_TOOLS } from '../../providers/kory-mcp-bridge';
import { DEFAULT_PERMISSION_MATRIX } from '../../security/permission-matrix';
import { proposeNoteRelationshipTool, reviewNoteRelationshipTool } from '../note-relationships';
import { noteTools } from '../notes';
import { READ_ONLY_TOOLS, resolveToolPermissionPolicy } from '../permission-policy';
import { ToolRegistry, type ToolContext } from '../registry';
const root = mkdtempSync(join(tmpdir(), 'kory-relationship-permissions-'));
beforeAll(async () => {
  await initDb();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const registry = new ToolRegistry();
registry.register(proposeNoteRelationshipTool);
registry.register(reviewNoteRelationshipTool);
function permission(name: string, level: 'auto' | 'ask' | 'block') {
  saveNotesAgentPermissions(root, {
    preset: 'custom',
    tools: {
      ...DEFAULT_NOTE_TOOL_PERMISSIONS,
      propose_note_relationship: 'auto',
      review_note_relationship: 'auto',
      [name]: level,
    },
  });
}
function context(): ToolContext {
  return {
    sessionId: 'host-session',
    agentId: 'host-agent',
    activeModel: 'host-model',
    workingDirectory: root,
    settingsRoot: root,
    permissionPolicy: resolveToolPermissionPolicy({
      ...DEFAULT_AGENT_SETTINGS,
      permissionMode: 'yolo',
    }),
  };
}
async function proposal(label: string) {
  const from = await createNote({ title: `${label} from` }, root);
  const to = await createNote({ title: `${label} to` }, root);
  return {
    fromId: from.id,
    toId: to.id,
    type: 'contradicts',
    evidence: 'Conflicting measured outcomes',
    expectedSourceRevision: 1,
    expectedTargetRevision: 1,
  };
}
describe('independent relationship tool approvals', () => {
  test('write catalogs, MCP schemas and critic denial agree', () => {
    for (const tool of [proposeNoteRelationshipTool, reviewNoteRelationshipTool]) {
      expect(noteTools).toContain(tool);
      expect(NOTE_TOOL_DEFINITIONS.find((row) => row.name === tool.name)?.category).toBe('write');
      expect(DEFAULT_PERMISSION_MATRIX.tools[tool.name]?.level).toBe('ask');
      expect(READ_ONLY_TOOLS.has(tool.name)).toBe(false);
      expect(registry.isAllowedForRole(tool.name, 'critic')).toBe(false);
      expect(KORY_TOOLS.find((row) => row.name === `kory__${tool.name}`)?.inputSchema).toEqual(
        tool.inputSchema,
      );
    }
  });
  test('bounded proposal binds host identity and does not accept', async () => {
    permission('propose_note_relationship', 'auto');
    const input = await proposal('Host identity');
    const result = await registry.execute(context(), {
      id: 'propose',
      name: proposeNoteRelationshipTool.name,
      input,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({
      status: 'proposed',
      actor: { sessionId: 'host-session', agentId: 'host-agent', model: 'host-model' },
    });
    const forged = await registry.execute(context(), {
      id: 'forged',
      name: proposeNoteRelationshipTool.name,
      input: { ...input, actor: { sessionId: 'fake' } },
    });
    expect(forged.isError).toBe(true);
  });
  test('review asks separately even with YOLO, Notes auto and replayed receipt', async () => {
    permission('review_note_relationship', 'auto');
    const input = await proposal('Approved');
    await proposeNoteRelationship(input as never, root, { provenance: 'agent' });
    let prompts = 0;
    const ctx = {
      ...context(),
      approvedToolCallIds: new Set(['review']),
      waitForUserInput: async () => {
        prompts++;
        return 'Allow once';
      },
    };
    const call = {
      id: 'review',
      name: reviewNoteRelationshipTool.name,
      input: { fromId: input.fromId, toId: input.toId, status: 'accepted', expectedRevision: 1 },
    };
    expect((await registry.execute(ctx, call)).isError).toBe(false);
    expect(prompts).toBe(1);
    expect(ctx.approvedToolCallIds.size).toBe(0);
    expect((await registry.execute({ ...ctx, waitForUserInput: undefined }, call)).isError).toBe(
      true,
    );
    expect((await listNoteRelationships(root, { fromId: input.fromId }))[0]?.revision).toBe(2);
  });
  test('proposal approval cannot authorize review; missing channel and explicit rejection fail closed', async () => {
    permission('review_note_relationship', 'auto');
    const input = await proposal('Reject review');
    await proposeNoteRelationship(input as never, root, { provenance: 'agent' });
    const call = {
      id: 'separate',
      name: reviewNoteRelationshipTool.name,
      input: { fromId: input.fromId, toId: input.toId, status: 'accepted', expectedRevision: 1 },
    };
    expect(
      (
        await registry.execute(
          { ...context(), approvedToolCallIds: new Set(['proposal-call']) },
          call,
        )
      ).isError,
    ).toBe(true);
    expect(
      (await registry.execute({ ...context(), waitForUserInput: async () => 'Reject' }, call))
        .isError,
    ).toBe(true);
    expect((await reviewNoteRelationshipTool.run(context(), call)).isError).toBe(true);
    expect((await listNoteRelationships(root, { fromId: input.fromId }))[0]?.status).toBe(
      'proposed',
    );
  });
  test('block and approval-time revocation defeat allowlists and YOLO', async () => {
    permission('review_note_relationship', 'auto');
    const input = await proposal('Revoke review');
    await proposeNoteRelationship(input as never, root, { provenance: 'agent' });
    const call = {
      id: 'revoke',
      name: reviewNoteRelationshipTool.name,
      input: { fromId: input.fromId, toId: input.toId, status: 'accepted', expectedRevision: 1 },
    };
    const ctx = context();
    ctx.permissionPolicy!.toolAllowlist = [reviewNoteRelationshipTool.name];
    ctx.waitForUserInput = async () => {
      permission('review_note_relationship', 'block');
      return 'Allow once';
    };
    expect((await registry.execute(ctx, call)).isError).toBe(true);
    expect((await listNoteRelationships(root, { fromId: input.fromId }))[0]?.status).toBe(
      'proposed',
    );
    permission('propose_note_relationship', 'block');
    expect(
      (
        await registry.execute(context(), {
          id: 'blocked',
          name: proposeNoteRelationshipTool.name,
          input: await proposal('Blocked proposal'),
        })
      ).isError,
    ).toBe(true);
  });
});
