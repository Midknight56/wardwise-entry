import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// Read-only money views. The Ask button may call /api/ask; no money writes occur.
const baseURL = process.env.WW_BASE || 'http://127.0.0.1:18823';
const output = path.resolve('out/shots');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    const phone = name === 'phone';
    const context = await browser.newContext({ baseURL, viewport: { width, height }, isMobile: phone, hasTouch: phone, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      await page.route('**/api/**', async route => {
        const req = route.request();
        if (req.method() !== 'GET' && new URL(req.url()).pathname !== '/api/ask')
          throw new Error(`Screenshot script refused money write: ${req.method()} ${new URL(req.url()).pathname}`);
        await route.continue();
      });
      await page.goto('/');
      await page.locator('[data-ward]').last().waitFor();
      const stateStatus = page.locator('#state-status');
      await stateStatus.waitFor({ state: 'attached' });
      await page.waitForFunction(() => document.querySelector('#state-status')?.textContent?.includes('Money synced'));
      await page.evaluate(() => document.fonts.ready);
      const snap = async (number, slug, target) => {
        if (target) await target.scrollIntoViewIfNeeded();
        // Let chart rendering and smooth scroll settle before a viewport-sized shot.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.waitForTimeout(250);
        const file = path.join(output, `${name}-${number}-${slug}.png`);
        await page.screenshot({ path: file, fullPage: false, animations: 'disabled' });
        console.log(file);
      };
      await page.getByTestId('plan-line').waitFor({ state: 'visible' });
      await page.waitForFunction(() => {
        const headline = document.querySelector('#map-title')?.textContent?.trim();
        const votes = document.querySelector('#expected-votes')?.textContent?.trim();
        return Boolean(headline && votes);
      });
      await page.waitForTimeout(2500);
      await snap('01', 'plan');
      await page.getByTestId('budget').fill('2000');
      await page.getByTestId('budget').dispatchEvent('input');
      await snap('02', 'budget-drop', page.locator('#drop-line'));
      await page.getByTestId('ask-why').click();
      await page.getByTestId('ask-submit').click();
      await page.getByTestId('ask-answer').locator('.chip').waitFor();
      await snap('03', 'ask-answer', page.getByTestId('ask-answer'));
      await page.getByTestId('budget').fill('5000');
      await page.getByTestId('budget').dispatchEvent('input');
      // Select the ward with the best available collection of real money records.
      const stateResponse = await page.request.get('/api/state');
      if (!stateResponse.ok()) throw new Error(`State HTTP ${stateResponse.status()}`);
      const state = await stateResponse.json();
      const records = [...state.records, ...state.openItems];
      const ward = [...records].sort((a, b) => Number(Boolean(b.captureId)) - Number(Boolean(a.captureId)))[0]?.ward || 2;
      const wardSynced = page.waitForResponse(r => new URL(r.url()).pathname === '/api/state' && new URL(r.url()).searchParams.get('ward') === String(ward));
      await page.getByTestId('ward-picker').selectOption(String(ward));
      await page.getByTestId('give-25').waitFor({ state: 'attached' });
      await wardSynced;
      await page.locator('#app[aria-busy="false"]').waitFor();
      await snap('04', 'ward-donations', page.locator('#ward-donations'));
      await snap('05', 'cap-refund', page.getByTestId('supporter-total').locator('xpath=ancestor::section[1]'));
      const wardFacts = page.locator('#ward-facts');
      await page.getByTestId('ward-facts').click();
      await snap('12', 'ward-facts', wardFacts);
      await page.getByTestId('ward-facts').click();
      const workWard = records.find(r => r.payee)?.ward;
      if (workWard && workWard !== ward) {
        await page.getByTestId('close-ward').click();
        if (phone) await page.getByTestId('tab-plan').click();
        await page.getByTestId('ward-picker').selectOption(String(workWard));
        await page.locator('#ward-work .money-record').first().waitFor();
      }
      await snap('06', 'work-payouts', page.locator('#ward-work'));
      await page.getByTestId('close-ward').click();
      if (phone) await page.getByTestId('tab-plan').click();
      await page.getByTestId('mode-backtest').click();
      await snap('07', 'last-election', page.getByTestId('scorecard'));
      await page.getByTestId('mode-plan').click();
      if (phone) await page.getByTestId('tab-grid').click();
      else if (!(await page.getByTestId('grid').isVisible())) await page.getByTestId('grid-toggle').click();
      await snap('08', 'grid-chart', page.getByTestId('grid'));
      if (phone) await page.getByTestId('tab-money').click();
      await snap('11', 'payroll', page.getByTestId('payroll'));
      const everyoneRecords = page.locator('details.everyone-records');
      await everyoneRecords.locator(':scope > summary').click();
      const receipt = everyoneRecords.locator('.money-record details').first();
      if (await receipt.count()) {
        await receipt.locator('summary').click();
        await snap('09', 'money-receipt', receipt);
      } else {
        console.warn(`${name}: no receipts available; run money tests before pictures.`);
        await snap('09', 'money-receipt', page.getByTestId('money-log'));
      }
      await page.getByTestId(phone ? 'tab-about' : 'about-open').click();
      await snap('10', 'about', page.getByTestId('about'));
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
