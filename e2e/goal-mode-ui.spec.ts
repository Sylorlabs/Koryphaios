import { expect, test } from '@playwright/test';

test('Goal Mode slash commands reveal a scoped, Critic-aware control surface', async ({ page }) => {
  await page.goto('/?demo=full');
  const composer = page.locator('textarea').last();
  await expect(composer).toBeVisible({ timeout: 30_000 });

  await composer.fill('/goal create Finish the release');
  await composer.press('Enter');

  const goals = page.getByLabel('Active Goals');
  await expect(goals).toBeVisible();
  const newGoal = goals.getByLabel('New goal');
  await expect(newGoal).toHaveValue('Finish the release');
  await newGoal.press('Enter');
  await expect(goals.getByText(/Critic quality gate (on|off)/)).toBeVisible();

  await composer.fill('/goal resume');
  await composer.press('Enter');
  await expect(goals.getByRole('alert')).toContainText('No paused or blocked goal');
});
