import { afterEach, describe, expect, it, vi } from 'vitest';
import { allocate } from '../src/model/allocate';
import { sixWards } from './fixtures/six-wards';
import { defaultWardPickers, decimal, dollars, escapeHtml, foldKey, heatBucket, integer, nonVoterTotal, percent, pourFrame, PRECINCT_HEAT, precinctBreaks, precinctBucket, returnMessage, summaryMatches } from '../src/web/helpers';
import { expectedVotes } from '../src/model/score';
import { SETUP_COST, STEP } from '../src/model/assumptions';
import type { CityData } from '../src/model/types';
import { api, emptyState, type MoneyRecord, type PayrollRecord } from '../src/web/api';
import { payrollStatusText, recordKind, renderMoneyLog, renderRecord, statusChip } from '../src/web/money';
import { aboutContent, BACKTEST_LIMIT, CITY_DISCLAIMER, ESTIMATE_LIMIT } from '../src/web/about';
import { planCsv } from '../src/web/helpers';
import { compareWards } from '../src/model/explain';
import { costPerContact } from '../src/model/score';
import { readFileSync } from 'node:fs';

afterEach(() => vi.restoreAllMocks());
const city: CityData = JSON.parse(readFileSync('public/data/chicago.json', 'utf8'));
describe('plan CSV', () => {
  it('exports the named columns and a real funded ward using model costs and returns', () => {
    const plan = allocate(5000, 'y2023', city.wards);
    const [header, ...rows] = planCsv(plan, city.wards, 'y2023').trim().split('\r\n');
    expect(header).toBe('ward,dollars,expected_contacts,expected_votes,votes_per_100');
    expect(rows).toHaveLength(4);
    const ward = city.wards.find(w => w.id === 21)!;
    const row = rows.find(row => row.startsWith('21,'))!.split(',').map(Number);
    expect(row).toEqual([21, 1350, Math.floor((1350 - SETUP_COST) / costPerContact(ward, city.wards)),
      Number(expectedVotes(ward, 1350, 'y2023', city.wards).toFixed(1)), compareWards(21, 2, plan, 'y2023', city.wards).a.votesPer100]);
    expect(rows.map(row => Number(row.split(',')[0]))).toEqual(city.wards.filter(w => plan.perWard[w.id] > 0).map(w => w.id));
  });
  it('exports only funded wards at changed budgets and supports the last-election plan', () => {
    for (const base of ['y2023', 'y2019'] as const) {
      const plan = allocate(2000, base, city.wards);
      const rows = planCsv(plan, city.wards, base).trim().split('\r\n').slice(1).map(row => row.split(',').map(Number));
      expect(rows.reduce((sum, row) => sum + row[1], 0)).toBe(2000);
      for (const row of rows) {
        const ward = city.wards.find(w => w.id === row[0])!;
        expect(row[1]).toBeGreaterThan(0);
        expect(row[3]).toBe(Number(expectedVotes(ward, row[1], base, city.wards).toFixed(1)));
      }
    }
    expect(planCsv(allocate(0, 'y2023', city.wards), city.wards, 'y2023')).toBe('ward,dollars,expected_contacts,expected_votes,votes_per_100\r\n');
  });
});
describe('map story', () => {
  it('computes the headline from the 2023 ward totals', () => {
    expect(nonVoterTotal(city.wards)).toBe(1581564 - 566973);
    expect(integer(nonVoterTotal(city.wards))).toBe('1,014,591');
    expect(nonVoterTotal(city.wards.slice(0, 1))).toBe(city.wards[0].y2023.registered - city.wards[0].y2023.ballots);
  });
  it('uses five nearest-rank quantiles, including the boundary values', () => {
    const breaks = precinctBreaks(city.precincts);
    const values = city.precincts.map(p => p.registered - p.ballots).sort((a, b) => a - b);
    expect(breaks).toEqual([.2, .4, .6, .8].map(q => values[Math.ceil(values.length * q) - 1]));
    expect(PRECINCT_HEAT).toHaveLength(5);
    expect(breaks.map(n => precinctBucket(n, breaks))).toEqual([0, 1, 2, 3]);
    expect(precinctBucket(values.at(-1)!, breaks)).toBe(4);
    expect(precinctBreaks([])).toEqual([0, 0, 0, 0]);
  });
  it.each([0, 1000, 2000, 5000, 25000])('returns each funded ward exactly once in the pour order at $%i', budget => {
    const plan = allocate(budget, 'y2023', city.wards);
    expect([...plan.order].sort((a, b) => a - b)).toEqual(city.wards.filter(w => plan.perWard[w.id] > 0).map(w => w.id));
    expect(new Set(plan.order).size).toBe(plan.order.length);
  });
  it('starts the greedy pour with the highest opening return, independent of ward input order', () => {
    const budget = 2000;
    const returns = sixWards.map(w => ({ id: w.id, value: Math.max(...Array.from({ length: (budget - SETUP_COST) / STEP }, (_, i) => {
      const spend = SETUP_COST + (i + 1) * STEP;
      return expectedVotes(w, spend, 'y2023', sixWards) / spend;
    })) })).sort((a, b) => b.value - a.value || a.id - b.id);
    expect(allocate(budget, 'y2023', [...sixWards].reverse()).order[0]).toBe(returns[0].id);
  });
  it('orders the exact safeguard result by votes per $100, highest first', () => {
    // This real-city case replaces greedy with the exact knapsack result.
    const plan = allocate(5000, 'y2023', city.wards);
    expect(plan.order).toEqual([...plan.order].sort((a, b) => plan.votes[b] / plan.perWard[b] - plan.votes[a] / plan.perWard[a] || a - b));
    const firstReturns = city.wards.map(w => ({ id: w.id, score: Math.max(...Array.from({ length: (5000 - SETUP_COST) / STEP }, (_, i) => {
      const spend = SETUP_COST + (i + 1) * STEP;
      return expectedVotes(w, spend, 'y2023', city.wards) / spend;
    })) })).sort((a, b) => b.score - a.score || a.id - b.id);
    expect(plan.order[0]).toBe(firstReturns[0].id);
  });
  it('fills one ward at a time and counts only the poured dollars and votes', () => {
    const plan = { perWard: { 9: 1000, 2: 4000 }, votes: { 9: 10, 2: 50 }, total: 60, order: [9, 2] };
    expect(pourFrame(plan, 0)).toEqual({ fractions: { 9: 0, 2: 0 }, dollars: 0, votes: 0 });
    expect(pourFrame(plan, .25)).toEqual({ fractions: { 9: .5, 2: 0 }, dollars: 500, votes: 5 });
    expect(pourFrame(plan, .75)).toEqual({ fractions: { 9: 1, 2: .5 }, dollars: 3000, votes: 35 });
    expect(pourFrame(plan, 2)).toEqual({ fractions: { 9: 1, 2: 1 }, dollars: 5000, votes: 60 });
    expect(pourFrame({ perWard: {}, votes: {}, total: 0, order: [] }, 1).dollars).toBe(0);
  });
});
describe('browser API boundary', () => {
  it('sends only the chosen JSON fields with the browser cookie', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'donation' }));
    expect(await api('/api/donations', { ward: 2, amount: 25, method: 'card' })).toEqual({ id: 'donation' });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"ward":2,"amount":25,"method":"card"}' });
  });
  it('shows the server rule message, and turns transport failures into plain text', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: 'Work log amount must be at most $60.' }, { status: 400 }));
    await expect(api('/api/worklogs', {})).rejects.toThrow('Work log amount must be at most $60.');
    fetchMock.mockRejectedValue(new Error('internal transport stack detail'));
    await expect(api('/api/state')).rejects.toThrow('Connection interrupted. Check the money log before trying again.');
  });
});

