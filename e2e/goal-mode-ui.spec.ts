import { test, expect } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';
import { ApiClient } from './helpers/api';
import { E2E_BACKEND_URL as BACKEND_URL } from './helpers/urls';

/**
 * Verifies Goal Mode slash commands reveal the Critic-aware control surface.
 *
 * Uses the REAL backend for auth and session creation — no demo mode.
 */
test('Goal Mode slash commands reveal a scoped, Critic-aware control surface', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);

  const auth = await createAuthSession(request, BACKEND_URL);
  await injectAuthIntoPage(page, auth.bearerToken);
  const api = new ApiClient(request, BACKEND_URL, auth.bearerToken);
  const sessionTitle = `Goal Mode E2E ${Date.now()}`;
  await api.createSession(sessionTitle);

  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });
  // Session rows expose a full-row accessible button so the title and
  // goal/status chips remain non-interactive descendants. Click that public
  // interaction target instead of relying on text hit-testing.
  await page.getByRole('button', { name: `Open session ${sessionTitle}` }).click();

  // Wait for the composer to be ready
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeEnabled({ timeout: 30_000 });

  // Type a goal creation command — the composer opens above the chat
  await composer.fill('/goal create Finish the release');
  await composer.press('Enter');

  // The goal composer card should appear above the chat with the prefilled text
  const goalComposer = page.getByRole('group', { name: 'New goal' });
  await expect(goalComposer).toBeVisible({ timeout: 10_000 });
  const newGoal = goalComposer.getByLabel('Goal objective');
  await expect(newGoal).toHaveValue('Finish the release');

  // Confirm the goal
  await newGoal.press('Enter');

  // Goal Mode renders above the chat, never in the session rail. The steering
  // bar is a single row: the objective, its progress, and the lifecycle
  // controls that actually change the goal's fate.
  const goalMode = page.getByRole('group', { name: 'Goal Mode' });
  await expect(goalMode).toBeVisible({ timeout: 10_000 });
  await expect(
    goalMode.getByRole('button', { name: /Open goal in its chat: Finish the release/ }),
  ).toBeVisible({ timeout: 10_000 });
  // The bar reports how long the goal has been going, in the smallest unit
  // that matters rather than a frozen "<1m".
  await expect(goalMode.getByLabel('Time going')).toHaveText(/\d+s/, { timeout: 10_000 });

  // Expand the slide-over to reach the Critic-aware detail
  await goalMode.getByRole('button', { name: 'Expand goal details' }).click();

  // The Critic quality gate toggle should be visible for the selected goal
  await expect(goalMode.getByText(/Critic quality gate (auto|on|off)/)).toBeVisible({ timeout: 10_000 });

  // Test goal resume command
  await composer.fill('/goal resume');
  await composer.press('Enter');
  // With no paused goals, an alert should appear on the bar
  await expect(goalMode.getByRole('alert')).toContainText('No paused or blocked goal', {
    timeout: 10_000,
  });
});

/**
 * Exercises the steering surface against the REAL backend: the combined
 * lifecycle control, the single-statement status, and hand-editing the plan.
 */
