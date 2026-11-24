import { test, expect } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';
import { E2E_BACKEND_URL } from './helpers/urls';
import { createIdleSessionRun } from '../shared/src/run/SessionRun';

test('open project activity tracks live outcomes and cross-window chat membership', async ({
  page,
  request,
}) => {
  const auth = await createAuthSession(request);
  const headers = { Authorization: auth.bearerToken };
  const create = async (title: string) => {
    const response = await request.post(`${E2E_BACKEND_URL}/api/sessions`, {
      headers,
      data: { title, workingDirectory: '/synthetic-chart-project' },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).data.id as string;
  };
  const first = await create(`Chart first ${Date.now()}`);
  let push!: (message: string) => void;
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    push = (message) => socket.send(message);
    const server = socket.connectToServer();
    server.onMessage((message) => socket.send(message));
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await injectAuthIntoPage(page, auth.bearerToken);
  await page.goto('/');
  const activity = page.getByRole('button', { name: 'Show synthetic-chart-project chat activity' });
  await expect(activity).toBeVisible();
  await expect.poll(() => Boolean(push)).toBe(true);
  const outcome = (id: string, phase: 'done' | 'error', revision: number) =>
    push(
      JSON.stringify({
        type: 'run.state',
        sessionId: id,
        timestamp: Date.now(),
        payload: {
          snapshot: {
            ...createIdleSessionRun(id),
            runId: `fixture-${id}`,
            phase,
            status: 'terminal',
            revision,
          },
          transition: null,
        },
      }),
    );
  outcome(first, 'done', 100);
  await activity.click();
  const dialog = page.getByRole('dialog', { name: 'synthetic-chart-project activity' });
  const summary = dialog.locator('.status-detail-summary');
  await expect(summary).toContainText('Completed');
  outcome(first, 'error', 101);
  await expect(summary).toContainText('Failed');
  await expect(summary).not.toContainText('Completed');
  // An older projection must not overwrite the newer failure.
  outcome(first, 'done', 100);
  await expect(summary).toContainText('Failed');
  const secondTitle = `Chart second ${Date.now()}`;
  const second = await create(secondTitle);
  await expect(dialog.getByText(secondTitle)).toBeVisible();
  await expect(dialog.locator('.status-detail-chart')).toHaveText('2');
  await expect(summary).toContainText('Idle');
  const removed = await request.delete(`${E2E_BACKEND_URL}/api/sessions/${first}`, { headers });
  expect(removed.ok()).toBe(true);
  await expect(dialog.locator('.status-detail-chart')).toHaveText('1');
  await expect(summary).not.toContainText('Failed');
  await expect(dialog.locator('.status-detail-row')).toHaveCount(1);
  await page.screenshot({ path: 'outputs/pie-chart-verified.png' });
  await request.delete(`${E2E_BACKEND_URL}/api/sessions/${second}`, { headers });
  expect(errors).toEqual([]);
});