describe('heat buckets', () => {
  it('reserves pale sand for zero and clamps the high end', () => {
    expect([0, 1, 20, 21, 40, 60, 80, 100, 1000].map(n => heatBucket(n, 100))).toEqual([0, 1, 1, 2, 2, 3, 4, 5, 5]);
  });
  it('handles an empty plan and invalid numbers safely', () => {
    for (const [value, max] of [[0, 0], [1, 0], [-10, 100], [NaN, 100], [1, Infinity]]) expect(heatBucket(value, max)).toBe(0);
  });
});
describe('screen formatters', () => {
  it('formats USD, whole counts, model fractions and turnout consistently', () => {
    expect(dollars(5000)).toBe('$5,000'); expect(dollars(2.3, true)).toBe('$2.30');
    expect(integer(12345.7)).toBe('12,346'); expect(decimal(4, 2)).toBe('4.00'); expect(percent(.3585)).toBe('35.9%');
  });
  it('escapes server text and attributes', () => {
    expect(escapeHtml('<b a="x">&\'</b>')).toBe('&lt;b a=&quot;x&quot;&gt;&amp;&#39;&lt;/b&gt;');
  });
  it('uses the plain failure messages and accepts the server completed return', () => {
    expect(returnMessage('cancelled')).toBe('You cancelled. No money moved.');
    expect(returnMessage('declined')).toBe('Declined by PayPal. No money moved.');
    expect(returnMessage('pending')).toBe('Pending at PayPal');
    expect(returnMessage('checking')).toBe('Checking payment');
    expect(returnMessage('completed')).toBe(returnMessage('captured'));
    expect(returnMessage('<script>')).toBeUndefined();
  });
});
describe('default comparison wards', () => {
  const plan = allocate(2000, 'y2023', sixWards);
  it('picks the largest funded allocation and a distinct unfunded ward', () => {
    const { a, b } = defaultWardPickers(plan, sixWards);
    expect(plan.perWard[a]).toBe(Math.max(...Object.values(plan.perWard)));
    expect(a).not.toBe(b); expect(plan.perWard[b]).toBe(0);
  });
  it('prefers the last dropped ward, if still unfunded', () => {
    const dropped = sixWards.find(w => !plan.perWard[w.id])!.id;
    expect(defaultWardPickers(plan, sixWards, dropped).b).toBe(dropped);
    expect(defaultWardPickers(plan, sixWards, 999)).toEqual(defaultWardPickers(plan, sixWards));
  });
  it('breaks exact ties on lower id and supports an all funded plan', () => {
    const wards = sixWards.slice(0, 2);
    expect(defaultWardPickers({ perWard: { 1: 500, 2: 500 }, votes: { 1: 5, 2: 5 }, total: 10 }, [...wards].reverse())).toEqual({ a: 1, b: 2 });
    expect(() => defaultWardPickers(plan, [])).toThrow('Two wards');
  });
});
const record = (overrides: Partial<MoneyRecord> = {}): MoneyRecord & { mine: boolean } => ({ id: 'r1', ward: 2, cents: 2500,
  status: 'COMPLETED', createdAt: 1700000000000, receipts: [], mine: false, ...overrides });
