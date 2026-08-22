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

  // Type a goal creation command
  await composer.fill('/goal create Finish the release');
  await composer.press('Enter');

  // The Active Goals panel should appear
  const goals = page.getByLabel('Active Goals');
  await expect(goals).toBeVisible({ timeout: 10_000 });

  // The new goal input should contain the goal text
  const newGoal = goals.getByLabel('New goal');
  await expect(newGoal).toHaveValue('Finish the release');

  // Confirm the goal
  await newGoal.press('Enter');

  // The Critic quality gate toggle should be visible
  await expect(goals.getByText(/Critic quality gate (on|off)/)).toBeVisible({ timeout: 10_000 });

  // Test goal resume command
  await composer.fill('/goal resume');
  await composer.press('Enter');
  // With no paused goals, an alert should appear
  await expect(goals.getByRole('alert')).toContainText('No paused or blocked goal', {
    timeout: 10_000,
  });
});
