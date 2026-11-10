import { deflateSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';
import { ApiClient } from './helpers/api';
import { E2E_BACKEND_URL } from './helpers/urls';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([typeBytes, Buffer.from(data)]);
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  payload.copy(result, 4);
  result.writeUInt32BE(crc32(payload), 8 + data.length);
  return result;
}

function solidPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256, 0);
  header.writeUInt32BE(256, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(256 * (1 + 256 * 4));
  for (let row = 0; row < 256; row += 1) {
    const offset = row * (1 + 256 * 4);
    pixels[offset] = 0;
    for (let column = 0; column < 256; column += 1) {
      pixels[offset + 1 + column * 4] = 36;
      pixels[offset + 2 + column * 4] = 99;
      pixels[offset + 3 + column * 4] = 235;
      pixels[offset + 4 + column * 4] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

test('project identity persists, uploads a cropped image, resets, and syncs to another client', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(180_000);
  const fixture = mkdtempSync(join(tmpdir(), 'kory-project-identity-'));
  mkdirSync(join(fixture, 'demo-project'), { recursive: true });
  const root = realpathSync(fixture);
  const project = realpathSync(join(root, 'demo-project'));
  const auth = await createAuthSession(request, E2E_BACKEND_URL);
  const api = new ApiClient(request, E2E_BACKEND_URL, auth.bearerToken);
  const secondPage = await browser.newPage();

  try {
    expect((await api.post('/api/workspace/open', { root })).ok()).toBe(true);
    expect((await api.post('/api/workspace/select', { path: project })).ok()).toBe(true);
    await injectAuthIntoPage(page, auth.bearerToken);
    await injectAuthIntoPage(secondPage, auth.bearerToken);
    await page.goto('/');
    await secondPage.goto('/');

    const settings = page.getByRole('button', { name: 'Open settings', exact: true });
    await settings.click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.getByRole('button', { name: /Project identity/ }).click();
    await expect(
      dialog.getByRole('heading', { name: 'Project identity', exact: true }),
    ).toBeVisible();

    await dialog.getByRole('textbox', { name: 'Display name' }).fill('Demo Project');
    const mode = dialog.getByRole('combobox', { name: 'Icon mode' });
    await mode.click();
    const modeListbox = page.getByRole('listbox', { name: 'Icon mode' });
    await expect(modeListbox).toBeVisible();
    await page
      .getByRole('listbox', { name: 'Icon mode' })
      .getByRole('option', { name: /^Color/ })
      .click();
    await dialog.getByRole('combobox', { name: 'Color' }).click();
    await page
      .getByRole('listbox', { name: 'Color' })
      .getByRole('option', { name: /^Teal/ })
      .click();
    await dialog.getByRole('button', { name: 'Save identity' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Project identity saved.');

    const saved = await api.getJson<{ data: { name: string; icon: { mode: string } } }>(
      '/api/workspace/project-identity',
      { 'X-Koryphaios-Project': project },
    );
    expect(saved.data).toMatchObject({ name: 'Demo Project', icon: { mode: 'color' } });

    // Letters and emoji share one field so the icon renders both together.
    await mode.click();
    await page
      .getByRole('listbox', { name: 'Icon mode' })
      .getByRole('option', { name: /^Monogram & emoji/ })
      .click();
    const iconText = dialog.getByRole('textbox', { name: 'Monogram & emoji' });
    await iconText.fill('🚀');
    await dialog.getByRole('combobox', { name: 'Color' }).click();
    await page.getByRole('listbox', { name: 'Color' }).getByRole('option', { name: /^Purple/ }).click();
    await dialog.getByRole('button', { name: 'Save identity' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Project identity saved.');

    // One emoji plus one letter is exactly two graphemes, so both fit.
    await iconText.fill('🚀D');
    await dialog.getByRole('button', { name: 'Save identity' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Project identity saved.');
    const mixed = await api.getJson<{
      data: { icon: { mode: string; value?: string } };
    }>('/api/workspace/project-identity', { 'X-Koryphaios-Project': project });
    expect(mixed.data.icon).toMatchObject({ mode: 'monogram', value: '🚀D' });

    await mode.click();
    await page
      .getByRole('listbox', { name: 'Icon mode' })
      .getByRole('option', { name: /^Uploaded image/ })
      .click();
    await dialog
      .getByRole('region', { name: 'Custom icon' })
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'project.png',
        mimeType: 'image/png',
        buffer: solidPng(),
      });
    await expect(dialog.getByText('Project image saved.', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    const uploaded = await api.getJson<{
      data: { icon: { mode: string; assetId?: string }; assetUrl?: string };
    }>('/api/workspace/project-identity', { 'X-Koryphaios-Project': project });
    expect(uploaded.data.icon.mode).toBe('image');
    expect(uploaded.data.assetUrl).toContain('/api/workspace/project-icon/');

    await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(dialog.getByText('Project identity reset.', { exact: true })).toBeVisible();
    const reset = await api.getJson<{ data: { id: string; icon: { mode: string } } }>(
      '/api/workspace/project-identity',
      { 'X-Koryphaios-Project': project },
    );
    expect(reset.data.icon.mode).toBe('automatic');

    // A second browser receives the authoritative workspace update rather than
    // relying on a local project preference.
    const picker = secondPage.getByTestId('workspace-new-chat');
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await expect(picker.getByTestId('project-icon')).toHaveAttribute(
      'data-project-id',
      reset.data.id,
    );
  } finally {
    await api.delete('/api/workspace/state').catch(() => undefined);
    await secondPage.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
