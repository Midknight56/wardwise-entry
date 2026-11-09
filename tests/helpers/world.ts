import type { Store, Table } from '../../src/server/campaign/store';
import { CampaignEngine } from '../../src/server/campaign/engine';
import { GateEngine } from '../../src/server/gate/engine';
import { PayPal, type Resource } from '../../src/server/paypal/client';
import { payees } from '../../src/server/payees';
export class MemoryStore implements Store {
  private rows = new Map<string, string>();
  get<T>(table: Table, id: string): T | undefined { const row = this.rows.get(`${table}:${id}`); return row === undefined ? undefined : JSON.parse(row); }
  put<T>(table: Table, id: string, value: T) { this.rows.set(`${table}:${id}`, JSON.stringify(value)); }
  list<T>(table: Table): T[] { return [...this.rows].filter(([key]) => key.startsWith(table + ':')).map(([, value]) => JSON.parse(value)); }
}
export class FakePayPal {
  calls: { method: string; path: string; body: Resource; headers: Headers }[] = [];
  orders = new Map<string, Resource>(); captures = new Map<string, Resource>(); refunds = new Map<string, Resource>();
  batches = new Map<string, Resource>(); items = new Map<string, Resource>();
  captureStatus = 'COMPLETED'; refundStatus = 'COMPLETED'; payoutStatus = 'SUCCESS';
  cardApproved = false; verify = true; lose?: string; fail?: string; duplicateBatch = false;
  private n = 0;
  private idempotent = new Map<string, Resource>();
  unreadable?: string;
  transportFailure?: string;
  writes(path: string) { return this.calls.filter(c => c.method === 'POST' && c.path === path); }
  private response(body: Resource, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'paypal-debug-id': 'debug-test' } }); }
  private capture(order: Resource) {
    const id = 'C' + ++this.n;
    const resource = { id, status: this.captureStatus, amount: { value: order.purchase_units[0].amount.value, currency_code: 'USD' }, custom_id: order.purchase_units[0].custom_id, supplementary_data: { related_ids: { order_id: order.id } } };
    this.captures.set(id, resource); order.purchase_units[0].payments = { captures: [resource] }; order.status = 'COMPLETED';
  }
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname, method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers); let body: Resource = {};
    try { body = JSON.parse(String(init?.body ?? '{}')); } catch { /* OAuth uses form body. */ }
    this.calls.push({ method, path, body, headers });
    const key = method === 'POST' && path !== '/v1/oauth2/token' ? `${path}:${headers.get('PayPal-Request-Id')}` : undefined;
    if (this.transportFailure === path) throw new TypeError('Network unavailable');
    if (key && this.idempotent.has(key)) {
      const original = this.idempotent.get(key)!;
      if (path === '/v1/payments/payouts' && this.duplicateBatch) return this.response({ name: 'USER_BUSINESS_ERROR', details: [{ field: 'SENDER_BATCH_ID' }], links: [{ href: 'https://api-m.sandbox.paypal.com/v1/payments/payouts/' + original.batch_header.payout_batch_id }] }, 400);
      return this.response(original, 201);
    }
    if (this.fail === path) return this.response({ name: 'UNAVAILABLE' }, 503);
    let result: Resource | undefined;
    let status = method === 'POST' ? 201 : 200;
    if (path === '/v1/oauth2/token') return this.response({ access_token: 'test-token', expires_in: 3600 });
    if (path === '/v1/notifications/verify-webhook-signature') return this.response({ verification_status: this.verify ? 'SUCCESS' : 'FAILURE' });
    if (path === '/v2/checkout/orders' && method === 'POST') {
      if (headers.get('PayPal-Mock-Response')?.includes('INSTRUMENT_DECLINED')) return this.response({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] }, 422);
      const id = 'O' + ++this.n;
      result = { id, status: body.payment_source.card && this.cardApproved ? 'APPROVED' : 'CREATED', purchase_units: structuredClone(body.purchase_units), links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=' + id }] };
      if (body.payment_source.card && !this.cardApproved) this.capture(result);
      this.orders.set(id, result);
    } else if (/^\/v2\/checkout\/orders\/[^/]+\/capture$/.test(path)) {
      result = this.orders.get(path.split('/')[4]); if (result) this.capture(result);
    } else if (path.startsWith('/v2/checkout/orders/')) result = this.orders.get(path.split('/')[4]);
    else if (/^\/v2\/payments\/captures\/[^/]+\/refund$/.test(path)) {
      const id = 'R' + ++this.n; result = { id, status: this.refundStatus, amount: body.amount, custom_id: body.custom_id }; this.refunds.set(id, result);
    } else if (path.startsWith('/v2/payments/captures/')) result = this.captures.get(path.split('/')[4]);
    else if (path.startsWith('/v2/payments/refunds/')) result = this.refunds.get(path.split('/')[4]);
    else if (path === '/v1/payments/payouts' && method === 'POST') {
      const batch = 'B' + ++this.n;
      const itemsList = Array.isArray(body.items) ? body.items : [body.items?.[0]];
      const items = itemsList.map((it: Resource) => {
        const item = 'I' + ++this.n;
        const status = it.receiver === 'crew-unclaimed@example.com' ? 'UNCLAIMED' : this.payoutStatus;
        const resource = { payout_item_id: item, payout_item: it, transaction_status: status };
        this.items.set(item, resource);
        return resource;
      });
      result = { batch_header: { payout_batch_id: batch, sender_batch_header: body.sender_batch_header }, items };
      this.batches.set(batch, result);
      if (this.duplicateBatch) return this.response({ name: 'USER_BUSINESS_ERROR', details: [{ field: 'SENDER_BATCH_ID' }], links: [{ href: 'https://api-m.sandbox.paypal.com/v1/payments/payouts/' + batch }] }, 400);
    } else if (/^\/v1\/payments\/payouts-item\/[^/]+\/cancel$/.test(path)) {
      result = this.items.get(path.split('/')[4]); if (result) result.transaction_status = 'CANCELED';
    } else if (path.startsWith('/v1/payments/payouts-item/')) result = this.items.get(path.split('/')[4]);
    else if (path.startsWith('/v1/payments/payouts/')) result = this.batches.get(path.split('/')[4]);
    if (key && result) this.idempotent.set(key, structuredClone(result));
    if (this.unreadable === path) { this.unreadable = undefined; return new Response('{', { status }); }
    if (this.lose === path) { this.lose = undefined; throw new Error('Answer lost after PayPal applied the write'); }
    if (!result) return this.response({ name: 'NOT_FOUND' }, 404);
    return this.response(result, status);
  };
}
export function world(plan: Record<number, number> = { 1: 4900, 2: 100, 3: 0 }) {
  let time = Date.parse('2026-11-06T12:00:00Z');
  const clock = () => time;
  const store = new MemoryStore(), gateStore = new MemoryStore(), fake = new FakePayPal();
  const gate = new GateEngine(gateStore, clock);
  const paypal = new PayPal({ PAYPAL_CLIENT_ID: 'test-client', PAYPAL_CLIENT_SECRET: 'test-secret' }, ((input, init) => fake.fetch(input, init)) as typeof fetch, clock, async () => {});
  const options = { store, gate, paypal, clock, payees: payees({ PAYOUT_EMAIL_CREW: 'crew@example.test' }), plan, wards: [1, 2, 3] };
  const engine = new CampaignEngine(options);
  return { store, gateStore, gate, fake, paypal, engine, options, advance: (ms: number) => { time += ms; } };
}
