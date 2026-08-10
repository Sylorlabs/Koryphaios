import { describe, expect, test } from 'bun:test';
import { ConflictError, InternalError } from '../errors/types';
import { errorHandler } from './error-handling';

function invoke(error: Error) {
  const set: { status?: number; headers: Record<string, string> } = { headers: {} };
  const body = errorHandler({
    code: 'UNKNOWN',
    error,
    request: new Request('http://localhost/api/notes/example', { method: 'PUT' }),
    set,
  });
  return { body, set };
}

describe('public error detail boundaries', () => {
  test('returns only whitelisted optimistic-concurrency fields for conflicts', () => {
    const { body, set } = invoke(
      new ConflictError('Source changed', {
        currentRevision: 4,
        sourceDeleted: true,
        sourcePath: '/private/project/plan.md',
        submittedContent: 'private draft',
      }),
    );

    expect(set.status).toBe(409);
    expect(body).toMatchObject({
      ok: false,
      code: 'CONFLICT',
      details: { currentRevision: 4, sourceDeleted: true },
    });
    expect(JSON.stringify(body)).not.toContain('/private/project');
    expect(JSON.stringify(body)).not.toContain('private draft');
  });

  test('never exposes details for internal errors', () => {
    const { body, set } = invoke(new InternalError('Database failed', { secret: 'hidden' }));
    expect(set.status).toBe(500);
    expect(body).toMatchObject({
      ok: false,
      code: 'INTERNAL_ERROR',
      error: 'Internal server error',
    });
    expect(body).not.toHaveProperty('details');
  });
});