test('Goal Mode steers a goal and lets the plan be edited by hand', async ({ page, request }) => {
  test.setTimeout(90_000);

  const auth = await createAuthSession(request, BACKEND_URL);
  await injectAuthIntoPage(page, auth.bearerToken);
  const api = new ApiClient(request, BACKEND_URL, auth.bearerToken);
  const sessionTitle = `Goal Steering E2E ${Date.now()}`;
  const sessionId = await api.createSession(sessionTitle);

  // Seed the goal BEFORE the page loads. Goal Mode refreshes once on mount and
  // then follows the websocket, so a goal created after that first read would
  // never reach the bar.
  const created = await api.postJson<{ data: { id: string; checklist: { title: string }[] } }>(
    '/api/goals',
    { objective: 'Prove the steering surface end to end', scope: 'workspace' },
  );
  const goal = created.data;
  expect(goal.checklist.length).toBeGreaterThan(0);
  const firstCheck = goal.checklist[0]!.title;

  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });
  await page.getByRole('button', { name: `Open session ${sessionTitle}` }).click();
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeEnabled({ timeout: 30_000 });

  const goalMode = page.getByRole('group', { name: 'Goal Mode' });
  await expect(goalMode).toBeVisible({ timeout: 15_000 });

  // The bar steers whichever active goal it picked. Switch to this test's goal
  // through the switcher rather than assuming it is already selected.
  await goalMode.getByRole('button', { name: /Open goal in its chat:/ }).click();
  const switcher = goalMode.getByRole('menu', { name: 'Switch goal' });
  await expect(switcher).toBeVisible();
  await switcher
    .getByRole('menuitemradio', { name: /Prove the steering surface end to end/ })
    .click();
  await expect(
    goalMode.getByRole('button', { name: /Open goal in its chat: Prove the steering surface/ }),
  ).toBeVisible({ timeout: 10_000 });

  // A queued goal offers exactly one lifecycle control, and closing it out is
  // a separate destructive action rather than a second button in the pair.
  await expect(goalMode.getByRole('button', { name: 'Start goal' })).toBeVisible();
  await expect(goalMode.getByRole('button', { name: 'Close goal' })).toBeVisible();

  await goalMode.getByRole('button', { name: 'Expand goal details' }).click();
  const panel = goalMode.getByRole('region', { name: 'Goal details' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Close out' })).toBeVisible();

  // Edit the plan by hand: add, then rename, then delete.
  await panel.getByRole('button', { name: 'Edit checks' }).click();
  await panel.getByLabel('New check').fill('E2E: a hand-written check');
  await panel.getByRole('button', { name: 'Add' }).click();

  const addedRow = panel
    .getByRole('listitem')
    .filter({ hasText: 'E2E: a hand-written check' })
    .first();
  await expect(addedRow).toBeVisible({ timeout: 10_000 });

  await addedRow.getByRole('button', { name: /^Rename check/ }).click();
  // The per-row buttons are also labelled "Rename check: <title>", so the input
  // has to be addressed by role as well.
  const renameInput = panel.getByRole('textbox', { name: 'Rename check' });
  await renameInput.fill('E2E: renamed by hand');
  await renameInput.press('Enter');
  await expect(panel.getByText('E2E: renamed by hand')).toBeVisible({ timeout: 10_000 });

  // The server kept the plan; confirm through the API rather than the DOM alone.
  // GET /api/goals returns every goal, so pick this test's goal out of the list.
  const checkTitles = async () => {
    const list = await api.getJson<{ data: { id: string; checklist: { title: string }[] }[] }>(
      '/api/goals',
    );
    return list.data.find((entry) => entry.id === goal.id)!.checklist.map((item) => item.title);
  };
  const titles = await checkTitles();
  expect(titles).toContain('E2E: renamed by hand');
  expect(titles).toContain(firstCheck);

  const renamedRow = panel
    .getByRole('listitem')
    .filter({ hasText: 'E2E: renamed by hand' })
    .first();
  await renamedRow.getByRole('button', { name: /^Delete check/ }).click();
  await expect(panel.getByText('E2E: renamed by hand')).toHaveCount(0, { timeout: 10_000 });
  expect(await checkTitles()).not.toContain('E2E: renamed by hand');

  // Drive the goal through the API so the bar has a running goal to steer. The
  // e2e backend has no provider credentials, so the UI's Start button cannot
  // succeed here; what this test covers is the steering transition, not startup.
  await api.post(`/api/goals/${goal.id}/drive`, {
    sessionId,
    provider: 'openai',
    model: 'openai:e2e-stub',
  });
  await expect(goalMode.getByRole('button', { name: 'Pause goal' })).toBeVisible({
    timeout: 30_000,
  });

  // Pause through the UI, then assert the state is stated exactly once.
  await goalMode.getByRole('button', { name: 'Pause goal' }).click();
  await expect(goalMode.getByRole('button', { name: 'Resume goal' })).toBeVisible({
    timeout: 30_000,
  });

  // One badge, one reason. The blocker, the badge, and the activity log must not
  // all repeat the same word.
  await expect(panel.getByText('Paused', { exact: true })).toHaveCount(1, { timeout: 10_000 });

  // Close out is armed before it fires.
  await goalMode.getByRole('button', { name: 'Close goal' }).click();
  await expect(goalMode.getByRole('button', { name: 'Confirm close goal' })).toBeVisible();
  await goalMode.getByRole('button', { name: 'Confirm close goal' }).click();

  // Another goal may still be active (the shared e2e backend keeps earlier
  // goals), so the bar can legitimately remain. What must be true is that this
  // goal is finished and no longer offered for steering.
  await expect
    .poll(
      async () => {
        const list = await api.getJson<{ data: { id: string; status: string }[] }>('/api/goals');
        return list.data.find((entry) => entry.id === goal.id)?.status;
      },
      { timeout: 15_000 },
    )
    .toBe('cancelled');
  await expect(goalMode.getByRole('button', { name: /Prove the steering surface/ })).toHaveCount(0);
  expect(sessionId).toBeTruthy();
});
