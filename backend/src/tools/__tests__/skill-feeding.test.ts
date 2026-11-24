import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoadSkillDetailTool, ManageSkillFeedingTool } from '../skills';
import type { ToolCallInput, ToolContext } from '../registry';

let root = '';
let skillsHome = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-skill-feeding-'));
  skillsHome = mkdtempSync(join(tmpdir(), 'kory-skill-feeding-home-'));
  process.env.KORYPHAIOS_SKILLS_HOME = skillsHome;
});

afterEach(() => {
  delete process.env.KORYPHAIOS_SKILLS_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(skillsHome, { recursive: true, force: true });
});

const call = (input: Record<string, unknown>): ToolCallInput => ({
  id: 'call-1',
  name: 'test',
  input,
});

const baseCtx = (): ToolContext => ({
  sessionId: 'session-1',
  workingDirectory: root,
});

describe('LoadSkillDetailTool feeder tracking', () => {
  test('reports a successfully loaded skill to the host', async () => {
    const loaded: string[] = [];
    const ctx = { ...baseCtx(), onSkillDetailLoaded: (skill: string) => loaded.push(skill) };
    const output = await new LoadSkillDetailTool().run(ctx, call({ name: 'plan-mode' }));
    expect(output.isError).toBe(false);
    expect(loaded).toEqual(['plan-mode']);
    expect(output.output).toContain('# plan-mode');
  });

  test('does not report when the skill is unknown', async () => {
    const loaded: string[] = [];
    const ctx = { ...baseCtx(), onSkillDetailLoaded: (skill: string) => loaded.push(skill) };
    const output = await new LoadSkillDetailTool().run(ctx, call({ name: 'missing-skill' }));
    expect(output.isError).toBe(true);
    expect(loaded).toEqual([]);
  });

  test('a throwing tracker never fails delivery', async () => {
    const ctx = {
      ...baseCtx(),
      onSkillDetailLoaded: () => {
        throw new Error('tracker exploded');
      },
    };
    const output = await new LoadSkillDetailTool().run(ctx, call({ name: 'plan-mode' }));
    expect(output.isError).toBe(false);
    expect(output.output).toContain('# plan-mode');
  });
});

describe('ManageSkillFeedingTool', () => {
  test('fails closed when the host does not wire the callback', async () => {
    const output = await new ManageSkillFeedingTool().run(baseCtx(), call({ action: 'report' }));
    expect(output.isError).toBe(true);
    expect(output.output).toContain('not available');
  });

  test('forwards the request to the host callback', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx: ToolContext = {
      ...baseCtx(),
      manageSkillFeeding: async (request) => {
        seen.push(request);
        return 'ok';
      },
    };
    const output = await new ManageSkillFeedingTool().run(
      ctx,
      call({ action: 'block', skills: ['plan-mode'], reason: 'already absorbed it' }),
    );
    expect(output.isError).toBe(false);
    expect(output.output).toBe('ok');
    expect(seen[0]).toEqual({
      action: 'block',
      skills: ['plan-mode'],
      reason: 'already absorbed it',
    });
  });

  test('callback errors surface as tool errors', async () => {
    const ctx: ToolContext = {
      ...baseCtx(),
      manageSkillFeeding: async () => {
        throw new Error('No active skill named nope.');
      },
    };
    const output = await new ManageSkillFeedingTool().run(
      ctx,
      call({ action: 'block', skills: ['nope'] }),
    );
    expect(output.isError).toBe(true);
    expect(output.output).toContain('No active skill named nope.');
  });
});
