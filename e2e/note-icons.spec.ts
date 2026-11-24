import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from './helpers/fixture';

test('note icons can be customized from editor and graph and survive reload', async ({
  authenticatedPage: page,
  api,
}, testInfo) => {
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), 'kory-note-icons-e2e-'));
  const project = { 'x-koryphaios-project': root };
  try {
    expect((await api.post('/api/workspace/select', { path: root })).ok()).toBe(true);
    const created = await api.post(
      '/api/notes',
      { title: 'Icon example', content: 'A note with its own icon.' },
      project,
    );
    expect(created.ok()).toBe(true);
    const note = (await created.json()).data;
    await page.goto('/');
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page
      .getByRole('button', { name: /Icon example/ })
      .first()
      .click();
    await expect(page.getByPlaceholder('Note title...')).toHaveValue('Icon example');
    await page.getByPlaceholder('Note title...').click({ button: 'right' });
    await page.getByRole('menuitemradio', { name: 'Idea', exact: true }).click();
    await expect(page.getByRole('menu', { name: 'Note icon' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Customize note icon' }).last()).toContainText(
      '💡',
    );

    await page.getByRole('tab', { name: 'Graph', exact: true }).click();
    const graph = page.getByLabel('Interactive note graph', { exact: true });
    await expect(graph).toBeVisible();
    await graph.press('Home');
    const bounds = await graph.boundingBox();
    await graph.click({
      button: 'right',
      position: { x: bounds!.width / 2, y: bounds!.height / 2 },
    });
    await expect(page.getByRole('menu', { name: 'Note icon' })).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: 'Idea' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.getByLabel('Upload a note icon').setInputFiles({
      name: 'custom.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    await expect(page.getByRole('menu', { name: 'Note icon' })).toHaveCount(0);
    const saved = (await (await api.get(`/api/notes/${note.id}`, project)).json()).data;
    expect(saved.icon.kind).toBe('image');
    expect(saved.icon.value).toMatch(/^data:image\/png;base64,/);
    expect(saved.revision).toBe(note.revision);
    await page.screenshot({ path: testInfo.outputPath('note-icon-graph.png') });

    await page.reload();
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page
      .getByRole('button', { name: /Icon example/ })
      .first()
      .click();
    await expect(
      page.getByRole('button', { name: 'Customize note icon' }).last().locator('img'),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('note-icon-editor.png') });
    await page
      .getByRole('button', { name: 'Customize note icon' })
      .last()
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Reset to default' }).click();
    await expect(
      page.getByRole('button', { name: 'Customize note icon' }).last().locator('img'),
    ).toHaveCount(0);
  } finally {
    await api.post('/api/workspace/deselect');
    await rm(root, { recursive: true, force: true });
  }
});
