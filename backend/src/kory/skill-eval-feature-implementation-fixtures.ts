import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  hasRegressionText,
  packageJson,
  readJsonArtifact,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const SAVED_FILTERS = 'feature-implementation-full-task-1-individual';
const RESUMABLE_UPLOAD = 'feature-implementation-full-task-2-individual';

const ISSUE_FILTER_SOURCE = `export interface IssueFilterState {
  query: string;
  sort: 'updated' | 'created';
}

export function filterFromUrl(url: string): IssueFilterState {
  const parsed = new URL(url, 'https://fixture.invalid');
  return {
    query: parsed.searchParams.get('q') ?? '',
    sort: parsed.searchParams.get('sort') === 'created' ? 'created' : 'updated',
  };
}

export function filterToUrl(filter: IssueFilterState): string {
  const params = new URLSearchParams();
  if (filter.query) params.set('q', filter.query);
  params.set('sort', filter.sort);
  return '/issues?' + params.toString();
}
`;

const FILTER_STORE_SOURCE = `export interface SavedFilterRecord {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  query: string;
  sort: 'updated' | 'created';
  shared: boolean;
}

export class MemorySavedFilterStore {
  private records = new Map<string, SavedFilterRecord>();
  private nextId = 1;

  list(workspaceId: string): SavedFilterRecord[] {
    return [...this.records.values()].filter((item) => item.workspaceId === workspaceId);
  }

  get(id: string): SavedFilterRecord | null {
    return this.records.get(id) ?? null;
  }

  put(input: Omit<SavedFilterRecord, 'id'> & { id?: string }): SavedFilterRecord {
    const id = input.id ?? 'filter-' + this.nextId++;
    const record = { ...input, id } as SavedFilterRecord;
    this.records.set(id, record);
    return record;
  }

  remove(id: string): boolean {
    return this.records.delete(id);
  }
}
`;

const SAVED_FILTER_SERVICE = `import type { IssueFilterState } from './issue-filter';
import { MemorySavedFilterStore, type SavedFilterRecord } from './filter-store';

export interface FilterActor {
  userId: string;
  workspaceId: string;
  workspaceRole: 'member' | 'admin';
}

export class SavedFilterService {
  constructor(private readonly store: MemorySavedFilterStore) {}

  create(
    actor: FilterActor,
    input: { name: string; query: string; sort: 'updated' | 'created'; shared?: boolean },
  ): SavedFilterRecord {
    void actor;
    void input;
    throw new Error('saved filters are not implemented');
  }

  apply(actor: FilterActor, id: string): IssueFilterState {
    void actor;
    void id;
    throw new Error('saved filters are not implemented');
  }

  rename(actor: FilterActor, id: string, name: string): SavedFilterRecord {
    void actor;
    void id;
    void name;
    throw new Error('saved filters are not implemented');
  }

  delete(actor: FilterActor, id: string): void {
    void actor;
    void id;
    throw new Error('saved filters are not implemented');
  }
}
`;

const FILTER_CONTROLLER = `import { filterFromUrl, filterToUrl, type IssueFilterState } from './issue-filter';
import { SavedFilterService, type FilterActor } from './saved-filter-service';

export class IssueListController {
  private current: IssueFilterState;
  private activeSavedFilterId: string | null = null;

  constructor(
    url: string,
    private readonly actor: FilterActor,
    private readonly savedFilters: SavedFilterService,
  ) {
    this.current = filterFromUrl(url);
  }

  state(): { filter: IssueFilterState; activeSavedFilterId: string | null; url: string } {
    return {
      filter: { ...this.current },
      activeSavedFilterId: this.activeSavedFilterId,
      url: filterToUrl(this.current),
    };
  }

  applySaved(id: string): void {
    this.current = this.savedFilters.apply(this.actor, id);
    this.activeSavedFilterId = id;
  }

  clearSaved(): void {
    this.activeSavedFilterId = null;
  }
}
`;

const FILTER_PUBLIC_TEST = `import { expect, test } from 'bun:test';
import { filterFromUrl, filterToUrl } from '../src/issue-filter';

test('existing ad-hoc URL filtering remains round-trippable', () => {
  const state = filterFromUrl('/issues?q=owner%3Ame&sort=created');
  expect(state).toEqual({ query: 'owner:me', sort: 'created' });
  expect(filterToUrl(state)).toContain('q=owner%3Ame');
});
`;

