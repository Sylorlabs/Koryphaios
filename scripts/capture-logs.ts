import { chromium, ConsoleMessage } from '@playwright/test';

interface LogEntry {
  type: string;
  text: string;
  timestamp: string;
}

async function captureLogs() {
  const browser = await chromium.launch({
    headless: true
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  const logs: LogEntry[] = [];

  // Capture all console messages
  page.on('console', (msg: ConsoleMessage) => {
    const type = msg.type();
    const text = msg.text();
    logs.push({
      type,
      text,
      timestamp: new Date().toISOString()
    });
    console.log(`[${type.toUpperCase()}] ${text}`);
  });

  // Capture page errors
  page.on('pageerror', (error) => {
    logs.push({
      type: 'error',
      text: error.message,
      timestamp: new Date().toISOString()
    });
    console.error(`[PAGE ERROR] ${error.message}`);
  });

  // Capture network failures
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    if (failure) {
      logs.push({
        type: 'network',
        text: `Failed to load ${request.url()}: ${failure.errorText}`,
        timestamp: new Date().toISOString()
      });
      console.error(`[NETWORK] Failed to load ${request.url()}: ${failure.errorText}`);
    }
  });

  // Capture response issues
  page.on('response', (response) => {
    if (response.status() >= 400) {
      logs.push({
        type: 'http-error',
        text: `${response.status()} ${response.url()}`,
        timestamp: new Date().toISOString()
      });
      console.error(`[HTTP ${response.status()}] ${response.url()}`);
    }
  });

  console.log('Navigating to http://localhost:3003...');
  await page.goto('http://localhost:3003', { waitUntil: 'networkidle', timeout: 30000 });

  // Wait a bit for any async errors
  await page.waitForTimeout(5000);

  // Check for any visible error messages in the DOM
  const errorElements = await page.locator('[class*="error"], [class*="Error"], [role="alert"]').all();
  console.log(`\nFound ${errorElements.length} potential error elements in DOM`);

  for (const el of errorElements) {
    try {
      const text = await el.textContent();
      const isVisible = await el.isVisible();
      if (isVisible && text) {
        console.log(`[DOM ERROR] ${text.trim()}`);
        logs.push({
          type: 'dom-error',
          text: text.trim(),
          timestamp: new Date().toISOString()
        });
      }
    } catch (e) {
      // Element might have been detached
    }
  }

  // Get page title and URL
  console.log(`\nPage title: ${await page.title()}`);
  console.log(`Final URL: ${page.url()}`);

  // Save logs to file
  const fs = await import('fs');
  fs.writeFileSync(
    '/tmp/koryphaios-logs.json',
    JSON.stringify(logs, null, 2)
  );
  console.log(`\nSaved ${logs.length} log entries to /tmp/koryphaios-logs.json`);

  await browser.close();

  // Return logs for processing
  return logs;
}

captureLogs().then((logs) => {
  const errors = logs.filter(l => l.type === 'error' || l.type === 'http-error' || l.type === 'network' || l.type === 'dom-error');
  const warnings = logs.filter(l => l.type === 'warning' || l.type === 'warn');
  
  if (errors.length > 0 || warnings.length > 0) {
    console.log(`\n\n=== SUMMARY: Found ${errors.length} errors and ${warnings.length} warnings ===`);
    if (errors.length > 0) {
      console.log('Errors:');
      errors.forEach(e => console.log(`  - [${e.type}] ${e.text}`));
    }
    if (warnings.length > 0) {
      console.log('Warnings:');
      warnings.forEach(w => console.log(`  - [${w.type}] ${w.text}`));
    }
    process.exit(1);
  } else {
    console.log('\n\n=== No errors or warnings found! ===');
    process.exit(0);
  }
}).catch((err) => {
  console.error('Script error:', err);
  process.exit(1);
});
