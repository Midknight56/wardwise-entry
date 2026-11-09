import { test, expect } from '@playwright/test';
import { action, attachJson, completed, give, openPlan, pickWard, record, state } from './helpers';

test('fresh supporter: $125 captured, exactly $25 refund, $100 kept', async ({ browser, baseURL }, info) => {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await openPlan(page);
    await expect(page.getByTestId('ward-card')).toBeHidden();
    expect((await state(page)).supporterTotal).toBe(0);
    await pickWard(page);
    const captures = [];
    captures.push(await completed(page, await give(page, 50)));
    captures.push(await completed(page, await give(page, 50)));
    captures.push(await completed(page, await give(page, 25)));
    console.log(`Capture ids: ${captures.map(c => c.captureId).join(', ')}`);
    await expect(page.getByTestId('ward-card').getByTestId('approve-refund')).toHaveText('Approve refund $25.00');
    const proposal = (await state(page)).refundProposals.find(r => r.status === 'PROPOSED');
    expect(proposal?.cents).toBe(2500);
    // Scope to the card because the money trail also renders the approval button.
    const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/api/refunds/${proposal!.id}/approve`));
    await page.getByTestId('ward-card').getByTestId('approve-refund').click();
    const approved = await response;
    expect(approved.ok(), await approved.text()).toBeTruthy();
    const refund = await approved.json();
    expect(['COMPLETED', 'PENDING']).toContain(refund.status);
    expect(refund.refundId).toBeTruthy();
    await attachJson(info, 'refund', refund);
    console.log(`Refund ${refund.refundId}: ${refund.status}`);
    const history = page.getByTestId('ward-history');
    if (!(await history.evaluate(el => (el as HTMLDetailsElement).open))) {
      await history.locator(':scope > summary').click();
    }
    const refundRecord = record(page, refund.id);
    const refundDetails = refundRecord.locator('details:not(.evidence)');
    if (!(await refundDetails.evaluate(el => (el as HTMLDetailsElement).open))) {
      await refundDetails.locator('summary').click();
    }
    await expect(refundRecord).toContainText(refund.refundId);
    // The evidence shows the cap arithmetic: $125 captured, $25 over the $100 cap, so $100 stays donated.
    const evidence = refundRecord.getByTestId('refund-evidence');
    if (!(await evidence.evaluate(el => (el as HTMLDetailsElement).open))) await evidence.locator('summary').click();
    await expect(evidence).toContainText('Captured from this browser $125.00');
    await expect(evidence).toContainText('Demo cap $100.00');
    await expect(evidence).toContainText('Over the cap $25.00');
    await expect(evidence).toContainText('Approved by a person at');
    await expect(evidence).toContainText(`Refund ${refund.refundId} · `);
    if (refund.status === 'COMPLETED') await expect(evidence).toContainText('Stays donated $100.00');
    const after = await state(page);
    expect(after.supporterTotal).toBe(100);
    await expect(page.getByTestId('supporter-total')).toHaveText('$100.00');
  } finally { await context.close(); }
});