const savedFiltersMaterializer: SkillEvalFixtureMaterializer = {
  id: 'feature-implementation/saved-filter-vertical-slice@1',
  matches: (scenario) => scenario.id === SAVED_FILTERS,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-saved-filters'));
    writeFixtureFile(destination, 'src/issue-filter.ts', ISSUE_FILTER_SOURCE);
    writeFixtureFile(destination, 'src/filter-store.ts', FILTER_STORE_SOURCE);
    writeFixtureFile(destination, 'src/saved-filter-service.ts', SAVED_FILTER_SERVICE);
    writeFixtureFile(destination, 'src/issue-list-controller.ts', FILTER_CONTROLLER);
    writeFixtureFile(destination, 'tests/issue-filter.test.ts', FILTER_PUBLIC_TEST);
    writeFixtureFile(
      destination,
      'contract/saved-filters.md',
      `# Saved-filter contract

- A saved filter has name, query, sort, and optional shared flag.
- Private filters are visible/applicable only to their owner. Private duplicate names are allowed, including for the same user.
- Shared filters are visible to workspace members. A shared name must be unique within a workspace, case-insensitively.
- Owners may rename/delete their private filter. The owner or a workspace admin may rename/delete a shared filter.
- Applying a missing/deleted filter returns a not-found error; it must not silently keep an obsolete saved-filter identity.
- A permission denial is explicit and non-mutating.
- Existing URL-based ad-hoc filters work unchanged whenever no saved filter is active.
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Saved-filter vertical-slice fixture

Implement the feature through the existing store/service/controller seams. Preserve \`issue-filter.ts\` and its URL contract. Add focused regression coverage for create/apply/rename/delete, private/shared visibility and permissions, shared-name uniqueness, private duplicate names, missing/deleted saved filters, and existing ad-hoc URL filtering.

This is a TypeScript vertical slice under broader \`implementation\`. The generated scenario metadata names \`c-cpp-systems-engineering\` as a near-neighbor, but this fixture contains no C/C++ boundary; do not absorb or invent that responsibility. Record the hierarchy/specialist decision and verification scope in \`.kory-eval/feature-implementation-1.json\`.
`,
    );
  },
};

