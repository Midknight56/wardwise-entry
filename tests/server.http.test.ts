import { describe, expect, it } from 'vitest';
import { route, type RouterDependencies } from '../src/server/router';
import { buildVerifyBody } from '../src/server/paypal/webhooks';
import type { MoneyRecord } from '../src/server/campaign/engine';
import { world } from './helpers/world';
const sid = 'a'.repeat(32);
function fixture() {
  const w = world();
  const deps: RouterDependencies = { campaign: () => w.engine, ask: async () => ({ text: 'Rules', source: 'rules' }), paypal: w.paypal, webhookId: 'webhook-test',
    assets: async () => new Response('static'), dev: false, build: 'test-build' };
  const send = (path: string, body?: unknown, headers?: HeadersInit, method = body === undefined ? 'GET' : 'POST') => route(new Request('https://wardwise.test' + path, { method, headers: { cookie: `ww_sid=${sid}`, ...Object.fromEntries(new Headers(headers)) }, body: body === undefined ? undefined : JSON.stringify(body) }), deps);
  return { ...w, deps, send };
}
const signature = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-transmission-id': 'transmission', 'paypal-transmission-sig': 'signature', 'paypal-transmission-time': '2026-11-06T12:00Z' };
describe('Worker routes and trust boundaries', () => {
  it('health includes build; assets use static binding', async () => {
    const w = fixture(); expect(await (await w.send('/healthz')).json()).toEqual({ ok: true, build: 'test-build' }); expect(await (await w.send('/')).text()).toBe('static');
  });
  it('new cookies have 128 random bits, HttpOnly, SameSite=Lax and Secure on https', async () => {
    const w = fixture(), res = await route(new Request('https://wardwise.test/healthz'), w.deps);
    expect(res.headers.get('set-cookie')).toMatch(/^ww_sid=[a-f0-9]{32}; Path=\/; HttpOnly; SameSite=Lax; Secure;/);
    const http = await route(new Request('http://localhost/healthz'), w.deps); expect(http.headers.get('set-cookie')).not.toContain('Secure');
    expect((await w.send('/healthz')).headers.get('set-cookie')).toBeNull();
  });
  it('returns JSON validation errors and rejects a foreign browser origin', async () => {
    const w = fixture(), invalid = await w.send('/api/donations', { ward: 99, amount: 10, method: 'card' });
    expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ error: 'invalid_request', message: expect.stringContaining('Ward') });
    expect((await w.send('/api/donations', { ward: 1, amount: 10, method: 'card' }, { Origin: 'https://evil.test' })).status).toBe(403);
  });
  it('gate cap returns 429 before a seventh order', async () => {
    const w = fixture(); for (let i = 0; i < 6; i++) expect((await w.send('/api/donations', { ward: 1, amount: 10, method: 'card' })).status).toBe(200);
    const response = await w.send('/api/donations', { ward: 1, amount: 10, method: 'card' }); expect(response.status).toBe(429); expect(w.fake.writes('/v2/checkout/orders')).toHaveLength(6);
  });
  it('dev fault route is hidden unless enabled', async () => {
    const w = fixture(); expect((await w.send('/api/dev/fault', { kind: 'lose_next_response' })).status).toBe(404);
    w.deps.dev = true; expect((await w.send('/api/dev/fault', { kind: 'pending_next_capture' })).status).toBe(200);
    expect((await w.send('/api/dev/fault', { kind: 'unknown' })).status).toBe(400);
  });
  it('declineTest only adds the PayPal mock header in dev', async () => {
    const w = fixture();
    const normal = await (await w.send('/api/donations?declineTest=1', { ward: 1, amount: 10, method: 'card' })).json() as MoneyRecord; expect(normal.status).toBe('COMPLETED');
    w.deps.dev = true;
    const declined = await (await w.send('/api/donations?declineTest=1', { ward: 1, amount: 10, method: 'card' })).json() as MoneyRecord; expect(declined.status).toBe('DECLINED');
  });
  it.each(['/api/worklogs/log/pay', '/api/worklogs/log/refresh', '/api/worklogs/log/cancel', '/api/refunds/refund/approve'])('rejects browser amount or recipient at %s', async path => {
    const w = fixture(); expect((await w.send(path, { amount: 0.01 })).status).toBe(400); expect((await w.send(path, { email: 'evil@example.test' })).status).toBe(400); expect(w.fake.calls).toHaveLength(0);
  });
  it('removed late-record path is an unknown route', async () => {
    const w = fixture(); const response = await w.send('/api/supporters/me/late-record', {});
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ message: 'Route not found.' });
  });
  it('PayPal returns capture then redirect to selected ward', async () => {
    const w = fixture(), d = await w.engine.donate(sid, { ward: 1, amount: 25, method: 'paypal' });
    w.fake.orders.get(d.orderId!)!.status = 'APPROVED'; const result = await w.send(`/return/paypal?token=${d.orderId}`);
    expect(result.status).toBe(303); expect(result.headers.get('location')).toBe('https://wardwise.test/?ward=1&result=completed');
  });
  it('PayPal cancel redirects with cancellation message and no counted money', async () => {
    const w = fixture(), d = await w.engine.donate(sid, { ward: 2, amount: 25, method: 'paypal' });
    const result = await w.send(`/return/cancel?token=${d.orderId}`), location = new URL(result.headers.get('location')!);
    expect(location.searchParams.get('ward')).toBe('2'); expect(location.searchParams.get('message')).toBe('You cancelled. No money moved.');
    expect((await w.engine.state(sid)).supporterTotal).toBe(0);
  });
  it('state is demo-wide but never leaks supporter cookies or approval links', async () => {
    const w = fixture(); await w.engine.donate('other', { ward: 1, amount: 25, method: 'card' });
    const state = await (await w.send('/api/state')).json() as Awaited<ReturnType<typeof w.engine.state>>; expect(state.wards[1].funded).toBe(25); expect(state.supporterTotal).toBe(0);
    expect(state.records[0]).not.toHaveProperty('sid'); expect(state.records[0]).not.toHaveProperty('approvalUrl');
  });
  it('state returns only the last 30 records', async () => {
    const w = fixture(); for (let i = 0; i < 35; i++) w.store.put('worklogs', String(i), { id: String(i), ward: 1, cents: 1, createdAt: i, status: 'READY', receipts: [] });
    const state = await w.engine.state(sid); expect(state.records).toHaveLength(30); expect(state.records[0].id).toBe('34'); expect(state.records[29].id).toBe('5');
  });
  it('malformed or oversized body is rejected', async () => {
    const w = fixture();
    const invalid = await route(new Request('https://wardwise.test/api/donations', { method: 'POST', body: '{' }), w.deps); expect(invalid.status).toBe(400);
    expect((await w.send('/api/donations', { padding: 'x'.repeat(17000) })).status).toBe(413);
  });
});
describe('verified, idempotent webhook application', () => {
  it('raw body is spliced byte-for-byte into verification', () => {
    const raw = '{ "id": "event", "resource": {"x": 1.00} }';
    const body = buildVerifyBody(new Headers(signature), 'hook', raw)!; expect(body).toContain(',"webhook_event":' + raw + '}');
    expect(buildVerifyBody(new Headers(), 'hook', raw)).toBeNull();
  });
  it('bad signature returns 400 and stores no events', async () => {
    const w = fixture(); w.fake.verify = false;
    const res = await w.send('/webhooks/paypal', { id: 'bad', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { custom_id: 'ww-unknown' } }, signature);
    expect(res.status).toBe(400); expect(w.store.list('events')).toHaveLength(0);
  });
  it('foreign custom_id is ignored after verification', async () => {
    const w = fixture(), res = await w.send('/webhooks/paypal', { id: 'foreign', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { custom_id: 'other-app' } }, signature);
    expect(res.status).toBe(200); expect(w.store.list('events')).toHaveLength(0); expect(w.store.list('donations')).toHaveLength(0);
  });
  it('duplicates are ignored and out-of-order events read current capture state', async () => {
    const w = fixture(), d = await w.engine.donate(sid, { ward: 1, amount: 25, method: 'card' });
    const event = { id: 'event', event_type: 'PAYMENT.CAPTURE.PENDING', resource: { custom_id: 'ww-' + d.id, id: d.captureId, status: 'PENDING' } };
    expect((await w.send('/webhooks/paypal', event, signature)).status).toBe(200);
    const before = w.fake.calls.filter(c => c.path.includes('/captures/')).length;
    const duplicate = await (await w.send('/webhooks/paypal', event, signature)).json() as { duplicate: boolean }; expect(duplicate.duplicate).toBe(true);
    expect(w.fake.calls.filter(c => c.path.includes('/captures/'))).toHaveLength(before);
    expect((await w.engine.state(sid)).supporterTotal).toBe(25); expect(w.store.list('events')).toHaveLength(1);
  });
  it('a capture never regresses from COMPLETED on a stale failed resource read', async () => {
    const w = fixture(), d = await w.engine.donate(sid, { ward: 1, amount: 25, method: 'card' });
    w.fake.captures.get(d.captureId!)!.status = 'FAILED';
    await w.send('/webhooks/paypal', { id: 'stale-failed', event_type: 'PAYMENT.CAPTURE.DECLINED', resource: { custom_id: 'ww-' + d.id } }, signature);
    expect(w.store.get<MoneyRecord>('donations', d.id)?.status).toBe('COMPLETED');
  });
  it('refund webhook re-reads actual refund and never regresses COMPLETED', async () => {
    const w = fixture(); for (let i = 0; i < 3; i++) await w.engine.donate(sid, { ward: 1, amount: 50, method: 'card' });
    const refund = w.store.list<MoneyRecord>('refunds')[0]; const paid = await w.engine.approveRefund(sid, refund.id);
    await w.send('/webhooks/paypal', { id: 'old-refund', event_type: 'PAYMENT.REFUND.PENDING', resource: { id: paid.refundId, custom_id: 'ww-' + refund.id, status: 'PENDING' } }, signature);
    expect(w.store.get<MoneyRecord>('refunds', refund.id)?.status).toBe('COMPLETED'); expect((await w.engine.state(sid)).supporterTotal).toBe(100);
  });
  it('CAPTURE.REFUNDED carries a refund resource and completes a pending refund', async () => {
    const w = fixture(); for (let i = 0; i < 3; i++) await w.engine.donate(sid, { ward: 1, amount: 50, method: 'card' });
    w.fake.refundStatus = 'PENDING'; const proposal = w.store.list<MoneyRecord>('refunds')[0]; const refund = await w.engine.approveRefund(sid, proposal.id);
    w.fake.refunds.get(refund.refundId!)!.status = 'COMPLETED';
    const result = await w.send('/webhooks/paypal', { id: 'refunded', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: refund.refundId, custom_id: 'ww-' + refund.id } }, signature);
    expect(result.status).toBe(200); expect(w.store.get<MoneyRecord>('refunds', refund.id)?.status).toBe('COMPLETED'); expect((await w.engine.state(sid)).supporterTotal).toBe(100);
  });
  it('payout webhook reads current item rather than trusting the event status', async () => {
    const w = fixture(), log = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    const paid = await w.engine.pay(log.id);
    const res = await w.send('/webhooks/paypal', { id: 'old-item', event_type: 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED', resource: { payout_item_id: paid.itemId, payout_item: { sender_item_id: `ww-${log.id}-1` } } }, signature);
    expect(res.status).toBe(200); expect(w.store.get<MoneyRecord>('worklogs', log.id)?.status).toBe('SUCCESS');
  });
  it('does not mark an event processed if authoritative read fails, so retry can heal', async () => {
    const w = fixture(), d = await w.engine.donate(sid, { ward: 1, amount: 10, method: 'card' });
    const event = { id: 'retry', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { custom_id: 'ww-' + d.id } };
    w.fake.fail = `/v2/checkout/orders/${d.orderId}`; expect((await w.send('/webhooks/paypal', event, signature)).status).toBe(503); expect(w.store.list('events')).toHaveLength(0);
    w.fake.fail = undefined; expect((await w.send('/webhooks/paypal', event, signature)).status).toBe(200); expect(w.store.list('events')).toHaveLength(1);
  });
});

describe('live regression routes', () => {
  it('unknown ww-probe-1 webhook returns 200 without any stored change', async () => {
    const w = fixture();
    const res = await w.send('/webhooks/paypal', { id: 'probe', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { custom_id: 'ww-probe-1' } }, signature);
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ ignored: true });
    for (const table of ['donations', 'refunds', 'worklogs', 'events', 'ops'] as const) expect(w.store.list(table)).toHaveLength(0);
  });
  it('donation response omits sid and refresh accepts an empty POST body', async () => {
    const w = fixture(); w.fake.lose = '/v2/checkout/orders';
    const response = await w.send('/api/donations', { ward: 1, amount: 25, method: 'card' });
    const d = await response.json() as MoneyRecord; expect(d).not.toHaveProperty('sid'); expect(d.status).toBe('CHECKING');
    const refreshed = await w.send(`/api/donations/${d.id}/refresh`, undefined, undefined, 'POST');
    expect(refreshed.status).toBe(200); const body = await refreshed.json();
    expect(body).toMatchObject({ status: 'COMPLETED' }); expect(body).not.toHaveProperty('sid'); expect(w.fake.orders.size).toBe(1);
    expect((await w.send(`/api/donations/${d.id}/refresh`, { recipient: 'evil' })).status).toBe(400);
  });
  it('refund approval JSON omits sid', async () => {
    const w = fixture(); for (let i = 0; i < 3; i++) await w.engine.donate(sid, { ward: 1, amount: 50, method: 'card' });
    const refund = (await w.engine.state(sid)).refundProposals[0];
    const body = await (await w.send(`/api/refunds/${refund.id}/approve`, {})).json();
    expect(body).not.toHaveProperty('sid');
  });
  it('cancel rejection with a confirmed UNCLAIMED read returns the record with HTTP 200', async () => {
    const w = fixture(); w.fake.payoutStatus = 'UNCLAIMED';
    const ready = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    const log = await w.engine.pay(ready.id), path = `/v1/payments/payouts-item/${log.itemId}/cancel`;
    w.fake.fail = path;
    const fetch = w.fake.fetch;
    w.fake.fetch = async (input, init) => {
      const response = await fetch(input, init);
      return response.status === 503 && new URL(String(input)).pathname === path
        ? new Response(await response.text(), { status: 500, headers: response.headers }) : response;
    };
    const response = await w.send(`/api/worklogs/${log.id}/cancel`, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'UNCLAIMED', message: expect.stringContaining('HTTP 500, debug id debug-test') });
  });
});


