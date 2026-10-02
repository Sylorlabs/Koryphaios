import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SkillHierarchy from './SkillHierarchy.svelte';
import { buildSkillHierarchy, skillInventoryCounts, type HierarchySkill } from './skill-hierarchy';

const entry = (name: string, overrides: Partial<HierarchySkill> = {}): HierarchySkill => ({
  name,
  source: 'personal',
  state: 'active',
  hash: name,
  metadata: { broader: [], facets: [], requires: [], conflicts: [] },
  validation: { valid: true },
  ...overrides,
});
afterEach(cleanup);

describe('skill hierarchy navigation', () => {
  it('separates skill responsibilities from active and draft revisions', () => {
    const skills = [
      entry('design'),
      entry('web', { metadata: { broader: ['design'] } }),
      entry('web', { source: 'project' }),
      entry('web', { state: 'draft' }),
    ];
    expect(skillInventoryCounts(skills)).toEqual({ skills: 2, activeRevisions: 3, revisions: 4 });
    expect(skillInventoryCounts([entry('invalid', { validation: { valid: false } })])).toEqual({
      skills: 0,
      activeRevisions: 0,
      revisions: 1,
    });
  });

  it('renders both parents and scoped children and opens the exact requested revision', async () => {
    const design = entry('design');
    const frontend = entry('frontend');
    const web = entry('web', { metadata: { broader: ['design', 'frontend'] } });
    const childPersonal = entry('react', { metadata: { broader: ['web'] } });
    const childProject = entry('react', { source: 'project', metadata: { broader: ['web'] } });
    const onselect = vi.fn();
    render(SkillHierarchy, {
      props: {
        skills: [design, frontend, web, childPersonal, childProject],
        selected: web,
        onselect,
      },
    });
    const parents = screen.getByRole('navigation', { name: 'Broader skills' });
    expect(within(parents).getAllByRole('button')).toHaveLength(2);
    const children = screen.getByRole('navigation', { name: 'Narrower skills' });
    expect(within(children).getAllByRole('button')).toHaveLength(2);
    const project = within(children).getByRole('button', { name: 'Open react (project, active)' });
    project.focus();
    expect(document.activeElement).toBe(project);
    await fireEvent.click(project);
    expect(onselect).toHaveBeenCalledExactlyOnceWith(childProject);
  });

  it('keeps missing, draft and invalid dependencies explicit without promoting them', async () => {
    const selected = entry('web', {
      metadata: {
        requires: ['draft-check', 'absent', 'invalid-check'],
        facets: ['accessibility'],
        conflicts: ['legacy'],
      },
    });
    const draft = entry('draft-check', { state: 'draft' });
    const invalid = entry('invalid-check', { validation: { valid: false } });
    const onselect = vi.fn();
    render(SkillHierarchy, {
      props: {
        skills: [selected, draft, invalid, entry('accessibility'), entry('legacy')],
        selected,
        onselect,
      },
    });
    expect(screen.getByText('absent: missing')).toBeInTheDocument();
    expect(screen.getByText('draft-check: no valid active revision')).toBeInTheDocument();
    expect(screen.getByText('invalid-check: no valid active revision')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Related disciplines' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Conflicts' })).toBeInTheDocument();
    await fireEvent.click(
      screen.getByRole('button', { name: 'Open draft-check (personal, draft)' }),
    );
    expect(onselect).toHaveBeenCalledExactlyOnceWith(draft);
    expect(draft.state).toBe('draft');
  });

  it('updates with local reparenting and does not traverse cycles or activate draft children', async () => {
    const parent = entry('design', { metadata: { broader: ['design'] } });
    const child = entry('web', { metadata: { parent: 'design' } });
    const draftChild = entry('native', { state: 'draft', metadata: { broader: ['design'] } });
    const props = { skills: [parent, child, draftChild], selected: parent, onselect: vi.fn() };
    const { rerender } = render(SkillHierarchy, { props });
    expect(screen.getByText('design: invalid self reference')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open web (personal, active)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open native/ })).toBeNull();
    await rerender({
      ...props,
      skills: [parent, { ...child, metadata: { broader: ['other'] } }, draftChild],
    });
    expect(screen.queryByRole('navigation', { name: 'Narrower skills' })).toBeNull();
    expect(buildSkillHierarchy([parent], parent)[0]!.items[0]!.selfReference).toBe(true);
  });
});
