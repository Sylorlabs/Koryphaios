import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { communicationPacket, scoreCommunication } from '../../eval/skills/skill-eval-communication-fixtures';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('communication artifact fixture contracts', () => {
  test('executive uncertainty is not mistaken for affirmative certainty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-communication-fixture-test-'));
    roots.push(root);
    const id = 'executive-communication-risk-update';
    writeFixtureFile(root, 'source.md', communicationPacket(id).source);
    writeFixtureFile(root, 'review.md', 'Review artifact present.');

    writeFixtureFile(root, 'revised.md', communicationPacket(id).source);
    const preserved = scoreCommunication(root, id);
    expect(preserved.passed, preserved.evidence.join('\n')).toBe(true);

    writeFixtureFile(
      root,
      'revised.md',
      '# Executive update\n\nThe launch is approved. Security review is complete.\n',
    );
    const invented = scoreCommunication(root, id);
    expect(invented.passed).toBe(false);
    expect(invented.evidence).toContain('no invented certainty: fail');
  });
});