describe('money presentation', () => {
  it('keeps status truth and permits cancellation only for UNCLAIMED work', () => {
    expect(statusChip('SUCCESS')).toContain('Paid · SUCCESS');
    expect(statusChip('ONHOLD')).not.toContain('Paid');
    expect(renderRecord(record({ payee: 'crew-unclaimed', status: 'UNCLAIMED' }))).toContain('data-testid="cancel-r1"');
    expect(renderRecord(record({ payee: 'crew-unclaimed', status: 'PENDING' }))).not.toContain('data-testid="cancel-r1"');
    expect(renderRecord(record({ payee: 'crew-north', status: 'READY' }))).toContain('Paid from Payroll');
  });
  it('only offers approval for the caller’s own proposed refund', () => {
    const refund = record({ donationId: 'donation1', status: 'PROPOSED' });
    expect(recordKind(refund)).toBe('Refund');
    expect(renderRecord(refund)).not.toContain('data-testid="approve-refund"');
    expect(renderRecord(refund, [refund])).toContain('data-testid="approve-refund"');
  });
  it('escapes messages, ids and receipt data, and shows open items first', () => {
    const malicious = record({ message: '<script>bad()</script>', captureId: '" onclick="bad', receipts: [{ method: 'GET', path: '/v2/<bad>', status: 503, debugId: '<id>', at: '2026-11-06' }] });
    const html = renderRecord(malicious);
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;'); expect(html).toContain('/v2/&lt;bad&gt;'); expect(html).toContain('HTTP'); expect(html).toContain('503');
    const state = emptyState(); state.records = [malicious]; state.openItems = [record({ status: 'UNCLAIMED' })];
    const log = renderMoneyLog(state); expect(log.indexOf('UNCLAIMED')).toBeLessThan(log.indexOf('Your records'));
  });
  it('shows own records before the closed everyone list', () => {
    const state = emptyState();
    const own = record({ id: 'own', mine: true, createdAt: 20 });
    const other = record({ id: 'other', mine: false, createdAt: 30 });
    state.records = [other, own];
    const html = renderMoneyLog(state);
    expect(html.indexOf('Your records')).toBeLessThan(html.indexOf('Everyone\'s records (2)'));
    expect(html.indexOf('data-record-id="own"')).toBeLessThan(html.indexOf('Everyone\'s records (2)'));
    expect(html.indexOf('data-record-id="other"')).toBeGreaterThan(html.indexOf('Everyone\'s records (2)'));
    expect(html).toMatch(/<details class="everyone-records">\s*<summary>Everyone's records \(2\)<\/summary>/);
    expect(renderMoneyLog(emptyState())).toContain('No records from this browser yet. Give $10 on a ward card to make one.');
  });
  it('renders payroll panel with status chips, header, and polished item rows', () => {
    expect(payrollStatusText('PAID')).toBe('Paid');
    expect(payrollStatusText('PARTLY_PAID')).toBe('Partly paid');
    expect(payrollStatusText('CHECKING')).toBe('Checking');
    expect(payrollStatusText('NEEDS_REVIEW')).toBe('Needs review');
    expect(payrollStatusText('FAILED')).toBe('Failed');

    const state = emptyState();
    state.payees = [
      { key: 'crew-north', label: 'North Side door crew (sandbox)', role: 'doors', rateDollars: 0.25 },
      { key: 'crew-unclaimed', label: 'New crew, no PayPal account yet (sandbox)', role: 'doors', rateDollars: 0.25 },
    ];
    const item1: MoneyRecord & { mine: boolean } = {
      id: 'w1', ward: 2, payee: 'crew-north', cents: 3000, status: 'SUCCESS', mine: false,
      createdAt: 1700000000000, receipts: [], itemId: 'ITEM1', batchId: 'BATCH1',
    };
    const item2: MoneyRecord & { mine: boolean } = {
      id: 'w2', ward: 2, payee: 'crew-unclaimed', cents: 1000, status: 'UNCLAIMED', mine: false,
      createdAt: 1700000000000, receipts: [], itemId: 'ITEM2', batchId: 'BATCH1', message: 'UNCLAIMED',
    };
    const payroll: PayrollRecord = {
      id: 'p1', worklogIds: ['w1', 'w2'], cents: 4000, status: 'PARTLY_PAID',
      batchId: 'BATCH1', requestId: 'REQ1', receipts: [], createdAt: 1700000000000,
    };
    state.records = [item1, item2];
    state.payrolls = [payroll];

    const html = renderMoneyLog(state);
    // Header line has Payroll · <date time> on left and status chip on right
    expect(html).toContain('Payroll ·');
    expect(html).toContain('Partly paid');
    // Under it Batch <id> in mono
    expect(html).toContain('data-copy="BATCH1"');
    // Item 1 line 1
    expect(html).toContain('Ward 2 · North Side door crew (sandbox)');
    expect(html).toContain('$30.00');
    // Item 1 line 2 has status chip and Item <id> in mono
    expect(html).toContain('Paid · SUCCESS');
    expect(html).toContain('Item ITEM1');
    // Item 2 has cancel button on UNCLAIMED item
    expect(html).toContain('data-testid="cancel-w2"');
    // Stray status text 'UNCLAIMED' does not repeat under Cancel button
    expect(html).not.toMatch(/<button[^>]*cancel-w2[^>]*>Cancel<\/button>\s*<p class="muted">UNCLAIMED<\/p>/);
    // Pay all ready button is disabled when nothing is ready
    expect(html).toContain('data-ready-count="0" disabled>Approve and pay 0 logs ($0.00)</button>');
  });
  const previewItem = (id: string, ward: number, payee: string, payeeLabel: string, units: number, rateCents: number) =>
    ({ id, ward, payee, payeeLabel, units, rateCents, cents: units * rateCents });
  const payees = [
    { key: 'crew-north', label: 'North Side door crew (sandbox)', role: 'doors', rateDollars: 0.25 },
    { key: 'crew-unclaimed', label: 'New crew, no PayPal account yet (sandbox)', role: 'doors', rateDollars: 0.25 },
    { key: 'print-shop', label: 'Lincoln Park print shop (sandbox)', role: 'flyers', rateDollars: 0.1 },
  ];
  it('shows the exact next payroll batch and ties the approve button to its version', () => {
    const state = emptyState();
    state.payees = payees;
    state.payrollPreview = { version: 'v-abc123', count: 2, readyCount: 2, excluded: 0, limit: null, cents: 4000, items: [
      previewItem('w1', 2, 'crew-north', payees[0].label, 120, 25),
      previewItem('w2', 3, 'print-shop', payees[2].label, 100, 10),
    ] };
    const html = renderMoneyLog(state);
    expect(html).toContain('Next payroll batch');
    expect(html).toContain('data-testid="payroll-preview"');
    expect(html).toContain('Ward 2 · North Side door crew (sandbox) · 120 doors × $0.25 = $30.00');
    expect(html).toContain('Ward 3 · Lincoln Park print shop (sandbox) · 100 flyers × $0.10 = $10.00');
    expect(html).toMatch(/data-testid="payroll-preview-total"[^>]*>Batch total \$40\.00</);
    expect(html).toContain('data-testid="pay-all" data-version="v-abc123" data-ready-count="2" >Approve and pay 2 logs ($40.00)</button>');
    expect(html).not.toContain('Ready to pay');
    expect(html).not.toContain('wait for the next batch');
    expect(html).toContain('AI explanation of this batch');
    state.payrollPreview = { ...state.payrollPreview, count: 1, readyCount: 1, cents: 3000, items: [state.payrollPreview.items[0]] };
    expect(renderMoneyLog(state)).toContain('Approve and pay 1 log ($30.00)</button>');
  });
  it('says when more ready logs wait, and why', () => {
    const state = emptyState();
    state.payees = payees;
    const items = [previewItem('w1', 2, 'crew-north', payees[0].label, 10, 25)];
    state.payrollPreview = { version: 'v1', count: 1, readyCount: 2, excluded: 1, limit: 'batch', cents: 250, items };
    expect(renderMoneyLog(state)).toContain('1 more ready logs wait for the next batch (at most 10 per batch).');
    state.payrollPreview = { ...state.payrollPreview, limit: 'daily' };
    expect(renderMoneyLog(state)).toContain('1 more ready logs wait for the next batch (daily payout limit).');
  });
  it('escapes preview text from the server', () => {
    const state = emptyState();
    state.payrollPreview = { version: '"><b>', count: 1, readyCount: 1, excluded: 0, limit: null, cents: 250,
      items: [previewItem('w1', 2, 'x', '<i>crew</i>', 10, 25)] };
    const html = renderMoneyLog(state);
    expect(html).not.toContain('<i>crew</i>'); expect(html).not.toContain('"><b>');
    expect(html).toContain('&lt;i&gt;crew&lt;/i&gt;');
  });
  it('renders evidence for a mixed payroll with a total equal to the rows, and no email', () => {
    const state = emptyState();
    state.payees = payees;
    const item1: MoneyRecord & { mine: boolean } = { id: 'abcdef1234567890', ward: 2, payee: 'crew-north', units: 120, cents: 3000, status: 'SUCCESS',
      mine: false, createdAt: 1700000000000, itemId: 'ITEM-ONE', batchId: 'BATCH-MIX',
      receipts: [{ method: 'GET', path: '/v1/payments/payouts-item/ITEM-ONE', status: 200, at: '2023-11-14T22:13:20Z' }] };
    const item2: MoneyRecord & { mine: boolean } = { id: 'fedcba0987654321', ward: 3, payee: 'crew-unclaimed', units: 40, cents: 1000, status: 'UNCLAIMED',
      mine: false, createdAt: 1700000000000, itemId: 'ITEM-TWO', batchId: 'BATCH-MIX', receipts: [] };
    state.records = [item1, item2];
    state.payrolls = [{ id: 'p1', worklogIds: [item1.id, item2.id], cents: 4000, status: 'PARTLY_PAID', batchId: 'BATCH-MIX', requestId: 'REQ1',
      createdAt: 1700000000000, approvedAt: 1700000005000, previewVersion: 'v1',
      receipts: [{ method: 'POST', path: '/v1/payments/payouts', status: 201, at: '2023-11-14T22:13:25Z' }] }];
    const html = renderMoneyLog(state);
    expect(html).not.toContain('@');
    const evidence = html.match(/<details class="evidence" data-testid="payroll-evidence">([\s\S]*?)<\/details>/)?.[1] ?? '';
    expect(evidence).toContain('<summary>Evidence</summary>');
    expect(evidence).toContain('Approved by a person at ');
    expect(evidence).not.toContain('<table');
    expect(evidence).toContain('<ol class="evidence-items">');
    expect(evidence.match(/<li class="evidence-item"/g)?.length).toBe(2);
    for (const text of ['abcdef12', 'fedcba09', 'ITEM-ONE', 'ITEM-TWO', 'SUCCESS', 'UNCLAIMED', 'North Side door crew (sandbox)', 'Batch BATCH-MIX',
      'Rule check: accepted by the server, inside the ward\'s $5,000 plan, at most $60', '/v1/payments/payouts', 'HTTP', '201',
      'PayPal\'s own status is the source of truth. UNCLAIMED means the payee has no PayPal account yet.']) expect(evidence).toContain(text);
    expect(evidence).not.toContain('abcdef1234567890');
    expect(evidence).toContain('$0.25'); expect(evidence).toContain('$30.00'); expect(evidence).toContain('$10.00');
    expect(evidence).toContain('Batch total $40.00');
    const rowSum = [...evidence.matchAll(/data-testid="evidence-amount"[^>]*>\$([\d.]+)</g)].reduce((s, m) => s + Number(m[1]), 0);
    expect(rowSum).toBe(40);
  });
  it('renders an older payroll from its own items when its work logs are no longer in the loaded records', () => {
    const state = emptyState();
    state.payees = payees;
    state.records = [];
    state.payoutCounts = { paid: 1, unclaimed: 1 };
    state.payrolls = [{ id: 'p-old', worklogIds: ['abcdef1234567890', 'fedcba0987654321'], cents: 4000, status: 'PARTLY_PAID', batchId: 'BATCH-OLD',
      requestId: 'REQ', createdAt: 1700000000000, approvedAt: 1700000005000, receipts: [], items: [
        { id: 'abcdef1234567890', ward: 2, payee: 'crew-north', units: 120, cents: 3000, status: 'SUCCESS', itemId: 'ITEM-ONE', receipts: [], createdAt: 1 },
        { id: 'fedcba0987654321', ward: 3, payee: 'crew-unclaimed', units: 40, cents: 1000, status: 'UNCLAIMED', itemId: 'ITEM-TWO', receipts: [], createdAt: 1 },
      ] }];
    const html = renderMoneyLog(state);
    const evidence = html.match(/<details class="evidence" data-testid="payroll-evidence">([\s\S]*?)<\/details>/)?.[1] ?? '';
    expect(evidence.match(/<li class="evidence-item"/g)?.length).toBe(2);
    expect(evidence).not.toContain('not loaded');
    for (const text of ['abcdef12', 'fedcba09', 'ITEM-ONE', 'ITEM-TWO', 'North Side door crew (sandbox)']) expect(evidence).toContain(text);
    const rowSum = [...evidence.matchAll(/data-testid="evidence-amount"[^>]*>\$([\d.]+)</g)].reduce((s, m) => s + Number(m[1]), 0);
    expect(rowSum).toBe(40);
    expect(html.match(/class="payroll-item-row"/g)?.length).toBe(2);
    expect(html).toContain('Paid <span class="mono">1</span>');
    expect(html).toContain('Unclaimed <span class="mono">1</span>');
  });
  it('takes the paid and unclaimed counts from the server totals, not from the loaded records', () => {
    const state = emptyState();
    state.payoutCounts = { paid: 7, unclaimed: 2 };
    const html = renderMoneyLog(state);
    expect(html).toContain('Paid <span class="mono">7</span>');
    expect(html).toContain('Unclaimed <span class="mono">2</span>');
  });
  it('says so when an old payroll has no approval time', () => {
    const state = emptyState();
    state.payrolls = [{ id: 'p1', worklogIds: [], cents: 0, status: 'PAID', batchId: 'B', requestId: 'R', receipts: [], createdAt: 1 }];
    expect(renderMoneyLog(state)).toContain('Approval time not recorded');
  });
  it('renders refund evidence with the cap arithmetic, and only ids for old refunds', () => {
    const refund = record({ id: 'ref1', donationId: 'don1', captureId: 'CAP-REFUNDED', refundId: 'REF-123', cents: 2500, status: 'COMPLETED',
      approvedAt: 1700000005000, evidence: { capturedCents: 12500, refundedBeforeCents: 0, capCents: 10000, excessCents: 2500 },
      receipts: [{ method: 'POST', path: '/v2/payments/captures/CAP-REFUNDED/refund', status: 201, at: '2023-11-14T22:13:25Z' }] });
    const html = renderRecord(refund);
    const evidence = html.match(/<details class="evidence" data-testid="refund-evidence">([\s\S]*?)<\/details>/)?.[1] ?? '';
    for (const text of ['Captured from this browser $125.00', 'Refunded before $0.00', 'Demo cap $100.00', 'Over the cap $25.00', 'Proposed refund $25.00',
      'Approved by a person at ', 'Refund REF-123 · COMPLETED', 'CAP-REFUNDED', 'Stays donated $100.00', 'HTTP']) expect(evidence).toContain(text);
    const waiting = renderRecord({ ...refund, status: 'PROPOSED', approvedAt: undefined, refundId: undefined });
    expect(waiting).toContain('Waiting for a person to approve'); expect(waiting).not.toContain('Stays donated');
    const old = renderRecord({ ...refund, evidence: undefined, approvedAt: undefined });
    expect(old).toContain('data-testid="refund-evidence"'); expect(old).toContain('REF-123'); expect(old).toContain('CAP-REFUNDED');
    expect(old).not.toContain('Demo cap'); expect(old).not.toContain('Stays donated');
    expect(renderRecord(record({ payee: 'crew-north' }))).not.toContain('refund-evidence');
  });
  it('puts paypal ids inside details with updated summary and keeps actions outside', () => {
    const rec = record({
      donationId: 'donation1',
      captureId: 'CAP12345678901234',
      status: 'PROPOSED',
      receipts: [
        { method: 'POST', path: '/v2/checkout/orders', status: 201, at: '2026-11-09' },
      ],
    });
    const html = renderRecord(rec, [rec]);
    expect(html).toContain('data-testid="approve-refund"');
    expect(html).toContain('PayPal ids and receipts (1)');
    const detailsMatch = html.match(/<details>([\s\S]*?)<\/details>/);
    expect(detailsMatch).toBeTruthy();
    expect(detailsMatch![1]).toContain('CAP12345678901234');
    expect(detailsMatch![1]).not.toContain('approve-refund');
    expect(html.indexOf('approve-refund')).toBeLessThan(html.indexOf('<details>'));
  });
  it('puts older payrolls into details when there are multiple payrolls', () => {
    const state = emptyState();
    state.payrolls = [
      { id: 'p3', worklogIds: [], cents: 1000, status: 'PAID', batchId: 'BATCH3', requestId: 'REQ3', receipts: [], createdAt: 300 },
      { id: 'p2', worklogIds: [], cents: 2000, status: 'PAID', batchId: 'BATCH2', requestId: 'REQ2', receipts: [], createdAt: 200 },
      { id: 'p1', worklogIds: [], cents: 3000, status: 'PAID', batchId: 'BATCH1', requestId: 'REQ1', receipts: [], createdAt: 100 },
    ];
    const html = renderMoneyLog(state);
    expect(html).toContain('data-payroll-id="p3"');
    expect(html).toContain('data-testid="older-payrolls"');
    expect(html).toContain('Older payrolls (2)');
    const olderStart = html.indexOf('<details class="older-payrolls"');
    expect(olderStart).toBeGreaterThan(-1);
    const older = html.slice(olderStart);
    expect(older).toContain('data-payroll-id="p2"');
    expect(older).toContain('data-payroll-id="p1"');
    expect(older).not.toContain('data-payroll-id="p3"');
  });
});
it('preserves the City disclaimer exactly, ignoring Markdown line wrapping', () => {
  const source = readFileSync('docs/SOURCES.md', 'utf8');
  const quote = source.split(/\r?\n/).filter(line => line.startsWith('> ')).map(line => line.slice(2)).join(' ');
  expect(CITY_DISCLAIMER).toBe(quote);
});

it('uses server catalog labels in the global money log and escapes them', () => {
  const state = emptyState();
  state.payees = [{ key: 'custom-crew', label: '<New crew>', role: 'doors', rateDollars: 0.25 }];
  state.records = [record({ payee: 'custom-crew' })];
  expect(renderMoneyLog(state)).toContain('&lt;New crew&gt;');
  expect(renderRecord(record({ payee: 'unknown' }))).toContain('unknown');
});

describe('about and limits', () => {
  it('documents model limits and browser-scoped sandbox records', () => {
    const content = aboutContent();
    expect(content).toContain(ESTIMATE_LIMIT);
    expect(content).toContain('Counted per browser, not per person');
    expect(content).toContain('AI writes the explanation only');
    expect(content).not.toContain('No personal data');
    expect(ESTIMATE_LIMIT.toLowerCase()).toContain('simulated');
    expect(ESTIMATE_LIMIT).toContain('No extra votes have been measured');
    expect(BACKTEST_LIMIT).toContain('does not test what spending does');
  });
});

describe('payroll summary binding', () => {
  it('keeps an AI summary only while it describes the batch on screen', () => {
    expect(summaryMatches('w1,w2:4000', 'w1,w2:4000', 'w1,w2:4000')).toBe(true);
    // the batch changed while the question was out: the late answer is for the old batch
    expect(summaryMatches('w1,w2:4000', 'w1,w2:4000', 'w1,w2,w3:5000')).toBe(false);
    // the server already saw a newer batch than the screen shows
    expect(summaryMatches('w1,w2,w3:5000', 'w1,w2:4000', 'w1,w2:4000')).toBe(false);
    // an answer with no version is judged by the version it was asked for
    expect(summaryMatches(undefined, 'w1,w2:4000', 'w1,w2:4000')).toBe(true);
    expect(summaryMatches(undefined, 'w1,w2:4000', 'w9:100')).toBe(false);
    expect(summaryMatches('w1,w2:4000', 'w1,w2:4000', '')).toBe(false);
  });
});
describe('foldKey', () => {
  type Fake = { cls: string; rec?: string; pay?: string };
  const fake = ({ cls, rec, pay }: Fake) => ({
    matches: (s: string) => s === '.' + cls,
    closest: (s: string) => s === '[data-record-id]' && rec ? { dataset: { recordId: rec } } : s === '[data-payroll-id]' && pay ? { dataset: { payrollId: pay } } : null,
  }) as unknown as Element;
  it('keeps payroll evidence in different batches apart', () => {
    expect(foldKey(fake({ cls: 'evidence', pay: 'p1' }))).not.toBe(foldKey(fake({ cls: 'evidence', pay: 'p2' })));
  });
  it('keeps a record evidence and ids details apart', () => {
    expect(foldKey(fake({ cls: 'evidence', rec: 'r1' }))).not.toBe(foldKey(fake({ cls: 'ids', rec: 'r1' })));
  });
  it('names the older payrolls fold', () => {
    expect(foldKey(fake({ cls: 'older-payrolls' }))).toBe('older-payrolls');
  });
});
