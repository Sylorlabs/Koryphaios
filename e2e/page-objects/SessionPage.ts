/**
 * SessionPage — page object for session sidebar and session management.
 */

import type { Page, Locator } from '@playwright/test';

export class SessionPage {
  readonly page: Page;
  readonly sidebar: Locator;
  readonly newSessionButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.sidebar = page.locator('[data-testid="session-sidebar"], aside').first();
    this.newSessionButton = page.getByRole('button', { name: /new session|create session/i });
  }

  async createSession(title?: string) {
    await this.newSessionButton.click();
    if (title) {
      // If the session has an editable title field, fill it
      const titleField = this.page.getByPlaceholder(/session title|name.*session/i);
      if (await titleField.isVisible().catch(() => false)) {
        await titleField.fill(title);
        await titleField.press('Enter');
      }
    }
  }

  async selectSession(index: number) {
    const sessions = this.sidebar.getByRole('button');
    await sessions.nth(index).click();
  }

  async expectMainContentLoaded(timeout = 30_000) {
    await this.page.locator('#main-content').expectNotEmpty(timeout);
  }
}
