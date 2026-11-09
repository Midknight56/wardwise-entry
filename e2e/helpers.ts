import { expect, type Page, type TestInfo } from '@playwright/test';
import type { MoneyRecord, MoneyState } from '../src/web/api';

export async function openPlan(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.locator('[data-ward]')).toHaveCount(50);
  await expect(page.locator('#state-status')).toContainText('Money synced');
}
export async function fundedWards(page: Page) {
  return page.locator('[data-ward]').evaluateAll(nodes => nodes.filter(n =>
    !/plan \$0,/.test(n.getAttribute('aria-label') || '')
  ).map(n => Number(n.getAttribute('data-ward'))));
}
export async function pickWard(page: Page, ward?: number) {
  ward ??= (await fundedWards(page))[0];
  await page.getByTestId('ward-picker').selectOption(String(ward));
  await expect(page.getByTestId('ward-card')).toBeVisible();
  await expect(page.getByTestId('ward-card')).toHaveAttribute('data-history', 'ready', { timeout: 20_000 });
  await expect(page.getByTestId('give-25')).toBeEnabled();
  return ward;
}
export async function openWardFacts(page: Page) {
  const facts = page.locator('#ward-facts');
  if (!(await facts.evaluate(el => (el as HTMLDetailsElement).open))) await page.getByTestId('ward-facts').click();
  await expect(facts).toHaveAttribute('open', '');
}
export async function budget(page: Page, amount: number) {
  await page.getByTestId('budget').fill(String(amount));
  await page.getByTestId('budget').dispatchEvent('input');
  await expect(page.locator('#budget-value')).toHaveText(`$${amount.toLocaleString('en-US')}`);
}
export async function state(page: Page, ward?: number): Promise<MoneyState> {
  const response = await page.request.get('/api/state' + (ward ? `?ward=${ward}` : ''));
  expect(response.ok(), `state HTTP ${response.status()}`).toBeTruthy();
  return response.json();
}
export function record(page: Page, id: string, inCard = true) {
  return page.getByTestId(inCard ? 'ward-card' : 'money-log').locator(`[data-record-id="${id}"]`).first();
}
export async function action(page: Page, testid: string, path: RegExp): Promise<MoneyRecord> {
  const response = page.waitForResponse(r => r.request().method() === 'POST' && path.test(new URL(r.url()).pathname));
  await page.getByTestId('ward-card').getByTestId(testid).click();
  const result = await response;
  expect(result.ok(), await result.text()).toBeTruthy();
  const data = await result.json();
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
  return data;
}
export async function give(page: Page, amount: 10 | 25 | 50) {
  return action(page, `give-${amount}`, /\/api\/donations$/);
}
export async function completed(page: Page, donation: MoneyRecord) {
  // This deadline includes API polling and the visible receipt assertion.
  const deadline = Date.now() + 20_000;
  await expect.poll(async () => {
    const s = await state(page, donation.ward);
    return s.wardRecords?.find(r => r.id === donation.id)?.status;
  }, { timeout: Math.max(1, deadline - Date.now()), intervals: [500, 1000] }).toBe('COMPLETED');
  const s = await state(page, donation.ward);
  const found = s.wardRecords!.find(r => r.id === donation.id)!;
  expect(found.captureId).toMatch(/^[A-Z0-9]{17}$/);
  const rec = record(page, donation.id);
  await expect(rec).toContainText('COMPLETED', { timeout: Math.max(1, deadline - Date.now()) });
  const details = rec.locator('details');
  if (!(await details.evaluate(el => (el as HTMLDetailsElement).open))) {
    await details.locator('summary').click();
  }
  await expect(rec).toContainText(found.captureId!);
  return found;
}
export async function attachJson(info: TestInfo, name: string, value: unknown) {
  await info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}
