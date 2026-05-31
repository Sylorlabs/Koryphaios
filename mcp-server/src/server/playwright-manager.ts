import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { Logger } from '../utils/logger.js';

export class PlaywrightManager {
  private browser: Browser | null = null;
  private contexts: Map<string, BrowserContext> = new Map();
  private pages: Map<string, Page> = new Map();
  private consoleLogs: Map<string, string[]> = new Map();
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger('info', { logFile: undefined, enableConsole: false });
  }

  async initialize(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
      this.logger.info('Playwright Chromium launched');
    }
  }

  async shutdown(): Promise<void> {
    for (const context of this.contexts.values()) {
      await context.close();
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.contexts.clear();
    this.pages.clear();
    this.consoleLogs.clear();
  }

  private async getOrCreateContext(sessionId: string): Promise<BrowserContext> {
    let context = this.contexts.get(sessionId);
    if (!context) {
      if (!this.browser) await this.initialize();
      context = await this.browser!.newContext();
      this.contexts.set(sessionId, context);
      this.consoleLogs.set(sessionId, []);
    }
    return context;
  }

  async getPage(sessionId: string): Promise<Page> {
    let page = this.pages.get(sessionId);
    if (!page) {
      const context = await this.getOrCreateContext(sessionId);
      page = await context.newPage();
      this.pages.set(sessionId, page);

      // Capture logs
      page.on('console', (msg) => {
        const logs = this.consoleLogs.get(sessionId) || [];
        logs.push(`[${msg.type()}] ${msg.text()}`);
        this.consoleLogs.set(sessionId, logs);
      });

      page.on('pageerror', (err) => {
        const logs = this.consoleLogs.get(sessionId) || [];
        logs.push(`[error] ${err.message}`);
        this.consoleLogs.set(sessionId, logs);
      });
    }
    return page;
  }

  async navigate(sessionId: string, url: string): Promise<void> {
    const page = await this.getPage(sessionId);
    await page.goto(url, { waitUntil: 'networkidle' });
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    const page = await this.getPage(sessionId);
    return await page.screenshot({ fullPage: true });
  }

  async click(sessionId: string, selector: string): Promise<void> {
    const page = await this.getPage(sessionId);
    await page.click(selector);
  }

  async fill(sessionId: string, selector: string, value: string): Promise<void> {
    const page = await this.getPage(sessionId);
    await page.fill(selector, value);
  }

  async evaluate(sessionId: string, script: string): Promise<any> {
    const page = await this.getPage(sessionId);
    return await page.evaluate(script);
  }

  getLogs(sessionId: string): string[] {
    return this.consoleLogs.get(sessionId) || [];
  }

  clearLogs(sessionId: string): void {
    this.consoleLogs.set(sessionId, []);
  }
}
