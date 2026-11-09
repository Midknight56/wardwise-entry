import { describe, expect, it, vi } from 'vitest';
import { PayPal, NotSentError } from '../src/server/paypal/client';
import { world } from './helpers/world';
describe('PayPal client', () => {
  it('caches token until 60 seconds before expiry', async () => {
    const w = world(); await w.paypal.token(); await w.paypal.token(); expect(w.fake.writes('/v1/oauth2/token')).toHaveLength(1);
    w.advance(3539 * 1000); await w.paypal.token(); expect(w.fake.writes('/v1/oauth2/token')).toHaveLength(1);
    w.advance(1000); await w.paypal.token(); expect(w.fake.writes('/v1/oauth2/token')).toHaveLength(2);
  });
  it('simultaneous token requests mint once', async () => {
    const w = world(); await Promise.all([w.paypal.token(), w.paypal.token()]); expect(w.fake.writes('/v1/oauth2/token')).toHaveLength(1);
  });
  it('every POST has a request id; orders and refunds request representation', async () => {
    const w = world(); for (let i = 0; i < 3; i++) await w.engine.donate('s', { ward: 1, amount: 50, method: 'card' });
    const state = await w.engine.state('s'); await w.engine.approveRefund('s', state.refundProposals[0].id);
    for (const call of w.fake.calls.filter(c => c.method === 'POST')) {
      expect(call.headers.get('PayPal-Request-Id')).toBeTruthy(); if (/orders|\/refund/.test(call.path)) expect(call.headers.get('Prefer')).toBe('return=representation');
    }
  });
  it('read transient failures retry, writes with lost answers do not', async () => {
    const w = world(); w.fake.fail = '/v2/payments/captures/missing'; await w.paypal.request('GET', w.fake.fail);
    expect(w.fake.calls.filter(c => c.path === w.fake.fail)).toHaveLength(3);
    w.fake.fail = undefined; w.fake.lose = '/v2/checkout/orders';
    await w.engine.donate('s', { ward: 1, amount: 10, method: 'card' }); expect(w.fake.writes('/v2/checkout/orders')).toHaveLength(1);
  });
  it('refuses a live or attacker-controlled PayPal host', () => {
    expect(() => new PayPal({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_BASE: 'https://api-m.paypal.com' })).toThrow('Sandbox');
  });
  it('preserves PayPal debug_id in a failed call receipt', async () => {
    const w = world(), receipts: unknown[] = []; w.paypal.onCall = r => receipts.push(r);
    await w.paypal.request('GET', '/v2/payments/captures/unknown'); expect(receipts).toContainEqual(expect.objectContaining({ status: 404, debugId: 'debug-test' }));
  });
});

describe('PayPal send boundary', () => {
  it('calls default global fetch unbound for both OAuth and the money write', async () => {
    const w = world(), receivers: unknown[] = [];
    const f = function(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      receivers.push(this); return w.fake.fetch(input, init);
    };
    vi.stubGlobal('fetch', f);
    try {
      const p = new PayPal({ PAYPAL_CLIENT_ID: 'client', PAYPAL_CLIENT_SECRET: 'secret' });
      await p.request('POST', '/v2/checkout/orders', { payment_source: {}, purchase_units: [] });
      expect(receivers).toEqual([undefined, undefined]); expect(w.fake.orders.size).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it('OAuth failure is NotSentError, with no order receipt or order fetch', async () => {
    const w = world(), receipts: unknown[] = []; w.paypal.onCall = r => receipts.push(r); w.fake.fail = '/v1/oauth2/token';
    await expect(w.paypal.request('POST', '/v2/checkout/orders', {})).rejects.toBeInstanceOf(NotSentError);
    expect(w.fake.writes('/v2/checkout/orders')).toHaveLength(0);
    expect(receipts).not.toContainEqual(expect.objectContaining({ path: '/v2/checkout/orders' }));
  });
  it('body serialization failure is NotSentError before OAuth or write fetch', async () => {
    const w = world(), circular: any = {}; circular.self = circular;
    await expect(w.paypal.request('POST', '/v2/checkout/orders', circular)).rejects.toBeInstanceOf(NotSentError);
    expect(w.fake.calls).toHaveLength(0);
  });
});

describe('safe PayPal failure logs', () => {
  it('logs the tag, path, error name and message without credentials or email', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = new PayPal({ PAYPAL_CLIENT_ID: 'client-id', PAYPAL_CLIENT_SECRET: 'private-secret' }, async () => {
      throw new TypeError('Illegal invocation client-id private-secret person@example.test Authorization: Bearer hidden-token');
    });
    try {
      await expect(p.request('POST', '/v2/checkout/orders', {})).rejects.toBeInstanceOf(NotSentError);
      expect(log).toHaveBeenCalledWith('paypal', '/v1/oauth2/token', 'TypeError', expect.stringContaining('Illegal invocation'));
      const text = JSON.stringify(log.mock.calls);
      for (const forbidden of ['client-id', 'private-secret', 'person@example.test', 'hidden-token']) expect(text).not.toContain(forbidden);
    } finally { log.mockRestore(); }
  });
  it('logs a lost money write with its exact path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {}), w = world();
    try {
      w.fake.lose = '/v2/checkout/orders'; await w.engine.donate('s', { ward: 1, amount: 10, method: 'card' });
      expect(log).toHaveBeenCalledWith('paypal', '/v2/checkout/orders', 'Error', 'Answer lost after PayPal applied the write');
    } finally { log.mockRestore(); }
  });
});
