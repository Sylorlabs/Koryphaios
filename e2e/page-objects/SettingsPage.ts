/**
 * SettingsPage — page object for the settings drawer and keyboard shortcuts.
 */

import type { Page, Locator } from '@playwright/test';

export class SettingsPage {
  readonly page: Page;
  readonly openButton: Locator;
  readonly drawer: Locator;

  constructor(page: Page) {
    this.page = page;
    this.openButton = page.getByRole('button', { name: /settings/i });
    this.drawer = page.locator('[data-testid="settings-drawer"], [role="dialog"]').filter({ hasText: /settings/i });
  }

  async openViaKeyboard() {
    await this.page.keyboard.press('Control+,');
  }

  async close() {
    await this.page.keyboard.press('Escape');
  }

  async expectVisible() {
    await this.drawer.expectVisible();
  }

  async expectHidden() {
    await this.drawer.expectHidden();
  }

  get keyboardShortcutsSection(): Locator {
    return this.page.getByText('Keyboard Shortcuts');
  }
}
