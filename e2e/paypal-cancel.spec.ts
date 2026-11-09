import { test, expect } from '@playwright/test';
import { openPlan, pickWard, record, state } from './helpers';

test('cancel PayPal approval without logging in; no donation counts', async ({ page, baseURL }) => {
  await openPlan(page);
  const ward = await pickWard(page);
  const before = await state(page, ward);
  const created = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/donations');
  // Read the redirect, but do not navigate to or authenticate with PayPal.
  let approvalRedirect = '';
  await page.route('https://**.paypal.com/**', async route => {
    if (route.request().isNavigationRequest()) {
      approvalRedirect = route.request().url();
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' });
    }
    else await route.continue();
  });
  await page.getByTestId('give-paypal').click();
  const response = await created;
  expect(response.ok(), await response.text()).toBeTruthy();
  const donation = await response.json();
  await expect.poll(() => approvalRedirect).not.toBe('');
  await page.waitForURL(approvalRedirect);
  await page.waitForLoadState('load');
  const redirect = new URL(approvalRedirect);
  const orderToken = redirect.searchParams.get('token');
  expect(orderToken, 'Order token read from the PayPal approval redirect').toBe(donation.orderId);
  // orderBody configures /return/cancel; PayPal appends this redirect's order token.
  const cancel = new URL('/return/cancel', baseURL);
  cancel.searchParams.set('token', orderToken!);
  await page.goto(cancel.href);
  await expect(page.getByTestId('toast')).toHaveText('You cancelled. No money moved.');
  const after = await state(page, ward);
  expect(after.supporterTotal).toBe(before.supporterTotal);
  expect(after.wards[ward].funded).toBe(before.wards[ward].funded);
  expect(after.wardRecords!.find(r => r.id === donation.id)?.status).toBe('CANCELLED');
  await expect(record(page, donation.id)).toContainText('CANCELLED');
});
