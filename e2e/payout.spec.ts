import { test, expect } from '@playwright/test';
import { action, openPlan, pickWard, state } from './helpers';

test('a work log over $60 is refused with its rule', async ({ page }) => {
  await openPlan(page);
  await pickWard(page);
  await page.getByTestId('work-payee').selectOption('crew-north');
  await page.getByTestId('work-units').fill('241');
  await page.getByTestId('log-work').click();
  await expect(page.getByTestId('toast')).toContainText('Work log amount must be at most $60.');
});

test('payroll batch pays ready logs with one SUCCESS and one UNCLAIMED', async ({ page }) => {
  await openPlan(page);
  const payroll = page.getByTestId('payroll');
  await expect(payroll).toBeVisible();
  await expect(payroll).toContainText('Next payroll batch');
  await expect(payroll.getByTestId('pay-all')).toHaveText('Approve and pay 0 logs ($0.00)');
  await expect(payroll.getByTestId('pay-all')).toBeDisabled();

  await pickWard(page);
  await page.getByTestId('work-payee').selectOption('crew-north');
  await page.getByTestId('work-units').fill('120');
  const workNorth = await action(page, 'log-work', /\/api\/worklogs$/);
  expect(workNorth.cents).toBe(3000);

  await page.getByTestId('work-payee').selectOption('crew-unclaimed');
  await page.getByTestId('work-units').fill('40');
  const workUnclaimed = await action(page, 'log-work', /\/api\/worklogs$/);
  expect(workUnclaimed.cents).toBe(1000);

  if (await page.getByTestId('tab-money').isVisible()) await page.getByTestId('tab-money').click();

  await expect(payroll).toBeVisible();

  // see the summary with a source tag
  const summary = payroll.getByTestId('payroll-summary');
  await expect(summary).toBeVisible();
  await expect(summary.locator('.chip')).toHaveText(/Live AI|Cached AI answer|Explained by rules|Recorded answer/, { timeout: 15_000 });
  // Nothing is paid before a person approves, so the summary must not say money moved.
  await expect(summary).not.toHaveText(/\b(was|were|been|is|are) paid\b|\bpaid (out|to)\b|\b(sent|transferred|received|deposited)\b/i);

  // The person sees the exact batch first: both rows, one total, and a button that names the same total.
  const preview = payroll.getByTestId('payroll-preview');
  await expect(preview.locator('li')).toHaveCount(2);
  const previewTotal = ((await payroll.getByTestId('payroll-preview-total').textContent()) ?? '').replace('Batch total ', '').trim();
  expect(previewTotal).toBe('$40.00');
  const payAllBtn = payroll.getByTestId('pay-all');
  await expect(payAllBtn).toBeEnabled();
  await expect(payAllBtn).toHaveText(`Approve and pay 2 logs (${previewTotal})`);
  const payResponsePromise = page.waitForResponse(r => r.request().method() === 'POST' && /\/api\/payroll\/pay$/.test(new URL(r.url()).pathname));
  await payAllBtn.click();
  const payResponse = await payResponsePromise;
  expect(payResponse.ok()).toBeTruthy();

  // then (Refresh until final, at most 90 s) one item SUCCESS and one UNCLAIMED, both with item ids and the same batch id.
  const started = Date.now();
  let northStatus = '';
  let unclaimedStatus = '';
  let batchId = '';
  let northItemId = '';
  let unclaimedItemId = '';

  await expect.poll(async () => {
    const refreshBtn = payroll.getByTestId('payroll-refresh');
    if (await refreshBtn.isEnabled()) {
      const refreshPromise = page.waitForResponse(r => r.request().method() === 'POST' && /\/api\/payroll\/[^/]+\/refresh$/.test(new URL(r.url()).pathname));
      await refreshBtn.click();
      await refreshPromise;
    }
    const s = await state(page);
    const rNorth = s.records.find(r => r.id === workNorth.id);
    const rUnclaimed = s.records.find(r => r.id === workUnclaimed.id);
    northStatus = rNorth?.status ?? '';
    unclaimedStatus = rUnclaimed?.status ?? '';
    batchId = rNorth?.batchId ?? rUnclaimed?.batchId ?? '';
    northItemId = rNorth?.itemId ?? '';
    unclaimedItemId = rUnclaimed?.itemId ?? '';
    return [northStatus, unclaimedStatus];
  }, { timeout: Math.max(1, Math.min(85_000, 90_000 - (Date.now() - started))), intervals: [1000, 2000, 3000] }).toEqual(['SUCCESS', 'UNCLAIMED']);

  expect(northItemId).toBeTruthy();
  expect(unclaimedItemId).toBeTruthy();
  expect(batchId).toBeTruthy();

  // Both item ids and the same batch id
  const s = await state(page);
  const finalNorth = s.records.find(r => r.id === workNorth.id)!;
  const finalUnclaimed = s.records.find(r => r.id === workUnclaimed.id)!;
  expect(finalNorth.batchId).toBe(finalUnclaimed.batchId);
  expect(finalNorth.itemId).toBe(northItemId);
  expect(finalUnclaimed.itemId).toBe(unclaimedItemId);

  // The payroll header chip reads Partly paid after one SUCCESS and one UNCLAIMED.
  await expect(payroll.locator('.payroll-header .chip').first()).toHaveText('Partly paid');

  // The evidence shows the same total that the person approved, and it equals the sum of its rows.
  const evidence = payroll.getByTestId('payroll-evidence').first();
  if (!(await evidence.evaluate(el => (el as HTMLDetailsElement).open))) await evidence.locator('summary').click();
  await expect(evidence).toContainText(`Batch total ${previewTotal}`);
  await expect(evidence).toContainText('Approved by a person at');
  await expect(evidence).toContainText(batchId);
  const amounts = await evidence.getByTestId('evidence-amount').allTextContents();
  expect(amounts).toHaveLength(2);
  expect(amounts.reduce((sum, text) => sum + Number(text.replace('$', '')), 0).toFixed(2)).toBe(previewTotal.replace('$', ''));

  // Print both item ids and the batch id so I can read them back from PayPal.
  console.log(`Batch ID: ${batchId}`);
  console.log(`crew-north Item ID: ${northItemId}`);
  console.log(`crew-unclaimed Item ID: ${unclaimedItemId}`);
});
