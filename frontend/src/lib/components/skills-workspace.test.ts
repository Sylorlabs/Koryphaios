import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(process.cwd(), 'src/lib/components/SkillsWorkspace.svelte'),
  'utf8',
);
const settingsSource = readFileSync(
  join(process.cwd(), 'src/lib/components/AgentSettings.svelte'),
  'utf8',
);
const visualEditorSource = readFileSync(
  join(process.cwd(), 'src/lib/components/SkillVisualEditor.svelte'),
  'utf8',
);
const drawerSource = readFileSync(
  join(process.cwd(), 'src/lib/components/SettingsDrawer.svelte'),
  'utf8',
);
const pageSource = readFileSync(join(process.cwd(), 'src/routes/+page.svelte'), 'utf8');

describe('Skills workspace contracts', () => {
  it('is the live Skills settings branch rather than a dormant preview', () => {
    expect(settingsSource).toContain("agentSettingsStore.activeTab !== 'skills'");
    expect(settingsSource).toContain(
      "active={active &&\n          agentSettingsStore.activeTab === 'skills' &&\n          !agentSettingsStore.isLoading}",
    );
    expect(drawerSource).toContain("active={open && activeTab === 'agent'}");
    expect(settingsSource).toContain('per-revision and in-progress creator edits survive');
  });

  it('keeps the large library searchable, grouped, and readable', () => {
    expect(source).toContain('Search all skills');
    expect(source).toContain("'Needs attention'");
    expect(source).toContain('grid-template-columns: 320px minmax(0, 1fr)');
    expect(source).toMatch(
      /@media \(max-width: 1100px\)[\s\S]*?\.workspace-body \{[\s\S]*?display: block;/,
    );
    expect(source).toContain('min-height: 44px');
    expect(source).not.toMatch(/text-\[(?:9|10)px\]/);
  });

  it('preserves per-revision buffers and keyboard save while navigating', () => {
    expect(source).toContain('buffers = $state<Record<string, DraftBuffer>>');
    expect(source).toContain('buffers[revisionKey(skill)]?.dirty');
    expect(source).toContain('${skill.state}:${skill.hash}');
    expect(source).toContain('hasDirtySkillBuffer(selectedSkill)');
    expect(source).toContain("event.key.toLowerCase() === 's'");
    expect(source).toContain('if (!active) return');
    expect(source).toContain("window.addEventListener('beforeunload', beforeUnload)");
  });

  it('provides semantic tabs, source/split editing, comparisons, and focused routing', () => {
    expect(source).not.toContain('<main class:hidden-on-narrow');
    expect(source).toContain('aria-label="Skill detail workspace"');
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain("type EditorMode = 'visual' | 'source' | 'split'");
    expect(source).toContain('Active and draft comparison');
    expect(source).toContain('Replace with bundled Markdown');
    expect(source).toContain("applyBundledUpdate('merge-with-agent')");
    expect(source).toContain('Preview conversion');
    expect(source).toContain('Create converted draft');
    expect(source).toContain('Test routing');
    expect(source).toContain('<SkillCodeEditor');
    expect(source).toContain('<SkillVisualEditor');
  });

  it('uses Kory controls and a locked-down HTML preview for every native format', () => {
    expect(source).toContain('type SkillFormatKind');
    expect(source).toContain("{ value: 'custom', label: 'Custom extension' }");
    expect(source).toContain('<KorySelect');
    expect(source).toContain('<NumberStepper');
    expect(source).not.toMatch(/<select\b|type="(?:checkbox|number|range)"/);
    expect(source).toContain('sandbox=""');
    expect(source).toContain("default-src 'none'");
    expect(source).toContain("script-src 'none'");
    expect(source).toContain("form-action 'none'");
    expect(visualEditorSource).toContain('Raw source protected');
    expect(visualEditorSource).toContain('data-testid="locked-raw-source"');
  });

  it('keeps guided creation in the detail pane while the library remains mounted', () => {
    expect(source).toContain('{@render creatorPane()}');
    expect(source).toContain('{#snippet creatorPane()}');
    expect(source).toContain('class="creator-workspace"');
    expect(source).not.toContain('{#if creatorOpen}<div class="tool-overlay"');
  });

  it('uses computed contrast tokens for solid primary actions', () => {
    expect(source).toContain('color: var(--color-on-accent)');
    expect(source).toContain('color: var(--color-on-success)');
  });

  it('routes Settings closure and narrow focus through the unsaved-work guard', () => {
    expect(drawerSource).toContain('requestSettingsCloseWith');
    expect(drawerSource).toContain('pendingSettingsCloseAction');
    expect(drawerSource).toContain(
      'let loadedAgentProject: string | null | undefined = undefined;',
    );
    expect(drawerSource).toContain('settingsSearchInput?.getClientRects().length');
    expect(pageSource).not.toMatch(
      /shortcutStore\.matches\('close', e\)[\s\S]{0,80}showSettings\s*=\s*false/,
    );
  });

  it('traps every routing result control and restores comparison focus after actions', () => {
    expect(source).toContain('textarea:not(:disabled), summary, [tabindex]');
    expect(source).toMatch(/applyBundledSkillUpdate[\s\S]+closeComparison\(\)/);
  });
});
