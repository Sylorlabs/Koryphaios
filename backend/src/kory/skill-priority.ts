/**
 * Advisory ordering metadata for presenting an already-selected skill bundle.
 *
 * This module intentionally has no resolver, provider, model, or activation
 * behavior. It must not be used to turn a skill into a routing match. A future
 * consumer should apply this ordering only after explicit pins, routing
 * decisions, hierarchy closure, conflict handling, and context-budget policy.
 */

export type SkillPriorityPhase =
  | 'routing'
  | 'discovery'
  | 'planning'
  | 'project-workflow'
  | 'diagnosis'
  | 'implementation'
  | 'verification'
  | 'presentation'
  | 'neutral';

export interface SkillPriorityMetadata {
  name: string;
  /** Higher values are earlier within an already-selected bundle. */
  priority: number;
  phase: SkillPriorityPhase;
  rationale: string;
}

/**
 * Dependencies are advisory input to presentation ordering only. The resolver
 * remains responsible for deciding whether a dependency is selected and for
 * closing the hierarchy before this helper is called.
 */
export type SkillPriorityDependencies = ReadonlyMap<string, readonly string[]>;

/**
 * Core-first priorities for the cross-cutting skills that make a task
 * executable. Specialist skills not listed here remain neutral and therefore
 * cannot displace the core sequence by accidental metadata invention.
 */
export const CORE_FIRST_SKILL_PRIORITIES: readonly SkillPriorityMetadata[] = [
  {
    name: 'task-routing',
    priority: 1000,
    phase: 'routing',
    rationale: 'Classify scope and retain only relevant guidance.',
  },
  {
    name: 'repository-environment-discovery',
    priority: 950,
    phase: 'discovery',
    rationale: 'Establish repository rules, runtime, and existing integration points.',
  },
  {
    name: 'planning',
    priority: 900,
    phase: 'planning',
    rationale: 'Translate the task into bounded work, acceptance, and verification.',
  },
  {
    name: 'plan-mode',
    priority: 890,
    phase: 'planning',
    rationale: 'Keep question-led, durable planning ahead of any approved implementation.',
  },
  {
    name: 'project-program-management',
    priority: 850,
    phase: 'project-workflow',
    rationale:
      'Coordinate owners, milestones, dependencies, and delivery boundaries when selected.',
  },
  {
    name: 'architecture-planning',
    priority: 840,
    phase: 'project-workflow',
    rationale: 'Resolve system-boundary decisions before construction when the task requires them.',
  },
  {
    name: 'debugging',
    priority: 820,
    phase: 'diagnosis',
    rationale: 'Establish the failure and root cause before changing a broken path.',
  },
  {
    name: 'implementation',
    priority: 800,
    phase: 'implementation',
    rationale: 'Make the smallest coherent change through the existing architecture.',
  },
  {
    name: 'feature-implementation',
    priority: 790,
    phase: 'implementation',
    rationale: 'Apply feature-specific construction after the implementation boundary is clear.',
  },
  {
    name: 'refactor-implementation',
    priority: 790,
    phase: 'implementation',
    rationale: 'Preserve behavior while restructuring an existing implementation.',
  },
  {
    name: 'integration-implementation',
    priority: 790,
    phase: 'implementation',
    rationale: 'Keep adapter and external-boundary work under the implementation contract.',
  },
  {
    name: 'testing-engineering',
    priority: 700,
    phase: 'verification',
    rationale: 'Add or shape observability and regression coverage where needed.',
  },
  {
    name: 'verification',
    priority: 690,
    phase: 'verification',
    rationale: 'Close the task with fresh claim-specific evidence.',
  },
  {
    name: 'functional-verification',
    priority: 680,
    phase: 'verification',
    rationale: 'Apply functional or domain-specific completion checks when selected.',
  },
  {
    name: 'reliability-verification',
    priority: 680,
    phase: 'verification',
    rationale: 'Verify restart, recovery, replay, and resilience claims when selected.',
  },
  {
    name: 'security-verification',
    priority: 680,
    phase: 'verification',
    rationale: 'Verify security-boundary claims through their enforcing surface.',
  },
  {
    name: 'visual-verification',
    priority: 680,
    phase: 'verification',
    rationale: 'Verify rendered output only when the task has a visual claim.',
  },
  {
    name: 'response-style',
    priority: -100,
    phase: 'presentation',
    rationale: 'Shape the final response after task evidence and completion state are known.',
  },
];

const priorities = new Map(
  CORE_FIRST_SKILL_PRIORITIES.map((metadata) => [metadata.name, metadata]),
);

const neutralPriority = (name: string): SkillPriorityMetadata => ({
  name,
  priority: 0,
  phase: 'neutral',
  rationale: 'No core-first advisory priority is declared.',
});

export function getSkillPriority(name: string): SkillPriorityMetadata {
  return priorities.get(name) ?? neutralPriority(name);
}

/** Comparator suitable only for an already-selected, hierarchy-closed bundle. */
export function compareSkillPriority(left: string, right: string): number {
  const priorityDifference = getSkillPriority(right).priority - getSkillPriority(left).priority;
  return priorityDifference || left.localeCompare(right);
}

