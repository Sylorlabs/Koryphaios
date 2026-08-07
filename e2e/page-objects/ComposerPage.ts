/**
 * ComposerPage — page object for the message composer/input area.
 */

import type { Page, Locator } from '@playwright/test';

export class ComposerPage {
  readonly page: Page;
  readonly textarea: Locator;
  readonly sendButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.textarea = page.locator('textarea').last();
    this.sendButton = page.getByRole('button', { name: /send|submit/i });
  }

  async fill(message: string) {
    await this.textarea.fill(message);
  }

  async send(message: string) {
    await this.textarea.fill(message);
    await this.textarea.press('Enter');
  }

  async pressEnter() {
    await this.textarea.press('Enter');
  }

  async expectVisible(timeout = 10_000) {
    await this.textarea.expectVisible(timeout);
  }
}
