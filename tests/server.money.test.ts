import { describe, expect, it } from 'vitest';
import { CampaignEngine, type MoneyRecord, type Operation, type PayrollRecord } from '../src/server/campaign/engine';
import { world } from './helpers/world';
const gift = { ward: 1, amount: 50, method: 'card' };
async function overCap(w = world()) {
  for (let i = 0; i < 3; i++) { w.advance(1); await w.engine.donate('s', gift); }
  return w;
}
describe('donations and cap', () => {
  it('marks only each supporter’s own public records and never exposes sid', async () => {
    const w = world();
    const a = await w.engine.donate('supporter-a', gift);
    w.advance(1);
    const b = await w.engine.donate('supporter-b', gift);
    const aState = await w.engine.state('supporter-a');
    const bState = await w.engine.state('supporter-b');
    expect(aState.records.find(r => r.id === a.id)?.mine).toBe(true);
    expect(aState.records.find(r => r.id === b.id)?.mine).toBe(false);
    expect(bState.records.find(r => r.id === a.id)?.mine).toBe(false);
    expect(bState.records.find(r => r.id === b.id)?.mine).toBe(true);
    expect(JSON.stringify(aState)).not.toContain('"sid"');
    expect(JSON.stringify(bState)).not.toContain('"sid"');
  });

  it('card captures on create and verifies capture with receipts', async () => {
    const w = world(), d = await w.engine.donate('s', gift), state = await w.engine.state('s');
    expect(d.status).toBe('COMPLETED'); expect(state.wards[1].funded).toBe(50);
    expect(w.fake.writes('/v2/checkout/orders')).toHaveLength(1);
    expect(w.fake.calls.filter(c => c.path.endsWith('/capture'))).toHaveLength(0);
    expect(d.receipts.some(r => r.path.includes('/captures/') && r.status === 200 && r.debugId === 'debug-test')).toBe(true);
    const body = w.fake.writes('/v2/checkout/orders')[0].body;
    expect(body.purchase_units[0].custom_id).toBe('ww-' + d.id);
    expect(body.payment_source.card.name).toBe('Test Supporter');
  });
  it('excludes a partially refunded donation from open items', async () => {
    const w = world(), d = await w.engine.donate('s', gift);
    w.store.put('donations', d.id, { ...d, status: 'PARTIALLY_REFUNDED' });
    const state = await w.engine.state('s');
    expect(state.openItems.some(r => r.id === d.id)).toBe(false);
  });
  it('card APPROVED is captured once', async () => {
    const w = world(); w.fake.cardApproved = true;
    const d = await w.engine.donate('s', gift); expect(d.status).toBe('COMPLETED');
    expect(w.fake.writes(`/v2/checkout/orders/${d.orderId}/capture`)).toHaveLength(1);
  });
  it('approval link and two concurrent returns capture once', async () => {
    const w = world(), d = await w.engine.donate('s', { ...gift, method: 'paypal' });
    expect(d.approvalUrl).toContain('sandbox.paypal.com'); expect((await w.engine.state('s')).wards[1].funded).toBe(0);
    w.fake.orders.get(d.orderId!)!.status = 'APPROVED';
    await Promise.all([w.engine.finishOrder('s', d.orderId!), w.engine.finishOrder('s', d.orderId!)]);
    expect(w.fake.writes(`/v2/checkout/orders/${d.orderId}/capture`)).toHaveLength(1);
    expect((await w.engine.state('s')).supporterTotal).toBe(50);
  });
  it('approval cancellation has no counted money or capture', async () => {
    const w = world(), d = await w.engine.donate('s', { ...gift, method: 'paypal' });
    const result = await w.engine.finishOrder('s', d.orderId!, true);
    expect(result.message).toBe('You cancelled. No money moved.'); expect((await w.engine.state('s')).supporterTotal).toBe(0);
    expect(w.fake.writes(`/v2/checkout/orders/${d.orderId}/capture`)).toHaveLength(0);
  });
  it('declined card gives the plain message and no funded dollars', async () => {
    const w = world(), d = await w.engine.donate('s', gift, { declineTest: true });
    expect(d.message).toBe('Declined by PayPal. No money moved.'); expect((await w.engine.state('s')).wards[1].funded).toBe(0);
  });
  it('PENDING capture never fills the bar', async () => {
    const w = world(); w.fake.captureStatus = 'PENDING';
    const d = await w.engine.donate('s', gift);
    expect(d.message).toBe('Pending at PayPal'); expect((await w.engine.state('s')).wards[1].funded).toBe(0);
  });
  it('lost response fault reads the order and never creates another', async () => {
    const w = world(); await w.engine.setFault('lose_next_response');
    const d = await w.engine.donate('s', gift);
    expect(d.status).toBe('COMPLETED'); expect(w.fake.writes('/v2/checkout/orders')).toHaveLength(1);
    expect(w.fake.calls.some(c => c.method === 'GET' && c.path === `/v2/checkout/orders/${d.orderId}`)).toBe(true);
    expect(w.store.list<Operation>('ops')[0].status).toBe('uncertain');
  });
  it('network-lost capture response reconciles from known order after restart', async () => {
    const w = world(), d = await w.engine.donate('s', { ...gift, method: 'paypal' });
    w.fake.orders.get(d.orderId!)!.status = 'APPROVED'; w.fake.lose = `/v2/checkout/orders/${d.orderId}/capture`;
    expect((await w.engine.finishOrder('s', d.orderId!)).status).toBe('COMPLETED');
    const restarted = new CampaignEngine(w.options); const fixed = await restarted.finishOrder('s', d.orderId!);
    expect(fixed.status).toBe('COMPLETED'); expect(w.fake.writes(`/v2/checkout/orders/${d.orderId}/capture`)).toHaveLength(1);
  });
  it('network-lost create remains visible then heals from a verified webhook', async () => {
    const w = world(); w.fake.lose = '/v2/checkout/orders'; const d = await w.engine.donate('s', gift);
    expect(d.message).toBe('Checking payment'); expect(d.status).toBe('CHECKING');
    const cap = [...w.fake.captures.values()][0];
    await w.engine.applyWebhook({ id: 'heal', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: cap });
    expect((await w.engine.state('s')).supporterTotal).toBe(50); expect(w.fake.writes('/v2/checkout/orders')).toHaveLength(1);
  });
  it('an unreadable order leaves Checking payment, then state heals it by GET', async () => {
    const w = world(); w.fake.fail = '/v2/checkout/orders/O1';
    const d = await w.engine.donate('s', gift); expect(d.status).toBe('CHECKING'); expect(d.message).toBe('Checking payment');
    w.fake.fail = undefined; expect((await w.engine.state('s')).supporterTotal).toBe(50); expect(w.fake.writes('/v2/checkout/orders')).toHaveLength(1);
  });
  it('pending dev fault affects one capture read', async () => {
    const w = world(); await w.engine.setFault('pending_next_capture'); const d = await w.engine.donate('s', gift);
    expect(d.status).toBe('PENDING'); expect(d.message).toBe('Pending at PayPal');
    expect((await w.engine.state('s')).supporterTotal).toBe(50);
  });
  it('three $50 gifts propose exactly $50 from the last capture', async () => {
    const w = await overCap(); const ds = w.store.list<MoneyRecord>('donations'), rs = w.store.list<MoneyRecord>('refunds');
    expect(rs).toHaveLength(1); expect(rs[0].cents).toBe(5000); expect(rs[0].captureId).toBe(ds[2].captureId);
    expect(rs[0].message).toBe('Waiting for a person to approve');
  });
  it('splits excess across captures, with no slice over its available amount', async () => {
    const w = world();
    for (const amount of [50, 50, 50, 25]) { w.advance(1); await w.engine.donate('s', { ...gift, amount }); }
    const refunds = w.store.list<MoneyRecord>('refunds'); expect(refunds.reduce((sum, r) => sum + r.cents, 0)).toBe(7500);
    for (const d of w.store.list<MoneyRecord>('donations')) expect(refunds.filter(r => r.donationId === d.id).reduce((s, r) => s + r.cents, 0)).toBeLessThanOrEqual(d.cents);
  });
  it('uses latest capture completion, including an earlier approval order completed last', async () => {
    const w = world(), approval = await w.engine.donate('s', { ...gift, method: 'paypal' });
    w.advance(10); await w.engine.donate('s', gift); await w.engine.donate('s', gift);
    w.advance(10); w.fake.orders.get(approval.orderId!)!.status = 'APPROVED'; await w.engine.finishOrder('s', approval.orderId!);
    const complete = w.store.get<MoneyRecord>('donations', approval.id)!;
    expect(w.store.list<MoneyRecord>('refunds')[0].captureId).toBe(complete.captureId);
  });
  it('two simultaneous approvals send one exact refund and subtract only on completion', async () => {
    const w = await overCap(), r = w.store.list<MoneyRecord>('refunds')[0];
    await Promise.all([w.engine.approveRefund('s', r.id), w.engine.approveRefund('s', r.id)]);
    const writes = w.fake.writes(`/v2/payments/captures/${r.captureId}/refund`); expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({ amount: { value: '50.00', currency_code: 'USD' }, custom_id: `ww-${r.id}`, note_to_payer: 'Over the demo cap of $100 (fictional campaign)' });
    expect((await w.engine.state('s')).supporterTotal).toBe(100); expect((await w.engine.state('s')).wards[1].funded).toBe(100);
    await new CampaignEngine(w.options).approveRefund('s', r.id); expect(w.fake.writes(`/v2/payments/captures/${r.captureId}/refund`)).toHaveLength(1);
  });
  it('refund resource id recovers from saved operation across a restart', async () => {
    const w = await overCap(), r = w.store.list<MoneyRecord>('refunds')[0];
    const complete = await w.engine.approveRefund('s', r.id);
    w.store.put('refunds', r.id, { ...complete, status: 'CHECKING', refundId: undefined });
    expect((await new CampaignEngine(w.options).approveRefund('s', r.id)).status).toBe('COMPLETED');
    expect(w.fake.writes(`/v2/payments/captures/${r.captureId}/refund`)).toHaveLength(1);
  });
  it.each(['PENDING', 'FAILED'])('refund %s stays open and excess remains owed', async status => {
    const w = await overCap(); w.fake.refundStatus = status;
    await w.engine.approveRefund('s', w.store.list<MoneyRecord>('refunds')[0].id);
    const state = await w.engine.state('s'); expect(state.supporterTotal).toBe(150); expect(state.openItems.some(r => r.status === status && r.refundId)).toBe(true);
  });
  it('another supporter cannot finish the order or approve a refund', async () => {
    const w = await overCap(), d = w.store.list<MoneyRecord>('donations')[0], r = w.store.list<MoneyRecord>('refunds')[0];
    await expect(w.engine.finishOrder('other', d.orderId!)).rejects.toMatchObject({ status: 404 });
    await expect(w.engine.approveRefund('other', r.id)).rejects.toMatchObject({ status: 404 });
  });

  it('Refund evidence: $25 + $50 + $50 completed for one sid gives a proposal with evidence { capturedCents: 12500, refundedBeforeCents: 0, capCents: 10000, excessCents: 2500 }; after approveRefund, approvedAt is set', async () => {
    const w = world();
    w.advance(1); await w.engine.donate('s', { ...gift, amount: 25 });
    w.advance(1); await w.engine.donate('s', { ...gift, amount: 50 });
    w.advance(1); await w.engine.donate('s', { ...gift, amount: 50 });
    const proposals = w.store.list<MoneyRecord>('refunds').filter(r => r.sid === 's');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].evidence).toEqual({ capturedCents: 12500, refundedBeforeCents: 0, capCents: 10000, excessCents: 2500 });
    expect(proposals[0].approvedAt).toBeUndefined();
    const approved = await w.engine.approveRefund('s', proposals[0].id);
    expect(approved.approvedAt).toBe(w.options.clock());
  });

  it('state() has no payee email and no receiver', async () => {
    const w = world();
    await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 100 });
    const s = await w.engine.state('s');
    const json = JSON.stringify(s);
    expect(json).not.toContain('crew@example.test');
    expect(json).not.toContain('crew-unclaimed@example.com');
    expect(json).not.toContain('receiver');
  });
  it.each([{ ...gift, amount: 500 }, { ...gift, amount: '50' }, { ...gift, ward: 4 }, { ...gift, ward: 1.5 }, { ...gift, email: 'evil@example.test' }, { ...gift, recipient: 'evil' }, { ...gift, method: 'wire' }])('rejects tampered donation %# before any write', async body => {
    const w = world(); await expect(w.engine.donate('s', body)).rejects.toMatchObject({ status: 400 }); expect(w.fake.calls).toHaveLength(0);
  });
});
describe('work logs and payouts', () => {
  it.each([
    [{ ward: 3, payee: 'crew-north', units: 10 }, "Ward 3 is not in the campaign's $5,000 plan."],
    [{ ward: 1, payee: 'crew-north', units: 241 }, '$60'],
    [{ ward: 1, payee: 'crew-north', units: 0 }, '1 to 400'],
    [{ ward: 1, payee: 'crew-north', units: 401 }, '1 to 400'],
    [{ ward: 1, payee: 'crew-north', units: 1.5 }, 'whole'],
    [{ ward: 1, payee: 'unknown', units: 10 }, 'Unknown payee'],
    [{ ward: 1, payee: 'crew-north', units: 10, amount: 1 }, 'Unexpected field'],
    [{ ward: 1, payee: 'crew-north', units: 10, email: 'evil' }, 'Unexpected field'],
    [{ ward: 1, payee: 'crew-north', units: 10, kind: 'flyers' }, 'Unexpected field'],
  ])('rejects invalid worklog %#', async (body, message) => { const w = world(); await expect(w.engine.createWorklog(body)).rejects.toThrow(message); expect(w.fake.calls).toHaveLength(0); });
  it('rejects a mismatched allow-list role', async () => {
    const w = world(); w.options.payees['crew-north'].role = 'flyers';
    await expect(w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 })).rejects.toThrow('role');
  });
  it('reserves unpaid plan so multiple approved logs cannot overdraw', async () => {
    const w = world({ 1: 10 }); await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 40 });
    await expect(w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 1 })).rejects.toThrow('unpaid plan');
  });
  it('uses print-shop server rate', async () => {
    const w = world(), log = await w.engine.createWorklog({ ward: 1, payee: 'print-shop', units: 400 }); expect(log.cents).toBe(4000);
  });
  it('two concurrent pay calls create one payout; only SUCCESS is Paid', async () => {
    const w = world(), log = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 100 });
    const [a, b] = await Promise.all([w.engine.pay(log.id), w.engine.pay(log.id)]); expect(a.status).toBe('SUCCESS'); expect(b.message).toBe('Paid');
    const writes = w.fake.writes('/v1/payments/payouts'); expect(writes).toHaveLength(1);
    expect(writes[0].body.items[0]).toMatchObject({ receiver: 'crew@example.test', amount: { value: '25.00', currency: 'USD' }, sender_item_id: `ww-${log.id}-1` });
    expect(writes[0].body.sender_batch_header.sender_batch_id).toBe(`ww-${log.id}`);
    expect((await w.engine.state('s')).wards[1].paid).toBe(25);
    await new CampaignEngine(w.options).pay(log.id); expect(w.fake.writes('/v1/payments/payouts')).toHaveLength(1);
  });
  it.each(['FAILED', 'UNCLAIMED', 'ONHOLD', 'BLOCKED', 'PENDING', 'RETURNED', 'REFUNDED'])('payout %s stays unpaid', async status => {
    const w = world(); w.fake.payoutStatus = status;
    const log = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 100 });
    expect((await w.engine.pay(log.id)).status).toBe(status); expect((await w.engine.state('s')).wards[1].paid).toBe(0);
  });
  it('UNCLAIMED can be cancelled once and uses the unclaimed sandbox recipient', async () => {
    const w = world(); w.fake.payoutStatus = 'UNCLAIMED';
    const log = await w.engine.createWorklog({ ward: 1, payee: 'crew-unclaimed', units: 100 });
    const paid = await w.engine.pay(log.id), cancelled = await w.engine.cancel(log.id);
    expect(w.fake.writes('/v1/payments/payouts')[0].body.items[0].receiver).toBe('crew-unclaimed@example.com');
    expect(cancelled.status).toBe('CANCELED'); expect(w.fake.writes(`/v1/payments/payouts-item/${paid.itemId}/cancel`)).toHaveLength(1);
  });
  it('cancel is refused when the current item became SUCCESS', async () => {
    const w = world(); w.fake.payoutStatus = 'UNCLAIMED'; const log = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 100 });
    const paid = await w.engine.pay(log.id); w.fake.items.get(paid.itemId!)!.transaction_status = 'SUCCESS';
    await expect(w.engine.cancel(log.id)).rejects.toThrow('Only an UNCLAIMED'); expect(w.fake.writes(`/v1/payments/payouts-item/${paid.itemId}/cancel`)).toHaveLength(0);
  });
  it('duplicate sender_batch_id recovers original batch with GET and no new id', async () => {
    const w = world(); w.fake.duplicateBatch = true;
    const log = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 100 });
    expect((await w.engine.pay(log.id)).status).toBe('SUCCESS'); expect(w.fake.writes('/v1/payments/payouts')).toHaveLength(1);
  });
  it('saved payout operation recovers its batch id after restart without a second payout', async () => {
    const w = world(), log = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    const paid = await w.engine.pay(log.id); w.store.put('worklogs', log.id, { ...paid, status: 'CHECKING', batchId: undefined, itemId: undefined });
    expect((await new CampaignEngine(w.options).pay(log.id)).status).toBe('SUCCESS'); expect(w.fake.writes('/v1/payments/payouts')).toHaveLength(1);
  });
  it('refresh can move a pending item to SUCCESS', async () => {
    const w = world(); w.fake.payoutStatus = 'PENDING'; const log = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    const paid = await w.engine.pay(log.id); w.fake.items.get(paid.itemId!)!.transaction_status = 'SUCCESS';
    expect((await w.engine.refresh(log.id)).message).toBe('Paid');
  });
});

