import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './helpers/fixture';

/**
 * Regression: Notes -> Bases must finish its first Base query. Selecting the
 * first Base used to throw inside the view's sync `$effect` (cloning the
 * reactive Base definition), which aborted the reactive flush and left the
 * panel on "Indexing and querying this Base…" with no reachable control.
 */
test('Notes then Bases resolves the first Base query instead of spinning forever', async ({
  authenticatedPage: page,
  api,
}, testInfo) => {
  test.setTimeout(120_000);

  const projectRoot = await mkdtemp(join(tmpdir(), 'kory-bases-e2e-'));
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));

  try {
    await writeFile(
      join(projectRoot, `alpha-${testInfo.workerIndex}.md`),
      '---\nstatus: open\n---\n\n# Alpha\n\nFirst indexed note.\n',
      'utf8',
    );
    await writeFile(
      join(projectRoot, `beta-${testInfo.workerIndex}.md`),
      '---\nstatus: closed\n---\n\n# Beta\n\nSecond indexed note.\n',
      'utf8',
    );

    const selected = await api.post('/api/workspace/select', { path: projectRoot });
    expect(selected.ok(), `Selecting the isolated project failed: ${selected.status()}`).toBe(true);

    await page.goto('/');
    await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

    // 1. Open Notes (the user's first step).
    const openNotes = page.getByRole('button', { name: 'Notes', exact: true });
    await expect(openNotes).toBeVisible({ timeout: 15_000 });
    await openNotes.click();
    await expect(page.getByRole('button', { name: 'Open Notes Trash' })).toBeVisible({
      timeout: 15_000,
    });

    // 2. Switch to the Bases view (the user's second step).
    await page.getByRole('tab', { name: 'Bases' }).click();

    const emptyState = page.getByRole('button', { name: 'Create your first Base' });
    await expect(emptyState).toBeVisible({ timeout: 20_000 });
    await emptyState.click();

    // 3. The first Base query must settle: no endless indexing spinner, and the
    //    seeded notes must render as rows.
    await expect(page.getByText('Indexing and querying this Base…')).toHaveCount(0, {
      timeout: 20_000,
    });
    const openButtons = page.getByRole('button', { name: /^Open / });
    await expect(openButtons.first()).toBeVisible({ timeout: 20_000 });
    expect(await openButtons.count()).toBeGreaterThan(0);

    // 4. The view must stay interactive (the user must not be trapped).
    await page.getByRole('tab', { name: 'Editor' }).click();
    await expect(page.getByRole('tab', { name: 'Bases' })).toBeVisible();

    expect(pageErrors, `Uncaught page errors while using Bases: ${pageErrors.join(' | ')}`).toEqual(
      [],
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
