import { chromium } from 'playwright';

async function verify() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  console.log('Navigating to http://localhost:5173...');
  try {
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 30000 });
    
    const title = await page.title();
    console.log(`Page Title: ${title}`);
    
    const h1 = await page.textContent('h1');
    console.log(`H1 Header: ${h1?.trim() || 'None'}`);
    
    // Take a screenshot to "see" it
    await page.screenshot({ path: 'app_screenshot.png' });
    console.log('Screenshot saved to app_screenshot.png');

    // Check for any obvious error text
    const body = await page.textContent('body');
    if (body?.includes('error') || body?.includes('Error')) {
       console.log('Warning: "Error" found in body text');
    } else {
       console.log('No obvious errors found in body text');
    }

  } catch (err: any) {
    console.error(`Verification failed: ${err.message}`);
  } finally {
    await browser.close();
  }
}

verify();