describe('not sent and ID-less recovery', () => {
  it('token failure fails donation, frees both gate counters, and never counts', async () => {
    const w = world(); w.fake.fail = '/v1/oauth2/token';
    for (let i = 0; i < 7; i++) {
      const d = await w.engine.donate('s', gift);
      expect(d.status).toBe('FAILED'); expect(d.message).toBe('PayPal could not be reached. No money moved.');
    }
    expect(w.fake.orders.size).toBe(0); expect((await w.engine.state('s')).supporterTotal).toBe(0);
    expect(w.gateStore.get('records', 'counter:2026-11-06:donation')).toBe(0);
    expect(w.gateStore.get('records', 'counter:2026-11-06:donation:s')).toBe(0);
    w.fake.fail = undefined; expect((await w.engine.donate('s', gift)).status).toBe('COMPLETED');
  });
  it.each([false, true])('replays a lost card create (APPROVED=%s) after restart with exactly the stored body and request id', async approved => {
    const w = world(); w.fake.cardApproved = approved; w.fake.lose = '/v2/checkout/orders';
    const d = await w.engine.donate('s', gift); expect(d.status).toBe('CHECKING'); expect(d.orderId).toBeUndefined();
    const originalId = [...w.fake.orders.keys()][0];
    const state = await new CampaignEngine(w.options).state('s');
    const writes = w.fake.writes('/v2/checkout/orders'); expect(writes).toHaveLength(2);
    expect(writes[1].body).toEqual(writes[0].body);
    expect(writes[1].headers.get('PayPal-Request-Id')).toBe(writes[0].headers.get('PayPal-Request-Id'));
    expect(w.fake.orders.size).toBe(1); expect(state.records[0].orderId).toBe(originalId); expect(state.supporterTotal).toBe(50);
  });
  it('an unreadable write answer stays CHECKING and replays to the original order', async () => {
    const w = world(); w.fake.unreadable = '/v2/checkout/orders';
    const d = await w.engine.donate('s', gift); expect(d.status).toBe('CHECKING');
    expect((await w.engine.state('s')).supporterTotal).toBe(50); expect(w.fake.orders.size).toBe(1);
  });
  it('state throttles ID-less recovery once per record per 60 seconds across restart', async () => {
    const w = world(); w.fake.transportFailure = '/v2/checkout/orders';
    const d = await w.engine.donate('s', gift);
    await w.engine.state('s'); await new CampaignEngine(w.options).state('s');
    expect(w.fake.writes('/v2/checkout/orders')).toHaveLength(2);
    w.advance(59_999); await w.engine.state('s'); expect(w.fake.writes('/v2/checkout/orders')).toHaveLength(2);
    w.advance(1); w.fake.transportFailure = undefined;
    expect((await w.engine.state('s')).supporterTotal).toBe(50);
    expect(w.fake.writes('/v2/checkout/orders')).toHaveLength(3);
    expect(w.store.get<MoneyRecord>('donations', d.id)?.status).toBe('COMPLETED');
  });
  it('manual donation refresh enforces ownership and recovers immediately', async () => {
    const w = world(); w.fake.lose = '/v2/checkout/orders'; const d = await w.engine.donate('s', gift);
    await expect(w.engine.refreshDonation('other', d.id)).rejects.toMatchObject({ status: 404 });
    expect((await w.engine.refreshDonation('s', d.id)).status).toBe('COMPLETED'); expect(w.fake.orders.size).toBe(1);
  });
  it.each(['donation', 'refund', 'payout'])('does not replay %s at three hours; keeps NEEDS_REVIEW open and uncounted', async kind => {
    const w = world(); let record: MoneyRecord, path: string;
    if (kind === 'donation') {
      path = '/v2/checkout/orders'; w.fake.lose = path; record = await w.engine.donate('s', gift);
    } else if (kind === 'refund') {
      await overCap(w); record = w.store.list<MoneyRecord>('refunds')[0];
      path = `/v2/payments/captures/${record.captureId}/refund`; w.fake.lose = path; record = await w.engine.approveRefund('s', record.id);
    } else {
      record = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
      path = '/v1/payments/payouts'; w.fake.lose = path; record = await w.engine.pay(record.id);
    }
    const count = w.fake.writes(path).length; w.advance(3 * 60 * 60 * 1000);
    const state = await new CampaignEngine(w.options).state('s');
    const open = state.openItems.find(r => r.id === record.id);
    expect(open?.status).toBe('NEEDS_REVIEW'); expect(open?.message).toBe('Could not confirm with PayPal. Not counted.');
    if (kind === 'donation') expect(state.supporterTotal).toBe(0);
    if (kind === 'refund') expect(state.supporterTotal).toBe(150);
    if (kind === 'payout') expect(state.wards[1].paid).toBe(0);
    await w.engine.state('s'); if (kind === 'donation') await w.engine.refreshDonation('s', record.id);
    expect(w.fake.writes(path)).toHaveLength(count);
  });
  it('replays an ID-less refund with the same body and id; one refund exists', async () => {
    const w = await overCap(), r = w.store.list<MoneyRecord>('refunds')[0];
    const path = `/v2/payments/captures/${r.captureId}/refund`; w.fake.lose = path;
    expect((await w.engine.approveRefund('s', r.id)).status).toBe('CHECKING');
    const state = await new CampaignEngine(w.options).state('s'), writes = w.fake.writes(path);
    expect(state.supporterTotal).toBe(100); expect(w.fake.refunds.size).toBe(1);
    expect(writes).toHaveLength(2); expect(writes[1].body).toEqual(writes[0].body);
    expect(writes[1].headers.get('PayPal-Request-Id')).toBe(writes[0].headers.get('PayPal-Request-Id'));
  });
  it('replays an ID-less payout with the same body, batch and request id; one payout exists', async () => {
    const w = world(), r = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    w.fake.lose = '/v1/payments/payouts'; expect((await w.engine.pay(r.id)).status).toBe('CHECKING');
    const state = await new CampaignEngine(w.options).state('s'), writes = w.fake.writes('/v1/payments/payouts');
    expect(state.wards[1].paid).toBe(2.5); expect(w.fake.batches.size).toBe(1);
    expect(writes).toHaveLength(2); expect(writes[1].body).toEqual(writes[0].body);
    expect(writes[1].headers.get('PayPal-Request-Id')).toBe(writes[0].headers.get('PayPal-Request-Id'));
  });
  it.each(['refund', 'payout'])('not-sent %s frees its gate slot', async kind => {
    const w = world(); let r: MoneyRecord;
    if (kind === 'refund') { await overCap(w); r = w.store.list<MoneyRecord>('refunds')[0]; }
    else r = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    w.advance(3600_000); w.fake.fail = '/v1/oauth2/token';
    const failed = kind === 'refund' ? await w.engine.approveRefund('s', r.id) : await w.engine.pay(r.id);
    expect(failed.status).toBe('FAILED'); expect(failed.message).toBe('PayPal could not be reached. No money moved.');
    expect(w.gateStore.get('records', `counter:2026-11-06:${kind}`)).toBe(0);
  });
  it('a not-sent replay never clears the original uncertainty or releases its slot', async () => {
    const w = world(); w.fake.lose = '/v2/checkout/orders'; const d = await w.engine.donate('s', gift);
    w.advance(3600_000); w.fake.fail = '/v1/oauth2/token';
    await w.engine.state('s');
    expect(w.store.get<MoneyRecord>('donations', d.id)?.status).toBe('CHECKING');
    expect(w.gateStore.get('records', 'counter:2026-11-06:donation')).toBe(1);
  });
});

