import type { Page, Locator } from '@playwright/test';

export class HomePage {
  readonly page: Page;
  readonly logo: Locator;
  readonly textarea: Locator;
  readonly enterButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.logo = page.locator('img[alt="OpenMAIC"]');
    this.textarea = page.locator('textarea');
    // Match any of: en "Enter Classroom" / zh "进入课堂" / ru "Войти в класс".
    // Falls back to a regex on any of those words.
    this.enterButton = page
      .getByRole('button', { name: /enter|进入课堂|Войти в класс/i })
      .or(page.locator('button:has-text("进入课堂")'))
      .or(page.locator('button:has-text("Войти в класс")'));
  }

  async goto() {
    await this.page.goto('/');
  }

  async fillRequirement(text: string) {
    await this.textarea.fill(text);
  }

  async submit() {
    await this.enterButton.click();
  }
}
