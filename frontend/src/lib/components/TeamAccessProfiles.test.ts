import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ updatePolicy: vi.fn() }));

/**
 * Svelte 5 stores deep-`$state` values as native `Proxy` objects, and nested
 * properties are proxied too. `structuredClone` throws `DataCloneError` on a
 * proxy, so any component that clones store state must unwrap it first
 * (`$state.snapshot`). `deepProxy` reproduces that shape faithfully: an
 * ordinary Proxy exotic object, which is exactly what `structuredClone`
 * rejects.
 */
function deepProxy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return new Proxy(
      value.map((item) => deepProxy(item)),
      {},
    ) as unknown as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = deepProxy(item);
  }
  return new Proxy(copy, {}) as T;
}

const permissions = {
  viewChat: true,
  viewSystemMessages: false,
  viewDiffs: true,
  viewAgentStatus: true,
  viewParticipants: true,
  submitPrompts: false,
  autoExecutePrompts: false,
  useTools: false,
  fullSystemAccess: false,
  readPaths: ['**'],
  writePaths: [],
  commandAllowlist: [],
  commandBlocklist: ['*'],
};

// A stable, deep-proxied session — recreated per getter call it would make the
// component's `$derived` policy identity churn.
const reactiveSession = deepProxy({
  id: 'collab-1',
  policy: {
    sessionName: 'Hosted',
    workspacePaths: [],
    modelCatalog: [],
    joinMode: 'approval',
    defaultTierId: 'viewer',
    accessTiers: [
      {
        id: 'viewer',
        name: 'Viewer',
        description: 'Read-only guest',
        builtin: 'viewer',
        color: '#94a3b8',
        allowedModels: ['*'],
        reasoningByModel: {},
        permissions,
      },
    ],
    allowedModels: ['*'],
    allowPrompts: false,
    requirePromptApproval: true,
    showDiffs: true,
    showAgentStatus: true,
    showParticipants: true,
  },
});

vi.mock('$lib/stores/collaboration.svelte', () => ({
  collaborationStore: {
    get activeCollab() {
      return reactiveSession;
    },
    get pendingJoins() {
      return [];
    },
    get participants() {
      return [];
    },
    updatePolicy: mocks.updatePolicy,
    createInvite: vi.fn(),
    decideJoin: vi.fn(),
    assignTier: vi.fn(),
  },
}));

import TeamAccessProfiles from './TeamAccessProfiles.svelte';

beforeEach(() => {
  mocks.updatePolicy.mockReset();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('TeamAccessProfiles', () => {
  it('creates and duplicates an access tier from reactive store state', async () => {
    render(TeamAccessProfiles, { props: { models: [] } });

    await fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));

    const nameInput = screen.getByPlaceholderText('New custom profile name');
    await fireEvent.input(nameInput, { target: { value: 'QA Reviewer' } });
    await fireEvent.click(screen.getByRole('button', { name: /Create profile/ }));

    expect(mocks.updatePolicy).toHaveBeenCalledTimes(1);
    const created = mocks.updatePolicy.mock.calls[0]![0] as {
      accessTiers: Array<{ id: string; name: string }>;
    };
    expect(created.accessTiers).toHaveLength(2);
    expect(created.accessTiers.at(-1)).toMatchObject({ id: 'qa-reviewer', name: 'QA Reviewer' });

    await fireEvent.click(screen.getByRole('button', { name: /Duplicate selected/ }));

    expect(mocks.updatePolicy).toHaveBeenCalledTimes(2);
    const duplicated = mocks.updatePolicy.mock.calls[1]![0] as {
      accessTiers: Array<{ id: string; name: string }>;
    };
    expect(duplicated.accessTiers).toHaveLength(2);
    expect(duplicated.accessTiers.at(-1)).toMatchObject({
      id: 'viewer-copy',
      name: 'Viewer Copy',
    });
  });
});
