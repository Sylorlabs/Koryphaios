import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_NOTE_TOOL_PERMISSIONS,
  NOTE_TOOL_DEFINITIONS,
  NOTE_TOOL_NAMES,
} from '@koryphaios/shared';
import { checkNoteToolPermission, getVisibleNoteToolNames } from '../../notes/notes-settings';
import { KORY_TOOLS, toolsForRole } from '../../providers/kory-mcp-bridge';
import { DEFAULT_PERMISSION_MATRIX } from '../../security/permission-matrix';
import { noteTools } from '../notes';
import { recordWorkNoteTool } from '../work-note';

describe('record_work_note registration', () => {
  test('is a runtime Notes tool with the evidence schema', () => {
    expect(noteTools.find((tool) => tool.name === 'record_work_note')).toBe(recordWorkNoteTool);
    expect(recordWorkNoteTool.role).toBe('worker');
    expect(recordWorkNoteTool.inputSchema.required).toEqual(['title', 'summary', 'status']);
    expect(
      (recordWorkNoteTool.inputSchema.properties as Record<string, { enum?: string[] }>).status
        .enum,
    ).toEqual(['completed', 'partial', 'blocked', 'decision']);
  });

  test('is governed by the shared Notes permission contract', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'kory-work-note-permission-'));
    try {
      expect(NOTE_TOOL_NAMES).toContain('record_work_note');
      expect(NOTE_TOOL_DEFINITIONS).toContainEqual(
        expect.objectContaining({ name: 'record_work_note', category: 'write' }),
      );
      expect(DEFAULT_NOTE_TOOL_PERMISSIONS.record_work_note).toBe('ask');
      expect(DEFAULT_PERMISSION_MATRIX.tools.record_work_note).toEqual({
        tool: 'record_work_note',
        level: 'ask',
      });
      expect(getVisibleNoteToolNames(projectRoot)).toContain('record_work_note');
      expect(checkNoteToolPermission('record_work_note', projectRoot)).toEqual(
        expect.objectContaining({ allowed: true, level: 'ask', requiresApproval: true }),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('is advertised to builders but never to the read-only critic', () => {
    const bridgeTool = KORY_TOOLS.find((tool) => tool.name === 'kory__record_work_note');
    expect(bridgeTool).toBeDefined();
    expect(bridgeTool?.inputSchema.required).toEqual(['title', 'summary', 'status']);
    expect(toolsForRole('manager').map((tool) => tool.name)).toContain('kory__record_work_note');
    expect(toolsForRole('worker').map((tool) => tool.name)).toContain('kory__record_work_note');
    expect(toolsForRole('coder').map((tool) => tool.name)).toContain('kory__record_work_note');
    expect(toolsForRole('critic').map((tool) => tool.name)).not.toContain('kory__record_work_note');
  });
});
