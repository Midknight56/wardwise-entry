import { test, expect } from '@playwright/test';
import { budget, completed, fundedWards, give, openPlan, pickWard, record } from './helpers';

test('judge path: plan, drop explanation, backtest and funded ward', async ({ page }) => {
  await openPlan(page);
  await expect(page.getByTestId('estimate-limit')).toBeVisible();
  await expect(page.getByTestId('budget')).toHaveValue('5000');
  const initial = await fundedWards(page);
  expect(initial.length).toBeGreaterThanOrEqual(2);
  expect(initial.length).toBeLessThanOrEqual(6);
  await budget(page, 2000);
  expect((await fundedWards(page)).length).toBeLessThan(initial.length);
  await expect(page.locator('#drop-line')).toContainText(/Ward \d+ dropped/);
  await page.getByTestId('mode-backtest').click();
  await expect(page.getByTestId('backtest-limit')).toBeVisible();
  await expect(page.getByTestId('scorecard').locator('strong')).toHaveCount(4);
  for (const value of await page.getByTestId('scorecard').locator('strong').allTextContents()) expect(value).toMatch(/\d/);
  const misses = page.locator('[data-ward].miss, [data-ward].plan-miss');
  expect(await misses.count()).toBeGreaterThan(0);
  expect(await misses.first().evaluate(el => getComputedStyle(el).stroke)).toBe('rgb(210, 70, 46)');
  const ward = (await fundedWards(page))[0];
  // Keyboard activation hits the same map handler without relying on an irregular SVG's bounding box.
  await page.getByTestId(`ward-${ward}`).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ward-card')).toContainText(`Ward ${ward}`);
});

test('judge path: Give $25 completes and appears in the money log @money', async ({ page }) => {
  await openPlan(page);
  await pickWard(page);
  const started = Date.now();
  const donation = await give(page, 25);
  const result = await completed(page, donation);
  expect(Date.now() - started, 'Give $25 must complete within 20 seconds').toBeLessThan(20_000);
  const logRecord = record(page, donation.id, false);
  const logDetails = logRecord.locator('details');
  if (!(await logDetails.evaluate(el => (el as HTMLDetailsElement).open))) {
    await logDetails.locator('summary').click();
  }
  await expect(logRecord).toContainText(result.captureId!);
  await expect(logRecord).toContainText('COMPLETED');
  const yourRecords = page.getByTestId('your-records');
  await expect(yourRecords).toContainText('Your records');
  await expect(yourRecords.locator(`.money-record[data-record-id="${donation.id}"]`)).toContainText('COMPLETED');
});