/**
 * Return a new array, retaining every input item, with core guidance first.
 *
 * When dependency metadata is supplied, selected dependencies are emitted
 * before their selected dependents. Dependencies that were not selected are
 * deliberately ignored: this function never expands the resolver result.
 * Duplicate names retain their multiplicity and are emitted together, as
 * names identify the logical selected skill for dependency purposes.
 *
 * This is intentionally opt-in presentation ordering. Call it only after
 * routing, closure, conflict, and budget decisions, and before prompt
 * materialization/rendering. It does not alter representations, prompt text,
 * assignment input, provider/model ranking, routing evidence, or qualification
 * inputs.
 * This is deliberately a presentation helper: it does not select, reject,
 * deduplicate, or otherwise change the routing result.
 */
export function orderSkillsCoreFirst(
  names: readonly string[],
  dependencies: SkillPriorityDependencies = new Map(),
): string[] {
  if (names.length < 2) return [...names];

  const firstIndex = new Map<string, number>();
  const occurrences = new Map<string, string[]>();
  for (const [index, name] of names.entries()) {
    if (!firstIndex.has(name)) firstIndex.set(name, index);
    occurrences.set(name, [...(occurrences.get(name) ?? []), name]);
  }

  const selectedNames = [...firstIndex.keys()];
  const selectedSet = new Set(selectedNames);
  const outgoing = new Map<string, Set<string>>(
    selectedNames.map((name) => [name, new Set<string>()]),
  );

  // An edge points from dependency to dependent. Restricting both endpoints
  // to selectedNames is what keeps this helper from changing membership.
  for (const name of selectedNames) {
    for (const dependency of dependencies.get(name) ?? []) {
      if (selectedSet.has(dependency) && dependency !== name) {
        outgoing.get(dependency)!.add(name);
      }
    }
  }

  // Collapse cycles into strongly connected components. A cycle cannot have
  // a valid internal dependency order, so its members retain input order while
  // all acyclic dependency edges remain enforced.
  const components = stronglyConnectedComponents(selectedNames, outgoing);
  const componentOf = new Map<string, number>();
  components.forEach((component, componentIndex) => {
    for (const name of component) componentOf.set(name, componentIndex);
  });

  const componentOutgoing = components.map(() => new Set<number>());
  const indegree = components.map(() => 0);
  for (const [dependency, dependents] of outgoing) {
    for (const dependent of dependents) {
      const from = componentOf.get(dependency)!;
      const to = componentOf.get(dependent)!;
      if (from !== to && !componentOutgoing[from]!.has(to)) {
        componentOutgoing[from]!.add(to);
        indegree[to]! += 1;
      }
    }
  }

  const componentRank = (componentIndex: number): [number, string, number] => {
    const members = components[componentIndex]!;
    const representative = [...members].sort(compareSkillPriority)[0]!;
    return [
      getSkillPriority(representative).priority,
      representative,
      firstIndex.get(representative)!,
    ];
  };
  const compareComponents = (left: number, right: number): number => {
    const leftRank = componentRank(left);
    const rightRank = componentRank(right);
    return compareSkillPriority(leftRank[1], rightRank[1]) || leftRank[2] - rightRank[2];
  };

  const ready = indegree
    .map((degree, componentIndex) => (degree === 0 ? componentIndex : -1))
    .filter((componentIndex) => componentIndex >= 0)
    .sort(compareComponents);
  const orderedNames: string[] = [];
  while (ready.length) {
    const componentIndex = ready.shift()!;
    const members = components[componentIndex]!.slice().sort(
      (left, right) => firstIndex.get(left)! - firstIndex.get(right)!,
    );
    for (const name of members) orderedNames.push(...occurrences.get(name)!);

    for (const dependent of componentOutgoing[componentIndex]!) {
      indegree[dependent]! -= 1;
      if (indegree[dependent] === 0) {
        ready.push(dependent);
        ready.sort(compareComponents);
      }
    }
  }

  // The SCC condensation graph is acyclic, so this is defensive only. It
  // makes the helper total if its graph construction changes in the future.
  if (orderedNames.length !== names.length) return [...names];
  return orderedNames;
}

function stronglyConnectedComponents(
  names: readonly string[],
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (name: string): void => {
    indices.set(name, nextIndex);
    lowLinks.set(name, nextIndex);
    nextIndex += 1;
    stack.push(name);
    onStack.add(name);

    for (const dependent of outgoing.get(name) ?? []) {
      if (!indices.has(dependent)) {
        visit(dependent);
        lowLinks.set(name, Math.min(lowLinks.get(name)!, lowLinks.get(dependent)!));
      } else if (onStack.has(dependent)) {
        lowLinks.set(name, Math.min(lowLinks.get(name)!, indices.get(dependent)!));
      }
    }

    if (lowLinks.get(name) === indices.get(name)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== name);
      components.push(component);
    }
  };

  for (const name of names) {
    if (!indices.has(name)) visit(name);
  }
  return components;
}
