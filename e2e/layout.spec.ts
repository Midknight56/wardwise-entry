import { test, expect, type Page } from '@playwright/test';
import { openPlan, pickWard } from './helpers';
import { busyWardState } from './fixtures/busy-ward';

async function checkLayout(page: Page, screen: string) {
  const failures = await page.evaluate(() => {
    const errors: string[] = [];
    const label = (el: Element) => el.getAttribute('data-testid') || el.id || el.getAttribute('aria-label') || `${el.tagName}: ${el.textContent?.trim().slice(0, 70)}`;
    if (document.documentElement.scrollWidth > innerWidth) errors.push(`document: horizontal scroll ${document.documentElement.scrollWidth} > ${innerWidth}`);
    const shownRect = (el: Element) => {
      const rect = el.getBoundingClientRect();
      let left = Math.max(rect.left, 0), top = Math.max(rect.top, 0);
      let right = Math.min(rect.right, innerWidth), bottom = Math.min(rect.bottom, innerHeight);
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX) || /(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          const clip = parent.getBoundingClientRect();
          left = Math.max(left, clip.left);
          top = Math.max(top, clip.top);
          right = Math.min(right, clip.right);
          bottom = Math.min(bottom, clip.bottom);
        }
      }
      return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    };
    const visible = (el: HTMLElement) => {
      if (el.closest('[inert]')) return false;
      const style = getComputedStyle(el), r = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || !r.width || !r.height) return false;
      const shown = shownRect(el);
      if (!shown.width || !shown.height) return false;
      const modal = document.querySelector('dialog[open]');
      if (modal && !modal.contains(el)) return false;
      const x = Math.max(0, Math.min(innerWidth - 1, shown.left + shown.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, shown.top + shown.height / 2));
      const hit = document.elementFromPoint(x, y);
      return !!hit && (hit === el || el.contains(hit));
    };
    const controls = [...document.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, a[href], [role="button"]')].filter(visible);
    // Ward polygons intentionally touch; the map's geometric regions are not rectangular controls.
    const rectangular = controls.filter(el => !(el instanceof SVGElement));
    for (const el of rectangular) {
      const r = shownRect(el);
      if (el.tagName === 'BUTTON' && el.scrollWidth > el.clientWidth) errors.push(`${label(el)}: text overflows (${el.scrollWidth} > ${el.clientWidth})`);
      if (r.left < 16 - 0.5 || r.right > innerWidth - 16 + 0.5) errors.push(`${label(el)}: less than 16px from horizontal viewport edge (${r.left}, ${r.right})`);
    }
    for (let i = 0; i < rectangular.length; i++) for (let j = i + 1; j < rectangular.length; j++) {
      const a = rectangular[i], b = rectangular[j];
      if (a.contains(b) || b.contains(a)) continue;
      const x = shownRect(a), y = shownRect(b);
      if (Math.min(x.right, y.right) - Math.max(x.left, y.left) > 0.5 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 0.5)
        errors.push(`${label(a)} overlaps ${label(b)}`);
    }
    return errors;
  });
  expect(failures, `${screen}:\n${failures.join('\n')}`).toEqual([]);
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
test(`layout: plan, ask, ward sheet, grid, money and about at ${viewport.width}`, async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  test.skip(phone && viewport.width !== 1366, 'The phone has its own configured viewport.');
  if (!phone) await page.setViewportSize(viewport);
  await openPlan(page);
  await checkLayout(page, 'plan');
  await page.getByTestId('ask-why').click();
  await checkLayout(page, 'ask');
  await page.getByTestId('start-3').click();
  await expect(page.getByTestId('ward-card')).toBeVisible();
  await page.getByTestId('close-ward').click();
  await pickWard(page);
  await checkLayout(page, 'ward top');
  for (const id of ['work-payee', 'log-work']) {
    await page.getByTestId(id).scrollIntoViewIfNeeded();
    await checkLayout(page, `ward ${id}`);
  }
  await page.getByTestId('close-ward').click();
  if (phone) await page.getByTestId('tab-grid').click();
  else if (!(await page.getByTestId('grid').isVisible())) await page.getByTestId('grid-toggle').click();
  await expect(page.getByTestId('grid')).toBeVisible();
  await checkLayout(page, 'grid');
  await page.getByTestId('chart').scrollIntoViewIfNeeded();
  await checkLayout(page, 'chart');
  if (phone) await page.getByTestId('tab-money').click();
  else await page.getByTestId('money-log').scrollIntoViewIfNeeded();
  await checkLayout(page, 'money');
  await page.getByTestId(phone ? 'tab-about' : 'about-open').click();
  await expect(page.getByTestId('about')).toBeVisible();
  await checkLayout(page, 'about');
});
}

test('populated ward card puts actions before history', async ({ page }, info) => {
  await page.route('**/api/state**', r => r.fulfill({ json: busyWardState(21) }));
  await page.goto('/?ward=21');
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByTestId('ward-card')).toBeVisible();

  const approveRefund = page.getByTestId('ward-card').getByTestId('approve-refund');
  const logWork = page.getByTestId('ward-card').getByTestId('log-work');
  const wardHistory = page.getByTestId('ward-card').getByTestId('ward-history');

  await expect(approveRefund).toBeVisible();
  await expect(logWork).toBeVisible();

  const approveBox = await approveRefund.boundingBox();
  const logWorkBox = await logWork.boundingBox();
  const historyBox = await wardHistory.boundingBox();

  expect(approveBox).toBeTruthy();
  expect(logWorkBox).toBeTruthy();
  expect(historyBox).toBeTruthy();
  expect(approveBox!.y).toBeLessThan(historyBox!.y);
  expect(logWorkBox!.y).toBeLessThan(historyBox!.y);

  if (info.project.name === 'phone') {
    const cardBox = await page.getByTestId('ward-card').boundingBox();
    expect(cardBox).toBeTruthy();
    expect(approveBox!.y - cardBox!.y).toBeLessThan(844);
  }

  expect(await wardHistory.evaluate(el => (el as HTMLDetailsElement).open)).toBe(false);
  await wardHistory.locator(':scope > summary').click();
  expect(await wardHistory.evaluate(el => (el as HTMLDetailsElement).open)).toBe(true);
  await expect(wardHistory.locator('.money-record')).toHaveCount(50);

  await page.getByTestId('ward-card').getByTestId('close-ward').focus();
  let approveIndex = -1;
  let logWorkIndex = -1;
  let summaryIndex = -1;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const testId = await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset?.testid);
    const isSummary = await page.evaluate(() => document.activeElement === document.querySelector('[data-testid="ward-history"] > summary'));
    if (testId === 'approve-refund' && approveIndex === -1) approveIndex = i;
    if (testId === 'log-work' && logWorkIndex === -1) logWorkIndex = i;
    if (isSummary && summaryIndex === -1) summaryIndex = i;
    if (approveIndex !== -1 && logWorkIndex !== -1 && summaryIndex !== -1) break;
  }
  expect(approveIndex).toBeGreaterThan(-1);
  expect(logWorkIndex).toBeGreaterThan(-1);
  expect(summaryIndex).toBeGreaterThan(-1);
  expect(approveIndex).toBeLessThan(summaryIndex);
  expect(logWorkIndex).toBeLessThan(summaryIndex);

  const olderPayrolls = page.getByTestId('older-payrolls');
  await expect(olderPayrolls).toBeAttached();
  expect(await olderPayrolls.evaluate(el => (el as HTMLDetailsElement).open)).toBe(false);
});

