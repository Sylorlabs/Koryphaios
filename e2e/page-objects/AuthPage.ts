/**
 * AuthPage — page object for authentication flows.
 */

import type { Page, Locator } from '@playwright/test';

export class AuthPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** Navigates to the app and waits for auth to initialize. */
  async loadApp(timeout = 30_000) {
    await this.page.goto('/');
    await this.page.locator('#main-content').waitFor({ state: 'visible', timeout });
  }

  /** Waits for the auth store to report ready via the window sentinel. */
  async waitForAuthReady(timeout = 30_000) {
    await this.page.waitForFunction(
      () => (window as unknown as Record<string, unknown>).__koryphaiosAuthReady === true || document.querySelector('textarea') !== null,
      { timeout },
    );
  }

  /** Checks if the backend-unavailable overlay is visible. */
  get backendUnavailableDialog(): Locator {
    return this.page.getByRole('alertdialog', { name: 'Koryphaios backend is unavailable' });
  }

  /** Clicks the Retry now button in the unavailable dialog. */
  async retry() {
    await this.page.getByRole('alertdialog').getByRole('button', { name: 'Retry now' }).click();
  }

  /** Performs logout via the auth store. */
  async logout() {
    await this.page.evaluate(() => {
      // Access the auth store through the module system if available
      localStorage.removeItem('koryphaios-local-auth-token');
    });
    await this.page.reload();
  }
}