describe('recovery boundaries', () => {
  it('uses legacy intent body/id and receipt time when no firstAttemptAt was saved', async () => {
    const w = world(); w.fake.lose = '/v2/checkout/orders'; const d = await w.engine.donate('s', gift);
    const op = w.store.get<Operation>('ops', `${d.id}:create`)!;
    delete op.firstAttemptAt; delete op.path; w.store.put('ops', op.id, op);
    expect((await new CampaignEngine(w.options).state('s')).supporterTotal).toBe(50);
    expect(w.fake.orders.size).toBe(1);
    const writes = w.fake.writes('/v2/checkout/orders'); expect(writes[1].body).toEqual(op.body);
    expect(writes[1].headers.get('PayPal-Request-Id')).toBe(op.requestId);
  });
  it('legacy refund expiry uses its first write receipt, not the old proposal time', async () => {
    const w = await overCap(), r = w.store.list<MoneyRecord>('refunds')[0];
    w.advance(4 * 3600_000); const path = `/v2/payments/captures/${r.captureId}/refund`; w.fake.lose = path;
    await w.engine.approveRefund('s', r.id);
    const op = w.store.get<Operation>('ops', `${r.id}:refund`)!; delete op.firstAttemptAt; w.store.put('ops', op.id, op);
    expect((await w.engine.state('s')).supporterTotal).toBe(100); expect(w.fake.refunds.size).toBe(1);
  });
  it('recovers duplicate sender_batch_id from the replay answer without a second batch', async () => {
    const w = world(), r = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    w.fake.lose = '/v1/payments/payouts'; await w.engine.pay(r.id); w.fake.duplicateBatch = true;
    expect((await w.engine.state('s')).wards[1].paid).toBe(2.5); expect(w.fake.batches.size).toBe(1);
  });
  it('readable PayPal write rejection is FAILED, not a lost answer', async () => {
    const w = world(); w.fake.fail = '/v2/checkout/orders';
    expect((await w.engine.donate('s', gift)).status).toBe('FAILED');
    await w.engine.state('s'); expect(w.fake.writes('/v2/checkout/orders')).toHaveLength(1);
  });
});

