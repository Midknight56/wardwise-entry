// Records the demo film's raw take from a site (default: the live site) at 1920 x 1080.
// Frames come from the browser's own screencast, so the browser stays headless (no window).
// Output: out/film/<take>/frames/*.jpg, frames.json (frame times) and marks.json (beat marks).
// Usage: node dev/film.mjs <take>          desktop take, 1920 x 1080, beats 1 to 10
//        node dev/film.mjs <take> --phone  phone take, 390 x 844, the money panel and its evidence
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const baseURL = process.env.WW_BASE || 'https://wardwise.midknight-labs.workers.dev';
const take = process.argv[2] || 'take1';
const phone = process.argv.includes('--phone');
const dir = path.resolve('out/film', take);
const framesDir = path.join(dir, 'frames');
await mkdir(framesDir, { recursive: true });

const frames = [];
const marks = [];
const now = () => Date.now() / 1000;
const mark = label => { marks.push({ t: now(), label }); console.log(new Date().toLocaleTimeString(), label); };

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext(phone
  ? { baseURL, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
  : { baseURL, viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
// A drawn pointer, because a headless screencast has none. It lives in the top layer so dialogs do not hide it.
await context.addInitScript(() => {
  const install = () => {
    if (document.getElementById('film-pointer')) return;
    const p = document.createElement('div');
    p.id = 'film-pointer';
    p.setAttribute('popover', 'manual');
    p.innerHTML = '<svg width="30" height="30" viewBox="0 0 30 30"><path d="M4 2 L4 23 L9.5 18 L13.2 26.5 L16.8 25 L13.2 16.8 L21 16.8 Z" fill="#1d1d1b" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/></svg><span></span>';
    p.style.cssText = 'position:fixed;inset:auto;left:0;top:0;margin:0;padding:0;border:0;background:transparent;overflow:visible;width:30px;height:30px;pointer-events:none;transform:translate(-200px,-200px)';
    const ring = p.querySelector('span');
    ring.style.cssText = 'position:absolute;left:-14px;top:-14px;width:34px;height:34px;border-radius:50%;border:3px solid #c9a227;opacity:0;transform:scale(.4);transition:opacity .35s,transform .35s';
    document.documentElement.appendChild(p);
    const lift = () => { try { p.hidePopover(); p.showPopover(); } catch {} };
    lift();
    addEventListener('mousemove', e => { p.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)`; }, true);
    addEventListener('mousedown', () => {
      ring.style.transition = 'none'; ring.style.opacity = '1'; ring.style.transform = 'scale(.4)';
      requestAnimationFrame(() => { ring.style.transition = 'opacity .45s,transform .45s'; ring.style.opacity = '0'; ring.style.transform = 'scale(1.3)'; });
    }, true);
    new MutationObserver(lift).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install); else install();
});

const page = await context.newPage();
page.setDefaultTimeout(30_000);
const cdp = await context.newCDPSession(page);
let n = 0;
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  const file = `${String(n++).padStart(6, '0')}.jpg`;
  frames.push({ file, t: metadata.timestamp });
  await writeFile(path.join(framesDir, file), Buffer.from(data, 'base64'));
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: phone ? 780 : 1920, maxHeight: phone ? 1688 : 1080, everyNthFrame: 1 });

let mx = 960, my = 600;
const wait = ms => page.waitForTimeout(ms);
const ease = t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
async function moveTo(x, y, ms = 650) {
  const steps = Math.max(10, Math.round(ms / 16));
  const [sx, sy] = [mx, my];
  for (let i = 1; i <= steps; i++) {
    const k = ease(i / steps);
    await page.mouse.move(sx + (x - sx) * k, sy + (y - sy) * k);
    await wait(14);
  }
  mx = x; my = y;
}
async function point(loc, ms) {
  await loc.scrollIntoViewIfNeeded();
  await wait(250);
  const b = await loc.boundingBox();
  await moveTo(b.x + b.width / 2, b.y + b.height / 2, ms);
  return b;
}
async function click(loc, pause = 300) {
  await point(loc);
  await wait(pause);
  mark('click');
  await page.mouse.click(mx, my);
}
async function scrollTo(loc, block = 'center') {
  await loc.evaluate((el, block) => el.scrollIntoView({ behavior: 'smooth', block }), block);
  await wait(900);
}
async function budgetX(value) {
  const b = await page.getByTestId('budget').boundingBox();
  const thumb = 16;
  return { x: b.x + thumb / 2 + (value - 1000) / 24000 * (b.width - thumb), y: b.y + b.height / 2 };
}
async function drag(to, ms) {
  const current = Number(await page.getByTestId('budget').inputValue());
  const a = await budgetX(current);
  await moveTo(a.x, a.y, 600);
  await wait(250);
  await page.mouse.down();
  const z = await budgetX(to);
  await moveTo(z.x, z.y, ms);
  await page.mouse.up();
  await wait(300);
  return Number(await page.getByTestId('budget').inputValue());
}
const chip = loc => loc.locator('.chip').first();
async function answerTag(loc) {
  await chip(loc).waitFor({ timeout: 30_000 });
  const tag = (await chip(loc).innerText()).trim();
  mark(`tag ${tag}`);
  return tag;
}
async function money200(action, re) {
  const res = page.waitForResponse(r => r.request().method() === 'POST' && re.test(new URL(r.url()).pathname), { timeout: 45_000 });
  await action();
  const r = await res;
  const body = await r.json().catch(() => ({}));
  if (!r.ok()) throw new Error(`${r.url()} HTTP ${r.status()} ${JSON.stringify(body)}`);
  return body;
}


// The 9 Nov film follows one supporter and one ward from the first screen to PayPal's receipts.
try {
  await page.mouse.move(mx, my);
  if (phone) {
    // Phone take: the money panel at 390 x 844, readable status, no tour.
    mark('phone load');
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#state-status')?.textContent?.includes('Money synced'));
    await wait(2500);
    await page.getByTestId('tab-money').click();
    mark('phone money');
    await wait(3000);
    const ev = page.getByTestId('payroll-evidence').first();
    await ev.scrollIntoViewIfNeeded();
    await wait(1500);
    await ev.locator(':scope > summary').click();
    mark('phone evidence');
    await wait(5000);
    await page.evaluate(() => scrollBy({ top: 300, behavior: 'smooth' }));
    await wait(3000);
    mark('end');
    throw new Error('phone done');
  }

  // Beat 1: who it is for, the opening screen, the fictional campaign and sandbox labels.
  mark('beat1 load');
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#state-status')?.textContent?.includes('Money synced'));
  await wait(9000);
  mark('beat1 poured');
  await point(page.locator('.top-chips'), 900);
  await wait(2500);

  // Beat 2: explore a budget; the campaign plan stays at $5,000; the estimate says what it is.
  mark('beat2 drag');
  const explored = await drag(9000, 2200);
  mark(`beat2 at ${explored}`);
  await wait(1500);
  await point(page.getByTestId('campaign-chip'), 700);
  await wait(2000);
  await point(page.getByTestId('estimate-limit'), 700);
  await wait(3500);
  await click(page.getByTestId('back-to-plan'));
  mark('beat2 back');
  await wait(2500);

  // Beat 3: one AI explanation with its real tag.
  mark('beat3 ask');
  await click(page.getByTestId('ask-why'));
  await wait(1200);
  const answer = page.getByTestId('ask-answer');
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = page.waitForResponse(r => new URL(r.url()).pathname === '/api/ask' && r.request().postDataJSON()?.kind === 'why', { timeout: 45_000 });
    mark(`ask why ${attempt}`);
    await click(page.getByTestId('ask-submit'));
    const body = await (await res).json().catch(() => ({}));
    await wait(500);
    const tag = await answerTag(answer);
    if (tag !== 'Explained by rules') { mark(`ask ok ${body.source}`); break; }
    const a = await page.getByTestId('ask-a').inputValue();
    const options = (await page.getByTestId('ask-b').locator('option').evaluateAll(o => o.map(x => x.value))).filter(v => v !== a);
    const current = await page.getByTestId('ask-b').inputValue();
    await page.getByTestId('ask-b').selectOption(options[(options.indexOf(current) + 1) % options.length]);
    await wait(600);
  }
  await scrollTo(answer);
  await wait(7000);
  mark('beat3 end');

  // Beat 4: $25 by test card on Ward A; capture id and balance.
  const card = page.getByTestId('ward-card');
  const ward = Number(await page.getByTestId('ask-a').inputValue());
  await point(page.getByTestId('ward-picker'));
  await page.getByTestId('ward-picker').selectOption(String(ward));
  await page.locator('[data-testid="ward-card"][data-history="ready"]').waitFor({ timeout: 30_000 });
  mark(`beat4 ward ${ward}`);
  await wait(2000);
  const giveAndWait = async amount => {
    const d = await money200(() => click(card.getByTestId(`give-${amount}`)), /\/api\/donations$/);
    mark(`give ${amount} ${d.status} ${d.captureId ?? ''}`);
    await page.waitForFunction(id => [...document.querySelectorAll(`#ward-card [data-record-id="${id}"]`)].some(el => el.textContent.includes('COMPLETED')), d.id, { timeout: 45_000 });
    mark(`give ${amount} COMPLETED`);
    return d;
  };
  await scrollTo(card.getByTestId('give-25'));
  await giveAndWait(25);
  await wait(1200);
  const latestDetails = card.locator('section.card-section').filter({ has: page.locator('h4', { hasText: 'Your latest record' }) }).locator('[data-record-id] details:not(.evidence)').first();
  await scrollTo(latestDetails);
  await click(latestDetails.locator(':scope > summary'));
  mark('beat4 ids');
  await wait(3500);
  await point(card.getByTestId('supporter-total'), 700);
  await wait(2500);

  // Beat 5: $50 twice; $125, the $25 proposal, a person approves, the refund, $100 stays donated.
  mark('beat5 cap');
  await scrollTo(card.getByTestId('give-50'));
  await giveAndWait(50);
  await wait(1000);
  await giveAndWait(50);
  const approve = card.getByTestId('approve-refund');
  await approve.waitFor({ timeout: 30_000 });
  await scrollTo(approve);
  mark('beat5 proposal');
  await point(card.getByTestId('supporter-total'), 700);
  await wait(2500);
  await point(approve, 600);
  await wait(1500);
  const refund = await money200(() => click(approve), /\/api\/refunds\/[^/]+\/approve$/);
  mark(`refund ${refund.status} ${refund.refundId}`);
  await page.waitForFunction(id => [...document.querySelectorAll(`[data-record-id="${id}"]`)].some(el => el.textContent.includes('COMPLETED')), refund.id, { timeout: 60_000 });
  const evidence = page.locator(`[data-record-id="${refund.id}"] [data-testid="refund-evidence"]`).first();
  if (!(await evidence.isVisible())) await click(card.getByTestId('ward-history').locator(':scope > summary'));
  await scrollTo(evidence);
  await click(evidence.locator(':scope > summary'));
  mark('beat5 refund evidence');
  await wait(6000);

  // Beat 6: two work logs, the server's checks, the exact payroll preview.
  mark('beat6 work');
  await scrollTo(card.getByTestId('work-payee'));
  await point(card.getByTestId('work-payee'));
  await card.getByTestId('work-payee').selectOption('crew-north');
  await click(card.getByTestId('work-units'));
  await card.getByTestId('work-units').fill('');
  await page.keyboard.type('120', { delay: 110 });
  const w1 = await money200(() => click(card.getByTestId('log-work')), /\/api\/worklogs$/);
  mark(`work ${w1.status}`);
  await wait(1800);
  await point(card.getByTestId('work-payee'));
  await card.getByTestId('work-payee').selectOption('crew-unclaimed');
  await click(card.getByTestId('work-units'));
  await card.getByTestId('work-units').fill('');
  await page.keyboard.type('40', { delay: 110 });
  const w2 = await money200(() => click(card.getByTestId('log-work')), /\/api\/worklogs$/);
  mark(`work ${w2.status}`);
  await wait(2500);
  const payroll = page.getByTestId('payroll');
  await scrollTo(payroll.getByTestId('payroll-preview'), 'start');
  mark('beat6 preview');
  await answerTag(payroll.getByTestId('payroll-summary')).catch(() => mark('summary tag missing'));
  mark(`summary ${(await payroll.getByTestId('payroll-summary').innerText()).replace(/\s+/g, ' ').trim()}`);
  await point(payroll.getByTestId('payroll-preview-total'), 700);
  await wait(5000);

  // Beat 7: approve the batch; one batch id, the paid item and the UNCLAIMED item.
  const pay = await money200(() => click(payroll.getByTestId('pay-all')), /\/api\/payroll\/pay$/);
  mark(`beat7 pay ${pay.batchId ?? ''} ${pay.status}`);
  await wait(2500);
  const started = Date.now();
  const newest = payroll.locator('.payroll-header .chip').first();
  mark('beat7 wait start');
  for (;;) {
    const shown = (await newest.innerText().catch(() => '')).trim();
    if (/paid/i.test(shown)) { mark(`beat7 final ${shown}`); break; }
    if (Date.now() - started > 150_000) { mark(`beat7 timeout ${shown}`); break; }
    const refresh = payroll.getByTestId('payroll-refresh');
    if (await refresh.isEnabled()) await click(refresh, 150);
    await wait(4000);
  }
  await scrollTo(payroll.locator('.payroll-batch').first(), 'start');
  await wait(5000);

  // Beat 8: the evidence for that payroll.
  mark('beat8 evidence');
  const pev = payroll.getByTestId('payroll-evidence').first();
  await scrollTo(pev);
  await click(pev.locator(':scope > summary'));
  await wait(1200);
  await scrollTo(pev, 'start');
  await wait(7000);
  await click(card.getByTestId('close-ward'));
  await wait(800);

  // Beat 9: last election and its limit.
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'smooth' }));
  await wait(800);
  mark('beat9 backtest');
  await click(page.getByTestId('mode-backtest'));
  await wait(1500);
  await point(page.getByTestId('scorecard'), 800);
  await wait(3500);
  await point(page.getByTestId('backtest-limit'), 700);
  await wait(4000);
  await click(page.getByTestId('mode-plan'));
  await wait(1200);

  // Beat 10: the ledger, briefly.
  mark('beat10 grid');
  await click(page.getByTestId('grid-toggle'));
  await page.locator('.ag-row').first().waitFor();
  await wait(4500);
  mark('end');
} catch (error) {
  mark(`error ${error.message.split('\n')[0]}`);
  await page.screenshot({ path: path.join(dir, 'error.png') }).catch(() => {});
  if (!/phone done/.test(error.message)) process.exitCode = 1;
} finally {
  await cdp.send('Page.stopScreencast').catch(() => {});
  await wait(300).catch(() => {});
  await writeFile(path.join(dir, 'frames.json'), JSON.stringify(frames));
  await writeFile(path.join(dir, 'marks.json'), JSON.stringify(marks, null, 1));
  await browser.close();
  console.log(`${frames.length} frames, ${marks.length} marks -> ${dir}`);
}
