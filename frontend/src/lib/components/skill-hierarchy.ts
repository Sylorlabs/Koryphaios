export interface HierarchySkill {
  name: string;
  source: 'personal' | 'project';
  state: 'active' | 'draft';
  hash: string;
  metadata: {
    parent?: string;
    broader?: readonly string[];
    facets?: readonly string[];
    requires?: readonly string[];
    conflicts?: readonly string[];
  };
  validation: { valid: boolean };
}

const parents = (skill: HierarchySkill): readonly string[] =>
  skill.metadata.broader?.length
    ? skill.metadata.broader
    : skill.metadata.parent
      ? [skill.metadata.parent]
      : [];

/** Count responsibilities separately from their personal, project and draft revisions. */
export function skillInventoryCounts(skills: readonly HierarchySkill[]) {
  const active = skills.filter((skill) => skill.state === 'active' && skill.validation.valid);
  return {
    skills: new Set(active.map((skill) => skill.name)).size,
    activeRevisions: active.length,
    revisions: skills.length,
  };
}

/** This is navigation, not resolution: expose scope collisions instead of choosing a winner. */
export function buildSkillHierarchy<T extends HierarchySkill>(skills: readonly T[], selected: T) {
  const children = skills
    .filter(
      (skill) =>
        skill.state === 'active' &&
        skill.validation.valid &&
        skill.name !== selected.name &&
        parents(skill).includes(selected.name),
    )
    .map((skill) => skill.name);
  const groups = [
    {
      label: 'Broader skills',
      note: 'Shared principles inherited from these parents.',
      names: parents(selected),
    },
    {
      label: 'Narrower skills',
      note: 'Active children add a more specific responsibility.',
      names: children,
    },
    {
      label: 'Required skills',
      note: 'These dependencies must be available when this skill is selected.',
      names: selected.metadata.requires ?? [],
    },
    {
      label: 'Related disciplines',
      note: 'Declared facets add a separate professional perspective, not another parent.',
      names: selected.metadata.facets ?? [],
    },
    {
      label: 'Conflicts',
      note: 'These skills cannot be combined with this revision.',
      names: selected.metadata.conflicts ?? [],
    },
  ];
  return groups.map((group) => ({
    ...group,
    items: [...new Set(group.names)].sort().map((name) => {
      const matching = skills.filter((skill) => skill.name === name);
      const active = matching.filter((skill) => skill.state === 'active' && skill.validation.valid);
      const targets = (active.length ? active : matching).toSorted(
        (left, right) =>
          left.source.localeCompare(right.source) ||
          left.state.localeCompare(right.state) ||
          left.hash.localeCompare(right.hash),
      );
      return { name, targets, selfReference: name === selected.name, available: active.length > 0 };
    }),
  }));
}