describe('payout write reconciliation', () => {
  async function unclaimedWorklog(w = world()) {
    w.fake.payoutStatus = 'UNCLAIMED';
    const ready = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    return { w, record: await w.engine.pay(ready.id) };
  }
  it('cancel 500 followed by an UNCLAIMED read keeps the payout available to cancel', async () => {
    const { w, record } = await unclaimedWorklog();
    const path = `/v1/payments/payouts-item/${record.itemId}/cancel`;
    w.fake.fail = path;
    const fetch = w.fake.fetch;
    w.fake.fetch = async (input, init) => {
      const response = await fetch(input, init);
      return response.status === 503 && new URL(String(input)).pathname === path
        ? new Response(await response.text(), { status: 500, headers: response.headers }) : response;
    };
    const result = await w.engine.cancel(record.id);
    expect(result.status).toBe('UNCLAIMED');
    expect(result.message).toBe('PayPal could not cancel this payout (HTTP 500, debug id debug-test). It stays unclaimed. PayPal returns unclaimed money after 30 days.');
    expect((await w.engine.state('s')).wards[1].paid).toBe(0);
    expect((await w.engine.cancel(record.id)).status).toBe('UNCLAIMED');
  });
  it('cancel 200 followed by RETURNED read reports the returned state', async () => {
    const { w, record } = await unclaimedWorklog();
    const itemPath = `/v1/payments/payouts-item/${record.itemId}`;
    const cancelPath = `${itemPath}/cancel`;
    const fetch = w.fake.fetch;
    let cancelPosted = false;
    w.fake.fetch = async (input, init) => {
      const response = await fetch(input, init);
      if ((init?.method ?? 'GET') === 'POST' && new URL(String(input)).pathname === cancelPath) cancelPosted = true;
      if (cancelPosted && (init?.method ?? 'GET') === 'GET' && new URL(String(input)).pathname === itemPath) {
        const body = await response.json() as Record<string, unknown>;
        return new Response(JSON.stringify({ ...body, transaction_status: 'RETURNED' }), { status: response.status, headers: response.headers });
      }
      return response;
    };
    const result = await w.engine.cancel(record.id);
    expect(result.status).toBe('RETURNED'); expect(result.message).toBe('RETURNED');
  });
  it('refund 500 leaves its proposal open and retries with the stored request ID', async () => {
    const w = await overCap(), proposal = w.store.list<MoneyRecord>('refunds')[0];
    const path = `/v2/payments/captures/${proposal.captureId}/refund`;
    w.fake.fail = path;
    const fetch = w.fake.fetch;
    w.fake.fetch = async (input, init) => {
      const response = await fetch(input, init);
      return response.status === 503 && new URL(String(input)).pathname === path
        ? new Response(await response.text(), { status: 500, headers: response.headers }) : response;
    };
    const first = await w.engine.approveRefund('s', proposal.id);
    expect(first.status).toBe('PROPOSED'); expect(w.fake.refunds.size).toBe(0);
    const requestId = w.fake.writes(path)[0].headers.get('PayPal-Request-Id');
    w.fake.fail = undefined;
    const recovered = await w.engine.approveRefund('s', proposal.id);
    expect(recovered.status).toBe('COMPLETED'); expect(w.fake.refunds.size).toBe(1);
    expect(w.fake.writes(path)[1].headers.get('PayPal-Request-Id')).toBe(requestId);
  });
  it('payout 500 remains CHECKING instead of marking the work log FAILED', async () => {
    const w = world(), ready = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    w.fake.fail = '/v1/payments/payouts';
    const fetch = w.fake.fetch;
    w.fake.fetch = async (input, init) => {
      const response = await fetch(input, init);
      return response.status === 503 && new URL(String(input)).pathname === '/v1/payments/payouts'
        ? new Response(await response.text(), { status: 500, headers: response.headers }) : response;
    };
    const result = await w.engine.pay(ready.id);
    expect(result.status).toBe('CHECKING'); expect(result.message).toBe('Checking payment');
  });
});

