import { test, expect } from '@playwright/test';
import { attachJson, openPlan, openWardFacts, pickWard } from './helpers';

const numbers = (text: string) => [...text.matchAll(/[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)]
  .filter(m => !/per\s\$\s*$/.test(text.slice(0, m.index)))
  .map(m => Number(m[0].replaceAll(',', '')));

test('Ask why defaults: labelled answer within 15s, all numbers on ward cards', async ({ page }, info) => {
  await openPlan(page);
  await page.getByTestId('ask-why').click();
  const a = Number(await page.getByTestId('ask-a').inputValue());
  const b = Number(await page.getByTestId('ask-b').inputValue());
  const cardTexts: string[] = [];
  for (const ward of [a, b]) {
    await pickWard(page, ward);
    await openWardFacts(page);
    // Only the plan facts, excluding historic donations, payout IDs and dates.
    cardTexts.push(await page.locator('#ward-title').innerText());
    cardTexts.push(await page.locator('.ward-numbers').innerText());
    cardTexts.push(await page.locator('dl.facts').innerText());
    await page.getByTestId('close-ward').click();
  }
  const answerResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/ask' && r.request().postDataJSON()?.kind === 'why', { timeout: 15_000 });
  const started = Date.now();
  await page.getByTestId('ask-submit').click();
  const response = await answerResponse;
  expect(response.ok(), await response.text()).toBeTruthy();
  const answer = await response.json();
  expect(['live', 'cache', 'rules', 'recorded']).toContain(answer.source);
  await expect(page.getByTestId('ask-answer').locator('.chip')).toHaveText(/Live AI|Cached AI answer|Explained by rules|Recorded answer/, { timeout: Math.max(1, 15_000 - (Date.now() - started)) });
  await expect(page.getByTestId('ask-answer').locator('p').first()).toHaveText(answer.text);
  expect(Date.now() - started).toBeLessThan(15_000);
  const allowed = new Set(cardTexts.flatMap(numbers).flatMap(n => [n, Math.round(n)]));
  (await page.locator('#scorecard').innerText()).split('\n').flatMap(numbers).forEach(n => { allowed.add(n); allowed.add(Math.round(n)); });
  const unsupported = numbers(answer.text).filter(n => !allowed.has(n));
  await attachJson(info, 'answer-and-visible-card-facts', { answer, cardTexts, unsupported });
  expect(unsupported, `Answer numbers absent from ward cards: ${unsupported.join(', ')}`).toEqual([]);
});
