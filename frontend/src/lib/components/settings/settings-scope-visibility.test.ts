import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const drawerSource = readFileSync(resolve(import.meta.dirname, '../SettingsDrawer.svelte'), 'utf8');
const scopeSource = readFileSync(resolve(import.meta.dirname, 'SettingsScopeBar.svelte'), 'utf8');
const agentSource = readFileSync(resolve(import.meta.dirname, '../AgentSettings.svelte'), 'utf8');
const knowledgeSource = readFileSync(
  resolve(import.meta.dirname, '../KnowledgeScope.svelte'),
  'utf8',
);

describe('settings scope visibility', () => {
  it('does not put a global scope switcher in the Settings shell', () => {
    expect(drawerSource).not.toContain('<SettingsScopeBar');
    expect(drawerSource).not.toContain('Applying settings for');
  });

  it('keeps scope controls at the contextual settings boundaries', () => {
    expect(agentSource).toContain('projectLabel="Project"');
    expect(agentSource).toContain('projectSelector="current"');
    expect(knowledgeSource).toContain(
      '<SettingsScopeBar {compact} {projectLabel} {showProjectName} />',
    );
    expect(knowledgeSource).not.toContain('projectDisplayName(projectStore.currentPath)');
    expect(knowledgeSource).toContain("scope.split(' · ')[0] || scope");
    expect(knowledgeSource).toContain("scopeLabel !== 'Personal' && scopeLabel !== 'Session'");
  });

  it('does not render an environment switcher without a real change handler', () => {
    expect(scopeSource).toContain('{#if onEnvironmentChange}');
    expect(scopeSource).toContain('A bound value alone must not create a');
  });
});
