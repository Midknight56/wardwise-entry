import { test, expect } from '@playwright/test';

test('a slow question never blocks a gift', async ({ page }) => {
  await page.route('**/api/ask', async route => {
    let body: { kind?: string } | null = null;
    try {
      body = route.request().postDataJSON();
    } catch {
      body = null;
    }
    if (body?.kind === 'why') {
      await new Promise(resolve => setTimeout(resolve, 6000));
      await route.continue();
    } else {
      await route.continue();
    }
  });

  let donationRequests = 0;
  await page.route('**/api/donations', async route => {
    donationRequests++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'mock-1',
        ward: 21,
        cents: 2500,
        status: 'COMPLETED',
        createdAt: Date.now(),
        receipts: [],
      }),
    });
  });

  await page.goto('/?ward=21');
  const give25 = page.getByTestId('give-25');
  await expect(give25).toBeEnabled();
  await page.getByTestId('ask-why').click();
  await page.getByTestId('ask-submit').click();

  const askAnswer = page.getByTestId('ask-answer');
  await expect(askAnswer).toContainText('Checking');
  await expect(give25).toBeEnabled({ timeout: 1000 });
  await give25.dblclick();
  await expect(page.getByTestId('toast')).toBeVisible();
  expect(donationRequests).toBe(1);

  await expect(askAnswer.locator('.chip')).toBeVisible({ timeout: 20_000 });
});
