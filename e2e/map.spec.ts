import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { allocate } from '../src/model/allocate';
import { BUDGET_DEFAULT, BUDGET_MAX } from '../src/model/assumptions';
import type { CityData } from '../src/model/types';
import { emptyState } from '../src/web/api';
import { decimal, dollars } from '../src/web/helpers';

const city: CityData = JSON.parse(await readFile(new URL('../public/data/chicago.json', import.meta.url), 'utf8'));
const campaign = allocate(BUDGET_DEFAULT, 'y2023', city.wards);

// All map tests use local assets and fake read-only API answers. No PayPal or AI calls.
async function openMap(page: Page) {
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/state') return route.fulfill({ json: emptyState() });
    if (path === '/api/ask') return route.fulfill({ json: { source: 'rules', text: 'The plan follows the expected return.' } });
    const files: Record<string, [string, string]> = {
      '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
      '/styles.css': ['styles.css', 'text/css'], '/data/chicago.json': ['data/chicago.json', 'application/json'],
      '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
    };
    const file = files[path];
    if (!file) return route.abort();
    return route.fulfill({ body: await readFile(new URL(`../public/${file[0]}`, import.meta.url)), contentType: file[1] });
  });
  await page.goto('http://wardwise.test/');
  await expect(page.locator('#state-status')).toContainText('Money synced');
}

test('the number, 1,291 filled precincts, two legends, and a closed grid', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMap(page);
  await expect(page.locator('#map-title')).toHaveText('1,014,591 registered Chicagoans did not vote in 2023');
  const precincts = page.getByTestId('precinct-layer').locator('path');
  await expect(precincts).toHaveCount(1291);
  const fills = await precincts.evaluateAll(nodes => nodes.map(n => n.getAttribute('fill')));
  expect(fills.every(fill => /^#[\dA-F]{6}$/i.test(fill ?? ''))).toBe(true);
  expect(new Set(fills).size).toBe(5);
  await expect(page.locator('#legend')).toContainText('Did not vote in 2023, per precinct');
  await expect(page.locator('#legend')).toContainText('Planned dollars');
  await expect(page.locator('.precinct-key > div')).toHaveCount(5);
  await expect(page.locator('#data-panel')).toBeHidden();
  await expect(page.locator('#cost-per-vote')).toHaveText(`about ${dollars(BUDGET_DEFAULT / campaign.total)} per expected vote`);
  await expect(page.locator('.wordmark svg')).toHaveAttribute('width', '18');
  await expect(page.locator('.wordmark-dot')).toHaveCount(0);
});

test('phone legend sits below the map without overlapping its SVG or tools', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await openMap(page);
  const boxes = await page.evaluate(() => {
    const legend = document.querySelector('#legend')!.getBoundingClientRect();
    const map = document.querySelector('#ward-map')!.getBoundingClientRect();
    const tools = document.querySelector('.map-tools')!.getBoundingClientRect();
    return { legend: { top: legend.top, bottom: legend.bottom, left: legend.left, right: legend.right },
      map: { top: map.top, bottom: map.bottom, left: map.left, right: map.right },
      tools: { top: tools.top, bottom: tools.bottom, left: tools.left, right: tools.right } };
  });
  expect(boxes.legend.top).toBeGreaterThanOrEqual(boxes.map.bottom - 1);
  expect(boxes.legend.bottom <= boxes.tools.top || boxes.legend.top >= boxes.tools.bottom ||
    boxes.legend.right <= boxes.tools.left || boxes.legend.left >= boxes.tools.right).toBe(true);
  expect(boxes.legend.right - boxes.legend.left).toBeGreaterThanOrEqual(389);
  await context.close();
});

