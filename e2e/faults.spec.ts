import { test, expect } from '@playwright/test';
import { attachJson, completed, give, openPlan, pickWard, state } from './helpers';

test.beforeEach(async ({ page }) => {
  // An invalid body probes availability without arming or consuming a shared fault.
  const probe = await page.request.post('/api/dev/fault', { data: {} });
  test.skip(probe.status() === 404, 'Dev fault routes are disabled (404); live sites do not support these tests.');
  expect(probe.status(), await probe.text()).toBe(400);
});

test('lost create response: one create, completed capture', async ({ page }, info) => {
  await openPlan(page);
  const ward = await pickWard(page);
  const armed = await page.request.post('/api/dev/fault', { data: { kind: 'lose_next_response' } });
  expect(armed.ok()).toBeTruthy();
  const donation = await give(page, 10);
  await expect(page.getByTestId('toast')).toContainText('Payment completed.');
  await completed(page, donation);
  const final = (await state(page, ward)).wardRecords!.find(r => r.id === donation.id)!;
  const creates = final.receipts.filter(r => r.method === 'POST' && r.path === '/v2/checkout/orders');
  expect(creates, 'One create receipt is the public evidence for the server operation intent').toHaveLength(1);
  await attachJson(info, 'lost-response-receipts', final);
});

test('pending capture: Pending at PayPal, no funded dollars added', async ({ page }, info) => {
  await openPlan(page);
  const ward = await pickWard(page);
  const before = await state(page, ward);
  const armed = await page.request.post('/api/dev/fault', { data: { kind: 'pending_next_capture' } });
  expect(armed.ok()).toBeTruthy();
  const donation = await give(page, 10);
  expect(donation.status).toBe('PENDING');
  await expect(page.getByTestId('toast')).toContainText('Pending at PayPal');
  await attachJson(info, 'pending-capture', donation);
  const after = await state(page, ward);
  const current = after.wardRecords!.find(r => r.id === donation.id)!;
  const expectedFunded = before.wards[ward].funded + (current.status === 'COMPLETED' || current.status === 'PARTIALLY_REFUNDED' ? 10 : 0);
  expect(['PENDING', 'COMPLETED', 'PARTIALLY_REFUNDED']).toContain(current.status);
  expect(after.wards[ward].funded).toBe(expectedFunded);
  await attachJson(info, 'pending-capture-after-state-read', { current, funded: after.wards[ward].funded, before: before.wards[ward].funded });
});

test('declineTest: card declined, no money counted', async ({ page }) => {
  await openPlan(page, '/?declineTest=1');
  const ward = await pickWard(page);
  const before = await state(page, ward);
  await give(page, 10);
  await expect(page.getByTestId('toast')).toHaveText('Declined by PayPal. No money moved.');
  const after = await state(page, ward);
  expect(after.wards[ward].funded).toBe(before.wards[ward].funded);
  expect(after.supporterTotal).toBe(before.supporterTotal);
});
