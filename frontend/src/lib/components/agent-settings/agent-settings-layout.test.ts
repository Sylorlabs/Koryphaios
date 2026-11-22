import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SegmentedChoice from './SegmentedChoice.svelte';
import PatternListEditor from './PatternListEditor.svelte';

const agentSource = readFileSync(resolve(import.meta.dirname, '../AgentSettings.svelte'), 'utf8');

afterEach(() => cleanup());

describe('Agent behavior layout', () => {
  it('shows the six essentials up front', () => {
    for (const label of [
      'label="Approval preset"',
      'label="Execution sandbox"',
      'label="Sub-agent approval"',
      'label="Worktree for new chats"',
      'label="Critic quality gate"',
      'label="Computer use"',
    ]) {
      expect(agentSource).toContain(label);
    }
    expect(agentSource).toContain('{ worktreeMode: value as');
  });

  it('puts every advanced control in exactly one group and drops the old navigation', () => {
    for (const id of ['safety', 'agents', 'workflow', 'quality', 'context', 'research']) {
      expect(agentSource).toContain(`group.id === '${id}'`);
    }
    expect(agentSource).not.toContain('agent-section-index');
    expect(agentSource).not.toContain('CONTROL_SECTIONS');
    expect(agentSource).toContain('bashCommandAllowlist: patterns');
    expect(agentSource).toContain('bashCommandBlocklist: patterns');
    expect(agentSource).toContain("toggleSetting('automaticGoalDriving')");
  });

  it('keeps old section deep links pointing at the new groups', () => {
    expect(agentSource).toMatch(/permissions: 'essentials'/);
    expect(agentSource).toMatch(/routing: 'agents'/);
  });

  it('uses no native select, checkbox or number spinner', () => {
    expect(agentSource).not.toMatch(/<select\b/);
    expect(agentSource).not.toMatch(/type="checkbox"/);
    expect(agentSource).not.toMatch(/type="number"/);
  });
});

describe('SegmentedChoice', () => {
  it('marks the selected option and describes it', () => {
    render(SegmentedChoice, {
      label: 'Mode',
      value: 'b',
      options: [
        { value: 'a', label: 'Alpha', description: 'First' },
        { value: 'b', label: 'Beta', description: 'Second' },
      ],
      onchange: vi.fn(),
    });
    expect(screen.getByRole('radio', { name: 'Beta' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Second')).toBeTruthy();
  });

  it('reports a new choice only when it changes', async () => {
    const onchange = vi.fn();
    render(SegmentedChoice, {
      label: 'Mode',
      value: 'a',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
      onchange,
    });
    await fireEvent.click(screen.getByRole('radio', { name: 'Alpha' }));
    expect(onchange).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('radio', { name: 'Beta' }));
    expect(onchange).toHaveBeenCalledWith('b');
  });
});

describe('PatternListEditor', () => {
  it('adds a trimmed new pattern and ignores duplicates', async () => {
    const onchange = vi.fn();
    render(PatternListEditor, {
      label: 'Allowed',
      patterns: ['git*'],
      emptyText: 'None',
      onchange,
    });
    const input = screen.getByLabelText('Add to Allowed');
    await fireEvent.input(input, { target: { value: '  npm*  ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add pattern to Allowed' }));
    expect(onchange).toHaveBeenCalledWith(['git*', 'npm*']);
    onchange.mockClear();
    await fireEvent.input(input, { target: { value: 'git*' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add pattern to Allowed' }));
    expect(onchange).not.toHaveBeenCalled();
  });

  it('removes a pattern', async () => {
    const onchange = vi.fn();
    render(PatternListEditor, {
      label: 'Blocked',
      patterns: ['rm*', 'mkfs*'],
      emptyText: 'None',
      tone: 'block',
      onchange,
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Remove rm*' }));
    expect(onchange).toHaveBeenCalledWith(['mkfs*']);
  });
});
