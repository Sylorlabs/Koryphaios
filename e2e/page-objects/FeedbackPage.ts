/**
 * FeedbackPage — page object for the feedback dialog.
 */

import type { Page, Locator } from '@playwright/test';

export class FeedbackPage {
  readonly page: Page;
  readonly openButton: Locator;
  readonly dialog: Locator;
  readonly typeButtons: {
    idea: Locator;
    bug: Locator;
    other: Locator;
  };
  readonly detailsField: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.openButton = page.getByRole('button', { name: /Feedback/ });
    this.dialog = page.getByRole('dialog');
    this.typeButtons = {
      idea: page.getByRole('button', { name: 'Idea' }),
      bug: page.getByRole('button', { name: 'Bug' }),
      other: page.getByRole('button', { name: 'Other' }),
    };
    this.detailsField = page.getByPlaceholder('Share the details that would help us act on this.');
    this.submitButton = page.getByRole('button', { name: 'Create issue' });
  }

  async open() {
    await this.openButton.click();
  }

  async submit(type: 'idea' | 'bug' | 'other', details: string) {
    await this.openButton.click();
    await this.typeButtons[type].click();
    await this.detailsField.fill(details);
    await this.submitButton.click();
  }

  get openingNotice(): Locator {
    return this.page.getByText('Opening GitHub issue');
  }
}