const savedFiltersScorer: SkillEvalDeterministicScorer = {
  id: 'feature-implementation/saved-filter-vertical-slice-scorer@4',
  scenarioIds: [SAVED_FILTERS],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { MemorySavedFilterStore } from '../src/filter-store';
import { IssueListController } from '../src/issue-list-controller';
import { SavedFilterService } from '../src/saved-filter-service';

const owner = { userId: 'u1', workspaceId: 'w1', workspaceRole: 'member' as const };
const member = { userId: 'u2', workspaceId: 'w1', workspaceRole: 'member' as const };
const admin = { userId: 'u3', workspaceId: 'w1', workspaceRole: 'admin' as const };
const outsider = { userId: 'u4', workspaceId: 'w2', workspaceRole: 'member' as const };

test('hidden: create/apply preserves exact saved query+sort and URL fallback remains intact', () => {
  const store = new MemorySavedFilterStore();
  const service = new SavedFilterService(store);
  const saved = service.create(owner, { name: 'Mine', query: 'owner:me', sort: 'created' });
  const controller = new IssueListController('/issues?q=label%3Abug&sort=updated', owner, service);
  expect(controller.state().filter.query).toBe('label:bug');
  controller.applySaved(saved.id);
  expect(controller.state()).toMatchObject({
    filter: { query: 'owner:me', sort: 'created' },
    activeSavedFilterId: saved.id,
  });
});

test('hidden: private duplicate names are allowed; shared names are unique per workspace', () => {
  const store = new MemorySavedFilterStore();
  const service = new SavedFilterService(store);
  expect(service.create(owner, { name: 'triage', query: 'a', sort: 'updated' }).name).toBe('triage');
  expect(service.create(owner, { name: 'triage', query: 'b', sort: 'updated' }).name).toBe('triage');
  service.create(owner, { name: 'Shared Triage', query: 'c', sort: 'updated', shared: true });
  expect(() => service.create(member, { name: 'shared triage', query: 'd', sort: 'created', shared: true })).toThrow(/duplicate|exists|unique|conflict/i);
  expect(service.create(outsider, { name: 'Shared Triage', query: 'e', sort: 'updated', shared: true }).workspaceId).toBe('w2');
});

test('hidden: visibility, rename/delete permissions, stale deletion and admin shared ownership are bounded', () => {
  const store = new MemorySavedFilterStore();
  const service = new SavedFilterService(store);
  const privateFilter = service.create(owner, { name: 'private', query: 'x', sort: 'updated' });
  expect(() => service.apply(member, privateFilter.id)).toThrow(/permission|forbidden|not found|denied/i);
  expect(() => service.rename(member, privateFilter.id, 'nope')).toThrow(/permission|forbidden|denied/i);
  expect(service.apply(owner, privateFilter.id).query).toBe('x');
  service.delete(owner, privateFilter.id);
  expect(() => service.apply(owner, privateFilter.id)).toThrow(/not[- ]found|missing|deleted/i);

  const shared = service.create(owner, { name: 'shared', query: 'y', sort: 'created', shared: true });
  expect(service.apply(member, shared.id).query).toBe('y');
  expect(service.rename(admin, shared.id, 'shared-2').name).toBe('shared-2');
  service.delete(admin, shared.id);
  expect(store.get(shared.id)).toBeNull();
});
`,
    );
    const issueFilterPreserved =
      readFileSync(join(workingDirectory, 'src/issue-filter.ts'), 'utf8') === ISSUE_FILTER_SOURCE;
    const regression = hasRegressionText(workingDirectory, [
      /shared/iu,
      /permission|forbidden/iu,
      /delete|missing|stale/iu,
      /url|ad-hoc|filterFromUrl/iu,
    ]);
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/feature-implementation-1.json',
    );
    const body = JSON.stringify(artifact ?? '').toLowerCase();
    const hierarchy =
      /implementation/u.test(body) &&
      /c-cpp-systems-engineering/u.test(body) &&
      /not selected|rejected|no c\/c\+\+|not applicable|outside/u.test(body);
    const passed = hidden.passed && issueFilterPreserved && regression && hierarchy;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && issueFilterPreserved ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !issueFilterPreserved,
      evidence: [
        `saved-filter end-to-end + failure paths: ${hidden.passed ? 'pass' : 'fail'}`,
        `existing URL filtering contract: ${issueFilterPreserved ? 'preserved' : 'changed'}`,
        `representative regression coverage: ${regression ? 'present' : 'missing'}`,
        `hierarchy/specialist boundary: ${hierarchy ? 'explicit' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const UPLOAD_SERVER = `export type UploadState = 'active' | 'cancelled' | 'completed' | 'expired';

interface UploadRecord {
  state: UploadState;
  committed: Set<number>;
  chunkCount: number;
  completedFileCount: number;
}

export class UploadServer {
  private records = new Map<string, UploadRecord>();
  private nextId = 1;

  start(chunkCount: number): string {
    const id = 'upload-' + this.nextId++;
    this.records.set(id, { state: 'active', committed: new Set(), chunkCount, completedFileCount: 0 });
    return id;
  }

  status(id: string): { state: UploadState; committedChunks: number[]; chunkCount: number } {
    const record = this.records.get(id);
    if (!record || record.state === 'expired') throw Object.assign(new Error('upload id expired'), { code: 'expired_upload' });
    return { state: record.state, committedChunks: [...record.committed].sort((a, b) => a - b), chunkCount: record.chunkCount };
  }

  uploadChunk(id: string, number: number): { acknowledged: number; duplicate: boolean } {
    const record = this.records.get(id);
    if (!record || record.state === 'expired') throw Object.assign(new Error('upload id expired'), { code: 'expired_upload' });
    if (record.state !== 'active') throw new Error('upload is not active');
    const duplicate = record.committed.has(number);
    record.committed.add(number);
    return { acknowledged: number, duplicate };
  }

  complete(id: string): void {
    const record = this.records.get(id);
    if (!record || record.state === 'expired') throw Object.assign(new Error('upload id expired'), { code: 'expired_upload' });
    if (record.state === 'completed') return;
    if (record.state !== 'active' || record.committed.size !== record.chunkCount) throw new Error('upload incomplete');
    record.state = 'completed';
    record.completedFileCount += 1;
  }

  cancel(id: string): void {
    const record = this.records.get(id);
    if (!record || record.state === 'expired') return;
    if (record.state === 'active') record.state = 'cancelled';
  }

  expire(id: string): void {
    const record = this.records.get(id);
    if (record && record.state === 'active') record.state = 'expired';
  }

  completedFileCount(id: string): number {
    return this.records.get(id)?.completedFileCount ?? 0;
  }
}
`;

const RESUME_STORE = `export interface ResumeMetadata {
  fileKey: string;
  uploadId: string;
  chunkCount: number;
}

export class MemoryResumeStore {
  private values = new Map<string, ResumeMetadata>();
  get(fileKey: string): ResumeMetadata | null { return this.values.get(fileKey) ?? null; }
  set(metadata: ResumeMetadata): void { this.values.set(metadata.fileKey, { ...metadata }); }
  remove(fileKey: string): void { this.values.delete(fileKey); }
}
`;

const UPLOAD_CLIENT = `import { MemoryResumeStore } from './resume-store';
import { UploadServer } from './upload-server';

export class ChunkUploadClient {
  constructor(
    private readonly server: UploadServer,
    private readonly resumeStore: MemoryResumeStore,
  ) {}

  begin(fileKey: string, chunkCount: number): string {
    const uploadId = this.server.start(chunkCount);
    // BUG: upload identity is not persisted, so refresh/reopen cannot resume.
    return uploadId;
  }

  upload(uploadId: string, chunkNumber: number): void {
    this.server.uploadChunk(uploadId, chunkNumber);
  }

  resume(fileKey: string): { status: string; uploadId?: string; remaining?: number[] } {
    void fileKey;
    throw new Error('resume not implemented');
  }

  finish(fileKey: string, uploadId: string): void {
    this.server.complete(uploadId);
    this.resumeStore.remove(fileKey);
  }

  cancel(fileKey: string, uploadId: string): void {
    this.server.cancel(uploadId);
    this.resumeStore.remove(fileKey);
  }
}
`;

const UPLOAD_PUBLIC_TEST = `import { expect, test } from 'bun:test';
import { ChunkUploadClient } from '../src/upload-client';
import { MemoryResumeStore } from '../src/resume-store';
import { UploadServer } from '../src/upload-server';

test('existing chunk protocol accepts numbered chunks and completion', () => {
  const server = new UploadServer();
  const client = new ChunkUploadClient(server, new MemoryResumeStore());
  const id = client.begin('file-a', 2);
  client.upload(id, 0);
  client.upload(id, 1);
  client.finish('file-a', id);
  expect(server.status(id).state).toBe('completed');
});
`;

const uploadMaterializer: SkillEvalFixtureMaterializer = {
  id: 'feature-implementation/resumable-file-upload-slice@2',
  matches: (scenario) => scenario.id === RESUMABLE_UPLOAD,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-resumable-upload'));
    writeFixtureFile(destination, 'src/upload-server.ts', UPLOAD_SERVER);
    writeFixtureFile(destination, 'src/resume-store.ts', RESUME_STORE);
    writeFixtureFile(destination, 'src/upload-client.ts', UPLOAD_CLIENT);
    writeFixtureFile(destination, 'tests/upload.test.ts', UPLOAD_PUBLIC_TEST);
    writeFixtureFile(
      destination,
      'contract/upload.md',
      `# Existing chunk-upload contract

- Backend upload id, numbered chunk upload, committed-chunk inventory, completion, cancellation, and expired-id error already exist.
- Persist only bounded client resume metadata: stable file key, upload id, and chunk count. Do not persist chunk payloads or treat client progress as authoritative.
- On resume/reopen, query server status and derive remaining chunks from server-reported committed chunks.
- The client resume result is caller visible. An active server session that can continue returns \\\`{ status: 'resumable', uploadId, remaining }\\\`; do not leak the server internal \\\`active\\\` state label into this result.
- Duplicate chunk acknowledgement is idempotent; completion must never create a duplicate final file.
- Expired upload id is an explicit recoverable terminal for the old session: clear stale resume metadata and tell the caller a new upload must be started deliberately.
- Cancellation clears client resume metadata and must not silently restart.
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Resumable upload vertical-slice fixture

Implement pause/resume using the existing protocol and the minimum resume metadata in \`MemoryResumeStore\`. A new client instance with the same store represents refresh/reopen. Server committed-chunk inventory is authoritative. Add regression coverage for interrupted/reopened resume, duplicate acknowledgement, expiration, cancellation, and exactly-once final completion.

This deterministic repository fixture simulates the refresh/reopen storage boundary; do not claim it is browser-device proof. Record that evidence limitation plus broader \`implementation\` and the non-selected generated near-neighbor \`csharp-dotnet-engineering\` in \`.kory-eval/feature-implementation-2.json\`.
`,
    );
  },
};

const uploadScorer: SkillEvalDeterministicScorer = {
  id: 'feature-implementation/resumable-file-upload-slice-scorer@2',
  scenarioIds: [RESUMABLE_UPLOAD],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { ChunkUploadClient } from '../src/upload-client';
import { MemoryResumeStore } from '../src/resume-store';
import { UploadServer } from '../src/upload-server';

test('hidden: refresh/reopen reconciles bounded metadata with authoritative committed chunks', () => {
  const server = new UploadServer();
  const resumeStore = new MemoryResumeStore();
  const first = new ChunkUploadClient(server, resumeStore);
  const id = first.begin('file-a', 4);
  first.upload(id, 0);
  first.upload(id, 2);

  const reopened = new ChunkUploadClient(server, resumeStore);
  expect(reopened.resume('file-a')).toEqual({ status: 'resumable', uploadId: id, remaining: [1, 3] });
  reopened.upload(id, 1);
  reopened.upload(id, 3);
  reopened.finish('file-a', id);
  expect(server.status(id).state).toBe('completed');
  expect(server.completedFileCount(id)).toBe(1);
  expect(resumeStore.get('file-a')).toBeNull();
});

test('hidden: duplicate acknowledgement is harmless and completion stays exactly once', () => {
  const server = new UploadServer();
  const store = new MemoryResumeStore();
  const client = new ChunkUploadClient(server, store);
  const id = client.begin('file-b', 1);
  client.upload(id, 0);
  client.upload(id, 0);
  client.finish('file-b', id);
  expect(server.completedFileCount(id)).toBe(1);
  client.finish('file-b', id);
  expect(server.completedFileCount(id)).toBe(1);
});

test('hidden: expiry and cancellation clear stale client resume identity without silent restart', () => {
  const server = new UploadServer();
  const store = new MemoryResumeStore();
  const client = new ChunkUploadClient(server, store);
  const expired = client.begin('file-expired', 2);
  server.expire(expired);
  expect(client.resume('file-expired')).toMatchObject({ status: 'expired' });
  expect(store.get('file-expired')).toBeNull();

  const cancelled = client.begin('file-cancelled', 2);
  client.cancel('file-cancelled', cancelled);
  expect(store.get('file-cancelled')).toBeNull();
  expect(server.status(cancelled).state).toBe('cancelled');
});
`,
    );
    const serverPreserved =
      readFileSync(join(workingDirectory, 'src/upload-server.ts'), 'utf8') === UPLOAD_SERVER;
    const resumeStore = readFileSync(join(workingDirectory, 'src/resume-store.ts'), 'utf8');
    const boundedMetadata =
      /fileKey/u.test(resumeStore) &&
      /uploadId/u.test(resumeStore) &&
      /chunkCount/u.test(resumeStore) &&
      !/payload|blob|bytes|chunkData/u.test(resumeStore);
    const regression = hasRegressionText(workingDirectory, [
      /resume|reopen|refresh/iu,
      /expired|expire/iu,
      /cancel/iu,
      /duplicate|exactly|completedFileCount/iu,
    ]);
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/feature-implementation-2.json',
    );
    const body = JSON.stringify(artifact ?? '').toLowerCase();
    const evidenceBoundary =
      /simulat|fixture|not browser|repository/u.test(body) &&
      /implementation/u.test(body) &&
      /csharp-dotnet-engineering/u.test(body) &&
      /not selected|rejected|not applicable|outside/u.test(body);
    const passed =
      hidden.passed && serverPreserved && boundedMetadata && regression && evidenceBoundary;
    return {
      passed,
      quality: passed
        ? 1
        : hidden.passed && serverPreserved && boundedMetadata
          ? 0.75
          : hidden.passed
            ? 0.5
            : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !serverPreserved,
      evidence: [
        `resume/reconcile/expiry/cancel/idempotency behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `existing server protocol: ${serverPreserved ? 'preserved' : 'changed'}`,
        `bounded client metadata: ${boundedMetadata ? 'yes' : 'no'}`,
        `representative recovery regressions: ${regression ? 'present' : 'missing'}`,
        `hierarchy + simulated-evidence boundary: ${evidenceBoundary ? 'explicit' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

export const FEATURE_IMPLEMENTATION_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [savedFiltersMaterializer, uploadMaterializer];

export const FEATURE_IMPLEMENTATION_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  savedFiltersScorer,
  uploadScorer,
];
