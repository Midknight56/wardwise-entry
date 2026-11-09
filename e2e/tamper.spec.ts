import { test, expect } from '@playwright/test';
import { fundedWards, openPlan } from './helpers';

test('server rejects tampered amounts, recipients, payees and wards with named rules', async ({ page }) => {
  await openPlan(page);
  const funded = await fundedWards(page), ward = funded[0];
  const unfunded = Array.from({ length: 50 }, (_, i) => i + 1).find(id => !funded.includes(id))!;
  for (const [path, body, rule] of [
    ['/api/donations', { ward, amount: 37, method: 'card' }, 'Donation amount must be $10, $25 or $50.'],
    ['/api/donations', { ward, amount: 25, method: 'card', recipient: 'tampered' }, 'Unexpected field. Amounts and recipients are set by server rules.'],
    ['/api/worklogs', { ward, payee: 'crew-north', units: 40, email: 'tampered@example.invalid' }, 'Unexpected field. Amounts and recipients are set by server rules.'],
    ['/api/worklogs', { ward, payee: 'unknown-crew', units: 40 }, 'Unknown payee key.'],
    ['/api/worklogs', { ward: unfunded, payee: 'crew-north', units: 40 }, `Ward ${unfunded} is not in the campaign's $5,000 plan.`],
  ] as const) {
    await test.step(rule, async () => {
      const response = await page.request.post(path, { data: body });
      expect(response.status()).toBe(400);
      expect((await response.json()).message).toBe(rule);
    });
  }
});