describe('payroll batch payouts', () => {
  it('an older payroll keeps its own items and the paid count after 31 newer records push its work log out of the list', async () => {
    const w = world();
    const log = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 100 });
    const preview = await w.engine.payrollPreview();
    const payroll = await w.engine.payPayroll({ version: preview.version });
    expect(w.store.get<MoneyRecord>('worklogs', log.id)!.status).toBe('SUCCESS');
    for (let i = 0; i < 31; i++) { w.advance(1000); await w.engine.donate(`newer-${i}`, { ward: 2, amount: 10, method: 'card' }); }
    const state = await w.engine.state('s');
    expect(state.records).toHaveLength(30);
    expect(state.records.some(r => r.id === log.id)).toBe(false);
    const shown = state.payrolls.find(p => p.id === payroll.id)!;
    expect(shown.items).toHaveLength(1);
    expect(shown.items![0]).toMatchObject({ id: log.id, ward: 1, payee: 'crew-north', units: 100, cents: log.cents, status: 'SUCCESS' });
    expect(shown.items![0].itemId).toBeTruthy();
    expect(state.payoutCounts).toEqual({ paid: 1, unclaimed: 0 });
    expect(JSON.stringify(shown.items)).not.toMatch(/"sid"|approvalUrl|email|receiver/);
  });
  it('two READY logs (crew-north, crew-unclaimed) give one POST to /v1/payments/payouts with two items and right sender_item_ids, batch read gives one SUCCESS and one UNCLAIMED and payroll is PARTLY_PAID, and gate counts 2 payouts', async () => {
    const w = world();
    const log1 = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 100 });
    const log2 = await w.engine.createWorklog({ ward: 1, payee: 'crew-unclaimed', units: 100 });
    const preview = await w.engine.payrollPreview();
    const payroll = await w.engine.payPayroll({ version: preview.version });
    const writes = w.fake.writes('/v1/payments/payouts');
    expect(writes).toHaveLength(1);
    expect(writes[0].body.items).toHaveLength(2);
    expect(writes[0].body.items[0].sender_item_id).toBe(`ww-${log1.id}-1`);
    expect(writes[0].body.items[1].sender_item_id).toBe(`ww-${log2.id}-1`);
    expect(writes[0].body.sender_batch_header.sender_batch_id).toBe(`ww-pr-${payroll.id}`);
    expect(payroll.status).toBe('PARTLY_PAID');
    const w1 = w.store.get<MoneyRecord>('worklogs', log1.id)!;
    const w2 = w.store.get<MoneyRecord>('worklogs', log2.id)!;
    expect(w1.status).toBe('SUCCESS');
    expect(w1.itemId).toBeTruthy();
    expect(w2.status).toBe('UNCLAIMED');
    expect(w2.itemId).toBeTruthy();
    const day = new Date(w.options.clock()).toISOString().slice(0, 10);
    expect(w.gateStore.get('records', `counter:${day}:payout`)).toBe(2);
  });

  it('a lost create answer is replayed with the same request id and makes no second batch', async () => {
    const w = world();
    w.fake.lose = '/v1/payments/payouts';
    const log1 = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 100 });
    const log2 = await w.engine.createWorklog({ ward: 1, payee: 'crew-unclaimed', units: 100 });
    const preview = await w.engine.payrollPreview();
    const payroll = await w.engine.payPayroll({ version: preview.version });
    expect(payroll.status).toBe('CHECKING');
    expect(payroll.batchId).toBeUndefined();
    const writesBefore = w.fake.writes('/v1/payments/payouts');
    expect(writesBefore).toHaveLength(1);
    const reqId = writesBefore[0].headers.get('PayPal-Request-Id');

    await w.engine.state('s');
    expect(w.store.get<MoneyRecord>('worklogs', log1.id)!.status).toBe('CHECKING');
    expect(w.store.get<MoneyRecord>('worklogs', log2.id)!.status).toBe('CHECKING');
    expect(w.store.get<PayrollRecord>('payrolls', payroll.id)!.status).toBe('CHECKING');

    const refreshed = await w.engine.refreshPayroll(payroll.id);
    const writesAfter = w.fake.writes('/v1/payments/payouts');
    expect(writesAfter).toHaveLength(2);
    expect(writesAfter[1].headers.get('PayPal-Request-Id')).toBe(reqId);
    expect(w.fake.batches.size).toBe(1);
    expect(refreshed.status).toBe('PARTLY_PAID');
    expect(refreshed.batchId).toBeTruthy();
    expect(w.store.get<MoneyRecord>('worklogs', log1.id)!.status).toBe('SUCCESS');
    expect(w.store.get<MoneyRecord>('worklogs', log2.id)!.status).toBe('UNCLAIMED');
  });

  it('when a payroll goes to NEEDS_REVIEW its non-final work logs go to NEEDS_REVIEW with the same message', async () => {
    const w = world();
    w.fake.lose = '/v1/payments/payouts';
    const log1 = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 100 });
    const log2 = await w.engine.createWorklog({ ward: 1, payee: 'crew-unclaimed', units: 100 });
    const preview = await w.engine.payrollPreview();
    const payroll = await w.engine.payPayroll({ version: preview.version });
    w.advance(3 * 60 * 60 * 1000);
    await w.engine.state('s');
    const p = w.store.get<PayrollRecord>('payrolls', payroll.id)!;
    expect(p.status).toBe('NEEDS_REVIEW');
    expect(p.message).toBe('Could not confirm with PayPal. Not counted.');
    const w1 = w.store.get<MoneyRecord>('worklogs', log1.id)!;
    const w2 = w.store.get<MoneyRecord>('worklogs', log2.id)!;
    expect(w1.status).toBe('NEEDS_REVIEW');
    expect(w1.message).toBe(p.message);
    expect(w2.status).toBe('NEEDS_REVIEW');
    expect(w2.message).toBe(p.message);
  });

  it('a NotSentError create leaves the logs READY and payPayroll can pay them on the next call', async () => {
    const w = world();
    const log1 = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 100 });
    const log2 = await w.engine.createWorklog({ ward: 1, payee: 'crew-unclaimed', units: 100 });
    w.fake.fail = '/v1/oauth2/token';
    const preview1 = await w.engine.payrollPreview();
    const failedPayroll = await w.engine.payPayroll({ version: preview1.version });
    expect(failedPayroll.status).toBe('FAILED');
    const w1 = w.store.get<MoneyRecord>('worklogs', log1.id)!;
    const w2 = w.store.get<MoneyRecord>('worklogs', log2.id)!;
    expect(w1.status).toBe('READY');
    expect(w1.payrollId).toBeUndefined();
    expect(w1.message).toBe('PayPal could not be reached. Ready to pay again.');
    expect(w2.status).toBe('READY');
    expect(w2.payrollId).toBeUndefined();
    expect(w2.message).toBe('PayPal could not be reached. Ready to pay again.');

    w.fake.fail = undefined;
    const preview2 = await w.engine.payrollPreview();
    const payroll = await w.engine.payPayroll({ version: preview2.version });
    expect(payroll.status).toBe('PARTLY_PAID');
    expect(payroll.worklogIds).toEqual([log1.id, log2.id]);
    expect(w.store.get<MoneyRecord>('worklogs', log1.id)!.status).toBe('SUCCESS');
    expect(w.store.get<MoneyRecord>('worklogs', log2.id)!.status).toBe('UNCLAIMED');
  });

  it('with 19 used and 2 ready only 1 is paid and the message says so', async () => {
    const w = world();
    const day = new Date(w.options.clock()).toISOString().slice(0, 10);
    w.gateStore.put('records', `counter:${day}:payout`, 19);
    const log1 = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 100 });
    const log2 = await w.engine.createWorklog({ ward: 1, payee: 'crew-unclaimed', units: 100 });
    const preview = await w.engine.payrollPreview();
    const payroll = await w.engine.payPayroll({ version: preview.version });
    expect(payroll.worklogIds).toHaveLength(1);
    expect(payroll.worklogIds[0]).toBe(log1.id);
    expect(payroll.message).toMatch(/limit reached|paid 1 of 2/i);
    expect(w.fake.writes('/v1/payments/payouts')).toHaveLength(1);
    expect(w.fake.writes('/v1/payments/payouts')[0].body.items).toHaveLength(1);
    expect(w.store.get<MoneyRecord>('worklogs', log1.id)!.status).toBe('SUCCESS');
    expect(w.store.get<MoneyRecord>('worklogs', log2.id)!.status).toBe('READY');
    expect(w.gateStore.get('records', `counter:${day}:payout`)).toBe(20);
  });

  it('state() JSON holds no email and returns payrolls', async () => {
    const w = world();
    await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 100 });
    const preview = await w.engine.payrollPreview();
    const payroll = await w.engine.payPayroll({ version: preview.version });
    const s = await w.engine.state('s');
    const json = JSON.stringify(s);
    expect(json).not.toContain('@');
    expect(json).not.toContain('crew@example.test');
    expect(json).not.toContain('crew-unclaimed@example.com');
    expect(s.payrolls).toHaveLength(1);
    expect(s.payrolls[0].id).toBe(payroll.id);
  });

  it('11 READY logs: preview has 10 items, excluded 1, limit batch; payPayroll({ version }) sends ONE POST to /v1/payments/payouts with 10 items; the batch total equals preview.cents; the 11th log stays READY', async () => {
    const w = world();
    const logs = [];
    for (let i = 0; i < 11; i++) {
      logs.push(await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 }));
    }
    const preview = await w.engine.payrollPreview();
    expect(preview.items).toHaveLength(10);
    expect(preview.count).toBe(10);
    expect(preview.readyCount).toBe(11);
    expect(preview.excluded).toBe(1);
    expect(preview.limit).toBe('batch');

    const payroll = await w.engine.payPayroll({ version: preview.version });
    const writes = w.fake.writes('/v1/payments/payouts');
    expect(writes).toHaveLength(1);
    expect(writes[0].body.items).toHaveLength(10);
    expect(payroll.cents).toBe(preview.cents);
    const itemCentsSum = writes[0].body.items.reduce((s: number, it: any) => s + Math.round(Number(it.amount.value) * 100), 0);
    expect(itemCentsSum).toBe(preview.cents);

    const log11 = w.store.get<MoneyRecord>('worklogs', logs[10].id)!;
    expect(log11.status).toBe('READY');
  });

  it('Daily capacity: set the gate counter so 3 payouts remain today; preview has 3 items, limit daily; pay sends 3', async () => {
    const w = world();
    const day = new Date(w.options.clock()).toISOString().slice(0, 10);
    w.gateStore.put('records', `counter:${day}:payout`, 17);
    for (let i = 0; i < 5; i++) {
      await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    }
    const preview = await w.engine.payrollPreview();
    expect(preview.items).toHaveLength(3);
    expect(preview.limit).toBe('daily');
    const payroll = await w.engine.payPayroll({ version: preview.version });
    expect(payroll.worklogIds).toHaveLength(3);
    const writes = w.fake.writes('/v1/payments/payouts');
    expect(writes).toHaveLength(1);
    expect(writes[0].body.items).toHaveLength(3);
  });

  it('Another visitor changes the ready set: take preview v1 (2 logs), create a 3rd log, payPayroll({ version: v1 }) throws 409 preview_changed, no POST to payouts, gate payout counter unchanged, all 3 logs still READY', async () => {
    const w = world();
    const day = new Date(w.options.clock()).toISOString().slice(0, 10);
    const log1 = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    const log2 = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    const v1 = await w.engine.payrollPreview();
    const gateCountBefore = w.gateStore.get<number>('records', `counter:${day}:payout`) ?? 0;

    const log3 = await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    await expect(w.engine.payPayroll({ version: v1.version })).rejects.toMatchObject({
      status: 409,
      error: 'preview_changed',
      message: 'The ready work changed. Check the new payroll preview, then approve again.',
    });

    expect(w.fake.writes('/v1/payments/payouts')).toHaveLength(0);
    expect(w.gateStore.get<number>('records', `counter:${day}:payout`) ?? 0).toBe(gateCountBefore);
    expect(w.store.get<MoneyRecord>('worklogs', log1.id)!.status).toBe('READY');
    expect(w.store.get<MoneyRecord>('worklogs', log2.id)!.status).toBe('READY');
    expect(w.store.get<MoneyRecord>('worklogs', log3.id)!.status).toBe('READY');
  });

  it('Double approval: payPayroll({ version }) twice with the same version: the second throws (409 or 400) and the fake PayPal saw exactly one POST to payouts', async () => {
    const w = world();
    await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    const preview = await w.engine.payrollPreview();
    await w.engine.payPayroll({ version: preview.version });
    await expect(w.engine.payPayroll({ version: preview.version })).rejects.toSatisfy((e: any) => e.status === 409 || e.status === 400);
    expect(w.fake.writes('/v1/payments/payouts')).toHaveLength(1);
  });

  it('Missing version: payPayroll({}) throws 400', async () => {
    const w = world();
    await w.engine.createWorklog({ ward: 1, payee: 'crew-north', units: 10 });
    await expect(w.engine.payPayroll({})).rejects.toMatchObject({ status: 400 });
  });
});
