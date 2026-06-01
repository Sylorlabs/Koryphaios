import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`[Browser Console Error] ${msg.text()}`);
    }
  });

  page.on('pageerror', exception => {
    console.log(`[Browser Page Error] ${exception}`);
  });

  console.log("Navigating to http://127.0.0.1:3003 ...");
  try {
    await page.goto('http://127.0.0.1:3003');
    await page.waitForTimeout(5000); // Wait 5 seconds to catch startup errors
  } catch (err) {
    console.log(`Failed to navigate: ${err}`);
  }

  await browser.close();
}

main().catch(console.error);
