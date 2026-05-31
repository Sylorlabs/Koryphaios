import { chromium } from 'playwright';

async function verify() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  console.log('Navigating to http://127.0.0.1:3003...');
  try {
    // Wait longer for hydration
    await page.goto('http://127.0.0.1:3003', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000); 

    const title = await page.title();
    console.log(`Page Title: ${title}`);
    
    // Log visible text to see what "Error" is
    const bodyText = await page.innerText('body');
    const lines = bodyText.split('\n').filter(l => l.toLowerCase().includes('error'));
    console.log('Lines containing "error":', lines);

    // Take a screenshot
    await page.screenshot({ path: 'app_full.png', fullPage: true });
    console.log('Full page screenshot saved to app_full.png');

  } catch (err: any) {
    console.error(`Verification failed: ${err.message}`);
  } finally {
    await browser.close();
  }
}

verify();