for (const [width, height] of [[1366, 768], [1920, 1080]]) {
  test(`city uses at least 70 percent of the stage height at ${width} × ${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openMap(page);
    const dimensions = await page.evaluate(() => {
      const stage = document.querySelector('.map-stage')!.getBoundingClientRect();
      // Measure the drawn ward shapes, not just the SVG element's CSS box.
      const city = document.querySelector('.ward-shapes')!.getBoundingClientRect();
      return { stage: stage.height, city: city.height, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(dimensions.overflow).toBe(false);
    expect(dimensions.city / dimensions.stage).toBeGreaterThanOrEqual(.7);
    await expect(page.locator('#data-panel')).toBeHidden();
  });
}

test('a burst of slider inputs paints the $25,000 plan on the next frame within 50 ms', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openMap(page);
  const timing = await page.getByTestId('budget').evaluate(input => new Promise<{ elapsed: number; budget: string | undefined; counter: string | null }>(resolve => {
    const start = performance.now();
    for (const value of [10000, 20000, 25000]) {
      (input as HTMLInputElement).value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    requestAnimationFrame(() => resolve({ elapsed: performance.now() - start,
      budget: (document.querySelector('#map-canvas') as HTMLElement).dataset.budget,
      counter: document.querySelector('#budget-value')!.textContent }));
  }));
  expect(timing.elapsed).toBeLessThan(50);
  expect(timing.budget).toBe('25000');
  expect(timing.counter).toBe('$25,000');
  await expect(page.locator('.map-stage')).toHaveAttribute('data-pouring', 'false');
  const explored = allocate(BUDGET_MAX, 'y2023', city.wards);
  await expect(page.locator('#expected-votes')).toHaveText(decimal(explored.total));
  for (const ward of city.wards) {
    await expect(page.getByTestId(`ward-${ward.id}`)).toHaveAttribute('fill', explored.perWard[ward.id] ? '#0E5C61' : 'transparent');
  }
});

test('start here opens the first ward in allocator order and keeps campaign votes while exploring', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMap(page);
  await page.getByTestId('start-3').click();
  await expect(page.locator('#ward-title')).toHaveText(`Ward ${campaign.order[0]}`);
  await expect(page.locator('#ward-facts')).not.toHaveAttribute('open', '');
  await expect(page.getByTestId('campaign-ward-votes')).toHaveText(decimal(campaign.votes[campaign.order[0]]));
  await page.getByTestId('budget').fill('25000');
  await expect(page.locator('#budget-value')).toHaveText('$25,000');
  await expect(page.getByTestId('campaign-ward-votes')).toHaveText(decimal(campaign.votes[campaign.order[0]]));
  const explored = allocate(BUDGET_MAX, 'y2023', city.wards);
  await expect(page.locator('.explore-ward-plan')).toHaveText(`At $25,000: ${dollars(explored.perWard[campaign.order[0]])}, ${decimal(explored.votes[campaign.order[0]])} expected votes Assumption`);
  await expect(page.getByTestId('ward-card')).not.toContainText(/Easy pool|Contact lift|Top two gap/);
  await page.getByTestId('close-ward').click();
  await page.getByTestId('start-3').click();
  await expect(page.locator('#ward-title')).toHaveText(`Ward ${explored.order[0]}`);
  await expect(page.locator('#ward-facts')).not.toHaveAttribute('open', '');
});

test('start here focuses and nudges the budget and opens the ask box', async ({ page }) => {
  await openMap(page);
  await page.getByTestId('start-1').click();
  await expect(page.getByTestId('budget')).toBeFocused();
  await expect(page.getByTestId('budget')).toHaveValue('5000');
  await page.getByTestId('start-2').click();
  await expect(page.locator('#agent-box')).toBeVisible();
  await expect(page.getByTestId('ask-a')).toBeFocused();
});

test('the heat fades first, then wards pour in order and counters finish at the plan totals', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await openMap(page);
  await expect(page.locator('.map-stage')).toHaveAttribute('data-pouring', 'true');
  await expect(page.locator('#budget-value')).toHaveText('$5,000');
  await page.clock.runFor(400);
  await expect(page.locator('.ward-shapes .funded')).toHaveCount(0);
  await page.clock.runFor(250);
  await expect(page.locator('.ward-shapes .funded')).toHaveCount(1);
  await expect(page.getByTestId(`ward-${campaign.order[0]}`)).toHaveClass(/funded/);
  await page.clock.runFor(2000);
  await expect(page.locator('.map-stage')).toHaveAttribute('data-pouring', 'false');
  await expect(page.locator('#budget-value')).toHaveText('$5,000');
  await expect(page.locator('#expected-votes')).toHaveText(decimal(campaign.total));
  await expect(page.locator('.ward-shapes .funded')).toHaveCount(campaign.order.length);
});

test('reduced motion shows the finished plan immediately', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMap(page);
  await expect(page.locator('.map-stage')).toHaveAttribute('data-pouring', 'false');
  await expect(page.locator('#budget-value')).toHaveText('$5,000');
  await expect(page.locator('#expected-votes')).toHaveText(decimal(campaign.total));
  await expect(page.locator('.ward-shapes .funded')).toHaveCount(campaign.order.length);
});
