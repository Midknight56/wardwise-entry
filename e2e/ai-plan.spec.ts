import { test, expect, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { emptyState } from '../src/web/api';

test('plan explanation debounces, ignores late answers, and supports the third question', async ({ page }) => {
  const asks: { kind: string; budget: number; ward?: number; amount?: number }[] = [];
  let delayed: Route | undefined;
  const sources = { 5000: 'live', 6000: 'cache', 6500: 'recorded', 25000: 'rules' };
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'wardwise.test') return route.abort();
    if (url.pathname === '/api/state') return route.fulfill({ json: emptyState() });
    if (url.pathname === '/api/ask') {
      const body = route.request().postDataJSON(); asks.push(body);
      if (body.kind === 'plan' && body.budget === 5500) { delayed = route; return; }
      return route.fulfill({ json: { source: sources[body.budget as keyof typeof sources] ?? 'rules', text: `${body.kind} answer at ${body.budget}.`, reason: 'Recorded answer, 2026-11-08' } });
    }
    const files: Record<string, [string, string]> = {
      '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
      '/styles.css': ['styles.css', 'text/css'], '/data/chicago.json': ['data/chicago.json', 'application/json'],
      '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
    };
    const file = files[url.pathname];
    if (!file) return route.abort();
    return route.fulfill({ body: await readFile(new URL(`../public/${file[0]}`, import.meta.url)), contentType: file[1] });
  });
  await page.goto('http://wardwise.test/');
  const slider = page.getByTestId('budget'), line = page.getByTestId('plan-line');
  const changeBudget = async (value: number) => {
    await slider.evaluate((input, amount) => {
      (input as HTMLInputElement).value = String(amount);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    // The allocation and debounce now start on the next animation frame.
    await page.clock.runFor(17);
  };
  await expect(slider).toHaveAttribute('max', '25000');
  await page.clock.runFor(699);
  expect(asks).toEqual([]);
  await page.clock.runFor(1);
  await expect(line.locator('.chip')).toHaveText('Live AI');
  expect(asks).toEqual([{ kind: 'plan', budget: 5000 }]);

  await changeBudget(5500);
  await page.clock.runFor(700);
  await expect.poll(() => Boolean(delayed)).toBe(true);
  await changeBudget(5950);
  await page.clock.runFor(500);
  await changeBudget(6000);
  const dropText = await page.locator('#drop-line').innerText();
  await page.clock.runFor(650);
  expect(asks.filter(a => a.kind === 'plan')).toHaveLength(2);
  await page.clock.runFor(50);
  await expect(line.locator('.chip')).toHaveText('Cached AI answer');
  await delayed!.fulfill({ json: { source: 'live', text: 'Late answer at 5500.' } });
  // The response must have time to run its promise continuation.
  await page.clock.runFor(50);
  await expect(line).toContainText('plan answer at 6000.');
  await expect(line).not.toContainText('Late answer');
  await expect(page.locator('#drop-line')).toHaveText(dropText);

  for (const [budget, chip] of [[6500, 'Recorded answer, 2026-11-08'], [25000, 'Explained by rules']] as const) {
    await changeBudget(budget);
    await page.clock.runFor(700);
    await expect(line.locator('.chip')).toHaveText(chip);
  }
  await page.getByTestId('ask-why').click();
  const ward = await page.getByTestId('ask-a').inputValue();
  await page.getByTestId('ask-b').selectOption(ward);
  await page.getByTestId('ask-more').click();
  await expect(page.getByTestId('ask-answer')).toContainText('more answer at 25000.');
  expect(asks.at(-1)).toEqual({ kind: 'more', ward: Number(ward), amount: 500, budget: 25000 });
});