describe('public payee catalog and ward history', () => {
  it('returns three public payees without email fields anywhere in state JSON', async () => {
    const w = fixture(), response = await w.send('/api/state');
    const text = await response.text(), state = JSON.parse(text);
    expect(state.payees).toEqual([
      { key: 'crew-north', label: 'North Side door crew (sandbox)', role: 'doors', rateDollars: 0.25 },
      { key: 'print-shop', label: 'Ward print shop (sandbox)', role: 'flyers', rateDollars: 0.1 },
      { key: 'crew-unclaimed', label: 'New crew, no PayPal account yet (sandbox)', role: 'doors', rateDollars: 0.25 },
    ]);
    expect(text).not.toContain('email'); expect(text).not.toContain('@');
    expect(state).not.toHaveProperty('wardRecords');
  });
  it('keeps the 31st oldest ward record beyond the global last 30, across all record types', async () => {
    const w = fixture();
    for (let i = 0; i < 60; i++) {
      const table = i % 3 === 0 ? 'donations' : i % 3 === 1 ? 'refunds' : 'worklogs';
      w.store.put(table, String(i), { id: String(i), ward: 1, cents: 1, createdAt: i, status: 'COMPLETED', receipts: [], sid: 'private', approvalUrl: 'private',
        ...(table === 'refunds' ? { donationId: 'donation' } : table === 'worklogs' ? { payee: 'crew-north' } : {}) });
    }
    w.store.put('donations', 'other', { id: 'other', ward: 2, cents: 1, createdAt: 100, status: 'COMPLETED', receipts: [] });
    const state = await (await w.send('/api/state?ward=1')).json() as Awaited<ReturnType<typeof w.engine.state>>;
    expect(state.records).toHaveLength(30); expect(state.records.some(r => r.id === '30')).toBe(false);
    expect(state.wardRecords).toHaveLength(50); expect(state.wardRecords?.some(r => r.id === '30')).toBe(true);
    expect(state.wardRecords?.map(r => r.id)).toEqual(Array.from({ length: 50 }, (_, i) => String(59 - i)));
    expect(state.wardRecords?.every(r => r.ward === 1 && !('sid' in r) && !('approvalUrl' in r))).toBe(true);
    expect((await w.engine.state(sid, 50)).wardRecords).toEqual([]);
  });
  it.each(['0', 'x', '51', '1.5', ''])('rejects invalid ward %s', async ward => {
    const response = await fixture().send('/api/state?ward=' + ward);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ message: 'Ward must be 1 to 50.' });
  });
  it('GET /api/payroll/preview returns the preview; POST /api/payroll/pay with {} is 400', async () => {
    const w = fixture();
    await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    const getRes = await w.send('/api/payroll/preview', undefined, undefined, 'GET');
    expect(getRes.status).toBe(200);
    const preview = await getRes.json() as any;
    expect(preview.items).toHaveLength(1);
    expect(preview.version).toBeTruthy();
    expect(preview.count).toBe(1);

    const postEmpty = await w.send('/api/payroll/pay', {});
    expect(postEmpty.status).toBe(400);
  });
});
