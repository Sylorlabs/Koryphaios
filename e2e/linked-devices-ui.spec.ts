import { test, expect } from './helpers/fixture';
import { createDevicePairingLink } from '../shared/src/device-pairing-link';

test('new-chat folders fit desktop and mobile layouts and mobile pairing renders a real QR', async ({
  authenticatedPage: page,
}, testInfo) => {
  const local = { id: 'local', name: 'My Mac', os: 'macOS', kind: 'desktop' };
  const remote = {
    id: 'remote',
    name: 'Linux desktop',
    os: 'Linux',
    kind: 'desktop',
    online: true,
  };
  const folder = {
    id: 'browse:project',
    name: 'Project',
    displayPath: '/home/me/projects/project',
  };
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.route('**/api/devices**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown;
    if (path.endsWith('/pairing')) {
      data = {
        code: 'ABCDE-FGHJK-LMNPQ-RSTUV',
        qrUrl: createDevicePairingLink({
          relayUrl: 'https://relay.example.com',
          code: 'ABCDE-FGHJK-LMNPQ-RSTUV',
          hostId: 'a'.repeat(64),
        }),
        expiresAt: Date.now() + 600_000,
      };
    } else if (path.endsWith('/rpc')) {
      const { operation } = route.request().postDataJSON();
      data =
        operation === 'browse_folders'
          ? { current: folder, parent: null, folders: [] }
          : operation === 'workspaces'
            ? [{ id: 'workspace', name: 'Documents', displayPath: '/home/me/Documents' }]
            : [];
    } else {
      data = {
        local,
        osName: 'My Mac',
        connected: true,
        relayUrl: 'https://relay.example.com',
        peers: [remote],
        requests: [],
      };
    }
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Create or open', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Where would you like to work?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Linux desktop Connected/ }).click();
  await expect(dialog.getByText('Start a chat without a folder')).toHaveCount(0);
  const choose = dialog.getByRole('button', { name: 'Choose a local folder on Linux desktop' });
  await expect(choose).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('new-chat-desktop.png') });
  await choose.click();
  await expect(dialog.getByText(folder.displayPath, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'New chat in Project' })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const bounds = await dialog.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: testInfo.outputPath('new-chat-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await dialog.getByRole('button', { name: '+ Link another device' }).click();
  await expect(page.getByRole('heading', { name: 'Link device', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Generate QR code', exact: true }).click();
  const qr = page.getByRole('img', { name: 'Scan to link this desktop to your phone or tablet' });
  await expect(qr).toBeVisible();
  await expect(qr).toHaveAttribute('src', /^data:image\/png;base64,/);
  expect(await qr.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('mobile-pairing-qr.png') });
  expect(errors).toEqual([]);
});

test('linked chats use the shared feed and composer and route send and stop to the chosen desktop', async ({
  authenticatedPage: page,
}) => {
  const remote = { id: 'b'.repeat(64), name: 'Target Linux', os: 'Linux', kind: 'desktop', online: true };
  const chat = { id: 'target-chat', title: 'Remote project', deviceId: remote.id,
    deviceName: remote.name, workspaceName: 'Target project' };
  const session = { id: chat.id, title: chat.title, workingDirectory: '/srv/target/project',
    createdAt: Date.now(), updatedAt: Date.now(), messageCount: 1, interactionMode: 'act' };
  const messages = [{ id: 'remote-answer', role: 'assistant', content: 'Target-owned history in the shared feed.', createdAt: Date.now() }];
  const operations: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const localPosts: string[] = [];
  const errors: string[] = [];
  let pushEvent: ((event: unknown) => void) | undefined;
  const providers = [{ name: 'custom:portable', label: 'Portable API', custom: true,
    enabled: true, authenticated: true, configured: true, connected: true,
    adapterAvailable: true, credentialDetected: true, configurationBlocked: false,
    connectionState: 'verified', models: ['portable-model'],
    allAvailableModels: [{ id: 'portable-model', name: 'Portable', provider: 'custom:portable',
      contextWindow: 8192, maxOutputTokens: 1024, functionCall: true, tier: 'fast' }] }];
  await page.route('**/api/providers', (route) => route.fulfill({ json: { ok: true, data: providers } }));
  await page.routeWebSocket('**/ws*', (socket) => {
    pushEvent = (event) => socket.send(JSON.stringify(event));
    const server = socket.connectToServer();
    server.onMessage((message) => {
      const event = JSON.parse(String(message));
      socket.send(event.type === 'provider.status'
        ? JSON.stringify({ ...event, payload: { providers } }) : message);
    });
  });
  page.on('pageerror', (error) => { errors.push(error.message); console.error(error.message); });
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/messages') localPosts.push(request.url());
  });
  await page.route('**/api/devices**', async (route) => {
    let data: unknown;
    if (new URL(route.request().url()).pathname.endsWith('/rpc')) {
      const command = route.request().postDataJSON();
      operations.push(command);
      switch (command.operation) {
        case 'workspaces': data = [{ id: 'target-workspace', name: 'Target project', displayPath: '/srv/target/project' }]; break;
        case 'folders': case 'sessions': data = []; break;
        case 'create_chat': data = chat; break;
        case 'open_chat': case 'snapshot': data = { chat, session, messages, run: null, question: null, review: null }; break;
        case 'events': data = []; break;
        case 'prompt': data = { accepted: true, runId: 'target-run' }; break;
        case 'cancel': data = { cancelled: true }; break;
        case 'workbench': {
          const path = command.input.path;
          const projected = path === `/api/messages/${chat.id}` ? messages
            : path === `/api/sessions/${chat.id}` ? session
            : path === `/api/agent/threads/${chat.id}` ? [] : {};
          data = { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: projected }) };
          break;
        }
        default: data = {};
      }
    } else data = { local: { id: 'local', name: 'My Mac', os: 'macOS', kind: 'desktop' },
      connected: true, relayUrl: 'https://relay.example.com', peers: [remote], requests: [] };
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Create or open', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Where would you like to work?' });
  await dialog.getByRole('button', { name: /Target Linux Connected/ }).click();
  await dialog.getByRole('button', { name: /Target project/ }).click();
  await dialog.getByRole('button', { name: 'New chat in Target project', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Target-owned history in the shared feed.', { exact: true })).toBeVisible();
  await expect(page.getByText('Micah’s agents', { exact: true }).first()).toBeVisible();
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeEnabled();
  await page.getByRole('button', { name: 'Select model', exact: true }).click();
  await page.getByRole('button', { name: 'Portable', exact: true }).click();
  await composer.fill('Run this on the chosen target.');
  await composer.press('Enter');
  await expect.poll(() => operations.find((command) => command.operation === 'prompt')).toMatchObject({
    operation: 'prompt', input: { sessionId: chat.id, content: 'Run this on the chosen target.', useLocalProviders: true },
  });
  pushEvent!({ type: 'device.event', timestamp: Date.now(), payload: { deviceId: remote.id,
    sessionId: chat.id, event: { type: 'run.state', sessionId: chat.id, timestamp: Date.now(),
      payload: { snapshot: { sessionId: chat.id, runId: 'target-run', revision: 1,
        status: 'active', phase: 'streaming', activeAgentIds: ['kory-manager'],
        startedAt: Date.now(), updatedAt: Date.now() }, transition: null } } } });
  await page.getByRole('button', { name: 'Stop the running model', exact: true }).click();
  await expect.poll(() => operations.find((command) => command.operation === 'cancel')).toMatchObject({
    operation: 'cancel', input: { sessionId: chat.id },
  });
  await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await expect.poll(() => operations.find((command) => command.input.path === '/api/messages/regenerate')).toMatchObject({
    operation: 'workbench', input: { useLocalProviders: true,
      body: { sessionId: chat.id } },
  });
  expect(localPosts).toEqual([]);
  expect(errors).toEqual([]);
});
